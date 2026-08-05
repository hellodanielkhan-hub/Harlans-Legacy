#!/usr/bin/env node
/* =========================================================
   Harlan's Legacy — Local Admin + Preview Server
   Zero dependencies (Node built-ins only).

   Serves the public site AND the admin dashboard, and exposes a
   small JSON API the dashboard uses to add / edit / publish / delete
   stories. Every mutation writes data/stories.json (or site.json) and
   then runs the generator, so the homepage, archive and story pages
   are regenerated the moment a story is published.

   Run:  node server.js         (http://localhost:4317)
         PORT=8080 node server.js
   ========================================================= */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { build } = require("./build.js");
const { processPhotos } = require("./lib/photos.js");

const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const STORIES = path.join(DATA, "stories.json");
const SITE = path.join(DATA, "site.json");
const ENTITIES = path.join(DATA, "entities.json");
const PHOTOS_JSON = path.join(DATA, "photos.json");
const PHOTOS_SRC = path.join(ROOT, "photos");
const PHOTOS_OUT = path.join(ROOT, "assets", "photos");
const PORT = process.env.PORT || 4317;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8"
};

function readJSON(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n"); }
function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8" });
  res.end(body);
}
function sendJSON(res, code, obj) { send(res, code, JSON.stringify(obj), "application/json; charset=utf-8"); }

function slugify(str) {
  return String(str).toLowerCase().trim()
    .replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// A fresh story record with every field the model defines, so the editor
// always round-trips the full schema even for a brand-new entry.
function normalize(input, existing) {
  const base = existing || {};
  const s = Object.assign({}, base, input);
  s.title = String(s.title || "Untitled").trim();
  s.slug = (s.slug && slugify(s.slug)) || slugify(s.title);
  s.status = ["published", "coming-soon", "draft"].includes(s.status) ? s.status : "coming-soon";
  s.featured = !!s.featured;
  s.theme = s.theme || "ordinary";
  s.publishedISO = s.publishedISO || null;
  s.dateLong = s.dateLong || "";
  s.dateLabel = s.dateLabel || "";
  s.memoryDate = s.memoryDate || null;
  s.summary = s.summary || "";
  s.description = s.description || null;
  s.ogDescription = s.ogDescription || null;
  s.lead = s.lead || null;
  s.body = Array.isArray(s.body) ? s.body : [];
  ["people", "places", "objects", "events", "echoStories", "keywords"].forEach(k => {
    s[k] = Array.isArray(s[k]) ? s[k] : [];
  });
  s.bookPart = s.bookPart || null;
  s.readingTime = (s.readingTime === 0 || s.readingTime) ? s.readingTime : null;
  return s;
}

function nextId(stories) {
  return stories.reduce((m, s) => Math.max(m, Number(s.id) || 0), 0) + 1;
}

// A published story must be the only featured one. Enforce single-featured.
function enforceSingleFeatured(stories, featuredId) {
  stories.forEach(s => { s.featured = (s.id === featuredId); });
}

function rebuild() {
  try { return { ok: true, summary: build() }; }
  catch (e) { return { ok: false, error: String(e && e.stack || e) }; }
}

/* ---------- request body ---------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 30e6) req.destroy(); }); // 30MB (base64 uploads)
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

/* ---------- photos ---------- */
function photoSlug(s) {
  return String(s).toLowerCase().replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
// person id -> display name, from the family data
function personNames() {
  const ents = readJSON(ENTITIES);
  const map = {};
  ((ents.family && ents.family.people) || []).forEach(p => { map[p.id] = p.name; });
  return map;
}
function rmDerivatives(personId, photoId) {
  const dir = path.join(PHOTOS_OUT, personId);
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).filter(f => f.indexOf(photoId + ".") === 0)
    .forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} });
}

/* ---------- static files ---------- */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname.replace(/^\/+/, ""));
  if (rel === "") rel = "index.html";
  if (rel.endsWith("/")) rel += "index.html";

  // Prevent path traversal outside ROOT.
  const abs = path.normalize(path.join(ROOT, rel));
  if (!abs.startsWith(ROOT)) return send(res, 403, "Forbidden", "text/plain");

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not found: " + rel, "text/plain; charset=utf-8");
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(abs).pipe(res);
  });
}

