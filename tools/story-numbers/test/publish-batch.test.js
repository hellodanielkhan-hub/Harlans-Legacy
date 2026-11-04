/* publish-batch (batches 02+, Unnumbered Publishing Mode), end to end in isolation: a synthetic copy of the
   archive (fixture.js: 405 This Week, 404 a Draft, Batch 1 = Drafts 406–430), synthetic import batches 02 and
   03 imported through the importer's runBatch(), then published with lib/run.js publishBatch().
   Covers: the happy path, every refusal (nothing written), a lost answer + safe resume, and the transport's
   own guards. No real post ids, text or photos.   node --test tools/story-numbers/test/publish-batch.test.js */
"use strict";
delete process.env.HL_STORY_NUMBERS_DISPLAY;            // the policy decides (displayStoryNumbers: false), as in Production
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
const numbering = require(path.join(WT, "lib", "numbering.js"));
const { approvalFingerprint, IMPORT_SYSTEM } = require(path.join(WT, "tools", "facebook-import", "lib", "batch.js"));
const { payloadFingerprint } = require(path.join(WT, "tools", "facebook-import", "lib", "authorize.js"));
const { createRehearsalTransport } = require("../lib/transport.js");
const run = require("../lib/run.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hl-publish-batch-"));
let dirs = 0;
const fresh = () => path.join(tmp, "backup-" + (++dirs));            // a new, empty backup folder per run
const sha = b => crypto.createHash("sha256").update(b).digest("hex");

// A synthetic import payload in the importer's exact shape (build-batch-payload.js output).
function synthPayload(batch, specs) {
  const items = specs.map((n, i) => {
    const postId = "T" + batch + String(i + 1).padStart(2, "0");
    const images = [];
    for (let k = 1; k <= n; k++) {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(900 + k)]);
      const f = path.join(tmp, "src-" + postId + "-" + k + ".jpg"); fs.writeFileSync(f, bytes);
      images.push({ order: k, primary: k === 1, file: f, sha256: sha(bytes) });
    }
    const d = `2024-${String(1 + i).padStart(2, "0")}-${String(5 + batch).padStart(2, "0")}`;
    const record = { id: 431 + i, storyNumber: null, title: "Synthetic batch " + batch + " memory " + (i + 1), slug: "", status: "draft", featured: false, theme: "ordinary",
      publishedISO: d, dateLong: "", dateLabel: "", memoryDate: null, summary: "", description: null, ogDescription: null,
      lead: "Synthetic opening paragraph for " + postId + ".", body: ["Second synthetic paragraph.", "#HashtagLineInsideTheText", "Third synthetic paragraph."],
      people: [], places: [], objects: [], events: [], bookPart: null, keywords: [], echoStories: [], readingTime: 1, readerImages: [],
      importSource: { system: IMPORT_SYSTEM, postId, facebookUrl: null, facebookTimeChicago: null } };
    return { postId, photoMode: n ? "photos" : "none", images, record };
  });
  const P = { batch, items, counts: { posts: items.length, withPhotos: items.filter(i => i.images.length).length, withoutPhotos: items.filter(i => !i.images.length).length, photos: items.reduce((a, i) => a + i.images.length, 0) } };
  P.approvedFingerprints = Object.fromEntries(items.map(it => [it.postId, approvalFingerprint(it)]));
  return P;
}
const P2 = synthPayload(2, [2, 0, 1, 0]);              // 4 posts: 3 photos, 2 text-only
const P3 = synthPayload(3, [1, 0]);
const FP2 = payloadFingerprint(P2), FP3 = payloadFingerprint(P3);
const L2 = path.join(tmp, "import-batch-02.jsonl"), L3 = path.join(tmp, "import-batch-03.jsonl");
const PUBLEDGER = path.join(tmp, "publish-ledger.jsonl");
let ids2, ids3;
const phrase = (n, b) => run.BATCH_PUBLISH_PHRASE(n, b);
const session = o => publishSession(site, Object.assign({ ledgerPath: PUBLEDGER, backupDir: fresh(), payload: P2, fingerprint: FP2, importLedgerPath: L2, answer: phrase(4, "batch-02") }, o));
const featured = () => site.stories().filter(s => s.featured).map(s => s.id);

test.before(async () => {
  await site.start();
  const r2 = await importBatch(site, P2, L2); assert.equal(r2.result.stopped, null, JSON.stringify(r2.result.stopped)); ids2 = r2.ids;
  const r3 = await importBatch(site, P3, L3); assert.equal(r3.result.stopped, null, JSON.stringify(r3.result.stopped)); ids3 = r3.ids;
});
test.after(() => { site.close(); fx.removeRoot(root); fs.rmSync(tmp, { recursive: true, force: true }); });

test("setup: the imported batches are unnumbered, non-featured Drafts; This Week = 405; 404 a Draft", () => {
  assert.equal(numbering.DISPLAY_STORY_NUMBERS, false);
  for (const id of ids2.concat(ids3)) { const s = site.stories().find(x => x.id === id); assert.equal(s.status, "draft"); assert.equal(s.featured, false); assert.equal(s.storyNumber, null); }
  assert.deepEqual(featured(), [405]);
  assert.equal(site.stories().find(s => s.id === 404).status, "draft");
});

