/* The publish route with ONE audit write (instead of one per record), end to end in isolation: a synthetic copy of
   the archive, a synthetic 25-record import batch, the real API in file mode with an instrumented store (every
   store call counted; optional per-call latency), the importer's runBatch() and lib/run.js publishBatch().
   Covers: a 25-record batch (one status write, one audit write with 25 events, one rebuild), timing under store
   latency against the old one-audit-write-per-record path, an audit-write failure, a rebuild failure, safe
   already-applied reruns and no duplicate status write. No real data.
     node --test tools/story-numbers/test/publish-route.test.js */
"use strict";
delete process.env.HL_STORY_NUMBERS_DISPLAY;
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const fx = require("./fixture.js");
const { startSite, importBatch, publishSession, WT } = require("./batch-site.js");

fx.cleanEnv();
const { root } = fx.makeRoot();
const site = startSite(root);
const store = require(path.join(WT, "lib", "store.js"));
const audit = require(path.join(WT, "lib", "narration", "audit.js"));
const { approvalFingerprint, IMPORT_SYSTEM } = require(path.join(WT, "tools", "facebook-import", "lib", "batch.js"));
const { payloadFingerprint } = require(path.join(WT, "tools", "facebook-import", "lib", "authorize.js"));
const run = require("../lib/run.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hl-publish-route-"));
let nb = 0; const fresh = () => path.join(tmp, "backup-" + (++nb));
const sha = b => crypto.createHash("sha256").update(b).digest("hex");

// ---- instrumented store: count every call (by function and document key); optional latency per call ----
const calls = [];
let latencyMs = 0, failAuditWrite = false;
for (const fn of ["getStories", "putStories", "putStory", "getDoc", "putDoc"]) {
  const orig = store[fn];
  store[fn] = async function (...a) {
    calls.push(fn + (fn.endsWith("Doc") ? ":" + a[0] : ""));
    if (latencyMs) await new Promise(r => setTimeout(r, latencyMs));
    if (failAuditWrite && fn === "putDoc" && a[0] === "narration_audit") throw new Error("simulated audit storage failure");
    return orig.apply(this, a);
  };
}
const count = (list, k) => list.filter(c => c === k).length;

function synthPayload(batch, n, photoEvery) {
  const items = Array.from({ length: n }, (_, i) => {
    const postId = "R" + batch + String(i + 1).padStart(2, "0");
    const images = [];
    if (photoEvery && i % photoEvery === 0) {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(800)]);
      const f = path.join(tmp, postId + ".jpg"); fs.writeFileSync(f, bytes);
      images.push({ order: 1, primary: true, file: f, sha256: sha(bytes) });
    }
    const record = { id: 431 + i, storyNumber: null, title: "Route test " + batch + "/" + (i + 1), slug: "", status: "draft", featured: false, theme: "ordinary",
      publishedISO: "2024-0" + (1 + (i % 9)) + "-1" + (i % 9), dateLong: "", dateLabel: "", memoryDate: null, summary: "", description: null, ogDescription: null,
      lead: "Synthetic lead " + postId + ".", body: ["Synthetic body."], people: [], places: [], objects: [], events: [], bookPart: null, keywords: [], echoStories: [],
      readingTime: 1, readerImages: [], importSource: { system: IMPORT_SYSTEM, postId, facebookUrl: null, facebookTimeChicago: null } };
    return { postId, photoMode: images.length ? "photos" : "none", images, record };
  });
  const P = { batch, items, counts: { posts: n, withPhotos: items.filter(i => i.images.length).length, withoutPhotos: items.filter(i => !i.images.length).length, photos: items.reduce((a, i) => a + i.images.length, 0) } };
  P.approvedFingerprints = Object.fromEntries(items.map(it => [it.postId, approvalFingerprint(it)]));
  return P;
}
const B = {};
for (const [n, size, ph] of [[2, 25, 6], [3, 25, 0], [4, 25, 0], [5, 25, 0], [6, 3, 0]]) {
  const P = synthPayload(n, size, ph);
  B[n] = { P, FP: payloadFingerprint(P), L: path.join(tmp, "import-" + n + ".jsonl") };
}
const PUBLEDGER = path.join(tmp, "publish.jsonl");
const session = (n, o) => publishSession(site, Object.assign({ ledgerPath: PUBLEDGER, backupDir: fresh(), payload: B[n].P, fingerprint: B[n].FP, importLedgerPath: B[n].L,
  answer: run.BATCH_PUBLISH_PHRASE(B[n].P.items.length, "batch-0" + n) }, o));
