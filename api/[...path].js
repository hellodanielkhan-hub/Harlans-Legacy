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

const store = require("../lib/store.js");
const records = require("../lib/records.js");
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
    const TOKEN = process.env.ADMIN_TOKEN;
    if (TOKEN) {
      const got = req.headers["x-admin-token"] || url.searchParams.get("token");
      if (got !== TOKEN) return json(res, 401, { error: "Unauthorized — admin token required." });
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
        await saveStory(story);
        return json(res, 201, { ok: true, story, build: await triggerRebuild() });
      }
      if (method === "PUT" && idParam != null) {
        const body = await readBody(req);
        const all = await store.getStories();
        const existing = all.find(s => s.id === idParam);
        if (!existing) return json(res, 404, { error: "No story " + idParam });
        const story = records.normalize(body, existing);
        story.id = idParam;
        await saveStory(story);
        return json(res, 200, { ok: true, story, build: await triggerRebuild() });
      }
      if (method === "DELETE" && idParam != null) {
        await store.deleteStory(idParam);
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
        return json(res, 201, { ok: true, gallery: g, build: await triggerRebuild() });
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
        return json(res, 200, { ok: true, gallery: manifest[key], build: await triggerRebuild() });
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
