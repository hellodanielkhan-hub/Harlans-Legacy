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
  // a legacy Story Number / Original Blog Number stored on one record (inert data that must stay as it is)
  Object.assign(list.find(s => s.id === 398), { storyNumber: 431, originalBlogNumber: 384 });
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

/* ---- the legacy Story Number is inert: nothing assigns, reserves, issues or releases one ---- */
test("legacy freeze: saves ignore Story Number fields, keep stored legacy values, never write the issued-number ledger", async () => {
  const numbering = require(path.join(WT, "lib", "numbering.js"));
  assert.equal(numbering.LEGACY_FROZEN, true);
  const ledger = path.join(root, "data", "story_numbers.json");
  assert.equal(fs.existsSync(ledger), false, "no issued-number ledger after every save above");
  const all0 = site.stories(), maxId = Math.max(...all0.map(s => s.id));
  // a create that tries to set legacy numbers (even a retired or reserved one) gets none, and is not refused for them
  const c = await call("POST", "/api/stories", { title: "Legacy probe", status: "draft", publishedISO: "2026-11-14", lead: "Synthetic.", body: [], storyNumber: 448, originalBlogNumber: 400 });
  assert.equal(c.status, 201); assert.equal(c.body.story.storyNumber, null); assert.equal(c.body.story.originalBlogNumber, null);
  assert.equal(c.body.story.id, maxId + 1);                       // the record id is allocated as before, and is not an issue number
  // a new record carries its own (empty) Issue Number, so the historical map can never apply to it, even when its
  // record id happens to be a key of the map (as here: the synthetic archive reuses low ids)
  assert.equal(c.body.story.issueNumber, null); assert.ok(SEED[String(c.body.story.id)], "this id is a key of the map");
  assert.equal(issues.effective(c.body.story), null);
  const r2 = await call("POST", "/api/stories", { title: "Legacy probe 2", status: "draft", storyNumber: 303 });   // retired in the old rules
  assert.equal(r2.status, 201); assert.equal(r2.body.story.storyNumber, null);
  // an edit that sends other legacy numbers keeps the stored ones exactly
  const s398 = site.stories().find(s => s.id === 398);
  const e = await call("PUT", "/api/stories/398", Object.assign({}, s398, { storyNumber: 9, originalBlogNumber: 1 }));
  assert.equal(e.status, 200); assert.equal(e.body.story.storyNumber, 431); assert.equal(e.body.story.originalBlogNumber, 384);
  assert.equal(fs.existsSync(ledger), false, "still no issued-number ledger");
  // the release is closed; the read-only facts say so and suggest no Story Number
  const rel = await call("POST", "/api/story-numbers/release", { fingerprint: numbering.assignmentsFingerprint() });
  assert.equal(rel.status, 410); assert.equal(rel.body.code, "story_numbers_frozen");
  const info = await call("GET", "/api/story-numbers");
  assert.equal(info.body.frozen, true); assert.equal(info.body.nextNewStoryNumber, null);
  assert.equal(info.body.assignmentsFingerprint, numbering.assignmentsFingerprint());   // the publisher's deployed-code check still works
  // the importer never takes a Story Number from the private registry
  const { buildRecord } = require(path.join(WT, "tools", "facebook-import", "lib", "record.js"));
  const b = buildRecord({ postId: "S010", title: "x", category: "shabbat", publishedISO: "2019-03-15" }, ["p"], 999, { numberFor: () => 10 });
  assert.equal(b.requestBody.storyNumber, null);
  for (const id of [c.body.story.id, r2.body.story.id]) assert.equal((await call("DELETE", "/api/stories/" + id)).status, 200);
});

/* ---- one resolution rule for historical memories edited in the Admin Panel ---- */
test("historical memory: an explicit number wins, an explicit clear never falls back to the map, the mapped number can be restored", async () => {
  const id = 393, seed = SEED[String(id)], cur = () => site.stories().find(s => s.id === id);
  // the Admin Panel re-sends nothing when the number is unchanged: the record keeps no field and the map still applies
  let r = await call("PUT", "/api/stories/" + id, (({ issueNumber, ...rest }) => rest)(Object.assign({}, cur(), { title: cur().title })));
  assert.equal(r.status, 200); assert.equal("issueNumber" in cur(), false); assert.ok(page(cur()).includes(label(seed)));
  // a changed number wins over the map, on the page and in the Admin facts
  r = await call("PUT", "/api/stories/" + id, Object.assign({}, cur(), { issueNumber: 777 }));
  assert.equal(r.status, 200); assert.equal(cur().issueNumber, 777);
  assert.ok(page(cur()).includes(label(777))); assert.ok(!page(cur()).includes(label(seed)));
  assert.equal((await call("GET", "/api/issue-numbers")).body.byId[id], 777);
  // cleared: no number anywhere; the map does not bring it back (also after another save without the field)
  r = await call("PUT", "/api/stories/" + id, Object.assign({}, cur(), { issueNumber: null }));
  assert.equal(r.status, 200); assert.equal(cur().issueNumber, null); assert.equal(labels(page(cur())), 0);
  const again = Object.assign({}, cur()); delete again.issueNumber;
  await call("PUT", "/api/stories/" + id, again);
  assert.equal(cur().issueNumber, null); assert.equal(labels(page(cur())), 0);
  assert.equal((await call("GET", "/api/issue-numbers")).body.byId[id], undefined);
  // restored to the approved mapped number
  r = await call("PUT", "/api/stories/" + id, Object.assign({}, cur(), { issueNumber: seed }));
  assert.ok(page(cur()).includes(label(seed))); assert.equal(labels(page(cur())), 1);
  // every other historical memory still resolves to its mapped number
  const g = (await call("GET", "/api/issue-numbers")).body;
  for (const s of before) if (s.id !== id && SEED[String(s.id)]) assert.equal(g.byId[s.id], SEED[String(s.id)], "record " + s.id);
  assert.deepEqual(site.buildErrors, []);
});
