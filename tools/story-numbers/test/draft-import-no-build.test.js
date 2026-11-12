/* Drafts-only import without the closing public rebuild (closingBuild: false), then the safeguarded publish sends
   the ONE rebuild. Isolated file-mode site, synthetic data.
   node --test tools/story-numbers/test/draft-import-no-build.test.js */
"use strict";
delete process.env.HL_STORY_NUMBERS_DISPLAY;
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const fx = require("./fixture.js");
const { startSite, importBatch, publishSession, WT } = require("./batch-site.js");
fx.cleanEnv();
const { root } = fx.makeRoot();
const site = startSite(root);
const { approvalFingerprint, IMPORT_SYSTEM } = require(path.join(WT, "tools", "facebook-import", "lib", "batch.js"));
const { payloadFingerprint } = require(path.join(WT, "tools", "facebook-import", "lib", "authorize.js"));
const { Ledger } = require(path.join(WT, "tools", "facebook-import", "lib", "ledger.js"));
const run = require("../lib/run.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hl-no-draft-build-"));
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
function synthPayload(batch, specs) {
  const items = specs.map((n, i) => {
    const postId = "N" + batch + String(i + 1).padStart(2, "0"), images = [];
    for (let k = 1; k <= n; k++) { const b = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(800 + k)]); const f = path.join(tmp, postId + "-" + k + ".jpg"); fs.writeFileSync(f, b); images.push({ order: k, primary: k === 1, file: f, sha256: sha(b) }); }
    const record = { id: 431 + i, storyNumber: null, title: "No-build batch " + batch + " memory " + (i + 1), slug: "", status: "draft", featured: false, theme: "ordinary",
      publishedISO: "2024-0" + (1 + i) + "-1" + batch, dateLong: "", dateLabel: "", memoryDate: null, summary: "", description: null, ogDescription: null,
      lead: "Opening " + postId + ".", body: ["Second paragraph " + postId + "."], people: [], places: [], objects: [], events: [], bookPart: null, keywords: [], echoStories: [], readingTime: 1, readerImages: [],
      importSource: { system: IMPORT_SYSTEM, postId, facebookUrl: null, facebookTimeChicago: null } };
    return { postId, photoMode: n ? "photos" : "none", images, record };
  });
  const P = { batch, items, counts: { posts: items.length, withPhotos: items.filter(i => i.images.length).length, withoutPhotos: items.filter(i => !i.images.length).length, photos: items.reduce((a, i) => a + i.images.length, 0) } };
  P.approvedFingerprints = Object.fromEntries(items.map(it => [it.postId, approvalFingerprint(it)]));
  return P;
}
const P = synthPayload(7, [2, 0, 1]), L = path.join(tmp, "import-07.jsonl");
let imp, publicBefore, buildsBefore;
const publicFiles = () => { const out = {}; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (!["node_modules", ".git", "data", "story-photos"].includes(e.name)) walk(f); } else if (/\.(html|js|json)$/.test(e.name)) out[path.relative(root, f)] = sha(fs.readFileSync(f)); } }; walk(root); return out; };

test.before(async () => {
  await site.start();
  publicBefore = publicFiles(); buildsBefore = site.builds;
  imp = await importBatch(site, P, L, { closingBuild: false });
});
test.after(() => { site.close(); fx.removeRoot(root); fs.rmSync(tmp, { recursive: true, force: true }); });

