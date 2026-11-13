/* Story Number API rules, the numbering release and the Batch 1 publication (two separate operations), end to
   end and in isolation: this checkout's real api/[...path].js (file store in a throwaway copy) on 127.0.0.1, a
   local deploy hook that runs the real build.js, and a static server standing in for the public site.
   Includes lost responses, reruns and refusals.
     node --test tools/story-numbers/test/release.test.js */
"use strict";
// These tests exercise the LEGACY Story Number rules and release themselves, which are frozen in production
// (policy.storyNumbersFrozen; lib/numbering.js LEGACY_FROZEN). Re-enable them for this file only.
process.env.HL_STORY_NUMBERS_LEGACY = "active";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
// These tests cover the mode in which Story Numbers ARE displayed (unnumbered.test.js covers the paused mode).
process.env.HL_STORY_NUMBERS_DISPLAY = "on";
const fx = require("./fixture.js");

fx.cleanEnv();
const { root, payload, registryDir } = fx.makeRoot();
const ADMIN = crypto.randomBytes(16).toString("hex"), MOD = crypto.randomBytes(16).toString("hex");
process.env.HL_DATA_DIR = root;
process.env.ADMIN_TOKEN = ADMIN;
process.env.HARLAN_MODERATORS = JSON.stringify({ [MOD]: { id: "mod1", name: "Test Moderator" } });

const handler = require(path.join(fx.WT, "api", "[...path].js"));
const numbering = require(path.join(fx.WT, "lib", "numbering.js"));
const verify = require("../lib/verify.js");
const run = require("../lib/run.js");
const { createRehearsalTransport, createLiveTransport } = require("../lib/transport.js");
const { BATCH_1_IDS } = require("../lib/batch1.js");
const registry = require("../lib/private-registry.js").load(registryDir, { expectHashes: false });
const { payloadFingerprint } = require(path.join(fx.WT, "tools", "facebook-import", "lib", "authorize.js"));
const PAYLOAD_FP = payloadFingerprint(payload);

let builds = 0;
const listen = srv => new Promise(r => srv.listen(0, "127.0.0.1", () => r("http://127.0.0.1:" + srv.address().port)));
const api = http.createServer((req, res) => handler(req, res));
const hook = http.createServer((req, res) => {             // the "Vercel deploy hook": a real build of the throwaway root
  builds++;
  execFileSync(process.execPath, [path.join(fx.WT, "build.js")], { env: Object.assign({}, process.env, { HL_DATA_DIR: root }), stdio: "ignore" });
  res.end("{}");
});
const site = http.createServer((req, res) => {            // the "public site": files from the throwaway root
  const rel = decodeURIComponent(String(req.url).split("?")[0]).replace(/^\/+/, "") || "index.html";
  const f = path.resolve(root, rel);
  if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end("not found"); }
  res.end(fs.readFileSync(f));
});
let API, SITE, backups = 0;
test.before(async () => { API = await listen(api); SITE = await listen(site); process.env.VERCEL_DEPLOY_HOOK_URL = (await listen(hook)) + "/hook"; });
test.after(() => { api.close(); hook.close(); site.close(); fx.removeRoot(root); for (let i = 1; i <= backups; i++) fs.rmSync(root + "-backup-" + i, { recursive: true, force: true }); });

