/* Every public place a Story Number appears, from a real build of a throwaway copy: the Story Number is
   shown, the record id never is, and a published memory without a Story Number shows no number at all.
     node --test tools/story-numbers/test/render.test.js */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
// These tests cover the mode in which Story Numbers ARE displayed (unnumbered.test.js covers the paused mode).
process.env.HL_STORY_NUMBERS_DISPLAY = "on";
const fx = require("./fixture.js");

fx.cleanEnv();
const { root, records } = fx.makeRoot();
const numbering = require(path.join(fx.WT, "lib", "numbering.js"));
const map = new Map(numbering.assignments().map(a => [a.id, a]));
// the released state, except record 303: published but (in this test only) without a Story Number
for (const s of records) {
  const a = map.get(s.id);
  s.storyNumber = s.id === 303 ? null : a.storyNumber;
  s.originalBlogNumber = a.originalBlogNumber == null ? null : a.originalBlogNumber;
  if ([405, 403, 402, 303].includes(s.id)) s.people = ["Harlan"];           // one shared person -> related cards, family list, explore cards
}
fs.writeFileSync(path.join(root, "data", "stories.json"), JSON.stringify(records, null, 2) + "\n");
execFileSync(process.execPath, [path.join(fx.WT, "build.js")], { env: Object.assign({}, process.env, { HL_DATA_DIR: root }), stdio: "ignore" });
test.after(() => fx.removeRoot(root));

const read = rel => fs.readFileSync(path.join(root, rel), "utf8");
const page = id => { const s = records.find(r => r.id === id); return read(path.join("story", id + "-" + s.slug + ".html")); };
const PUBLISHED = records.filter(s => s.status === "published");

test("story pages keep their URLs and show the Story Number in provenance, footer and listening badge", () => {
  for (const s of PUBLISHED) assert.ok(fs.existsSync(path.join(root, "story", s.id + "-" + s.slug + ".html")), "URL story/" + s.id + "-" + s.slug + ".html");
  const h = page(405);
  assert.match(h, /data-record-id="405" data-story-id="447"/);
  assert.ok(h.includes("No.&nbsp;<b>447</b>"), "provenance");
  assert.ok(h.includes("<span>Story No. 447</span>"), "footer");
  assert.ok(!h.includes("No.&nbsp;<b>405</b>") && !/Story No\. 405\b/.test(h), "never the record id");
  assert.ok(!/Story No\. \d+ of \d+/.test(h) && !h.includes(" of 378"), "the hardcoded total is gone");
  assert.ok(h.includes(`There are ${PUBLISHED.length - 1} more of these`), "the real published count");
  assert.ok(h.includes("Kept the way every Friday is."), "coda without a total");
});

test("a published memory without a Story Number shows no number anywhere (no record-id fallback)", () => {
  const h = page(303);
  assert.match(h, /data-record-id="303" data-story-id=""/);
  assert.ok(!h.includes("No.&nbsp;<b>"), "provenance shows no number");
  const footer = /<div class="footer-bottom">([\s\S]*?)<\/div>/.exec(h)[1];
  assert.ok(!/Story No\./.test(footer), "footer shows no number");
  assert.ok(!/No\.(&nbsp;| )303\b/.test(h), "never the record id");
  assert.ok(!read("archive.html").includes("No.&nbsp;303<br>"));
  assert.ok(!JSON.parse(read("search-index.json")).some(r => r.type === "story" && /No\. 303\b/.test(r.subtitle || "")));
});

test("homepage: This Week stamp, earlier-memory line and archive shelf-mark use Story Numbers", () => {
  const h = read("index.html");
  assert.ok(h.includes('class="tw-stamp">No.&nbsp;447 '), "This Week = No. 447");
  assert.ok(!/tw-stamp">No\.&nbsp;405/.test(h));
  const kicker = /class="tw-kicker">([^<]*)</.exec(h);
  const second = PUBLISHED.filter(s => s.id !== 405).sort((a, b) => (a.publishedISO < b.publishedISO ? 1 : -1))[0];
  assert.ok(kicker && kicker[1].endsWith("No.&nbsp;" + second.storyNumber), "earlier memory (record " + second.id + ") shows its Story Number: " + (kicker && kicker[1]));
  const nos = PUBLISHED.map(s => s.storyNumber).filter(n => n != null);
  assert.ok(h.includes(`Nos.&nbsp;${Math.min(...nos)}&thinsp;–&thinsp;${Math.max(...nos)}`), "shelf-mark range of Story Numbers");
});

test("archive cards, search, stories.js, related cards, family and explore lists use Story Numbers", () => {
  const a = read("archive.html");
  for (const s of PUBLISHED.filter(x => x.storyNumber)) assert.ok(a.includes("No.&nbsp;" + s.storyNumber + "<br>"), "archive card " + s.id);
  const idx = JSON.parse(read("search-index.json")).filter(r => r.type === "story");
  const r405 = idx.find(r => r.title === records.find(s => s.id === 405).title);
  assert.match(r405.subtitle, /^No\. 447 · /);
  assert.ok(/\bno 447\b/.test(r405.keywords) && !/\bno 405\b/.test(r405.keywords), "search keywords");
  const js = read("stories.js");
  assert.ok(js.includes('"storyNumber": 447') && js.includes('"storyNumber": null'));
  const related = page(405);
  assert.ok(/cp-label">No\.&nbsp;(446|385) &middot; shares/.test(related), "related card shows a Story Number");
  assert.ok(!/cp-label">No\.&nbsp;(403|402)\b/.test(related));
  const fam = read(path.join("family", "harlan.html"));
  assert.ok(fam.includes("Story No. 447 · read →") && !/Story No\. 405\b/.test(fam), "family list");
  assert.ok(/<span class="st-meta">read →<\/span>/.test(fam), "the unnumbered memory lists without a number");
  const explore = fs.readdirSync(root).filter(f => /\.html$/.test(f)).map(f => read(f)).join("\n") + fam;
  assert.ok(!/xc-meta">Story No\. (303|405)</.test(explore), "explore cards never show a record id");
});

test("no page anywhere shows a published record id as its number", () => {
  const files = [...fs.readdirSync(path.join(root, "story")).map(f => path.join("story", f)), "index.html", "archive.html",
    ...fs.readdirSync(path.join(root, "family")).map(f => path.join("family", f))];
  for (const f of files) {
    const h = read(f);
    for (const s of PUBLISHED) {
      if (s.storyNumber === s.id) continue;
      assert.ok(!h.includes("No.&nbsp;" + s.id + "<") && !h.includes("No.&nbsp;<b>" + s.id + "<") && !h.includes("Story No. " + s.id + " "), f + " shows record id " + s.id + " as a number");
    }
  }
});
