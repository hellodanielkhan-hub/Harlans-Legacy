/* =========================================================================
   Harlan's Legacy — production API (Vercel serverless, Phase 12)

   A single catch-all function that answers the SAME admin API the local server
   exposes (GET/POST/PUT/DELETE /api/stories, /api/site, /api/entities,
   /api/photos, /api/story-photos, /api/reader-plan, /api/build) — but backed by
   Supabase (via lib/store.js) instead of the local filesystem, so it is fully
   persistent on Vercel's read-only/ephemeral runtime.

   • Record logic (normalize / single-featured / ids) is SHARED with the local
     server via lib/records.js — no second copy.
   • Uploaded originals go to Supabase Storage; responsive derivatives are
     regenerated at build time (see lib/hydrate.js + lib/photos.js), so nothing
     generated needs to persist between requests.
   • Publishing triggers a Vercel Deploy Hook, which rebuilds the static public
     site from the current Supabase data.
   • The Supabase service-role key lives only here (server-side). Writes require
     the ADMIN_TOKEN header; if ADMIN_TOKEN is unset (local), the gate is off.
   ========================================================================= */
"use strict";

const crypto = require("crypto");
const store = require("../lib/store.js");
const records = require("../lib/records.js");
const narration = require("../lib/narration/service.js");
const identity = require("../lib/narration/identity.js");   // per-moderator auth + attribution
const audit = require("../lib/narration/audit.js");         // moderator action audit log

// Publish contract (§4/§5): bind/clear the approved-generation↔revision stamp.
// BLOCKING publish/edit on missing narration is OFF unless HARLAN_NARRATION_PUBLISH_GATE=1:
// narration generation still needs an engine host, so a hard gate would make every
// story edit depend on it. Listening itself is only ever exposed approved+fresh (build.js).
async function applyPublishContract(story, force) {
  if (story.status !== "published") return null;
  if (process.env.HARLAN_NARRATION_PUBLISH_GATE === "1") {
    const pr = await narration.publishReadiness(story);
    if (pr.block && !force) return pr;                     // caller returns 409
  }
  const b = narration.bindingFor(story); if (b) story.narrationPublication = b; else delete story.narrationPublication;
  return null;
}
const { buildGraph } = require("../lib/graph.js");
const { autoPlan } = require("../lib/reader.js");
const { deriveData } = require("../build.js");

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 30e6) req.destroy(); });
    req.on("end", () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch (e) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

async function triggerRebuild() {
  const hook = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hook) return { ok: true, rebuild: "skipped", note: "No VERCEL_DEPLOY_HOOK_URL configured — data saved; publish will appear on the next build." };
  try {
    const r = await fetch(hook, { method: "POST" });
    return { ok: r.ok, rebuild: r.ok ? "triggered" : "failed", status: r.status };
  } catch (e) { return { ok: false, rebuild: "failed", error: String(e.message || e) }; }
}

// Batch imports: a write may ask to skip its rebuild with `x-defer-rebuild: 1`, but ONLY when the
// memory it touches is a draft (drafts are not part of the public build, so nothing visible is
// delayed). Published memories always rebuild. The batch ends with one POST /api/build.
// Without the header this is exactly triggerRebuild(): the status is not even looked up.
async function rebuildUnlessDeferred(req, storyStatus) {
  if (String(req.headers["x-defer-rebuild"] || "") === "1") {
    const status = typeof storyStatus === "function" ? await storyStatus() : storyStatus;
    if (status === "draft") return { ok: true, rebuild: "deferred", note: "Draft write; rebuild deferred until POST /api/build." };
  }
  return triggerRebuild();
}
async function statusOf(storyId) {
  const s = (await store.getStories()).find(x => String(x.id) === String(storyId));
  return s ? s.status : null;
}

function publicUrl(bucket, objPath) {
  return (process.env.SUPABASE_URL || "").replace(/\/$/, "") + "/storage/v1/object/public/" + bucket + "/" + objPath;
}

// Save a story, enforcing that a published+featured story is the only featured one.
async function saveStory(story) {
  if (story.featured && story.status === "published") {
    const all = await store.getStories();
    const others = all.filter(s => s.id !== story.id).map(s => (s.featured ? Object.assign({}, s, { featured: false }) : s));
    await store.putStories(others.concat([story]));
  } else {
    await store.putStory(story);
  }
}

