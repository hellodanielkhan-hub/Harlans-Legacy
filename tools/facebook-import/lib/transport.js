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
   forgotten by close(). Redirects are refused (fetch redirect: "error"), so the token never follows one.

   Destination: createLiveTransport() talks ONLY to PRODUCTION_ORIGIN, compared as an exact string. Any other
   value (another domain, a look-alike, an IP, a port, user:password@, a path, query or fragment, even
   "https://www.harlanslegacy.com/") is refused before the token is used. createRehearsalTransport() is the
   isolated testing interface for the local rehearsals: loopback http(s) only. import.js and lib/run.js never
   load it (a unit test enforces that). */
"use strict";

const { scrub, assertNoUrlCredentials } = require("./secrets.js");
const { PROTECTED_IDS, IMPORT_SYSTEM } = require("./batch.js");

const READ_PATHS = [/^\/api\/stories(\/\d+)?$/, /^\/api\/story-photos(\/\d+)?$/, /^\/api\/story-photos\/\d+\/[^/]+\/(digest|original)$/, /^\/api\/(site|entities|photos)$/];

const PRODUCTION_ORIGIN = "https://www.harlanslegacy.com";

// Describe a refused destination without echoing anything that could be a credential.
function describe(v) {
  if (typeof v !== "string") return "a non-text value";
  try { const u = new URL(v); return u.protocol + "//" + u.hostname + (u.port ? ":" + u.port : "") + (u.username || u.password ? " (with credentials)" : "") + (u.pathname !== "/" || u.search || u.hash || v.endsWith("/") ? " (with path/query/fragment)" : ""); }
  catch (e) { return "an invalid URL"; }
}

// The only destination a live (credentialed) command may use. Exact string match, nothing derived.
function productionDestination(requested) {
  if (requested === undefined || requested === null) return PRODUCTION_ORIGIN;
  if (requested !== PRODUCTION_ORIGIN) throw new Error("destination refused: Production commands only talk to " + PRODUCTION_ORIGIN + " (got " + describe(requested) + "); nothing was sent");
  return PRODUCTION_ORIGIN;
}

// Rehearsals only: an isolated local API on a loopback address.
function rehearsalDestination(base) {
  assertNoUrlCredentials(base);
  const u = new URL(base);
  if (u.username || u.password) throw new Error("rehearsal base must not carry a user name or password");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new Error("rehearsal transport is loopback only: " + describe(base));
  if (!/^https?:$/.test(u.protocol) || u.pathname !== "/" || u.search || u.hash) throw new Error("rehearsal base must be a loopback origin: " + describe(base));
  return u.origin;
}

function createLiveTransport(opts) { return core(productionDestination(opts && opts.base), opts || {}); }
function createRehearsalTransport(opts) { return core(rehearsalDestination(opts.base), opts); }

function core(base, opts) {
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

module.exports = { createLiveTransport, createRehearsalTransport, productionDestination, PRODUCTION_ORIGIN, READ_PATHS };
