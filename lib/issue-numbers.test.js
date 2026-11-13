"use strict";
/* Issue numbers in the story date row ("Issue #N").
     node --test lib/issue-numbers.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const DATA = require("../data/issue-numbers.json");
const { issueNo, showing } = require("./issue-numbers.js");
const { loadData, storyPageHTML } = require("../build.js");

const withMode = (mode, vercelEnv, fn) => {
  const saved = [process.env.HL_ISSUE_NUMBERS_DISPLAY, process.env.VERCEL_ENV];
  if (mode == null) delete process.env.HL_ISSUE_NUMBERS_DISPLAY; else process.env.HL_ISSUE_NUMBERS_DISPLAY = mode;
  if (vercelEnv == null) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = vercelEnv;
  try { return fn(); } finally {
    if (saved[0] === undefined) delete process.env.HL_ISSUE_NUMBERS_DISPLAY; else process.env.HL_ISSUE_NUMBERS_DISPLAY = saved[0];
    if (saved[1] === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved[1];
  }
};
const provenanceOf = html => (html.match(/<div class="story-provenance"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || "";

test("data file: positive whole issue numbers keyed by record id; no #400 yet; record 751 (before the series) has none", () => {
  assert.ok(["on", "preview", "off"].includes(DATA.display));
  const entries = Object.entries(DATA.issues);
  assert.equal(entries.length, 397);
  for (const [id, n] of entries) {
    assert.match(id, /^[1-9]\d*$/, "record id " + id);
    assert.ok(Number.isInteger(n) && n > 0 && n < 400, id + " -> " + n);
  }
  assert.equal("751" in DATA.issues, false);
  // Hal's own repeated numbers stay repeated (not forced into a sequence)
  assert.equal(DATA.issues["305"], 388); assert.equal(DATA.issues["388"], 388);
});

test("display switch: 'preview' shows on Preview/local builds and never on Production builds; 'off' hides; 'on' shows", () => {
  withMode("preview", "preview", () => assert.equal(showing(), true));
  withMode("preview", null, () => assert.equal(showing(), true));
  withMode("preview", "production", () => assert.equal(showing(), false));
  withMode("off", "preview", () => assert.equal(showing(), false));
  withMode("on", "production", () => assert.equal(showing(), true));
  withMode("bogus", "preview", () => assert.equal(showing(), false));
});

test("story page: the issue number appears once, in the date row, in one uniform form; the story text is unchanged", () => {
  const D = loadData();
  const s = D.stories.find(x => x.published);
  assert.ok(s, "a published story in data/stories.json");
  const fake = Object.assign({}, s, { id: 393 });       // a record id that has an entry
  const n = DATA.issues["393"];
  const on = withMode("on", null, () => storyPageHTML(fake, D.site, null, null, []));
  const off = withMode("off", null, () => storyPageHTML(fake, D.site, null, null, []));
  const row = provenanceOf(on);
  assert.ok(row.includes(`<span class="issue-no">Issue&nbsp;<b>#${n}</b></span>`), row);
  assert.equal((on.match(/class="issue-no"/g) || []).length, 1);
  assert.doesNotMatch(on, /estimated|provisional|unverified|confidence/i);
  assert.doesNotMatch(provenanceOf(on), /title=/);
  // removing the row restores the page exactly: nothing else on the page changed (text, URL, record id, narration)
  assert.equal(on.replace(`<span class="issue-no">Issue&nbsp;<b>#${n}</b></span>`, "").replace(/\s+/g, " "), off.replace(/\s+/g, " "));
  assert.doesNotMatch(off, /class="issue-no"/);
});

test("a record id is never shown as an issue number; a story without an entry shows none", () => {
  const D = loadData();
  const s = D.stories.find(x => x.published);
  const withEntry = Object.entries(DATA.issues).find(([id, n]) => +id !== n);
  const page = withMode("on", null, () => storyPageHTML(Object.assign({}, s, { id: +withEntry[0] }), D.site, null, null, []));
  assert.ok(provenanceOf(page).includes("#" + withEntry[1] + "</b>"));
  assert.ok(!provenanceOf(page).includes("#" + withEntry[0] + "<"));
  const none = withMode("on", null, () => storyPageHTML(Object.assign({}, s, { id: 751 }), D.site, null, null, []));
  assert.doesNotMatch(none, /class="issue-no"/);
  assert.equal(withMode("on", null, () => issueNo({ id: 999999 })), null);
});

/* ---- one Issue Number per story: the record's own field, else the frozen historical map ---- */
const { effective, source, suggestNext, usedBy, parse, summary } = require("./issue-numbers.js");
const records = require("./records.js");
const numbering = require("./numbering.js");

