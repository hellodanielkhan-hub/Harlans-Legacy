/* Unnumbered Publishing Mode (policy displayStoryNumbers = false), end to end and in isolation: this checkout's
   real api/[...path].js (file store in a throwaway copy) on 127.0.0.1, a local deploy hook that runs the real
   build.js, and a static server standing in for the public site.
   - No page shows a Story Number (or an empty numbering label); the stored numbers stay intact.
   - A Draft can be published without a Story Number.
   - The Batch 1 publication runs with every safeguard (backup, identity, photos, typed confirmation,
     read-back, public checks), publishes exactly 406–430, and leaves This Week = 405 and 404 a Draft.
     node --test tools/story-numbers/test/unnumbered.test.js */
"use strict";
delete process.env.HL_STORY_NUMBERS_DISPLAY;            // the policy decides, as in Production
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const fx = require("./fixture.js");

fx.cleanEnv();
const { root, payload, registryDir } = fx.makeRoot();
const ADMIN = crypto.randomBytes(16).toString("hex");
process.env.HL_DATA_DIR = root;
process.env.ADMIN_TOKEN = ADMIN;

const handler = require(path.join(fx.WT, "api", "[...path].js"));
const numbering = require(path.join(fx.WT, "lib", "numbering.js"));
const verify = require("../lib/verify.js");
const run = require("../lib/run.js");
const { createRehearsalTransport } = require("../lib/transport.js");
const { BATCH_1_IDS } = require("../lib/batch1.js");
const registry = require("../lib/private-registry.js").load(registryDir, { expectHashes: false });
const { payloadFingerprint } = require(path.join(fx.WT, "tools", "facebook-import", "lib", "authorize.js"));

let builds = 0;
const listen = srv => new Promise(r => srv.listen(0, "127.0.0.1", () => r("http://127.0.0.1:" + srv.address().port)));
const build = () => execFileSync(process.execPath, [path.join(fx.WT, "build.js")], { env: Object.assign({}, process.env, { HL_DATA_DIR: root }), stdio: "ignore" });
const api = http.createServer((req, res) => handler(req, res));
const hook = http.createServer((req, res) => { builds++; build(); res.end("{}"); });
const site = http.createServer((req, res) => {
  const rel = decodeURIComponent(String(req.url).split("?")[0]).replace(/^\/+/, "") || "index.html";
  const f = path.resolve(root, rel);
  if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end("not found"); }
  res.end(fs.readFileSync(f));
});
let API, SITE, backups = 0;
test.before(async () => { API = await listen(api); SITE = await listen(site); process.env.VERCEL_DEPLOY_HOOK_URL = (await listen(hook)) + "/hook"; });
test.after(() => { api.close(); hook.close(); site.close(); fx.removeRoot(root); for (let i = 1; i <= backups; i++) fs.rmSync(root + "-backup-" + i, { recursive: true, force: true }); });

