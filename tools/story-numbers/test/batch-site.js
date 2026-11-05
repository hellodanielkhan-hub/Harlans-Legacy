/* Test harness for publish-batch: one isolated local site per process. The checkout's real
   api/[...path].js runs in FILE mode on 127.0.0.1 against `root` (a throwaway copy), a local deploy hook
   runs the real build.js, and a static server stands in for the public site. Batches are imported with
   the importer's own runBatch() (deferred rebuild, read-back, one closing build) and published with
   lib/run.js publishBatch(). No Supabase, no network beyond 127.0.0.1, random tokens. */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const WT = path.resolve(__dirname, "..", "..", "..");

function startSite(root) {
  const ADMIN = crypto.randomBytes(16).toString("hex");
  process.env.HL_DATA_DIR = root;
  process.env.ADMIN_TOKEN = ADMIN;
  const handler = require(path.join(WT, "api", "[...path].js"));
  const store = require(path.join(WT, "lib", "store.js"));
  if (store.USE_SUPABASE) throw new Error("the test site must run in file mode");
  // Storage writes go under <root>/story-photos (where the file backend reads them back).
  store.uploadObject = async (bucket, objPath, buf) => { const d = path.join(root, bucket, objPath); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.writeFileSync(d, buf); };
  const site = { root, token: ADMIN, builds: 0, buildErrors: [] };
  const build = () => { try { execFileSync(process.execPath, [path.join(WT, "build.js")], { env: Object.assign({}, process.env, { HL_DATA_DIR: root }), stdio: "pipe" }); } catch (e) { site.buildErrors.push(String(e.stderr || e.message).slice(0, 500)); } };
  const api = http.createServer((req, res) => handler(req, res));
  // site.hookStatus (default 200) lets a test make the deploy hook fail; a failed hook builds nothing
  const hook = http.createServer((req, res) => { site.builds++; const st = site.hookStatus || 200; if (st === 200) build(); res.statusCode = st; res.end("{}"); });
  const pub = http.createServer((req, res) => {
    const rel = decodeURIComponent(String(req.url).split("?")[0]).replace(/^\/+/, "") || "index.html";
    const f = path.resolve(root, rel);
    if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end("not found"); }
    res.end(fs.readFileSync(f));
  });
  const listen = srv => new Promise(r => srv.listen(0, "127.0.0.1", () => r("http://127.0.0.1:" + srv.address().port)));
  site.start = async () => {
    site.API = await listen(api); site.SITE = await listen(pub);
    process.env.VERCEL_DEPLOY_HOOK_URL = (await listen(hook)) + "/hook";
    build();                               // the public site as it stands before the batch
    return site;
  };
  site.close = () => { api.close(); hook.close(); pub.close(); };
  site.stories = () => JSON.parse(fs.readFileSync(path.join(root, "data", "stories.json"), "utf8"));
  site.galleries = () => { const f = path.join(root, "data", "story-photos.json"); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {}; };
  site.writeStories = list => fs.writeFileSync(path.join(root, "data", "stories.json"), JSON.stringify(list, null, 2) + "\n");
  // one raw POST /api/stories/publish (admin token), for route-level tests
  site.publishRaw = async ids => { const r = await fetch(site.API + "/api/stories/publish", { method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": site.token }, body: JSON.stringify({ ids }) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return site;
}

/* Imports a payload as Drafts through runBatch(), with ids allocated after the highest id on the site
   (the payload's provisional ids are never used as such, as in production). Returns { result, ids }. */
async function importBatch(site, payload, ledgerPath) {
  const { runBatch } = require(path.join(WT, "tools", "facebook-import", "lib", "batch.js"));
  const { Ledger } = require(path.join(WT, "tools", "facebook-import", "lib", "ledger.js"));
  const { createRehearsalTransport } = require(path.join(WT, "tools", "facebook-import", "lib", "transport.js"));
  const { batchIdOf } = require(path.join(WT, "tools", "facebook-import", "lib", "authorize.js"));
  const live = createRehearsalTransport({ base: site.API, token: site.token });
  const all = await live.transport("GET", "/api/stories");
  let next = Math.max(430, ...all.body.map(s => s.id)) + 1;
  const items = payload.items.map(it => Object.assign({}, it, { record: Object.assign({}, it.record, { id: next++ }) }));
  live.allow(items.map(it => it.record.id));            // as lib/run.js does after allocating the ids
  const snapshot = { takenAt: new Date().toISOString(), memories: all.body.map(s => ({ id: s.id, status: s.status, featured: !!s.featured, importSource: s.importSource || null })) };
  const result = await runBatch({ items, transport: live.transport, ledger: new Ledger(ledgerPath), batchId: batchIdOf(payload), approved: payload.approvedFingerprints,
    defer: true, snapshot, storedPhotoDigest: live.storedPhotoDigest });
  live.close();
  return { result, ids: items.map(it => it.record.id) };
}

/* One publish-batch session against the local site. `answer` is what the operator types at the confirmation;
   `wrap(live)` may replace the transport (failure injection). Returns { report, writes, asked }. */
async function publishSession(site, opts) {
  const run = require("../lib/run.js");
  const { Ledger } = require(path.join(WT, "tools", "facebook-import", "lib", "ledger.js"));
  const { createRehearsalTransport } = require("../lib/transport.js");
  const real = createRehearsalTransport({ base: site.API, token: site.token, operation: opts.operation || "publish-batch" });
  const live = opts.wrap ? opts.wrap(real) : real;
  const asked = [];
  const io = { isTTY: true, print: () => {}, ask: async q => { asked.push(q); return typeof opts.answer === "function" ? opts.answer(q) : opts.answer; } };
  const b0 = site.builds;
  const report = await run.publishBatch({ live, io, ledger: new Ledger(opts.ledgerPath), backupDir: opts.backupDir, payload: opts.payload,
    approvedFingerprint: opts.fingerprint, importEntries: new Ledger(opts.importLedgerPath).read(), fetch: globalThis.fetch, origin: site.SITE,
    publicTries: 3, publicWaitMs: 200 });
  real.close();
  return { report, asked, builds: site.builds - b0, writes: real.requests().filter(q => q.method !== "GET").map(q => q.path) };
}

module.exports = { WT, startSite, importBatch, publishSession };
