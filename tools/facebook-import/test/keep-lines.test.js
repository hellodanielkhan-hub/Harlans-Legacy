"use strict";
/* keepLines: exact lines the owner approved for keeping although an importer rule would remove them
   (Hal's own Blog Issue headers, batch-07: P381 "Issue #376", P384 "Blog Issue #378",
   P386 "Blog issue 380 The Orange Picture"). Synthetic story text; the header lines are the real ones.
     node --test tools/facebook-import/test/keep-lines.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { toStory } = require("../lib/text.js");
const { plan } = require("../import.js");

const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "synthetic-site-snapshot.json"), "utf8"));
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hl-keeplines-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// the three batch-07 shapes: leading hashtag line, Hal's header, the story, a trailing hashtag line
const POSTS = {
  P381: { header: "Issue #376", title: "Some Memories Fade", titleIsHeading: false,
    text: "#HarlansLegacy #ShabbatShalom #MothersDay\nIssue #376\nSix days says Shabbat and another edition of the blog!\nSome memories fade.\nOthers stay.\n#HarlansLegacy" },
  P384: { header: "Blog Issue #378", title: "Harmony", titleIsHeading: false,
    text: "#HarlansLegacy #ShabbatShalom #Harmony \nBlog Issue #378\nThis week’s photo is calligraphy.\nFour simple characters:\n#Harmony" },
  P386: { header: "Blog issue 380 The Orange Picture", title: "The Orange Picture", titleIsHeading: true,
    text: "#HarlansLegacy   #shabbatshalom   #Orange \nBlog issue 380 The Orange Picture\nShabbat Shalom.\nThis week’s portion begins with the lamps.\n#Orange" }
};

test("without keepLines nothing changes: the header is removed as before", () => {
  for (const [id, p] of Object.entries(POSTS)) {
    const r = toStory(p.text, p.title, { titleIsHeading: p.titleIsHeading });
    assert.ok(!r.paragraphs.includes(p.header), id);
    assert.ok(r.removed.some(x => x.line === p.header && x.reason === "Week/Issue number header"), id);
    assert.deepEqual(r.keptLines, []);
    assert.deepEqual(toStory(p.text, p.title, { titleIsHeading: p.titleIsHeading, keepLines: [] }), r, id + ": an empty keepLines is the same as none");
  }
});

test("P381, P384, P386: the original header is kept exactly, once, in its place; every other rule applies as before", () => {
  for (const [id, p] of Object.entries(POSTS)) {
    const before = toStory(p.text, p.title, { titleIsHeading: p.titleIsHeading });
    const r = toStory(p.text, p.title, { titleIsHeading: p.titleIsHeading, keepLines: [p.header] });
    assert.equal(r.paragraphs[0], p.header, id + ": the header is paragraph 1, exactly as written");
    assert.equal(r.paragraphs.filter(x => x === p.header).length, 1, id + ": no duplicate header");
    assert.equal(r.paragraphs.filter(x => x.includes(p.header)).length, 1, id + ": the header text appears in no other paragraph");
    assert.deepEqual(r.paragraphs.slice(1), before.paragraphs, id + ": the rest of the text is exactly what it was");
    assert.deepEqual(r.removed, before.removed.filter(x => x.line !== p.header), id + ": the same lines are removed, apart from the header");
    assert.deepEqual(r.keptLines, [p.header]);
    assert.equal(r.titleLineRemoved, before.titleLineRemoved, id);
    assert.ok(r.paragraphs.every(x => !/^#\S+(\s+#\S+)*$/.test(x)), id + ": hashtag-only lines are still removed");
  }
});

test("P386: a kept header that names the title is not taken as the title line; a real title line after it still is", () => {
  const p = POSTS.P386;
  const r = toStory(p.text, p.title, { titleIsHeading: true, keepLines: [p.header] });
  assert.equal(r.titleLineRemoved, false);
  assert.equal(r.paragraphs[0], p.header);
  // the same post with its title typed again after the header: that title line is still removed, as before
  const withTitle = p.text.replace(p.header + "\n", p.header + "\nThe Orange Picture\n");
  const was = toStory(withTitle, p.title, { titleIsHeading: true });
  const now = toStory(withTitle, p.title, { titleIsHeading: true, keepLines: [p.header] });
  assert.equal(was.titleLineRemoved, true); assert.equal(now.titleLineRemoved, true);
  assert.deepEqual(now.paragraphs, [p.header].concat(was.paragraphs));
  assert.equal(now.paragraphs.filter(x => x === "The Orange Picture").length, 0, "no duplicate heading");
});

test("a kept line never changes how the lines around it are treated", () => {
  // a second hashtag line or number header after the kept header is removed, exactly as without keepLines
  const raw = "#A #B\nBlog Issue #378\n#C #D\nWeek #12\nThe story starts here.\n#E";
  const was = toStory(raw, "X"), now = toStory(raw, "X", { keepLines: ["Blog Issue #378"] });
  assert.deepEqual(was.paragraphs, ["The story starts here."]);
  assert.deepEqual(now.paragraphs, ["Blog Issue #378", "The story starts here."]);
  // keepLines lines are matched as whole, exact lines: a sentence that only contains the words is untouched
  const s = toStory("#A\nIn Blog Issue #378 we wrote about tea.\nMore.", "X", { keepLines: ["Blog Issue #378"] });
  assert.deepEqual(s.paragraphs, ["In Blog Issue #378 we wrote about tea.", "More."]);
  assert.deepEqual(s.keptLines, []);
});

// ---- plan(): refuses a keepLines line that is not a line of the post; other entries are unaffected ----
const img = (name) => { const f = path.join(tmp, name); fs.writeFileSync(f, PNG); return f; };
const entry = (id, date, extra) => Object.assign({ postId: id, facebookUrl: null, facebookTimeChicago: date + " 17:00 Fri", publishedISO: date, title: "Title " + id, category: "shabbat",
  sourceText: "#ShabbatShalom\nUnique keepLines text for " + id + " about a family story.", flags: [], hold: false, approved: true,
  photos: { expectedCount: 0, expectedIsEstimate: false, files: [] }, photosConfirmedNone: true }, extra || {});

test("plan(): a keepLines line that is missing or appears twice blocks the entry; the other entries plan exactly as before", () => {
  const withHeader = entry("K101", "2025-05-02", { sourceText: "#HarlansLegacy #ShabbatShalom\nIssue #376\nUnique text K101 about a kitchen table.", keepLines: ["Issue #376"] });
  const other = entry("K102", "2025-05-09", { photos: { expectedCount: 1, expectedIsEstimate: false, files: [{ order: 1, path: img("01__k102.png") }] }, photosConfirmedNone: false });
  const r = plan({ entries: [withHeader, other] }, snapshot, {});
  const [a, b] = r.items;
  assert.equal(a.readiness, "READY", a.reasons.join("; "));
  assert.equal(a.record.lead, "Issue #376");
  const alone = plan({ entries: [Object.assign({}, other)] }, snapshot, {}).items[0];
  const noIds = x => Object.assign({}, x, { record: Object.assign({}, x.record, { id: 0 }), storedPreview: Object.assign({}, x.storedPreview, { id: 0 }), requests: null });   // ids are provisional
  assert.deepEqual(noIds(b), noIds(alone),
    "the other entry's text, photos and checks are identical");
  const missing = plan({ entries: [entry("K103", "2025-05-16", { keepLines: ["Issue #999"] })] }, snapshot, {}).items[0];
  assert.equal(missing.readiness, "BLOCKED"); assert.match(missing.reasons.join(), /keepLines: "Issue #999" is not a line of the post/);
  const twice = plan({ entries: [entry("K104", "2025-05-23", { sourceText: "#A\nIssue #376\nUnique text K104.\nIssue #376", keepLines: ["Issue #376"] })] }, snapshot, {}).items[0];
  assert.equal(twice.readiness, "BLOCKED"); assert.match(twice.reasons.join(), /appears 2 times/);
});

// ---- build-batch-payload.js end to end: keepLines from the approval; inputs never written ----
const BUILD = path.join(__dirname, "..", "build-batch-payload.js");
function files(posts, approvals) {
  const d = fs.mkdtempSync(path.join(tmp, "build-"));
  const m = path.join(d, "manifest.json"), a = path.join(d, "approved.json"), s = path.join(d, "snapshot.json");
  fs.writeFileSync(m, JSON.stringify({ entries: posts }));
  fs.writeFileSync(a, JSON.stringify({ batch: 9, postIds: approvals.map(x => x.postId), posts: approvals }));
  fs.writeFileSync(s, JSON.stringify(snapshot));
  return { d, m, a, s, out: path.join(d, "payload.json") };
}
const build = f => { try { execFileSync(process.execPath, [BUILD, "--manifest", f.m, "--approved", f.a, "--snapshot", f.s, "--out", f.out], { stdio: "pipe" }); return { ok: true }; } catch (e) { return { ok: false, err: String(e.stderr) }; } };
const hashes = f => [f.m, f.a, f.s].map(x => sha(fs.readFileSync(x)));

test("build-batch-payload: the approval's keepLines keeps the header; other posts, photos and the inputs are unchanged", () => {
  const photo = img("01__k202.png");
  const p1 = entry("K201", "2025-06-06", { sourceText: POSTS.P384.text.replace("This week’s photo", "Unique K201 photo"), title: "Harmony" });
  const p2 = entry("K202", "2025-06-13", { photos: { expectedCount: 1, expectedIsEstimate: false, files: [{ order: 1, path: photo }] }, photosConfirmedNone: false });
  const text1 = toStory(p1.sourceText, p1.title, { keepLines: ["Blog Issue #378"] }).paragraphs, text2 = toStory(p2.sourceText, p2.title).paragraphs;
  const appr = (e, text, extra) => Object.assign({ postId: e.postId, title: e.title, category: "Jewish Life / Shabbat", websiteText: text, sourceTextSha256: sha(e.sourceText), photos: [] }, extra || {});
  const a2 = appr(p2, text2, { photos: [{ order: 1, primary: true, file: photo, sha256: sha(PNG) }] });
  const f = files([p1, p2], [appr(p1, text1, { keepLines: ["Blog Issue #378"], excludeImages: false }), a2]);
  const h0 = hashes(f), r = build(f);
  assert.ok(r.ok, r.err);
  assert.deepEqual(hashes(f), h0, "manifest (Facebook source text), approval and snapshot are never written");
  const P = JSON.parse(fs.readFileSync(f.out, "utf8"));
  const it1 = P.items.find(i => i.postId === "K201"), it2 = P.items.find(i => i.postId === "K202");
  assert.equal(it1.record.lead, "Blog Issue #378");
  assert.deepEqual([it1.record.lead].concat(it1.record.body), text1);
  assert.equal(it1.record.storyNumber, null, "no Story Number is derived from the header");
  assert.ok(it1.record.originalBlogNumber == null, "no Blog number is derived from the header");
  assert.deepEqual(P.checks.find(c => c.postId === "K201").keptPerApproval, ["Blog Issue #378"]);
  // the photo post: built alone without any keepLines in the batch, byte-identical item
  const g = files([p2], [a2]); assert.ok(build(g).ok);
  const alone = JSON.parse(fs.readFileSync(g.out, "utf8")).items[0];
  assert.deepEqual(Object.assign({}, it2, { record: Object.assign({}, it2.record, { id: 0 }) }), Object.assign({}, alone, { record: Object.assign({}, alone.record, { id: 0 }) }));
  assert.equal(P.checks.find(c => c.postId === "K202").keptPerApproval, undefined);
  // an approval without keepLines but with the header in its text is refused (the importer would remove it)
  const h = files([p1], [appr(p1, text1)]); const bad = build(h);
  assert.equal(bad.ok, false); assert.match(bad.err, /K201/);
  // a keepLines line that is not in the approved website text is refused
  const k = files([p1], [appr(p1, text1.slice(1), { keepLines: ["Blog Issue #378"] })]); const bad2 = build(k);
  assert.equal(bad2.ok, false); assert.match(bad2.err, /keepLines "Blog Issue #378" is not in the approved website text/);
  assert.equal(fs.existsSync(h.out) || fs.existsSync(k.out), false, "a refused build writes no payload");
});