async function call(method, p, body) {
  const r = await fetch(API + p, { method, headers: { "Content-Type": "application/json", "x-admin-token": ADMIN }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const stories = async () => (await call("GET", "/api/stories")).body;
async function session(operation) {
  const live = createRehearsalTransport({ base: API, token: ADMIN, operation });
  const asked = [];
  const o = { live, io: { isTTY: true, print: () => {}, ask: async q => { asked.push(q); return /PUBLISH/.test(q) ? run.PUBLISH_PHRASE : run.RELEASE_PHRASE(46); } },
    ledger: { append: () => {} }, backupDir: root + "-backup-" + (++backups), payload, registry, payloadFingerprint: payloadFingerprint(payload),
    fetch: globalThis.fetch, origin: SITE, publicTries: 3, publicWaitMs: 300 };
  const b0 = builds;
  const report = operation === "release" ? await run.releaseNumbers(o) : await run.publishBatch1(o);
  live.close();
  return { report, asked, builds: builds - b0, writes: live.requests().filter(q => q.method !== "GET").map(q => q.path) };
}
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");
const publicFiles = () => [...fs.readdirSync(path.join(root, "story")).map(f => path.join("story", f)), "index.html", "archive.html",
  ...fs.readdirSync(path.join(root, "family")).map(f => path.join("family", f)), ...fs.readdirSync(root).filter(f => /\.html$/.test(f))];
// a number in any numbering position, or a numbering label left empty
const NUMBER_OR_EMPTY_LABEL = /No\.(&nbsp;| )(<b>)?\d|Story No\.|data-story-id="\d|class="(tw-stamp|arc-date|xc-meta|st-meta|cp-label|ai-nos)">\s*(·|&middot;|<br>|<\/span>)|Nos\.&nbsp;|of 378/;

test("the policy pauses the display: nothing is shown, the rules for saving numbers are unchanged", () => {
  assert.equal(numbering.policy().displayStoryNumbers, false);
  assert.equal(numbering.DISPLAY_STORY_NUMBERS, false);
  assert.equal(numbering.label({ id: 405, storyNumber: 447 }), "");
  assert.equal(numbering.displayNo({ id: 405, storyNumber: 447 }), null);
  assert.equal(numbering.storyNo({ id: 405, storyNumber: 447 }), 447, "the stored number is still read");
  const all = [{ id: 405, storyNumber: 447, status: "published", featured: true }];
  assert.match(numbering.prepareWrite({ storyNumber: 214 }, null, all, [], 999).problems[0], /retired/, "retired numbers are still refused");
  assert.match(numbering.prepareWrite({ storyNumber: 448 }, all[0], all, [], 405).problems[0], /permanent/, "a saved number is still permanent");
  assert.deepEqual(numbering.prepareWrite({ status: "published", title: "x" }, { id: 999, status: "draft" }, all, [], 999).problems, [], "publishing no longer needs a number");
});

test("the 46-record release still assigns and verifies the stored numbers (nothing is shown)", async () => {
  const before = await stories();
  const r = await session("release");
  assert.equal(r.report.stopped, undefined, r.report.stage + ": " + r.report.stopped);
  assert.deepEqual(r.writes, ["/api/story-numbers/release"]); assert.equal(r.builds, 1);
  assert.deepEqual(verify.releaseProblems(before, await stories()), []);
});

test("public pages show no Story Number, no record id as a number and no empty numbering label", async () => {
  const after = await stories();
  assert.ok(after.every(s => numbering.storyNo(s) != null), "all 46 stored numbers are intact");
  for (const f of publicFiles()) assert.ok(!NUMBER_OR_EMPTY_LABEL.test(read(f)), f + ": " + (read(f).match(NUMBER_OR_EMPTY_LABEL) || [])[0]);
  const h = read(path.join("story", "405-" + after.find(s => s.id === 405).slug + ".html"));
  assert.match(h, /data-record-id="405" data-story-id=""/);
  assert.ok(!/<div class="footer-bottom">[\s\S]*?Story[\s\S]*?<\/div>/.test(h.match(/<div class="footer-bottom">[\s\S]*?<\/div>/)[0].replace(/Harlan's Legacy/g, "")), "footer has no Story label");
  const js = read("stories.js");
  assert.ok(!/"storyNumber": \d/.test(js), "stories.js carries no number");
  for (const r of JSON.parse(read("search-index.json")).filter(x => x.type === "story")) {
    assert.ok(!/No\./.test(r.subtitle || ""), "search subtitle " + r.subtitle);
    assert.ok(!/\bno \d/.test(r.keywords), "search keywords for " + r.title);
  }
  assert.equal((await run.verifyPublic(globalThis.fetch, SITE, run.expectedPublic(after))).problems.length, 0);
});

test("publish-batch-1: exactly 406–430, every safeguard kept, This Week 405 and Draft 404 unchanged, no numbers shown", async () => {
  const pre = await stories();
  const galleries = (await call("GET", "/api/story-photos")).body;
  const r = await session("publish");
  assert.equal(r.report.stopped, undefined, r.report.stage + ": " + r.report.stopped);
  assert.deepEqual(r.report.steps.map(s => s.step), ["deployed-map", "backup", "batch-1-identity", "photos", "public-numbers", "publish", "publish-verified", "public-final"]);
  const ph = r.report.steps.find(s => s.step === "photos"); assert.equal(ph.photos, 23); assert.equal(ph.textOnly, 4);
  assert.deepEqual(r.writes, ["/api/stories/publish"]); assert.equal(r.builds, 1); assert.equal(r.asked.length, 1);
  const post = await stories();
  assert.deepEqual(verify.publishProblems(pre, post), []);
  for (const s of post) assert.equal(s.status, BATCH_1_IDS.includes(s.id) ? "published" : pre.find(x => x.id === s.id).status);
  assert.deepEqual(post.filter(s => s.featured).map(s => s.id), [405]);
  assert.equal(post.find(s => s.id === 404).status, "draft");
  assert.deepEqual((await call("GET", "/api/story-photos")).body, galleries, "photos, order and Primary unchanged");
  for (const s of post.filter(x => x.status === "published")) assert.ok(fs.existsSync(path.join(root, "story", s.id + "-" + s.slug + ".html")), "page of " + s.id);
  for (const f of publicFiles()) assert.ok(!NUMBER_OR_EMPTY_LABEL.test(read(f)), f + " after publication");
});

test("a Draft without a Story Number can be published (editor save and batch route)", async () => {
  const a = await call("POST", "/api/stories", { title: "Unnumbered memory", status: "draft", publishedISO: "2026-11-01" });
  assert.equal(a.status, 201); assert.equal(a.body.story.storyNumber, null);
  const p = await call("PUT", "/api/stories/" + a.body.story.id, Object.assign({}, a.body.story, { status: "published" }));
  assert.equal(p.status, 200); assert.equal(p.body.story.status, "published"); assert.equal(p.body.story.storyNumber, null); assert.equal(p.body.story.featured, false);
  const b = await call("POST", "/api/stories", { title: "Another", status: "draft", publishedISO: "2026-11-02" });
  const q = await call("POST", "/api/stories/publish", { ids: [b.body.story.id], deferRebuild: true });
  assert.equal(q.status, 200);
  assert.deepEqual((await stories()).filter(s => s.featured).map(s => s.id), [405], "This Week still 405");
  assert.equal((await call("POST", "/api/stories/publish", { ids: [404, 405] })).status, 409, "non-Drafts / featured are still refused");
});
