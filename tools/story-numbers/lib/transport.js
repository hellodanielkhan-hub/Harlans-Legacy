/* Transport for the Story Number release: the only code in this tool that talks to a site.

   An allow-list, checked before any request leaves the process:
   - GET   /api/stories[/<id>], /api/story-photos, /api/story-photos/<id>/<photoId>/digest|original,
           /api/site, /api/entities, /api/photos, /api/story-numbers
   - POST  /api/story-numbers/release   only for operation "release": at most once, body exactly
                                        { fingerprint } of THIS checkout's map
   - POST  /api/stories/publish         only for operation "publish": at most once, body exactly the
                                        approved Batch 1 record ids (406–430);
                                        or for operation "publish-batch" (batches 02+): at most once, body
                                        exactly the ids passed to approvePublish() (called once, after every
                                        check); never a protected, This Week or Batch 1 record (303–305, 388–430)
   Everything else (PUT, DELETE, any other path, the other operation's write, a second write) throws
   without a request. A transport without an operation can only read.

   Token: passed in once, held in a closure, sent only as x-admin-token, scrubbed from every error, and
   forgotten by close(). Redirects are refused, so the token never follows one. Destination: exactly
   https://www.harlanslegacy.com (createLiveTransport) or a loopback origin (createRehearsalTransport,
   used only by the local tests). */
"use strict";

const path = require("path");
const { scrub, assertNoUrlCredentials } = require(path.join(__dirname, "..", "..", "facebook-import", "lib", "secrets.js"));
const { productionDestination } = require(path.join(__dirname, "..", "..", "facebook-import", "lib", "transport.js"));
const numbering = require(path.join(__dirname, "..", "..", "..", "lib", "numbering.js"));
const { BATCH_1_IDS, FEATURED_ID } = require("./batch1.js");
const { PROTECTED_IDS } = require(path.join(__dirname, "..", "..", "facebook-import", "lib", "batch.js"));
// never published by the batch publisher: the protected archive, This Week and Batch 1 (it has its own operation)
const NEVER_BATCH_PUBLISHED = new Set([...PROTECTED_IDS, FEATURED_ID, ...BATCH_1_IDS]);

const READ_PATHS = [/^\/api\/stories(\/\d+)?$/, /^\/api\/story-photos(\/\d+)?$/, /^\/api\/story-photos\/\d+\/[^/]+\/(digest|original)$/,
  /^\/api\/(site|entities|photos|story-numbers)$/];

function rehearsalDestination(base) {
  assertNoUrlCredentials(base);
  const u = new URL(base);
  if (u.username || u.password) throw new Error("rehearsal base must not carry a user name or password");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new Error("rehearsal transport is loopback only");
  if (!/^https?:$/.test(u.protocol) || u.pathname !== "/" || u.search || u.hash) throw new Error("rehearsal base must be a loopback origin");
  return u.origin;
}

function createLiveTransport(opts) { return core(productionDestination(opts && opts.base), opts || {}); }
function createRehearsalTransport(opts) { return core(rehearsalDestination(opts.base), opts); }

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

function core(base, opts) {
  let token = opts.token;
  if (!token || typeof token !== "string") throw new Error("an admin token is required");
  const fetchFn = opts.fetch || globalThis.fetch;
  const operation = opts.operation || null;                 // "release" | "publish" | "publish-batch" | null (read-only)
  if (operation !== null && operation !== "release" && operation !== "publish" && operation !== "publish-batch") throw new Error("unknown operation " + operation);
  const used = { release: false, publish: false };
  let approvedIds = null;                                   // publish-batch: set once by approvePublish()
  const log = [];
  const secrets = () => (token ? [token] : []);

  function refuse(why) { throw new Error("transport refused: " + why); }
  function allowed(method, p, body) {
    if (method === "GET") { if (READ_PATHS.some(r => r.test(p))) return; refuse("GET " + p + " is not a read this tool needs"); }
    if (method !== "POST") refuse(method + " is never sent by this tool");
    if (p === "/api/story-numbers/release") {
      if (operation !== "release") refuse("this session may not run the numbering release");
      if (used.release) refuse("a second release in one run");
      const keys = Object.keys(body || {});
      if (keys.length !== 1 || body.fingerprint !== numbering.assignmentsFingerprint()) refuse("the release body must be exactly this checkout's map fingerprint");
      used.release = true; return;
    }
    if (p === "/api/stories/publish") {
      if (operation !== "publish" && operation !== "publish-batch") refuse("this session may not publish");
      if (used.publish) refuse("a second publish in one run");
      const keys = Object.keys(body || {});
      if (operation === "publish") {
        if (keys.length !== 1 || !sameList(body.ids, BATCH_1_IDS)) refuse("only the approved Batch 1 record ids may be published");
      } else {
        if (!approvedIds) refuse("no batch ids were approved for publication in this session");
        if (keys.length !== 1 || !sameList(body.ids, approvedIds)) refuse("only the ids approved for this batch may be published");
      }
      used.publish = true; return;
    }
    refuse("POST " + p + " is not allowed");
  }

  async function send(method, p, body, raw) {
    try {
      if (!token) throw new Error("transport is closed");
      allowed(method, p, body);
      const url = base + p;
      assertNoUrlCredentials(url);
      const h = { "x-admin-token": token };
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

  const transport = (method, p, body) => send(method, p, body, false);
  const photoPath = (storyId, photoId, what) => "/api/story-photos/" + Number(storyId) + "/" + encodeURIComponent(photoId) + "/" + what;
  return {
    base,
    transport,
    // the interface tools/facebook-import/lib/snapshot.js backup() expects
    storedPhotoDigest: (storyId, item) => send("GET", photoPath(storyId, item.id, "digest"), null, false),
    readOriginal: (storyId, photoId) => send("GET", photoPath(storyId, photoId, "original"), null, true),
    operation,
    // publish-batch only: the exact record ids the one publish may carry. Called once, after every check.
    approvePublish: ids => {
      if (operation !== "publish-batch") refuse("approvePublish is only for the publish-batch operation");
      if (approvedIds) refuse("the batch ids were already approved in this session");
      if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every(n => Number.isInteger(n) && n > 0) || new Set(ids).size !== ids.length) refuse("the approved ids must be a non-empty list of distinct record ids");
      const bad = ids.filter(id => NEVER_BATCH_PUBLISHED.has(id));
      if (bad.length) refuse("records " + bad.join(", ") + " are never published by the batch publisher");
      approvedIds = Object.freeze(ids.slice());
    },
    requests: () => log.slice(),
    secrets,
    close: () => { token = null; }
  };
}

module.exports = { createLiveTransport, createRehearsalTransport, READ_PATHS };