test("refusals: each stops before any write, with nothing changed and no build", async () => {
  const before = JSON.stringify(site.stories());
  const tampered = JSON.parse(JSON.stringify(P2)); tampered.items[1].record.title += " (edited)";
  const cases = [
    ["wrong approved fingerprint", { fingerprint: FP3 }, "batch-identity"],
    ["no fingerprint", { fingerprint: "" }, "batch-identity"],
    ["payload edited after approval", { payload: tampered, fingerprint: payloadFingerprint(tampered) }, "batch-identity"],
    ["another batch's import ledger", { importLedgerPath: L3 }, "batch-identity"],
    ["Batch 1 payload (has its own operation)", { payload: Object.assign({}, P2, { batch: 1 }) }, "batch-identity"],
    ["confirmation phrase not typed", { answer: "yes" }, "publish"],
    ["confirmation phrase for another batch", { answer: phrase(4, "batch-03") }, "publish"],
    ["a transport opened for another operation", { operation: "publish" }, "setup"],
  ];
  for (const [name, o, stage] of cases) {
    const r = await session(o);
    assert.equal(r.report.stage, stage, name + ": " + r.report.stopped);
    assert.deepEqual(r.writes, [], name + ": no write");
    assert.equal(r.builds, 0, name + ": no build");
  }
  // a non-empty backup folder is refused before anything is read into it
  const used = fresh(); fs.mkdirSync(used); fs.writeFileSync(path.join(used, "x"), "x");
  assert.match((await session({ backupDir: used })).report.stopped, /not empty/);
  assert.equal(JSON.stringify(site.stories()), before, "nothing changed on the site");
});

test("refusals on the live records: edited text, a duplicate Draft, a featured or published target, mixed state", async () => {
  const orig = site.stories();
  const mutate = (fn, name, stage, re) => async () => {
    const list = JSON.parse(JSON.stringify(orig)); fn(list); site.writeStories(list);
    const r = await session({});
    site.writeStories(orig);
    assert.equal(r.report.stage, stage, name + ": " + r.report.stopped);
    if (re) assert.match(r.report.stopped, re, name);
    assert.deepEqual(r.writes, [], name); assert.equal(r.builds, 0, name);
  };
  await mutate(l => { l.find(s => s.id === ids2[0]).body[0] = "changed after the import"; }, "text edited after import", "content", /body/)();
  await mutate(l => { l.find(s => s.id === ids2[2]).publishedISO = "2020-01-01"; }, "date edited after import", "content", /publishedISO/)();
  await mutate(l => { const c = Object.assign({}, l.find(s => s.id === ids2[1]), { id: 999 }); l.push(c); }, "a second record carries the same post", "batch-identity", /2 records carry/)();
  await mutate(l => { l.find(s => s.id === ids2[1]).featured = true; }, "a target is featured", "preconditions")();
  await mutate(l => { l.find(s => s.id === ids2[1]).status = "published"; }, "one target already published (mixed)", "batch-identity", /not all Drafts/)();
  await mutate(l => { l.find(s => s.id === ids2[3]).storyNumber = 448; }, "a target carries a Story Number", "batch-identity", /Story Number/)();
  await mutate(l => { l.find(s => s.id === 404).featured = true; }, "record 404 is featured", "preconditions", /404|This Week/)();
  assert.equal(JSON.stringify(site.stories()), JSON.stringify(orig));
});

test("a stored photo that differs from the approved one stops the run", async () => {
  const g = site.galleries()["story-" + ids2[0]];
  const f = path.join(root, "story-photos", "story-" + ids2[0], g.items[1].file), keep = fs.readFileSync(f);
  fs.writeFileSync(f, Buffer.concat([keep, Buffer.from("x")]));
  const r = await session({});
  fs.writeFileSync(f, keep);
  assert.equal(r.report.stage, "photos", r.report.stopped);
  assert.match(r.report.stopped, /photo 2/);
  assert.deepEqual(r.writes, []);
});

test("the transport: only approved ids, once; never 303–305, 388–430; no write before approval", async () => {
  const t = createRehearsalTransport({ base: site.API, token: site.token, operation: "publish-batch" });
  await assert.rejects(t.transport("POST", "/api/stories/publish", { ids: ids2 }), /no batch ids were approved/);
  for (const bad of [[404], [405], [406], [303], [ids2[0], 430]]) assert.throws(() => t.approvePublish(bad), /never published by the batch publisher/);
  t.approvePublish(ids2.slice());
  assert.throws(() => t.approvePublish(ids3.slice()), /already approved/);
  await assert.rejects(t.transport("POST", "/api/stories/publish", { ids: ids3 }), /only the ids approved/);
  await assert.rejects(t.transport("POST", "/api/stories/publish", { ids: ids2, extra: 1 }), /only the ids approved/);
  await assert.rejects(t.transport("PUT", "/api/stories/" + ids2[0], {}), /never sent/);
  const p1 = createRehearsalTransport({ base: site.API, token: site.token, operation: "publish" });
  assert.throws(() => p1.approvePublish(ids2), /only for the publish-batch operation/);
  t.close(); p1.close();
  assert.deepEqual(site.stories().filter(s => ids2.includes(s.id)).map(s => s.status), ["draft", "draft", "draft", "draft"]);
});

