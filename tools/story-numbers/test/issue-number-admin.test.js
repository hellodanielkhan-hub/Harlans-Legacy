/* Issue Number end to end, in isolation: a synthetic copy of the archive, the real API in FILE mode on 127.0.0.1,
   the real build.js behind a local deploy hook. New Post suggestion -> Draft -> edit -> publish -> public page ->
   later edit, duplicate warnings, invalid values, and the historical numbers left exactly as they were.
   No Supabase, no real stories, random tokens.
     node --test tools/story-numbers/test/issue-number-admin.test.js */
"use strict";
delete process.env.HL_ISSUE_NUMBERS_DISPLAY; delete process.env.VERCEL_ENV;
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const fx = require("./fixture.js");
const { startSite, WT } = require("./batch-site.js");

fx.cleanEnv();
const { root } = fx.makeRoot();
const site = startSite(root);
const issues = require(path.join(WT, "lib", "issue-numbers.js"));
const SEED = require(path.join(WT, "data", "issue-numbers.json")).issues;

const call = async (method, p, body) => {
  const r = await fetch(site.API + p, { method, headers: { "Content-Type": "application/json", "x-admin-token": site.token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const page = s => { const f = path.join(root, "story", `${s.id}-${s.slug}.html`); return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null; };
const label = n => `Issue&nbsp;<b>#${n}</b>`;
const labels = html => (html.match(/class="issue-no"/g) || []).length;

let before, next, draftA, draftB;
test.before(async () => {
  await site.start();
  // Make the fixture's newest published memory (record 405) the latest by date, as This Week is on the live site.
  const list = site.stories();
  list.find(s => s.id === 405).publishedISO = "2026-11-06";
  site.writeStories(list);
  before = JSON.parse(JSON.stringify(site.stories()));
});
test.after(() => { site.close(); fx.removeRoot(root); });

test("GET /api/issue-numbers: next = latest published issue + 1, with every memory's number by record id", async () => {
  const r = await call("GET", "/api/issue-numbers");
  assert.equal(r.status, 200);
  next = r.body.next;
  assert.equal(r.body.latest.id, 405); assert.equal(r.body.latest.issue, SEED["405"]); assert.equal(next, SEED["405"] + 1);
  for (const s of before) if (SEED[String(s.id)]) assert.equal(r.body.byId[s.id], SEED[String(s.id)]);
  assert.deepEqual(r.body.draftsUsingNext, []);
  // not a count of stories and not a record id
  assert.notEqual(next, before.length + 1); assert.notEqual(next, Math.max(...before.map(s => s.id)) + 1);
});

test("New Post saved as a Draft keeps its Issue Number; the suggestion does not move (nothing consumed, nothing skipped)", async () => {
  const r = await call("POST", "/api/stories", { title: "Issue test draft A", status: "draft", publishedISO: "2026-11-13", lead: "Synthetic.", body: ["Synthetic."], issueNumber: next });
  assert.equal(r.status, 201); draftA = r.body.story;
  assert.equal(draftA.issueNumber, next); assert.deepEqual(r.body.issueWarnings, []);
  assert.equal(site.stories().find(s => s.id === draftA.id).issueNumber, next);
  const g = await call("GET", "/api/issue-numbers");
  assert.equal(g.body.next, next); assert.deepEqual(g.body.draftsUsingNext.map(x => x.id), [draftA.id]);
  assert.equal(page(draftA), null);                                           // a Draft has no public page
});

test("a second New Post with the same number is saved (intentional repeats stay possible) and reports the duplicate", async () => {
  const r = await call("POST", "/api/stories", { title: "Issue test draft B", status: "draft", publishedISO: "2026-11-13", lead: "Synthetic.", body: ["Synthetic."], issueNumber: String(next) });
  assert.equal(r.status, 201); draftB = r.body.story;
  assert.equal(draftB.issueNumber, next);
  assert.deepEqual(r.body.issueWarnings.map(x => x.id), [draftA.id]);
  // a number already used by a historical memory is reported too
  const h = await call("PUT", "/api/stories/" + draftB.id, Object.assign({}, draftB, { issueNumber: SEED["303"] }));
  assert.equal(h.status, 200); assert.ok(h.body.issueWarnings.map(x => x.id).includes(303));
});

test("invalid Issue Numbers are refused with 400 and change nothing", async () => {
  const snap = JSON.stringify(site.stories());
  for (const bad of ["abc", 0, -4, 2.5, "12a"]) {
    const r = await call("PUT", "/api/stories/" + draftA.id, Object.assign({}, draftA, { issueNumber: bad }));
    assert.equal(r.status, 400, String(bad)); assert.equal(r.body.code, "issue_number_invalid");
  }
  const p = await call("POST", "/api/stories", { title: "bad", status: "draft", issueNumber: "x" });
  assert.equal(p.status, 400);
  assert.equal(JSON.stringify(site.stories()), snap);
});

test("edit keeps the number; an edit that does not send the field keeps it; empty means no number", async () => {
  let r = await call("PUT", "/api/stories/" + draftA.id, Object.assign({}, draftA, { title: "Issue test draft A (edited)" }));
  assert.equal(r.status, 200); assert.equal(r.body.story.issueNumber, next);
  const noField = Object.assign({}, r.body.story); delete noField.issueNumber;
  r = await call("PUT", "/api/stories/" + draftA.id, noField);
  assert.equal(r.body.story.issueNumber, next);
  r = await call("PUT", "/api/stories/" + draftB.id, Object.assign({}, draftB, { issueNumber: "" }));
  assert.equal(r.status, 200); assert.equal(r.body.story.issueNumber, null);
  assert.equal(issues.effective(r.body.story), null);
  draftA = site.stories().find(s => s.id === draftA.id);
});

test("publish: the public page shows the record's own number automatically (no data-file edit), once", async () => {
  const seedFile = fs.readFileSync(path.join(WT, "data", "issue-numbers.json"), "utf8");
  const r = await site.publishRaw([draftA.id]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(site.buildErrors, []);
  const html = page(site.stories().find(s => s.id === draftA.id));
  assert.ok(html, "published page exists");
  assert.ok(html.includes(label(next))); assert.equal(labels(html), 1);
  assert.equal(fs.readFileSync(path.join(WT, "data", "issue-numbers.json"), "utf8"), seedFile);   // the map was not touched
  const g = await call("GET", "/api/issue-numbers");
  assert.equal(g.body.latest.id, draftA.id); assert.equal(g.body.next, next + 1);                 // the next suggestion is +1
});

test("a later edit of the published story changes the number on the public page after the rebuild", async () => {
  const cur = site.stories().find(s => s.id === draftA.id);
  const r = await call("PUT", "/api/stories/" + cur.id, Object.assign({}, cur, { issueNumber: next + 5 }));
  assert.equal(r.status, 200);
  let html = page(site.stories().find(s => s.id === cur.id));
  assert.ok(html.includes(label(next + 5))); assert.ok(!html.includes(label(next)));
  const back = await call("PUT", "/api/stories/" + cur.id, Object.assign({}, site.stories().find(s => s.id === cur.id), { issueNumber: next }));
  assert.equal(back.status, 200);
  html = page(site.stories().find(s => s.id === cur.id));
  assert.ok(html.includes(label(next)));
  assert.deepEqual(site.buildErrors, []);
});

test("historical memories: records untouched, pages show exactly their mapped numbers, a record id never shows", async () => {
  const now = site.stories();
  for (const s of before) {
    assert.deepEqual(now.find(x => x.id === s.id), s, "record " + s.id + " unchanged");
    assert.equal("issueNumber" in s, false);
    if (s.status !== "published") continue;
    const html = page(s), n = SEED[String(s.id)];
    if (n) { assert.ok(html.includes(label(n)), "record " + s.id); assert.equal(labels(html), 1); }
    else assert.equal(labels(html), 0);
  }
});

/* Future weekly posts: the approved import entry carries its Issue Number, the safeguarded importer and publisher
   check it like every other approved field, and the public page shows it with no data-file edit. */
test("weekly import: an approved post with an Issue Number is imported, verified, published and shown", async () => {
  const os = require("os");
  const { approvalFingerprint, IMPORT_SYSTEM } = require(path.join(WT, "tools", "facebook-import", "lib", "batch.js"));
  const { payloadFingerprint } = require(path.join(WT, "tools", "facebook-import", "lib", "authorize.js"));
  const { importBatch, publishSession } = require("./batch-site.js");
  const run = require("../lib/run.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hl-issue-weekly-"));
  try {
    const want = next + 1;
    const record = { id: 431, storyNumber: null, title: "Synthetic weekly post", slug: "", status: "draft", featured: false, theme: "shabbat",
      publishedISO: "2026-11-20", dateLong: "", dateLabel: "", memoryDate: null, summary: "", description: null, ogDescription: null,
      lead: "A synthetic weekly paragraph.", body: ["A second synthetic paragraph."], people: [], places: [], objects: [], events: [], bookPart: null,
      keywords: [], echoStories: [], readingTime: 1, readerImages: [], importSource: { system: IMPORT_SYSTEM, postId: "W400", facebookUrl: null, facebookTimeChicago: null },
      issueNumber: want };
    const items = [{ postId: "W400", photoMode: "none", images: [], record }];
    const P = { batch: 90, items, counts: { posts: 1, withPhotos: 0, withoutPhotos: 1, photos: 0 } };
    P.approvedFingerprints = { W400: approvalFingerprint(items[0]) };
    const ledger = path.join(tmp, "import-90.jsonl");
    const imp = await importBatch(site, P, ledger);
    assert.equal(imp.result.stopped, null, JSON.stringify(imp.result.stopped));
    const id = imp.ids[0];
    assert.equal(site.stories().find(s => s.id === id).issueNumber, want);
    const r = await publishSession(site, { ledgerPath: path.join(tmp, "publish.jsonl"), backupDir: path.join(tmp, "backup"), payload: P, fingerprint: payloadFingerprint(P),
      importLedgerPath: ledger, answer: run.BATCH_PUBLISH_PHRASE(1, "batch-90") });
    assert.equal(r.report.stopped, undefined, r.report.stage + ": " + r.report.stopped);
    assert.deepEqual(r.writes, ["/api/stories/publish"]);
    const html = page(site.stories().find(s => s.id === id));
    assert.ok(html.includes(label(want))); assert.equal(labels(html), 1);
    const g = await call("GET", "/api/issue-numbers");
    assert.equal(g.body.latest.id, id); assert.equal(g.body.next, want + 1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
