/* Live transport for the Admin API: the only code in this tool that can write to a site.

   It is an allow-list, checked before any request leaves the process:
   - GET   /api/stories[/<id>], /api/story-photos[/<id>], /api/story-photos/<id>/<photoId>/digest|original,
           /api/site, /api/entities, /api/photos
   - POST  /api/stories              a NEW Draft only: status "draft", featured false, this importer's
                                     importSource, an id in this run's allocated ids, never a protected id,
                                     and the x-defer-rebuild header
   - POST  /api/story-photos/<id>    only for an id allocated to this run, never a protected id, deferred
   - POST  /api/build                at most once per transport
   Everything else (PUT, DELETE, any other path, a second build) throws without a request. The importer has
   no way to publish, edit, delete or reschedule a memory.

   Token: passed in once, held in a closure, sent only as x-admin-token, scrubbed from every error, and
   forgotten by close(). The base URL must be https (or http on a loopback address for rehearsals) and may
   not carry a credential. */
"use strict";

const { scrub, assertNoUrlCredentials } = require("./secrets.js");
const { PROTECTED_IDS, IMPORT_SYSTEM } = require("./batch.js");

const READ_PATHS = [/^\/api\/stories(\/\d+)?$/, /^\/api\/story-photos(\/\d+)?$/, /^\/api\/story-photos\/\d+\/[^/]+\/(digest|original)$/, /^\/api\/(site|entities|photos)$/];

function checkBase(base) {
  assertNoUrlCredentials(base);
  const u = new URL(base);
  if (u.username || u.password) throw new Error("API base must not carry a user name or password");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && loopback))) throw new Error("API base must be https (or http on a loopback address): " + u.origin);
  if (u.pathname !== "/" || u.search || u.hash) throw new Error("API base must be an origin only: " + base);
  return u.origin;
}

function createLiveTransport(opts) {
  const base = checkBase(opts.base);
  let token = opts.token;
  if (!token || typeof token !== "string") throw new Error("an admin token is required");
  const fetchFn = opts.fetch || globalThis.fetch;
  const allowIds = new Set((opts.allowIds || []).map(Number));
  const log = [];
  let builds = 0;
  const secrets = () => (token ? [token] : []);

  function refuse(why) { throw new Error("transport refused: " + why); }
  function allowed(method, p, body, headers) {
    const deferred = headers && String(headers["x-defer-rebuild"]) === "1";
    if (method === "GET") { if (READ_PATHS.some(r => r.test(p))) return; refuse("GET " + p + " is not a read this importer needs"); }
    if (method !== "POST") refuse(method + " is never sent by this importer");
    if (p === "/api/build") { if (builds >= 1) refuse("a second build in one run"); builds++; return; }
    let m = p.match(/^\/api\/stories$/);
    if (m) {
      const id = Number(body && body.id);
      if (!Number.isInteger(id) || !allowIds.has(id)) refuse("story id " + (body && body.id) + " was not allocated to this run");
      if (PROTECTED_IDS.includes(id)) refuse("story id " + id + " is protected");
      if (body.status !== "draft" || body.featured !== false) refuse("only non-featured Drafts may be created");
      if (!body.importSource || body.importSource.system !== IMPORT_SYSTEM) refuse("record lacks this importer's importSource");
      if (!deferred) refuse("writes must defer the rebuild");
      return;
    }
    m = p.match(/^\/api\/story-photos\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (!allowIds.has(id) || PROTECTED_IDS.includes(id)) refuse("photo upload to story " + id + " which this run did not create");
      if (!deferred) refuse("writes must defer the rebuild");
      return;
    }
    refuse("POST " + p + " is not allowed");
  }

  async function send(method, p, body, headers, raw) {
    try {
      if (!token) throw new Error("transport is closed");
      allowed(method, p, body, headers || {});
      const url = base + p;
      assertNoUrlCredentials(url);
      const h = Object.assign({ "x-admin-token": token }, headers || {});
      if (method !== "GET") h["Content-Type"] = "application/json";
      log.push({ method, path: p, at: new Date().toISOString() });
      const r = await fetchFn(url, { method, headers: h, body: method === "GET" ? undefined : JSON.stringify(body || {}), cache: "no-store", redirect: "error" });
      if (raw) return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()), headers: r.headers };
      const text = await r.text();
      let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch (e) { parsed = { error: "non-JSON response (" + text.length + " bytes)" }; }
      return { status: r.status, body: parsed };
    } catch (e) {
      throw new Error(scrub(e && e.message || e, secrets()));
    }
  }

  const transport = (method, p, body, headers) => send(method, p, body, headers, false);
  const photoPath = (storyId, photoId, what) => "/api/story-photos/" + Number(storyId) + "/" + encodeURIComponent(photoId) + "/" + what;
  return {
    base,
    transport,
    // runBatch's read-back contract: { status, body: { file, sha256 } } for the stored original
    storedPhotoDigest: (storyId, item) => send("GET", photoPath(storyId, item.id, "digest"), null, null, false),
    readOriginal: (storyId, photoId) => send("GET", photoPath(storyId, photoId, "original"), null, null, true),
    allow: ids => ids.forEach(id => allowIds.add(Number(id))),
    requests: () => log.slice(),
    secrets,
    close: () => { token = null; }
  };
}

module.exports = { createLiveTransport, READ_PATHS };
