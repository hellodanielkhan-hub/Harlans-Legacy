/* Hal's own Blog Issue headers kept in the story text (importer keepLines), end to end in isolation: the
   importer's toStory() with keepLines, the importer's runBatch() import as Drafts, lib/run.js publishBatch()
   (all its public checks, including "no Story Number shown"), the real API in file mode and the real build.
   The header is Hal's text, not a calculated Story Number: it shows once, as a paragraph, and the site shows
   no Story Number anywhere. Synthetic story text; the header lines are the real batch-07 ones. No real data.
     node --test tools/story-numbers/test/blog-issue-header.test.js */
"use strict";
delete process.env.HL_STORY_NUMBERS_DISPLAY;
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fx = require("./fixture.js");
const { startSite, importBatch, publishSession, WT } = require("./batch-site.js");

fx.cleanEnv();
const { root } = fx.makeRoot();
const site = startSite(root);
const { approvalFingerprint, IMPORT_SYSTEM } = require(path.join(WT, "tools", "facebook-import", "lib", "batch.js"));
const { payloadFingerprint } = require(path.join(WT, "tools", "facebook-import", "lib", "authorize.js"));
const { toStory } = require(path.join(WT, "tools", "facebook-import", "lib", "text.js"));
const run = require("../lib/run.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hl-blog-issue-"));

const POSTS = [
  { postId: "H381", header: "Issue #376", title: "Some Memories Fade", heading: false,
    text: "#HarlansLegacy #ShabbatShalom #MothersDay\nIssue #376\nSix days says Shabbat and another edition of the blog!\nSome memories fade.\n#HarlansLegacy" },
  { postId: "H384", header: "Blog Issue #378", title: "Harmony", heading: false,
    text: "#HarlansLegacy #ShabbatShalom #Harmony \nBlog Issue #378\nThis week’s photo is calligraphy.\nFour simple characters:" },
  { postId: "H386", header: "Blog issue 380 The Orange Picture", title: "The Orange Picture", heading: true,
    text: "#HarlansLegacy   #shabbatshalom   #Orange \nBlog issue 380 The Orange Picture\nShabbat Shalom.\nThis week’s portion begins with the lamps." }
];
const items = POSTS.map((p, i) => {
  const t = toStory(p.text, p.title, { titleIsHeading: p.heading, keepLines: [p.header] });
  const record = { id: 431 + i, storyNumber: null, title: p.title, slug: "", status: "draft", featured: false, theme: "shabbat",
    publishedISO: "2025-0" + (5 + i) + "-0" + (2 + i), dateLong: "", dateLabel: "", memoryDate: null, summary: "", description: null, ogDescription: null,
    lead: t.paragraphs[0], body: t.paragraphs.slice(1), people: [], places: [], objects: [], events: [], bookPart: null, keywords: [], echoStories: [],
    readingTime: 1, readerImages: [], importSource: { system: IMPORT_SYSTEM, postId: p.postId, facebookUrl: null, facebookTimeChicago: null } };
  return { postId: p.postId, photoMode: "none", images: [], record };
});
const P = { batch: 7, items, counts: { posts: 3, withPhotos: 0, withoutPhotos: 3, photos: 0 } };
P.approvedFingerprints = Object.fromEntries(items.map(it => [it.postId, approvalFingerprint(it)]));
const IMPORT_LEDGER = path.join(tmp, "import-07.jsonl");
let ids = [];

test.before(async () => {
  await site.start();
  const r = await importBatch(site, P, IMPORT_LEDGER);
  assert.equal(r.result.stopped, null, JSON.stringify(r.result.stopped));
  ids = r.ids;
});
test.after(() => { site.close(); fx.removeRoot(root); fs.rmSync(tmp, { recursive: true, force: true }); });

const page = id => { const d = path.join(root, "story"); const f = fs.readdirSync(d).find(n => n.startsWith(id + "-") && n.endsWith(".html")); return f ? fs.readFileSync(path.join(d, f), "utf8") : null; };
const count = (s, sub) => s.split(sub).length - 1;

test("the Drafts carry each header exactly once, as paragraph 1, with no Story Number or Blog number derived from it", () => {
  for (const [i, p] of POSTS.entries()) {
    const s = site.stories().find(x => x.id === ids[i]);
    assert.equal(s.status, "draft"); assert.equal(s.featured, false);
    assert.equal(s.lead, p.header, p.postId);
    assert.equal([s.lead].concat(s.body).filter(x => x === p.header).length, 1, p.postId + ": no duplicate header");
    assert.equal(s.storyNumber == null && s.originalBlogNumber == null, true, p.postId + ": unnumbered");
  }
});

test("published through the safeguarded publisher: all public checks pass, the header shows once as a paragraph, no Story Number anywhere", async () => {
  const r = await publishSession(site, { ledgerPath: path.join(tmp, "publish.jsonl"), backupDir: path.join(tmp, "backup"), payload: P, fingerprint: payloadFingerprint(P),
    importLedgerPath: IMPORT_LEDGER, answer: run.BATCH_PUBLISH_PHRASE(3, "batch-07") });
  assert.equal(r.report.stopped, undefined, r.report.stage + ": " + r.report.stopped);
  assert.deepEqual(r.writes, ["/api/stories/publish"]);
  assert.ok(r.report.steps.some(s => s.step === "public-unnumbered") && r.report.steps.some(s => s.step === "public-final"));
  for (const [i, p] of POSTS.entries()) {
    const html = page(ids[i]);
    assert.ok(html, p.postId + ": page built");
    const esc = p.header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.equal((html.match(new RegExp("<p(\\s[^>]*)?>\\s*" + esc + "\\s*</p>", "g")) || []).length, 1, p.postId + ": the header is one paragraph, once");
    const body = html.slice(html.indexOf("<body"));
    assert.equal(count(body.replace(/<[^>]+>/g, " "), p.header), 1, p.postId + ": the header text appears once on the whole page");
    assert.equal(count(html.slice(0, html.indexOf("<body")), p.header), 0, p.postId + ": not in the page title or meta tags");
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, p.postId + ": one heading (the title), no heading made from the header");
    assert.doesNotMatch(html, /<h[1-6][^>]*>[^<]*(Issue|issue) #?\d/, p.postId + ": the header is never a heading");
    assert.equal(html.includes("No.&nbsp;"), false, p.postId + ": no Story Number in the provenance");
    assert.doesNotMatch(html, /Story No\./, p.postId + ": no Story No. label");
  }
  const sj = fs.readFileSync(path.join(root, "stories.js"), "utf8");
  assert.doesNotMatch(sj, /"storyNumber":\s*\d/, "stories.js carries no Story Number");
  for (const f of ["index.html", "archive.html"]) {
    const h = fs.readFileSync(path.join(root, f), "utf8");
    assert.equal(h.includes("No.&nbsp;"), false, f + ": no Story Number");
  }
  assert.deepEqual(site.stories().filter(s => s.featured).map(s => s.id), [405], "This Week unchanged");
});
