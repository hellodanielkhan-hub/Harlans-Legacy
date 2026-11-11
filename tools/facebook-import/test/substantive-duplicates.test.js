"use strict";
/* Kept hashtag lines must not create false duplicates, and a repeated line can be kept in both positions.
   Synthetic text and ids only (no real memory).
     node --test tools/facebook-import/test/substantive-duplicates.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { checkEntry, substantiveLead } = require("../lib/dupes.js");
const { plan } = require("../import.js");

const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "synthetic-site-snapshot.json"), "utf8"));
const TAG = "#HarlansLegacy #shabbatshalom #passover";
const existing = [{ id: 901, title: "An Older Passover Story", status: "published", facebookPostId: "T900", publishedISO: "2026-03-27",
  lead: TAG, body: ["Week #900", "This was before we were born and nobody is left to explain it."] }];
const sameOpening = hits => hits.filter(h => h.kind === "same-opening-text");

test("substantiveLead skips hashtag-only lines, typo'd tag lines and Week/Issue headers", () => {
  assert.equal(substantiveLead([TAG, "Week #368", "This was before we were born."]), "This was before we were born.");
  assert.equal(substantiveLead([TAG, "#HarlansLegacy.#shabbatshalom", "Tonight we light the candles."]), "Tonight we light the candles.");
  assert.equal(substantiveLead([TAG]), "");
  assert.equal(substantiveLead(["Plain opening line here."]), "Plain opening line here.");
});

test("a shared kept tag line alone is NOT a duplicate (different stories)", () => {
  const paras = [TAG, "Tonight we light the Shabbas candles and we celebrate the first night of Passover.", "One year a gust of wind opened the door."];
  assert.equal(sameOpening(checkEntry({ postId: "T117", title: "Pass the Fish" }, paras, existing)).length, 0);
});

test("the same substantive opening behind the same tag line IS still a duplicate", () => {
  const paras = [TAG, "Week #900", "This was before we were born and nobody is left to explain it.", "More text."];
  assert.equal(sameOpening(checkEntry({ postId: "T118", title: "Another Title" }, paras, existing)).length, 1);
});

test("an untagged identical opening is still a duplicate (unchanged behaviour)", () => {
  const ex = [{ id: 902, title: "Calm", facebookPostId: "T902", lead: "May your evening be calm and bright, friends of ours.", body: [] }];
  assert.equal(sameOpening(checkEntry({ postId: "T119", title: "X" }, ["May your evening be calm and bright, friends of ours."], ex)).length, 1);
});

test("the same Facebook post is always blocked, whatever its opening", () => {
  const hits = checkEntry({ postId: "T900", title: "Different" }, ["Completely different words here today."], existing);
  assert.ok(hits.some(h => h.kind === "same-facebook-post" && h.severity === "block"));
});

test("substantive text overlap still blocks even when the openings differ", () => {
  const story = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
  const hits = checkEntry({ postId: "T120", title: "Y" }, [TAG, "A new first line.", story], existing, { T900: story });
  assert.ok(hits.some(h => h.kind === "text-overlap" && h.severity === "block"));
});

const entry = (id, text, keepLines) => ({ postId: id, facebookUrl: null, facebookTimeChicago: "2018-02-02 17:00 Fri", publishedISO: "2018-02-02", title: "Title " + id,
  category: "shabbat", sourceText: text, flags: [], hold: false, approved: true, excludeImages: true, photos: { expectedCount: 0, expectedIsEstimate: false, files: [] }, ...(keepLines ? { keepLines } : {}) });
const SAME = "#HarlansLegacy #ShabbatShalom #2727 #GenerationalEvent";
const TEXT = SAME + "\nA story about our first synagogue building.\nTell us about yours.\n" + SAME;

test("a line that opens AND closes the post is kept in both positions when listed twice", () => {
  const r = plan({ entries: [entry("T163", TEXT, [SAME, SAME])] }, snapshot, { assumeApproved: true }).items[0];
  assert.equal(r.readiness, "READY", r.reasons.join("; "));
  assert.deepEqual([r.record.lead].concat(r.record.body), [SAME, "A story about our first synagogue building.", "Tell us about yours.", SAME]);
  assert.equal(r.removedLines.length, 0);
});

test("listed once, a line that occurs twice is still refused as ambiguous", () => {
  const r = plan({ entries: [entry("T164", TEXT, [SAME])] }, snapshot, { assumeApproved: true }).items[0];
  assert.notEqual(r.readiness, "READY");
  assert.ok(r.reasons.some(x => /appears 2 times/.test(x)));
});

test("listed twice but present once is refused", () => {
  const r = plan({ entries: [entry("T165", SAME + "\nOnly one copy here.", [SAME, SAME])] }, snapshot, { assumeApproved: true }).items[0];
  assert.notEqual(r.readiness, "READY");
  assert.ok(r.reasons.some(x => /appears 1 times in the post \(listed 2 times\)/.test(x)));
});