test("lost answer: the publish is applied but its answer is lost; the rerun verifies and sends nothing", async () => {
  const before = site.stories();
  const lost = await session({ wrap: real => Object.assign({}, real, { transport: async (m, p, b) => { const r = await real.transport(m, p, b); if (m === "POST") throw new Error("simulated lost response"); return r; } }) });
  assert.equal(lost.report.stage, "error"); assert.match(lost.report.stopped, /lost response/);
  assert.deepEqual(lost.writes, ["/api/stories/publish"]); assert.equal(lost.builds, 1, "the server's one rebuild");
  assert.ok(site.stories().filter(s => ids2.includes(s.id)).every(s => s.status === "published"));
  const again = await session({});
  assert.equal(again.report.stopped, undefined, again.report.stage + ": " + again.report.stopped);
  assert.deepEqual(again.writes, [], "the rerun sends nothing"); assert.equal(again.builds, 0);
  assert.deepEqual(again.report.steps.map(s => s.step), ["deployed-map", "backup", "batch-identity", "content", "photos", "publish-already-applied", "public-final"]);
  // only the 4 records' status (and edit bookkeeping) changed
  const after = site.stories();
  for (const b of before) { const a = after.find(x => x.id === b.id);
    const changed = Object.keys(Object.assign({}, a, b)).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    assert.deepEqual(changed.filter(k => !["status", "lastEditedAt", "lastEditedBy"].includes(k)), [], "record " + b.id);
    if (!ids2.includes(b.id)) assert.deepEqual(changed, [], "record " + b.id + " untouched"); }
  assert.deepEqual(featured(), [405]); assert.equal(after.find(s => s.id === 404).status, "draft");
});

test("batch 03, the normal path: one write, one build, published unnumbered, everything else unchanged", async () => {
  // as on Production since 2026-11-04: the owner has published record 404 in the Editorial Workspace
  const owner = site.stories(); owner.find(s => s.id === 404).status = "published"; site.writeStories(owner);
  await fetch(process.env.VERCEL_DEPLOY_HOOK_URL, { method: "POST" });      // the rebuild the Editorial Workspace triggers
  const before = site.stories(), gBefore = JSON.stringify(site.galleries());
  const r = await session({ payload: P3, fingerprint: FP3, importLedgerPath: L3, answer: phrase(2, "batch-03") });
  assert.equal(r.report.stopped, undefined, r.report.stage + ": " + r.report.stopped);
  assert.deepEqual(r.report.steps.map(s => s.step), ["deployed-map", "backup", "batch-identity", "content", "photos", "public-unnumbered", "publish", "publish-verified", "public-final"]);
  assert.deepEqual(r.writes, ["/api/stories/publish"]); assert.equal(r.builds, 1); assert.equal(r.asked.length, 1);
  assert.match(r.asked[0], /PUBLISH 2 STORIES OF batch-03/);
  const after = site.stories();
  for (const id of ids3) assert.equal(after.find(s => s.id === id).status, "published");
  for (const s of before.filter(x => !ids3.includes(x.id))) assert.equal(JSON.stringify(after.find(x => x.id === s.id)), JSON.stringify(s), "record " + s.id);
  assert.equal(JSON.stringify(site.galleries()), gBefore, "photos, order and Primary unchanged");
  assert.deepEqual(featured(), [405]);
  assert.equal(after.find(s => s.id === 404).status, "published", "the owner's publication of 404 is kept, untouched");
  for (const id of Array.from({ length: 25 }, (_, i) => 406 + i)) assert.equal(after.find(s => s.id === id).status, "draft", "Batch 1 untouched");
  // the public pages: the new stories exist and no page shows a Story Number
  const s3 = after.find(s => s.id === ids3[0]);
  const html = fs.readFileSync(path.join(root, "story", s3.id + "-" + s3.slug + ".html"), "utf8");
  assert.match(html, new RegExp('data-record-id="' + s3.id + '" data-story-id=""'));
  assert.ok(!/No\.(&nbsp;| )(<b>)?\d|Story No\./.test(html), "no number on the new page");
  assert.ok(!/"storyNumber": \d/.test(fs.readFileSync(path.join(root, "stories.js"), "utf8")));
  // a completed batch reruns as "already applied", and the publish ledger records every step
  const again = await session({ payload: P3, fingerprint: FP3, importLedgerPath: L3, answer: "" });
  assert.equal(again.report.stopped, undefined); assert.deepEqual(again.writes, []);
  const led = fs.readFileSync(PUBLEDGER, "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.ok(led.some(e => e.operation === "publish-batch-03" && e.step === "publish-sent" && JSON.stringify(e.ids) === JSON.stringify(ids3)));
  assert.ok(!JSON.stringify(led).includes(site.token), "the token is never in the ledger");
});