async function call(method, p, body, token) {
  const h = { "Content-Type": "application/json" };
  if (token !== null) h["x-admin-token"] = token === undefined ? ADMIN : token;
  const r = await fetch(API + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const stories = async () => (await call("GET", "/api/stories")).body;
const one = async id => (await call("GET", "/api/stories/" + id)).body;
const writeStories = list => fs.writeFileSync(path.join(root, "data", "stories.json"), JSON.stringify(list, null, 2) + "\n");
const answers = q => (/PUBLISH/.test(q) ? run.PUBLISH_PHRASE : run.RELEASE_PHRASE(46));
// one operation session, as the CLI runs it; `lose` drops the answer to that write (the server still handles it)
async function session(operation, opts) {
  opts = opts || {};
  const fetchFn = opts.lose ? async (url, init) => { const r = await fetch(url, init); if (init && init.method === "POST" && String(url).endsWith(opts.lose)) throw new Error("simulated lost response"); return r; } : undefined;
  const live = createRehearsalTransport({ base: API, token: ADMIN, operation, fetch: fetchFn });
  const asked = [], lines = [];
  const o = { live, io: { isTTY: true, print: () => {}, ask: async q => { asked.push(q); return opts.answer !== undefined ? opts.answer : answers(q); } },
    ledger: { append: e => lines.push(e) }, backupDir: root + "-backup-" + (++backups), payload, registry, payloadFingerprint: PAYLOAD_FP,
    fetch: globalThis.fetch, origin: SITE, publicTries: 3, publicWaitMs: 300 };
  const b0 = builds;
  const report = operation === "release" ? await run.releaseNumbers(o) : await run.publishBatch1(o);
  live.close();
  return { report, asked, lines, builds: builds - b0, writes: live.requests().filter(q => q.method !== "GET").map(q => q.path), steps: report.steps.map(s => s.step) };
}

let original, afterRelease;

test("API before the release: numbers are validated on every save", async () => {
  original = await stories();
  const s405 = await one(405);
  assert.equal(s405.storyNumber, undefined);
  assert.equal((await call("PUT", "/api/stories/405", Object.assign({}, s405, { storyNumber: 6 }))).status, 400, "another record's approved number");
  assert.equal((await call("PUT", "/api/stories/405", Object.assign({}, s405, { storyNumber: 405 }))).body.code, "story_number_invalid", "its own record id (retired)");
  const d = await one(406);
  const pub = await call("PUT", "/api/stories/406", Object.assign({}, d, { status: "published" }));
  assert.equal(pub.status, 400); assert.match(pub.body.error, /required before a memory is published/);
  assert.deepEqual(await stories(), original, "refused saves wrote nothing");
});

test("release route: admin token only, exact map fingerprint", async () => {
  const fp = numbering.assignmentsFingerprint();
  assert.equal((await call("POST", "/api/story-numbers/release", { fingerprint: fp }, MOD)).status, 403, "moderators cannot release");
  assert.equal((await call("POST", "/api/story-numbers/release", { fingerprint: "0".repeat(64) })).status, 409, "a different map is refused");
  const info = await call("GET", "/api/story-numbers");
  assert.equal(info.body.assignmentsFingerprint, fp); assert.equal(info.body.pendingRelease.writes.length, 46); assert.deepEqual(info.body.pendingRelease.problems, []);
  assert.deepEqual(await stories(), original, "refused releases wrote nothing");
});

test("publishing first is refused: the release must be complete (nothing written, stop recorded)", async () => {
  const r = await session("publish");
  assert.equal(r.report.stage, "release-required");
  assert.deepEqual(r.writes, []); assert.equal(r.builds, 0); assert.equal(r.asked.length, 0);
  assert.ok(r.lines.some(e => e.step === "stopped" && e.stage === "release-required"));
  assert.deepEqual(await stories(), original);
});

test("release-numbers: backup, identity, photos, one write of the two fields, verified; nothing published", async () => {
  const r = await session("release");
  assert.equal(r.report.stopped, undefined, r.report.stage + ": " + r.report.stopped);
  assert.deepEqual(r.steps, ["deployed-map", "backup", "batch-1-identity", "photos", "release", "release-verified"]);
  assert.deepEqual(r.writes, ["/api/story-numbers/release"]); assert.equal(r.builds, 1); assert.equal(r.asked.length, 1);
  const ph = r.report.steps.find(s => s.step === "photos"); assert.equal(ph.photos, 23); assert.equal(ph.textOnly, 4);
  afterRelease = await stories();
  assert.deepEqual(verify.releaseProblems(original, afterRelease), []);
  for (const s of afterRelease) {
    const a = numbering.assignments().find(x => x.id === s.id);
    assert.equal(s.storyNumber, a.storyNumber); assert.equal(s.originalBlogNumber, a.originalBlogNumber);
    assert.equal(s.status, original.find(x => x.id === s.id).status, "status unchanged for " + s.id);
  }
  assert.deepEqual(afterRelease.filter(s => s.featured).map(s => s.id), [405]);
  assert.equal(afterRelease.find(s => s.id === 404).status, "draft");
  assert.equal(require(path.join(fx.WT, "tools", "facebook-import", "lib", "snapshot.js")).verifyBackup(root + "-backup-" + backups).ok, true);
});

test("release rerun: nothing to write, no build", async () => {
  const r = await session("release");
  assert.deepEqual(r.steps, ["deployed-map", "backup", "batch-1-identity", "photos", "release-already-applied"]);
  assert.deepEqual(r.writes, []); assert.equal(r.builds, 0); assert.equal(r.asked.length, 0);
});

test("release with a lost answer: recorded as stopped; the rerun finds it applied and writes nothing", async () => {
  writeStories(original); fs.rmSync(path.join(root, "data", "story_numbers.json"), { force: true });   // back to before the release
  const lost = await session("release", { lose: "/api/story-numbers/release" });
  assert.equal(lost.report.stage, "error"); assert.match(lost.report.stopped, /simulated lost response/);
  assert.ok(lost.lines.some(e => e.step === "release-sent") && lost.lines.some(e => e.step === "stopped"));
  const again = await session("release");
  assert.equal(again.report.stopped, undefined); assert.ok(again.steps.includes("release-already-applied")); assert.deepEqual(again.writes, []);
  assert.deepEqual(verify.releaseProblems(original, await stories()), []);
});

test("a wrong confirmation phrase writes nothing", async () => {
  writeStories(original);
  const r = await session("release", { answer: "assign them" });
  assert.equal(r.report.stage, "release"); assert.match(r.report.stopped, /confirmation phrase/);
  assert.deepEqual(r.writes, []); assert.deepEqual(await stories(), original);
  await session("release");                                     // back to the released state
});

test("publish-batch-1: exactly 406–430, only their status, after the public site shows the numbers", async () => {
  const pre = await stories();
  const r = await session("publish");
  assert.equal(r.report.stopped, undefined, r.report.stage + ": " + r.report.stopped);
  assert.deepEqual(r.steps, ["deployed-map", "backup", "batch-1-identity", "photos", "public-numbers", "publish", "publish-verified", "public-final"]);
  assert.deepEqual(r.writes, ["/api/stories/publish"]); assert.equal(r.builds, 1); assert.equal(r.asked.length, 1);
  const post = await stories();
  assert.deepEqual(verify.publishProblems(pre, post), []);
  for (const s of post) assert.equal(s.status, BATCH_1_IDS.includes(s.id) ? "published" : pre.find(x => x.id === s.id).status);
  assert.deepEqual(post.filter(s => s.featured).map(s => s.id), [405]);
  assert.equal(post.find(s => s.id === 404).status, "draft");
  const v = await run.verifyPublic(globalThis.fetch, SITE, run.expectedPublic(post));
  assert.deepEqual(v.problems, []); assert.equal(v.checked, 45);
  for (const s of post.filter(x => x.status === "published")) assert.ok(fs.existsSync(path.join(root, "story", s.id + "-" + s.slug + ".html")), "URL of " + s.id);
});

test("publish with a lost answer: recorded; the rerun detects it and verifies instead of publishing again", async () => {
  const pre = (await stories()).map(s => BATCH_1_IDS.includes(s.id) ? Object.assign({}, s, { status: "draft" }) : s);
  writeStories(pre);                                            // back to before the publication
  const lost = await session("publish", { lose: "/api/stories/publish" });
  assert.equal(lost.report.stage, "error"); assert.equal(lost.builds, 1, "the server did publish and rebuild");
  assert.ok(lost.lines.some(e => e.step === "publish-sent") && lost.lines.some(e => e.step === "stopped"));
  const again = await session("publish");
  assert.equal(again.report.stopped, undefined, again.report.stage + ": " + again.report.stopped);
  assert.deepEqual(again.steps, ["deployed-map", "backup", "batch-1-identity", "photos", "publish-already-applied", "public-final"]);
  assert.deepEqual(again.writes, []); assert.equal(again.builds, 0);
});

test("after completion: numbers permanent, issued numbers never reused, the importer rule for historical numbers", async () => {
  const info = (await call("GET", "/api/story-numbers")).body;
  assert.equal(info.pendingRelease.writes.length, 0); assert.equal(info.nextNewStoryNumber, 448);
  assert.equal((await call("POST", "/api/stories/publish", { ids: BATCH_1_IDS.slice() })).status, 409, "already published: refused");
  const s = await one(405);
  assert.equal((await call("PUT", "/api/stories/405", Object.assign({}, s, { storyNumber: 448 }))).status, 400, "cannot change");
  assert.equal((await call("PUT", "/api/stories/405", Object.assign({}, s, { storyNumber: null }))).status, 400, "cannot clear");
  const kept = await call("PUT", "/api/stories/405", Object.assign({}, s, { title: s.title + " (edited)", storyNumber: undefined, originalBlogNumber: undefined }));
  assert.equal(kept.status, 200); assert.equal(kept.body.story.storyNumber, 447); assert.equal(kept.body.story.originalBlogNumber, 398); assert.equal(kept.body.story.featured, true);
  const c = await call("POST", "/api/stories", { title: "New weekly post", status: "draft", storyNumber: 448 });
  assert.equal(c.status, 201); assert.equal(c.body.story.id, 431, "record ids keep counting on their own");
  assert.equal((await call("POST", "/api/stories", { title: "dup", status: "draft", storyNumber: 448 })).status, 400);
  assert.equal((await call("DELETE", "/api/stories/431")).status, 200);
  assert.match((await call("POST", "/api/stories", { title: "reuse", status: "draft", storyNumber: 448 })).body.error, /issued before/);
  assert.equal((await call("GET", "/api/story-numbers")).body.nextNewStoryNumber, 449);
  assert.equal((await call("POST", "/api/stories", { title: "retired", status: "draft", storyNumber: 430 })).status, 400);
  // a historical number nobody holds: refused for an editor memory, accepted for an imported one
  assert.match((await call("POST", "/api/stories", { title: "editor", status: "draft", storyNumber: 1 })).body.error, /historical weekly post/);
  const im = await call("POST", "/api/stories", { title: "imported", status: "draft", storyNumber: 1, importSource: { system: numbering.IMPORT_SYSTEM, postId: "S001" } });
  assert.equal(im.status, 201); assert.equal(im.body.story.storyNumber, 1);
});

test("publish route: refuses the whole list on any problem", async () => {
  const d = await call("POST", "/api/stories", { title: "Unnumbered draft", status: "draft" });
  const r = await call("POST", "/api/stories/publish", { ids: [d.body.story.id, 404] });
  assert.equal(r.status, 409); assert.ok(r.body.problems.some(p => /no Story Number/.test(p)));
  assert.equal((await one(404)).status, "draft");
  assert.equal((await call("POST", "/api/stories/publish", { ids: [404] }, MOD)).status, 403, "moderators cannot batch-publish");
});

test("transport: one operation per session, only its exact write; fixed destination; token never in errors", async () => {
  const rel = createRehearsalTransport({ base: API, token: ADMIN, operation: "release" });
  const pub = createRehearsalTransport({ base: API, token: ADMIN, operation: "publish" });
  const ro = createRehearsalTransport({ base: API, token: ADMIN });
  await assert.rejects(rel.transport("POST", "/api/stories/publish", { ids: BATCH_1_IDS.slice() }), /may not publish/);
  await assert.rejects(pub.transport("POST", "/api/story-numbers/release", { fingerprint: numbering.assignmentsFingerprint() }), /may not run the numbering release/);
  await assert.rejects(ro.transport("POST", "/api/story-numbers/release", { fingerprint: numbering.assignmentsFingerprint() }), /may not run/);
  await assert.rejects(rel.transport("POST", "/api/story-numbers/release", { fingerprint: "x" }), /exactly this checkout's map/);
  await assert.rejects(pub.transport("POST", "/api/stories/publish", { ids: [404] }), /only the approved Batch 1/);
  await assert.rejects(pub.transport("POST", "/api/stories/publish", { ids: BATCH_1_IDS.concat([404]) }), /only the approved Batch 1/);
  for (const t of [rel, pub]) {
    await assert.rejects(t.transport("PUT", "/api/stories/405", {}), /PUT is never sent/);
    await assert.rejects(t.transport("DELETE", "/api/stories/405"), /DELETE is never sent/);
    await assert.rejects(t.transport("POST", "/api/stories", {}), /not allowed/);
    await assert.rejects(t.transport("POST", "/api/build", {}), /not allowed/);
    await assert.rejects(t.transport("GET", "/api/narration"), /not a read this tool needs/);
  }
  assert.throws(() => createRehearsalTransport({ base: API, token: ADMIN, operation: "both" }), /unknown operation/);
  assert.throws(() => createLiveTransport({ base: "https://harlanslegacy.com", token: "t" }), /destination refused/);
  assert.throws(() => createLiveTransport({ base: "https://www.harlanslegacy.com/", token: "t" }), /destination refused/);
  assert.throws(() => createRehearsalTransport({ base: "https://example.com", token: "t" }), /loopback only/);
  const bad = createRehearsalTransport({ base: API, token: ADMIN, fetch: async () => { throw new Error("boom x-admin-token: " + ADMIN); } });
  await assert.rejects(bad.transport("GET", "/api/stories"), e => !e.message.includes(ADMIN));
  rel.close(); await assert.rejects(rel.transport("GET", "/api/stories"), /closed/);
});

test("a failure before any write (backup folder not empty) is recorded and writes nothing", async () => {
  const dir = root + "-backup-" + (++backups); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "x"), "x");
  const live = createRehearsalTransport({ base: API, token: ADMIN, operation: "release" });
  const lines = [];
  const r = await run.releaseNumbers({ live, io: { print() {}, ask: async () => "" }, ledger: { append: e => lines.push(e) }, backupDir: dir, payload, registry, payloadFingerprint: PAYLOAD_FP });
  assert.equal(r.stage, "error"); assert.match(r.stopped, /not empty/);
  assert.ok(lines.some(e => e.step === "stopped" && e.stage === "error"));
  assert.deepEqual(live.requests().filter(q => q.method !== "GET"), []);
});

test("Supabase writes: the release and the publication upsert only the rows they change", async () => {
  const store = require(path.join(fx.WT, "lib", "store.js"));
  const saved = {}, names = ["getStories", "putStories", "getDoc", "putDoc"];
  for (const n of names) saved[n] = store[n];
  const wasSupabase = store.USE_SUPABASE;
  const other = { id: 999, title: "edited by someone else meanwhile", status: "draft", featured: false };
  let rows = original.concat([other]), written = [];
  store.getStories = async () => JSON.parse(JSON.stringify(rows));
  store.putStories = async list => { written.push(list.map(s => s.id)); return list; };
  store.getDoc = async (k, fb) => fb; store.putDoc = async (k, o) => o;
  store.USE_SUPABASE = true;
  try {
    const r = await call("POST", "/api/story-numbers/release", { fingerprint: numbering.assignmentsFingerprint(), deferRebuild: true });
    assert.equal(r.status, 200);
    assert.deepEqual(written[0].sort((a, b) => a - b), numbering.assignments().map(a => a.id).sort((a, b) => a - b), "exactly the 46 mapped rows");
    assert.ok(!written[0].includes(999), "an unrelated record is never rewritten");
    rows = afterRelease.map(s => BATCH_1_IDS.includes(s.id) ? Object.assign({}, s, { status: "draft" }) : s).concat([other]); written = [];
    const p = await call("POST", "/api/stories/publish", { ids: BATCH_1_IDS.slice(), deferRebuild: true });
    assert.equal(p.status, 200);
    assert.deepEqual(written[0].sort((a, b) => a - b), BATCH_1_IDS.slice(), "exactly the 25 published rows");
  } finally { for (const n of names) store[n] = saved[n]; store.USE_SUPABASE = wasSupabase; }
});

test("a rebuild that is not triggered stops the session after the write is verified", async () => {
  writeStories(original); fs.rmSync(path.join(root, "data", "story_numbers.json"), { force: true });
  const hookUrl = process.env.VERCEL_DEPLOY_HOOK_URL;
  process.env.VERCEL_DEPLOY_HOOK_URL = "http://127.0.0.1:9/unreachable-hook";
  try {
    const r = await session("release");
    assert.equal(r.report.stage, "build"); assert.match(r.report.stopped, /did not trigger the site rebuild/);
    assert.ok(r.steps.includes("release-verified"), "the data was verified before the stop");
    assert.deepEqual(verify.releaseProblems(original, await stories()), []);
    assert.ok(r.lines.some(e => e.step === "stopped" && e.stage === "build"));
  } finally { process.env.VERCEL_DEPLOY_HOOK_URL = hookUrl; }
});