test("the record's own issueNumber wins; null means none; without the field the historical map applies; a record id is never used", () => {
  assert.equal(effective({ id: 393 }), DATA.issues["393"]);                       // historical map
  assert.equal(source({ id: 393 }), "historical-map");
  assert.equal(effective({ id: 393, issueNumber: 500 }), 500);                    // the record's own number
  assert.equal(source({ id: 393, issueNumber: 500 }), "record");
  assert.equal(effective({ id: 393, issueNumber: null }), null);                  // deliberately none
  assert.equal(effective({ id: 751 }), null);                                     // P001: none in the map
  assert.equal(effective({ id: 999999 }), null);                                  // never the record id
  assert.equal(effective({ id: 400, status: "published" }), DATA.issues["400"]);
  assert.notEqual(effective({ id: 400 }), 400);
});

test("parse and records.normalize keep one clean shape (absent stays absent; null is kept; strings become numbers)", () => {
  assert.deepEqual(parse(""), { value: null }); assert.deepEqual(parse(" 400 "), { value: 400 });
  assert.ok(parse("abc").error); assert.ok(parse(0).error); assert.ok(parse(-3).error); assert.ok(parse(2.5).error);
  assert.equal("issueNumber" in records.normalize({ title: "x" }), false);
  assert.equal(records.normalize({ title: "x", issueNumber: "401" }).issueNumber, 401);
  assert.equal(records.normalize({ title: "x", issueNumber: null }).issueNumber, null);
  assert.equal(records.normalize({ title: "x" }, { title: "x", issueNumber: 402 }).issueNumber, 402);   // an edit without the field keeps it
});

test("next-number suggestion: latest PUBLISHED issue by story date + 1, never the highest number, a count or a record id; drafts never consume or skip", () => {
  const base = [
    { id: 531, status: "published", publishedISO: "2026-11-06", title: "Latest" },                  // map: #399
    { id: 405, status: "published", publishedISO: "2026-10-30", title: "Before" },                  // map: #398
    { id: 900, status: "published", publishedISO: "2020-01-03", title: "Old, high", issueNumber: 450 }, // a higher number on an older story
  ];
  let r = suggestNext(base);
  assert.equal(r.latest.issue, 399); assert.equal(r.next, 400); assert.deepEqual(r.draftsUsingNext, []);
  // opening a New Post does nothing; a saved Draft with #400 does not move the suggestion (no skip), and is listed
  const withDraft = base.concat([{ id: 901, status: "draft", publishedISO: "2026-11-13", title: "Draft 400", issueNumber: 400 }]);
  r = suggestNext(withDraft);
  assert.equal(r.next, 400); assert.deepEqual(r.draftsUsingNext.map(x => x.id), [901]);
  // once #400 is published (story date after #399), the next suggestion is 401
  const published = base.concat([{ id: 901, status: "published", publishedISO: "2026-11-13", title: "Issue 400", issueNumber: 400 }]);
  assert.equal(suggestNext(published).next, 401);
  // an editor's different number is kept as entered (Hal's own number), and the suggestion follows it
  const own = base.concat([{ id: 902, status: "published", publishedISO: "2026-11-13", title: "Hal wrote 402", issueNumber: 402 }]);
  assert.equal(suggestNext(own).next, 403);
  // a historical import with an old date never moves the suggestion
  const late = base.concat([{ id: 903, status: "published", publishedISO: "2019-03-01", title: "Old import", issueNumber: 3 }]);
  assert.equal(suggestNext(late).next, 400);
  assert.deepEqual(suggestNext([]), { next: null, latest: null, draftsUsingNext: [] });
});

test("duplicates are reported (Hal's own repeats stay possible); summary gives every story's number by record id", () => {
  const list = [{ id: 305, status: "published", title: "A" }, { id: 388, status: "published", title: "B" }, { id: 777, status: "draft", title: "C", issueNumber: 500 }];
  assert.deepEqual(usedBy(388, list, 305).map(x => x.id), [388]);              // Hal's real #388 repeat (records 305 and 388)
  assert.deepEqual(usedBy(500, list, 777), []);
  const sm = summary(list);
  assert.equal(sm.byId[305], 388); assert.equal(sm.byId[388], 388); assert.equal(sm.byId[777], 500);
});

test("the old calculated Story Number stays retired from display: no second public numbering system", () => {
  assert.equal(numbering.DISPLAY_STORY_NUMBERS, false);
  assert.equal(numbering.displayNo({ id: 1, storyNumber: 5 }), null);
  assert.equal(numbering.label({ id: 1, storyNumber: 5 }), "");
});
