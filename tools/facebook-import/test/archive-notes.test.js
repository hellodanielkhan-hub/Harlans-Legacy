"use strict";
/* Archive notes (an editorial notice shown apart from Hal's words) and the owner-approved distinct-repost exception.
   Synthetic posts and ids only; no network, no token.
     node --test tools/facebook-import/test/archive-notes.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRecord } = require("../lib/record.js");
const { itemProblems } = require("../lib/batch.js");
const { checkEntry } = require("../lib/dupes.js");
const { loadData, storyPageHTML } = require("../../../build.js");

const URL_A = "https://www.facebook.com/halyes/posts/100000000000001", URL_B = "https://www.facebook.com/photo/?fbid=200000000000002&set=a.3";
const entry = (o) => Object.assign({ postId: "T315", title: "A Revisited Story", category: "shabbat", publishedISO: "2025-01-03", facebookUrl: URL_B, facebookTimeChicago: "2025-01-03 17:41 Fri" }, o);
const item = (e) => ({ postId: e.postId, photoMode: "none", images: [], record: buildRecord(e, ["#HarlansLegacy", "Hal's own words."], 9001, null).requestBody });

test("an archive note travels into the import record; without one the record is unchanged", () => {
  const plain = item(entry({}));
  assert.equal("archiveNote" in plain.record, false);
  assert.deepEqual(itemProblems(plain), []);
  const noted = item(entry({ archiveNote: { text: "Hal's original post included a photograph, which is not reproduced here.", sourceUrl: URL_B } }));
  assert.deepEqual(noted.record.archiveNote, { text: "Hal's original post included a photograph, which is not reproduced here.", sourceUrl: URL_B });
  assert.deepEqual(itemProblems(noted), []);
});

test("an archive note may only link to the post's own Facebook URL, and must have text", () => {
  assert.match(itemProblems(item(entry({ archiveNote: { text: "x", sourceUrl: URL_A } }))).join(" "), /post's own Facebook URL/);
  assert.match(itemProblems(item(entry({ archiveNote: { text: "x", sourceUrl: "https://example.com/" } }))).join(" "), /post's own Facebook URL/);
  assert.match(itemProblems(item(entry({ archiveNote: { text: "  " } }))).join(" "), /1-1000 characters/);
  const extra = item(entry({ archiveNote: { text: "x" } })); extra.record.archiveNote.html = "<b>no</b>";
  assert.match(itemProblems(extra).join(" "), /unknown archiveNote field "html"/);
});

const P301 = { id: 606, title: "The Original Story", status: "published", facebookPostId: "T301", publishedISO: "2024-10-04",
  lead: "#HarlansLegacy", body: ["Every autumn our mother answered the phone the same way and we laughed for a week about it."] };
const sharedText = "Every autumn our mother answered the phone the same way and we laughed for a week about it. Then we told the story again.";
const sources = { T301: "#HarlansLegacy\n" + sharedText };
const paras = ["#HarlansLegacy", "Every autumn our mother answered the phone the same way and we laughed for a week about it.", "Then we told the story again."];
const approved = { postId: "T301", record: 606, originalFacebookUrl: URL_A, originalDate: "2024-10-04", approval: "owner, chat, 2026-11-12" };
const blocks = hits => hits.filter(h => h.severity === "block").map(h => h.kind);

test("without an approval, a repost that repeats a published memory is still blocked", () => {
  assert.ok(blocks(checkEntry(entry({}), paras, [P301], sources)).includes("text-overlap"));
});

test("the approved distinct repost of THAT memory is reported for review, not blocked, and recorded on the record", () => {
  const hits = checkEntry(entry({ distinctRepostOf: approved }), paras, [P301], sources);
  assert.deepEqual(blocks(hits), []);
  assert.ok(hits.some(h => h.kind === "approved-distinct-repost" && h.severity === "review" && /No\. 606/.test(h.detail)));
  const it = item(entry({ distinctRepostOf: approved }));
  assert.deepEqual(it.record.importSource.distinctRepostOf, { postId: "T301", record: 606 });
  assert.deepEqual(itemProblems(it), []);
});

test("the exception never covers another memory, the same source post, the same URL or the same date, or a missing approval", () => {
  const other = Object.assign({}, P301, { id: 607, facebookPostId: "T302" });
  const sources2 = Object.assign({ T302: sources.T301 }, sources);
  // overlap with a second memory that is NOT named stays blocking
  assert.ok(blocks(checkEntry(entry({ distinctRepostOf: approved }), paras, [P301, other], sources2)).includes("text-overlap"));
  // a different record number, the original's own URL or date, or no approval text: unverified -> blocked
  for (const bad of [{ record: 607 }, { originalFacebookUrl: URL_B }, { originalDate: "2025-01-03" }, { approval: "" }]) {
    const b = blocks(checkEntry(entry({ distinctRepostOf: Object.assign({}, approved, bad) }), paras, [P301], sources));
    assert.ok(b.includes("distinct-repost-unverified") && b.includes("text-overlap"), JSON.stringify(bad));
  }
  // the same Facebook post is never a repost of itself
  assert.ok(blocks(checkEntry(entry({ postId: "T301", distinctRepostOf: approved }), paras, [P301], sources)).includes("same-facebook-post"));
  // a malformed audit field on the record is refused
  const it = item(entry({ distinctRepostOf: approved })); it.record.importSource.distinctRepostOf = { postId: "T315", record: 606 };
  assert.match(itemProblems(it).join(" "), /another post's id/);
});

test("story page: the note is shown apart from Hal's paragraphs, escaped, with the source link; pages without a note are unchanged", () => {
  const D = loadData();
  const s = D.stories.find(x => x.published && !(x.storyPhotos.items || []).length);
  assert.ok(s, "a published story without photos in data/stories.json");
  const before = storyPageHTML(s, D.site, null, null, []);
  assert.doesNotMatch(before, /archive-note/);
  assert.match(before, /class="cover-note"/);
  const noted = Object.assign({}, s, { archiveNote: { text: "Partial transcription: <three> lines of lyrics are omitted.", sourceUrl: URL_A } });
  const after = storyPageHTML(noted, D.site, null, null, []);
  assert.match(after, /<aside class="archive-note" role="note" aria-label="Archive note">/);
  assert.match(after, /Partial transcription: &lt;three&gt; lines of lyrics are omitted\./);
  assert.match(after, new RegExp('href="' + URL_A.replace(/[.?]/g, "\\$&") + '"'));
  assert.doesNotMatch(after, /class="cover-note"/);   // the note states what is missing instead of "No photograph survives"
  const narrated = h => (h.match(/data-narrate/g) || []).length;
  assert.equal(narrated(after), narrated(before));      // Hal's narrated paragraphs are untouched
  const noLink = storyPageHTML(Object.assign({}, s, { archiveNote: { text: "Note.", sourceUrl: "https://example.com/x" } }), D.site, null, null, []);
  assert.doesNotMatch(noLink, /example\.com/);
  // removing the note restores the page exactly
  assert.equal(storyPageHTML(Object.assign({}, s), D.site, null, null, []), before);
});
