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