const auditEvents = () => { const f = path.join(root, "data", "narration_audit.json"); return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")).events || []) : []; };
const idsOf = n => B[n].ids;
const featured = () => site.stories().filter(s => s.featured).map(s => s.id);

test.before(async () => {
  await site.start();
  for (const n of [2, 3, 4, 5, 6]) { const r = await importBatch(site, B[n].P, B[n].L); assert.equal(r.result.stopped, null, JSON.stringify(r.result.stopped)); B[n].ids = r.ids; }
});
test.after(() => { site.close(); fx.removeRoot(root); fs.rmSync(tmp, { recursive: true, force: true }); });

test("a 25-record batch: one status write, ONE audit write with 25 events, one rebuild; a rerun writes nothing", async () => {
  const ev0 = auditEvents().length, b0 = site.builds;
  calls.length = 0;
  const r = await session(2, {});
  assert.equal(r.report.stopped, undefined, r.report.stage + ": " + r.report.stopped);
  const pub = r.report.steps.find(s => s.step === "publish");
  assert.deepEqual(pub.audit, { ok: true, written: 25 });
  // the store calls the publish request made (the session's own reads are getStories/getDoc of other keys)
  assert.equal(count(calls, "putStories") + count(calls, "putStory"), 1, "exactly one status write: " + calls.filter(c => /^put/.test(c)).join(","));
  assert.equal(count(calls, "putDoc:narration_audit"), 1, "exactly one audit write");
  assert.equal(count(calls, "getDoc:narration_audit"), 1, "exactly one audit read");
  assert.equal(site.builds - b0, 1, "exactly one rebuild");
  const ev = auditEvents().slice(ev0);
  assert.equal(ev.length, 25);
  assert.deepEqual(ev.map(e => e.storyId), idsOf(2), "one event per record, in order");
  assert.ok(ev.every(e => e.action === "story.publish" && e.detail === "batch publish" && e.actorId === "admin" && e.at === ev[0].at));
  assert.ok(idsOf(2).every(id => site.stories().find(s => s.id === id).status === "published"));
  assert.deepEqual(featured(), [405]);
  // already applied: no publish request, no status write, no audit write, no build
  calls.length = 0; const b1 = site.builds;
  const again = await session(2, { answer: "" });
  assert.equal(again.report.stopped, undefined);
  assert.deepEqual(again.writes, []);
  assert.equal(count(calls, "putStories") + count(calls, "putStory") + count(calls, "putDoc:narration_audit"), 0, "a rerun writes nothing");
  assert.equal(site.builds - b1, 0);
});

test("timing, 25 records, 300 ms per store call, both measured: new path a few seconds; the old per-record audit path far longer", async () => {
  // the OLD route's audit step, exactly: one audit.record() (one read + one write of the document) per record
  const recordMany = audit.recordMany;
  latencyMs = 300;
  try {
    let t0 = Date.now();
    const rNew = await site.publishRaw(idsOf(5));
    const newMs = Date.now() - t0;
    audit.recordMany = async entries => { for (const e of entries) await audit.record(e); return { ok: true, written: entries.length }; };
    t0 = Date.now();
    const rOld = await site.publishRaw(idsOf(4));
    const oldMs = Date.now() - t0;
    assert.equal(rNew.status, 200); assert.equal(rOld.status, 200);
    console.log("TIMING " + JSON.stringify({ records: 25, storeLatencyMs: 300, newPathMs: newMs, oldPathMs: oldMs, ratio: Math.round(oldMs / newMs * 10) / 10 }));
    assert.ok(newMs < 5000, "new path " + newMs + " ms");
    assert.ok(oldMs > 4 * newMs, "old path " + oldMs + " ms vs new " + newMs + " ms");
  } finally { latencyMs = 0; audit.recordMany = recordMany; }
});

test("a 25-record batch with 300 ms store latency completes in a few seconds (measured)", async () => {
  latencyMs = 300;
  try {
    const t = Date.now();
    const r = await site.publishRaw(idsOf(3));
    const ms = Date.now() - t;
    console.log("TIMING " + JSON.stringify({ records: 25, storeLatencyMs: 300, publishRequestMs: ms }));
    assert.equal(r.status, 200); assert.deepEqual(r.body.audit, { ok: true, written: 25 });
    assert.ok(ms < 5000, ms + " ms");
  } finally { latencyMs = 0; }
});

test("audit-write failure: the publication stands, the rebuild still runs, the failure is reported and the run stops at 'audit'; a rerun sends nothing", async () => {
  failAuditWrite = true;
  const b0 = site.builds; calls.length = 0;
  let r;
  try { r = await session(6, {}); } finally { failAuditWrite = false; }
  assert.equal(r.report.stage, "audit", r.report.stage + ": " + r.report.stopped);
  assert.match(r.report.stopped, /published, verified and live.*audit log was not written.*simulated audit storage failure.*Do NOT publish again/);
  assert.deepEqual(r.writes, ["/api/stories/publish"]);
  assert.equal(count(calls, "putStories") + count(calls, "putStory"), 1, "one status write");
  assert.equal(site.builds - b0, 1, "the rebuild still ran");
  assert.ok(idsOf(6).every(id => site.stories().find(s => s.id === id).status === "published"));
  assert.ok(r.report.steps.some(s => s.step === "public-final"), "verified on the public site before stopping");
  const again = await session(6, { answer: "" });
  assert.equal(again.report.stopped, undefined); assert.deepEqual(again.writes, []);
});

test("rebuild failure: status and audit are written, the run stops at 'build'; a rerun never publishes again; after a build it completes", async () => {
  // batch 4 and 5 were published by the timing test through the route; use a fresh small batch
  const P = synthPayload(7, 3, 0); const FP = payloadFingerprint(P); const L = path.join(tmp, "import-7.jsonl");
  const imp = await importBatch(site, P, L); assert.equal(imp.result.stopped, null);
  const s7 = o => publishSession(site, Object.assign({ ledgerPath: PUBLEDGER, backupDir: fresh(), payload: P, fingerprint: FP, importLedgerPath: L, answer: run.BATCH_PUBLISH_PHRASE(3, "batch-07") }, o));
  const ev0 = auditEvents().length;
  site.hookStatus = 500;
  let r;
  try { r = await s7({}); } finally { site.hookStatus = 200; }
  assert.equal(r.report.stage, "build", r.report.stage + ": " + r.report.stopped);
  assert.deepEqual(r.writes, ["/api/stories/publish"]);
  assert.ok(imp.ids.every(id => site.stories().find(s => s.id === id).status === "published"), "the status write happened once");
  assert.equal(auditEvents().length - ev0, 3, "the audit was written");
  calls.length = 0;
  const stale = await s7({ answer: "" });
  assert.deepEqual(stale.writes, [], "a rerun does not publish again");
  assert.equal(count(calls, "putStories") + count(calls, "putStory"), 0);
  assert.equal(stale.report.stage, "public-final", "the site is not rebuilt yet: " + stale.report.stopped);
  await fetch(process.env.VERCEL_DEPLOY_HOOK_URL, { method: "POST" });   // the separate build-only recovery
  const done = await s7({ answer: "" });
  assert.equal(done.report.stopped, undefined, done.report.stage + ": " + done.report.stopped);
  assert.deepEqual(done.writes, []);
  assert.deepEqual(featured(), [405]);
});