/* ---------- API ---------- */
async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "stories", "214"]
  const resource = parts[1];
  const idParam = parts[2] ? Number(parts[2]) : null;

  try {
    if (resource === "site") {
      if (req.method === "GET") return sendJSON(res, 200, readJSON(SITE));
      if (req.method === "PUT") {
        const body = await readBody(req);
        writeJSON(SITE, body);
        return sendJSON(res, 200, { ok: true, site: body, build: rebuild() });
      }
    }

    if (resource === "entities") {
      if (req.method === "GET") return sendJSON(res, 200, readJSON(ENTITIES));
    }

    if (resource === "build" && req.method === "POST") {
      return sendJSON(res, 200, rebuild());
    }

    /* ------------------------------------------------------------------
       AI-ready metadata endpoint. The CMS's default provider runs entirely
       in the browser (admin/ai.js — local heuristics, no key). This server
       route is the single, documented seam for a real model. Until a key is
       configured it returns ok:false, and the CMS silently keeps using the
       local provider — nothing to redesign when you wire a model in.

       TO CONNECT A REAL MODEL (OpenAI / Claude / Gemini):
         1. Set an API key in the environment, e.g. HL_AI_KEY / HL_AI_PROVIDER.
         2. Below, branch on process.env.HL_AI_PROVIDER, call the provider's
            HTTP API with `body` (the story context the CMS sends) and map the
            response to the same Suggestions shape admin/ai.js documents:
              { seoDescription, ogDescription, summary, readingTime, keywords,
                people, places, objects, events, journey, relatedStories,
                searchTags, tone, timeline, connections }
         3. Return sendJSON(res, 200, { ok:true, suggestions, provider }).
         4. In the CMS console run HL_AI.use("remote") to switch providers.
       ------------------------------------------------------------------ */
    if (resource === "ai" && parts[2] === "generate" && req.method === "POST") {
      await readBody(req); // accept the context payload even when unconfigured
      var provider = process.env.HL_AI_PROVIDER || "none";
      if (provider === "none" || !process.env.HL_AI_KEY) {
        return sendJSON(res, 200, {
          ok: false, provider: "none",
          reason: "No server AI provider configured. The CMS is using its built-in local heuristics. Set HL_AI_PROVIDER + HL_AI_KEY and implement the mapping in server.js to enable a hosted model."
        });
      }
      // Placeholder for a real hosted model call (see instructions above).
      return sendJSON(res, 501, { ok: false, provider: provider, reason: "Provider '" + provider + "' is selected but its request mapping is not implemented yet." });
    }

    if (resource === "stories") {
      let stories = readJSON(STORIES);

      if (req.method === "GET") {
        if (idParam != null) {
          const one = stories.find(s => s.id === idParam);
          return one ? sendJSON(res, 200, one) : sendJSON(res, 404, { error: "No story " + idParam });
        }
        return sendJSON(res, 200, stories);
      }

      if (req.method === "POST") {
        const body = await readBody(req);
        const story = normalize(body);
        story.id = Number(body.id) || nextId(stories);
        if (stories.some(s => s.id === story.id)) return sendJSON(res, 409, { error: "id " + story.id + " already exists" });
        stories.push(story);
        if (story.featured && story.status === "published") enforceSingleFeatured(stories, story.id);
        writeJSON(STORIES, stories);
        return sendJSON(res, 201, { ok: true, story, build: rebuild() });
      }

      if (req.method === "PUT" && idParam != null) {
        const idx = stories.findIndex(s => s.id === idParam);
        if (idx === -1) return sendJSON(res, 404, { error: "No story " + idParam });
        const body = await readBody(req);
        const story = normalize(body, stories[idx]);
        story.id = idParam;
        stories[idx] = story;
        if (story.featured && story.status === "published") enforceSingleFeatured(stories, idParam);
        writeJSON(STORIES, stories);
        return sendJSON(res, 200, { ok: true, story, build: rebuild() });
      }

      if (req.method === "DELETE" && idParam != null) {
        const before = stories.length;
        stories = stories.filter(s => s.id !== idParam);
        if (stories.length === before) return sendJSON(res, 404, { error: "No story " + idParam });
        writeJSON(STORIES, stories);
        return sendJSON(res, 200, { ok: true, deleted: idParam, build: rebuild() });
      }
    }

    if (resource === "photos") {
      const personId = parts[2] ? decodeURIComponent(parts[2]) : null;
      const photoId = parts[3] ? decodeURIComponent(parts[3]) : null;
      const manifest = fs.existsSync(PHOTOS_JSON) ? readJSON(PHOTOS_JSON) : {};

      // GET /api/photos  → manifest + person display names
      if (req.method === "GET" && !personId) {
        return sendJSON(res, 200, { photos: manifest, names: personNames() });
      }

      // POST /api/photos/:personId  → upload one image (base64), reprocess, rebuild
      if (req.method === "POST" && personId) {
        const body = await readBody(req);
        if (!body.data || !body.filename) return sendJSON(res, 400, { error: "filename and data (base64) required" });
        const b64 = String(body.data).replace(/^data:[^;]+;base64,/, "");
        const buf = Buffer.from(b64, "base64");
        if (!buf.length) return sendJSON(res, 400, { error: "empty image" });
        const ext = /\.png$/i.test(body.filename) ? ".png" : ".jpg";
        const dir = path.join(PHOTOS_SRC, personId);
        fs.mkdirSync(dir, { recursive: true });
        let base = photoSlug(body.filename) || ("photo-" + Date.now());
        let file = base + ext, n = 1;
        while (fs.existsSync(path.join(dir, file))) { file = base + "-" + (++n) + ext; }
        fs.writeFileSync(path.join(dir, file), buf);
        await processPhotos();
        const updated = readJSON(PHOTOS_JSON);
        return sendJSON(res, 201, { ok: true, person: updated[personId], build: rebuild() });
      }

      // PUT /api/photos/:personId  → save primary + order + editorial fields
      if (req.method === "PUT" && personId) {
        const body = await readBody(req);
        const current = manifest[personId] || { primary: null, items: [] };
        const byId = {}; current.items.forEach(it => { byId[it.id] = it; });
        // rebuild items in the client's order, preserving generated derivative fields
        const items = (body.items || []).map(x => {
          const base = byId[x.id]; if (!base) return null;
          return Object.assign({}, base, {
            caption: x.caption != null ? x.caption : base.caption,
            year: x.year != null ? x.year : base.year,
            location: x.location != null ? x.location : base.location,
            source: x.source != null ? x.source : base.source,
            alt: x.alt != null ? x.alt : base.alt
          });
        }).filter(Boolean);
        // keep any items the client omitted (safety) appended in existing order
        current.items.forEach(it => { if (!items.find(i => i.id === it.id)) items.push(it); });
        let primary = body.primary;
        if (!primary || !items.find(it => it.id === primary)) primary = items[0] ? items[0].id : null;
        manifest[personId] = { primary, items };
        writeJSON(PHOTOS_JSON, manifest);
        return sendJSON(res, 200, { ok: true, person: manifest[personId], build: rebuild() });
      }

      // DELETE /api/photos/:personId/:photoId  → remove original + derivatives
      if (req.method === "DELETE" && personId && photoId) {
        const person = manifest[personId];
        if (!person) return sendJSON(res, 404, { error: "No person " + personId });
        const item = person.items.find(it => it.id === photoId);
        if (!item) return sendJSON(res, 404, { error: "No photo " + photoId });
        try { fs.unlinkSync(path.join(PHOTOS_SRC, personId, item.file)); } catch (e) {}
        rmDerivatives(personId, photoId);
        await processPhotos();
        const updated = readJSON(PHOTOS_JSON);
        return sendJSON(res, 200, { ok: true, person: updated[personId], build: rebuild() });
      }
    }

    return sendJSON(res, 404, { error: "Unknown endpoint " + req.method + " " + url.pathname });
  } catch (e) {
    return sendJSON(res, 400, { error: String(e.message || e) });
  }
}

/* ---------- server ---------- */
const server = http.createServer((req, res) => {
  let url;
  try {
    // Normalize leading double-slash etc. so a malformed path can't crash the server.
    url = new URL((req.url || "/").replace(/^\/{2,}/, "/"), "http://localhost");
  } catch (e) {
    return send(res, 400, "Bad request", "text/plain; charset=utf-8");
  }
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  if (url.pathname === "/admin") { res.writeHead(302, { Location: "/admin/" }); return res.end(); }
  return serveStatic(req, res, url.pathname);
});

// A single bad request must never take the whole server down.
server.on("clientError", (err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(PORT, () => {
  console.log("Harlan's Legacy admin + preview server");
  console.log("  Site  : http://localhost:" + PORT + "/");
  console.log("  Admin : http://localhost:" + PORT + "/admin/");
  console.log("  Story : http://localhost:" + PORT + "/story/214-the-blue-chair.html");
  console.log("Press Ctrl+C to stop.");
});