/* Stored-photo read-back for imports and backups (GET only, admin token only, no side effects).
   - Who: the shared admin token. Moderators get 403. With no token gate at all (local dev) it works only
     outside production.
   - What: the photo is found in the stored gallery manifest of an existing memory, by its photo id. The
     client never supplies a path or URL; the object path is built here from the manifest entry, whose file
     name must be a plain name (no slashes, no "..").
   - How: the bytes are read server-side (service-role download or the local copy). No signed or public URL
     is created, no bucket setting changes, nothing is written, no rebuild.
   - digest -> { storyId, photoId, file, bytes, sha256, expected, verification } where verification is
     "match" / "mismatch" when ?expect=<64 hex> is given, else "not-requested".
   - original -> the bytes (attachment, no-store), with X-Content-SHA256. */
const STORED_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*\.(jpe?g|png|webp|gif)$/i;
const MAX_ORIGINAL_BYTES = 4 * 1024 * 1024;   // stays under the serverless response limit
async function storedPhotoRead(res, actor, sid, photoId, what, expect, manifest) {
  const isAdmin = actor && (actor.via === "admin-token" || (actor.via === "no-gate" && process.env.NODE_ENV !== "production"));
  if (!isAdmin) return json(res, 403, { error: "Admin token required for stored-photo read-back." });
  if (expect != null && !/^[0-9a-f]{64}$/.test(expect)) return json(res, 400, { error: "expect must be a lowercase SHA-256 hex digest" });
  const storyId = Number(sid);
  const stories = await store.getStories();
  if (!stories.some(s => s.id === storyId)) return json(res, 404, { error: "No story " + storyId });
  const key = records.storyKey(storyId);
  const g = manifest[key];
  const item = g && (g.items || []).find(it => it.id === photoId);
  if (!item) return json(res, 404, { error: "No such photo in story " + storyId });
  if (typeof item.file !== "string" || !STORED_FILE.test(item.file)) return json(res, 400, { error: "Stored file name is not a plain file name" });
  let buf;
  try { buf = await store.readObject(store.BUCKET_STORY, key + "/" + item.file); }
  catch (e) {
    if (e && e.code === "ENOENT") return json(res, 404, { error: "Stored object missing for photo " + photoId });
    return json(res, 502, { error: "Storage read failed" });
  }
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  if (what === "digest") {
    return json(res, 200, { storyId, photoId, file: item.file, bytes: buf.length, sha256, expected: expect || null,
      verification: expect ? (expect === sha256 ? "match" : "mismatch") : "not-requested" });
  }
  if (buf.length > MAX_ORIGINAL_BYTES) return json(res, 413, { error: "Original too large for this route", bytes: buf.length, sha256 });
  res.statusCode = 200;
  res.setHeader("Content-Type", /\.png$/i.test(item.file) ? "image/png" : /\.webp$/i.test(item.file) ? "image/webp" : /\.gif$/i.test(item.file) ? "image/gif" : "image/jpeg");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Disposition", "attachment; filename=\"" + item.file + "\"");
  res.setHeader("X-Content-SHA256", sha256);
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.end(buf);
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    // Resolve path segments robustly. Vercel routes every /api/* depth here via a
    // rewrite (see vercel.json) and populates req.query.path with the segments
    // after /api ("stories/302" or ["stories","302"]); fall back to the URL
    // pathname otherwise. We normalise to ["api", …segments] so the routing below
    // (parts[1]=resource, parts[2]=id, …) is unchanged and nested routes such as
    // /api/stories/302 and /api/story-photos/5 are always reachable.
    const q = req.query && req.query.path;
    let parts = Array.isArray(q) ? q.slice()
      : (typeof q === "string" && q) ? q.split("/").filter(Boolean)
      : url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api") parts = ["api"].concat(parts);
    const resource = parts[1];
    const idParam = parts[2] != null && /^\d+$/.test(parts[2]) ? Number(parts[2]) : null;
    const method = req.method;

    // ---- auth gate (writes always; reads too when a token is configured) ----
    // preview-asset is fetched header-less by the cinematic engine, so the header gate
    // cannot apply; the route itself requires a moderator-issued, short-lived capability
    // (lib/narration/preview-cap.js) and only redirects to a signed URL on PRIVATE storage.
    const isPreviewAsset = parts[1] === "narration" && parts[3] === "preview-asset";
    // Provider completion/heartbeat callbacks: HMAC-authenticated inside the route.
    const isProviderCallback = parts[1] === "narration" && parts[2] === "staging" && (parts[3] === "complete" || parts[3] === "heartbeat");
    // Credentials travel in headers only. A credential-looking query parameter is refused (never logged
    // or echoed), even when a valid header is also present.
    if (identity.urlCredentialParams(url.searchParams).length) {
      return json(res, 400, { error: "Credentials must be sent in a request header, never in the URL." });
    }
    const auth = identity.authorize(req.headers);
    const actor = auth.actor;
    if (!isPreviewAsset && !isProviderCallback && !auth.ok) {
      return json(res, 401, { error: "Unauthorized — moderator or admin token required." });
    }

    /* ---------------- voice narration (async jobs) ---------------- */
    if (resource === "narration") {
      const narrationApi = require("../lib/narration/api.js");
      const body = method === "GET" ? {} : await readBody(req);
      const nres = await narrationApi.route(parts, method, body, actor);
      if (nres) {
        // The serverless runtime cannot run synthesis (30s / ephemeral); a separate
        // worker (the engine box) drains queued jobs. Enqueue returns 202; admin polls.
        if (nres.rebuild) { const b = await triggerRebuild(); nres.body.build = b; }
        if (nres.redirect) { res.writeHead(302, { Location: nres.redirect }); return res.end(); }
        return json(res, nres.status, nres.body);
      }
    }

    /* ---------------- site ---------------- */
    if (resource === "site") {
      if (method === "GET") return json(res, 200, await store.getSite());
      if (method === "PUT") { const body = await readBody(req); await store.putSite(body); return json(res, 200, { ok: true, site: body, build: await triggerRebuild() }); }
    }

    /* ---------------- entities ---------------- */
    if (resource === "entities") {
      if (method === "GET") return json(res, 200, await store.getEntities());
      if (method === "PUT") { const body = await readBody(req); await store.putEntities(body); return json(res, 200, { ok: true, build: await triggerRebuild() }); }
    }

    /* ---------------- rebuild ---------------- */
    if (resource === "build" && method === "POST") return json(res, 200, await triggerRebuild());

    /* ---------------- reader-plan (auto image picks) ---------------- */
    if (resource === "reader-plan" && method === "GET" && idParam != null) {
      const [site, stories, entities, photos, storyPhotos] = await Promise.all([store.getSite(), store.getStories(), store.getEntities(), store.getPhotos(), store.getStoryPhotos()]);
      const d = deriveData(site, stories, entities, photos, storyPhotos);
      const s = d.stories.find(x => x.id === idParam);
      if (!s) return json(res, 404, { error: "No story " + idParam });
      const graph = buildGraph(d.stories, d.entities);
      return json(res, 200, { plan: autoPlan(s, graph), storyPhotos: s.storyPhotos || { items: [] } });
    }

    /* ---------------- AI (unconfigured stub — local heuristics run in the browser) ---------------- */
    if (resource === "ai" && parts[2] === "generate" && method === "POST") {
      await readBody(req);
      return json(res, 200, { ok: false, provider: "none", reason: "No server AI provider configured; the CMS uses its built-in local heuristics." });
    }

    /* ---------------- stories ---------------- */
    if (resource === "stories") {
      if (method === "GET") {
        const all = await store.getStories();
        if (idParam != null) { const one = all.find(s => s.id === idParam); return one ? json(res, 200, one) : json(res, 404, { error: "No story " + idParam }); }
        return json(res, 200, all);
      }
      if (method === "POST") {
        const body = await readBody(req);
        const all = await store.getStories();
        const story = records.normalize(body);
        story.id = Number(body.id) || records.nextId(all);
        if (all.some(s => s.id === story.id)) return json(res, 409, { error: "id " + story.id + " already exists" });
        story.createdBy = actor; story.createdAt = new Date().toISOString(); story.lastEditedBy = actor; story.lastEditedAt = story.createdAt;
        const blockedP = await applyPublishContract(story, body.force);
        if (blockedP) return json(res, 409, { error: blockedP.message, code: blockedP.code, readiness: blockedP });
        await saveStory(story);
        await audit.record({ action: "story.create", storyId: story.id, actor, detail: story.title || null });
        return json(res, 201, { ok: true, story, build: await rebuildUnlessDeferred(req, story.status) });
      }
      if (method === "PUT" && idParam != null) {
        const body = await readBody(req);
        const all = await store.getStories();
        const existing = all.find(s => s.id === idParam);
        if (!existing) return json(res, 404, { error: "No story " + idParam });
        const story = records.normalize(body, existing);
        story.id = idParam;
        story.createdBy = existing.createdBy || story.createdBy || actor; story.createdAt = existing.createdAt || story.createdAt || new Date().toISOString();
        story.lastEditedBy = actor; story.lastEditedAt = new Date().toISOString();
        const blockedU = await applyPublishContract(story, body.force);
        if (blockedU) return json(res, 409, { error: blockedU.message, code: blockedU.code, readiness: blockedU });
        await saveStory(story);
        await audit.record({ action: "story.edit", storyId: idParam, actor, detail: story.title || null });
        // a memory that WAS public (published or coming-soon) must still rebuild (it has to leave the site)
        return json(res, 200, { ok: true, story, build: await rebuildUnlessDeferred(req, existing.status !== "draft" ? existing.status : story.status) });
      }
      if (method === "DELETE" && idParam != null) {
        await store.deleteStory(idParam);
        // Cascade: remove the story's editorial gallery (manifest entry + stored
        // originals) so deleting a memory never leaves orphaned story images.
        try {
          const key = records.storyKey(idParam);
          const manifest = await store.getStoryPhotos();
          if (manifest[key]) {
            for (const it of (manifest[key].items || [])) {
              try { await store.removeObject(store.BUCKET_STORY, key + "/" + it.file); } catch (e) {}
            }
            delete manifest[key];
            await store.putStoryPhotos(manifest);
          }
        } catch (e) { /* non-fatal: the story row is already gone */ }
        return json(res, 200, { ok: true, deleted: idParam, build: await triggerRebuild() });
      }
    }

    /* ---------------- family photos ---------------- */
    if (resource === "photos") {
      const personId = parts[2] ? decodeURIComponent(parts[2]) : null;
      const photoId = parts[3] ? decodeURIComponent(parts[3]) : null;
      const manifest = await store.getPhotos();
      if (method === "GET" && !personId) { const entities = await store.getEntities(); return json(res, 200, { photos: manifest, names: records.personNames(entities) }); }
      if (method === "POST" && personId) {
        const body = await readBody(req);
        if (!body.data || !body.filename) return json(res, 400, { error: "filename and data (base64) required" });
        const buf = Buffer.from(String(body.data).replace(/^data:[^;]+;base64,/, ""), "base64");
        if (!buf.length) return json(res, 400, { error: "empty image" });
        const ext = /\.png$/i.test(body.filename) ? ".png" : ".jpg";
        let base = records.photoSlug(body.filename) || ("photo-" + Date.now());
        const person = manifest[personId] || { primary: null, items: [] };
        let file = base + ext, n = 1;
        while (person.items.some(it => it.file === file)) file = base + "-" + (++n) + ext;
        await store.uploadObject(store.BUCKET_PHOTOS, personId + "/" + file, buf, ext === ".png" ? "image/png" : "image/jpeg");
        person.items.push({ id: records.photoSlug(file), file, caption: "", year: null, location: null, source: null, alt: null, focus: { x: 50, y: 42 }, url: publicUrl(store.BUCKET_PHOTOS, personId + "/" + file), portrait: [], full: [] });
        if (!person.primary) person.primary = person.items[0].id;
        manifest[personId] = person;
        await store.putPhotos(manifest);
        return json(res, 201, { ok: true, person, build: await triggerRebuild() });
      }
      if (method === "PUT" && personId) {
        const body = await readBody(req);
        const current = manifest[personId] || { primary: null, items: [] };
        const byId = {}; current.items.forEach(it => { byId[it.id] = it; });
        const items = (body.items || []).map(x => { const b = byId[x.id]; if (!b) return null; return Object.assign({}, b, { caption: x.caption != null ? x.caption : b.caption, year: x.year != null ? x.year : b.year, location: x.location != null ? x.location : b.location, source: x.source != null ? x.source : b.source, alt: x.alt != null ? x.alt : b.alt, focus: (x.focus && typeof x.focus.x === "number") ? x.focus : b.focus }); }).filter(Boolean);
        current.items.forEach(it => { if (!items.find(i => i.id === it.id)) items.push(it); });
        let primary = body.primary; if (!primary || !items.find(it => it.id === primary)) primary = items[0] ? items[0].id : null;
        manifest[personId] = { primary, items };
        await store.putPhotos(manifest);
        return json(res, 200, { ok: true, person: manifest[personId], build: await triggerRebuild() });
      }
      if (method === "DELETE" && personId && photoId) {
        const person = manifest[personId]; if (!person) return json(res, 404, { error: "No person " + personId });
        const item = person.items.find(it => it.id === photoId); if (!item) return json(res, 404, { error: "No photo " + photoId });
        await store.removeObject(store.BUCKET_PHOTOS, personId + "/" + item.file);
        person.items = person.items.filter(it => it.id !== photoId);
        if (person.primary === photoId) person.primary = person.items[0] ? person.items[0].id : null;
        manifest[personId] = person;
        await store.putPhotos(manifest);
        return json(res, 200, { ok: true, person, build: await triggerRebuild() });
      }
    }

    /* ---------------- per-story editorial images ---------------- */
    if (resource === "story-photos") {
      const sid = parts[2] ? decodeURIComponent(parts[2]) : null;
      const photoId = parts[3] ? decodeURIComponent(parts[3]) : null;
      if (sid != null && !/^[0-9]+$/.test(sid)) return json(res, 400, { error: "Invalid story id for gallery" });
      const key = sid != null ? records.storyKey(sid) : null;
      const manifest = await store.getStoryPhotos();
      // Admin-only read-back of ONE stored original: /api/story-photos/<storyId>/<photoId>/digest (SHA-256 of
      // the stored bytes, computed here) or /original (the bytes, for backups). See storedPhotoRead below.
      if (method === "GET" && sid != null && photoId != null && (parts[4] === "digest" || parts[4] === "original") && parts.length === 5) {
        return storedPhotoRead(res, actor, sid, photoId, parts[4], url.searchParams.get("expect"), manifest);
      }
      if (method === "GET" && sid == null) return json(res, 200, manifest);
      if (method === "GET" && sid != null) return json(res, 200, manifest[key] || { primary: null, items: [] });
      if (method === "POST" && sid != null) {
        const body = await readBody(req);
        if (!body.data || !body.filename) return json(res, 400, { error: "filename and data (base64) required" });
        const buf = Buffer.from(String(body.data).replace(/^data:[^;]+;base64,/, ""), "base64");
        if (!buf.length) return json(res, 400, { error: "empty image" });
        const ext = /\.png$/i.test(body.filename) ? ".png" : ".jpg";
        let base = records.photoSlug(body.filename) || ("image-" + Date.now());
        const g = manifest[key] || { primary: null, items: [] };
        let file = base + ext, n = 1;
        while (g.items.some(it => it.file === file)) file = base + "-" + (++n) + ext;
        await store.uploadObject(store.BUCKET_STORY, key + "/" + file, buf, ext === ".png" ? "image/png" : "image/jpeg");
        g.items.push({ id: records.photoSlug(file), file, caption: "", year: null, location: null, source: null, alt: null, focus: { x: 50, y: 50 }, url: publicUrl(store.BUCKET_STORY, key + "/" + file), portrait: [], full: [] });
        if (!g.primary) g.primary = g.items[0].id;
        manifest[key] = g;
        await store.putStoryPhotos(manifest);
        return json(res, 201, { ok: true, gallery: g, build: await rebuildUnlessDeferred(req, () => statusOf(sid)) });
      }
      if (method === "PUT" && sid != null) {
        const body = await readBody(req);
        const current = manifest[key] || { primary: null, items: [] };
        const byId = {}; current.items.forEach(it => { byId[it.id] = it; });
        const items = (body.items || []).map(x => { const b = byId[x.id]; if (!b) return null; return Object.assign({}, b, { caption: x.caption != null ? x.caption : b.caption, year: x.year != null ? x.year : b.year, location: x.location != null ? x.location : b.location, source: x.source != null ? x.source : b.source, alt: x.alt != null ? x.alt : b.alt, focus: (x.focus && typeof x.focus.x === "number") ? x.focus : b.focus }); }).filter(Boolean);
        current.items.forEach(it => { if (!items.find(i => i.id === it.id)) items.push(it); });
        let primary = body.primary; if (!primary || !items.find(it => it.id === primary)) primary = items[0] ? items[0].id : null;
        manifest[key] = { primary, items };
        await store.putStoryPhotos(manifest);
        return json(res, 200, { ok: true, gallery: manifest[key], build: await rebuildUnlessDeferred(req, () => statusOf(sid)) });
      }
      if (method === "DELETE" && sid != null && photoId) {
        const g = manifest[key]; if (!g) return json(res, 404, { error: "No gallery " + key });
        const item = g.items.find(it => it.id === photoId); if (!item) return json(res, 404, { error: "No image " + photoId });
        await store.removeObject(store.BUCKET_STORY, key + "/" + item.file);
        g.items = g.items.filter(it => it.id !== photoId);
        if (g.primary === photoId) g.primary = g.items[0] ? g.items[0].id : null;
        manifest[key] = g;
        await store.putStoryPhotos(manifest);
        return json(res, 200, { ok: true, gallery: g, build: await triggerRebuild() });
      }
    }

    return json(res, 404, { error: "Unknown endpoint " + method + " " + url.pathname });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
};