test("Drafts-only import completes, verified, WITHOUT a public rebuild", () => {
  assert.equal(imp.result.stopped, null, JSON.stringify(imp.result.stopped));
  assert.equal(imp.result.posts.filter(p => p.result === "verified").length, 3);
  assert.equal(site.builds, buildsBefore, "no deploy-hook call during the import");
  assert.equal(imp.result.finalBuild.sent, false);
  const done = new Ledger(L).read().filter(e => e.step === "batch-built");
  assert.equal(done.length, 1); assert.equal(done[0].build, "not sent (Drafts only)");
});
test("nothing public changed: the built site is byte-identical (Drafts are not on the public site)", () => {
  assert.deepEqual(publicFiles(), publicBefore);
});
test("Drafts and their photos are readable through the admin API without any build (Editorial Workspace path)", async () => {
  for (const id of imp.ids) {
    const r = await fetch(site.API + "/api/stories/" + id, { headers: { "x-admin-token": site.token } });
    assert.equal(r.status, 200); const s = await r.json(); assert.equal(s.status, "draft");
  }
  const g = site.galleries();
  assert.equal(g["story-" + imp.ids[0]].items.length, 2);
  assert.equal(g["story-" + imp.ids[2]].items.length, 1);
});
test("re-running the completed batch (same ids, same ledger, as in Production) sends nothing: no Draft, photo or build", async () => {
  const { runBatch } = require(path.join(WT, "tools", "facebook-import", "lib", "batch.js"));
  const { createRehearsalTransport } = require(path.join(WT, "tools", "facebook-import", "lib", "transport.js"));
  const live = createRehearsalTransport({ base: site.API, token: site.token });
  const all = await live.transport("GET", "/api/stories");
  const items = P.items.map((it, k) => Object.assign({}, it, { record: Object.assign({}, it.record, { id: imp.ids[k] }) })); live.allow(imp.ids);
  const before = site.stories().length, b0 = site.builds, n0 = live.requests().length;
  const r = await runBatch({ items, transport: live.transport, ledger: new Ledger(L), batchId: "batch-07", approved: P.approvedFingerprints, defer: true, snapshot: { takenAt: new Date().toISOString(), memories: all.body.map(s => ({ id: s.id, status: s.status, featured: !!s.featured, importSource: s.importSource || null })) }, storedPhotoDigest: live.storedPhotoDigest, closingBuild: false });
  const writes = live.requests().slice(n0).filter(q => q.method !== "GET"); live.close();
  assert.equal(r.stopped, null); assert.equal(site.stories().length, before); assert.equal(site.builds, b0); assert.deepEqual(writes, []);
  assert.equal(new Ledger(L).read().filter(e => e.step === "batch-built").length, 1);
});
test("the safeguarded publish then sends the ONE public rebuild and passes every public check", async () => {
  const r = await publishSession(site, { ledgerPath: path.join(tmp, "pub.jsonl"), backupDir: path.join(tmp, "bk"), payload: P, fingerprint: payloadFingerprint(P), importLedgerPath: L, answer: run.BATCH_PUBLISH_PHRASE(3, "batch-07") });
  assert.equal(r.report.stopped, undefined, r.report.stage + ": " + r.report.stopped);
  assert.deepEqual(r.writes, ["/api/stories/publish"]);
  assert.equal(r.builds, 1, "exactly one rebuild for the whole wave");
  assert.ok(r.report.steps.some(s => s.step === "public-final"));
  for (const id of imp.ids) assert.equal(site.stories().find(s => s.id === id).status, "published");
});
test("default behaviour is unchanged: without closingBuild:false the import still sends its one closing build", async () => {
  const Q = synthPayload(8, [1]), b0 = site.builds;
  const r = await importBatch(site, Q, path.join(tmp, "import-08.jsonl"));
  assert.equal(r.result.stopped, null); assert.equal(r.result.finalBuild.sent, true); assert.equal(site.builds, b0 + 1);
});
test("a stopped Drafts-only import never records completion", async () => {
  const Q = synthPayload(9, [1, 0]), LQ = path.join(tmp, "import-09.jsonl");
  const { runBatch } = require(path.join(WT, "tools", "facebook-import", "lib", "batch.js"));
  const { createRehearsalTransport } = require(path.join(WT, "tools", "facebook-import", "lib", "transport.js"));
  const live = createRehearsalTransport({ base: site.API, token: site.token });
  const all = await live.transport("GET", "/api/stories"); let next = Math.max(...all.body.map(s => s.id)) + 1;
  const items = Q.items.map(it => Object.assign({}, it, { record: Object.assign({}, it.record, { id: next++ }) })); live.allow(items.map(it => it.record.id));
  let n = 0; const failing = async (m, p, b, h) => { if (m === "POST" && /^\/api\/story-photos\//.test(p) && ++n === 1) throw new Error("simulated network failure"); return live.transport(m, p, b, h); };
  const r = await runBatch({ items, transport: failing, ledger: new Ledger(LQ), batchId: "batch-09", approved: Q.approvedFingerprints, defer: true, snapshot: { takenAt: new Date().toISOString(), memories: all.body.map(s => ({ id: s.id, status: s.status, featured: !!s.featured, importSource: s.importSource || null })) }, storedPhotoDigest: live.storedPhotoDigest, closingBuild: false });
  live.close();
  assert.notEqual(r.stopped, null);
  assert.equal(new Ledger(LQ).read().some(e => e.step === "batch-built"), false);
});
