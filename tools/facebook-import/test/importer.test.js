"use strict";
// Local-only tests: node --test tools/facebook-import/test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { toStory } = require("../lib/text.js");
const { buildRecord, longDate, labelDate, readingTime } = require("../lib/record.js");
const { checkEntry } = require("../lib/dupes.js");
const { checkImages } = require("../lib/images.js");
const { Ledger } = require("../lib/ledger.js");
const { AdminApi } = require("../lib/api.js");
const { plan } = require("../import.js");

// Synthetic site snapshot: fictional ids, titles, dates and text (no real memory or Draft).
const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "synthetic-site-snapshot.json"), "utf8"));

// 1x1 PNG
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

function tmpImage(name, buf) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "hlimp-")); const f = path.join(d, name); fs.writeFileSync(f, buf || PNG); return f; }

test("removes standalone hashtag lines and the Facebook label, keeps wording", () => {
  const r = toStory("#ShabbatShalom \nMay your evening be calm and bright.\n#HarlansLegacy See less", "A Calm and Bright Evening");
  assert.deepStrictEqual(r.paragraphs, ["May your evening be calm and bright."]);
  assert.strictEqual(r.removed.length, 3);
});

test("removes Week/Issue header and a title line that equals the title", () => {
  const r = toStory("#HarlansLegacy #ShabbatShalom #OldChairs\nWeek #512\nThere’s a story in every old chair.\nSome tell it louder than others.", "The Chair by the Window");
  assert.deepStrictEqual(r.paragraphs, ["There’s a story in every old chair.", "Some tell it louder than others."]);
  const t = toStory("#HarlansLegacy #ShabbatShalom #OldMaps\nThe Map in the Drawer\nYears ago, we found a folded map.", "The Map in the Drawer", { titleIsHeading: true });
  assert.strictEqual(t.titleLineRemoved, true);
  assert.deepStrictEqual(t.paragraphs, ["Years ago, we found a folded map."]);
  // a title taken from the opening sentence never removes that sentence
  const s = toStory("#ShabbatShalom\nNot every lamp needs a shade!\nThis week we look closer.", "Not Every Lamp Needs a Shade");
  assert.strictEqual(s.titleLineRemoved, false);
  assert.deepStrictEqual(s.paragraphs, ["Not every lamp needs a shade!", "This week we look closer."]);
});

test("recognises hyphenated tags and the split '#Shabbat Shalom' tag as tag lines", () => {
  assert.deepStrictEqual(toStory("#HarlansLegcy #shabbatshalom #Fri-day-vibes\nThe kettle is on.", "X").paragraphs, ["The kettle is on."]);
  assert.deepStrictEqual(toStory("#HarlansLegacy  #Shabbat Shalom #LiveFromHome \nThis Shabbat, the table is set.", "X").paragraphs, ["This Shabbat, the table is set."]);
  assert.deepStrictEqual(toStory("Shabbat Shalom and happy Friday.\nMore.", "X").paragraphs, ["Shabbat Shalom and happy Friday.", "More."]);
});

test("typo'd tag lines are kept and suggested, removed only when approved", () => {
  const raw = "#HarlansLegacy #ShabbatShalom#TheLamp\nPerhaps you know more about this brass lamp than we do.";
  const kept = toStory(raw, "The Brass Lamp");
  assert.strictEqual(kept.paragraphs[0], "#HarlansLegacy #ShabbatShalom#TheLamp");
  assert.ok(/typos/.test(kept.suggestedRemovals[0].reason));
  const approved = toStory(raw, "The Brass Lamp", { removeLines: ["#HarlansLegacy #ShabbatShalom#TheLamp"] });
  assert.deepStrictEqual(approved.paragraphs, ["Perhaps you know more about this brass lamp than we do."]);
  const sentence = toStory("#ShabbatShalom Tonight, as the candles are lit, may you rest well.", "As the Candles Are Lit");
  assert.ok(/begins with hashtags/.test(sentence.suggestedRemovals[0].reason));
});

test("keeps hashtags that sit inside a sentence and only reports punctuation", () => {
  const r = toStory("#ShabbatShalom #HarlansLegacy it's fine,, we can disagree kindly.", "Kindly");
  assert.deepStrictEqual(r.paragraphs, ["#ShabbatShalom #HarlansLegacy it's fine,, we can disagree kindly."]);
  assert.strictEqual(r.inlineHashtags, true);
  assert.ok(r.candidates.some(c => c.issue === "repeated commas"));
});

test("record matches the Editorial Workspace collect() shape", () => {
  const { requestBody: b, storedPreview: s } = buildRecord({ postId: "T101", title: "A Calm and Bright Evening", category: "shabbat", publishedISO: "2018-02-02" }, ["May your evening be calm and bright."], 107);
  assert.strictEqual(b.status, "draft"); assert.strictEqual(b.featured, false);
  assert.strictEqual(b.dateLong, "February 2, 2018"); assert.strictEqual(b.dateLabel, "Feb 2018");
  assert.strictEqual(b.lead, "May your evening be calm and bright."); assert.deepStrictEqual(b.body, []);
  assert.strictEqual(b.readingTime, 1);
  assert.strictEqual(s.slug, "a-calm-and-bright-evening");   // server normalize() from this checkout
  assert.strictEqual(longDate("2024-12-27"), "December 27, 2024"); assert.strictEqual(labelDate("2024-12-27"), "Dec 2024");
  assert.strictEqual(readingTime(new Array(500).fill("word")), 3);
});

test("detects an existing Draft and on-site posts as duplicates", () => {
  const draft = checkEntry({ postId: "T101", title: "Anything", publishedISO: "2018-02-02" }, ["May your evening be calm and bright."], snapshot.memories, {});
  assert.ok(draft.some(d => d.severity === "block"));
  const site = checkEntry({ postId: "T999", title: "New", publishedISO: "2020-01-01" }, ["For as long as anyone could remember, a postcard of a lighthouse leaned against the clock on the shelf by the door, beside the keys."], snapshot.memories, {});
  assert.ok(site.some(d => d.kind === "same-opening-text"));
  const fresh = checkEntry({ postId: "T102", title: "A Quiet Morning", publishedISO: "2018-03-09" }, ["May your morning be quiet and kind."], snapshot.memories, {});
  assert.ok(!fresh.some(d => d.severity === "block"));
});

test("image checks: order, Primary, count, missing files", () => {
  const a = tmpImage("a.png"), b = tmpImage("b.png", Buffer.concat([PNG, Buffer.from([0])]));
  const ok = checkImages([{ order: 1, path: a }, { order: 2, path: b }], 2);
  assert.strictEqual(ok.problems.length, 0); assert.strictEqual(ok.primary.order, 1); assert.strictEqual(ok.files[0].width, 1);
  const bad = checkImages([{ order: 1, path: a }, { order: 3, path: "nope.jpg" }], 3);
  assert.ok(bad.problems.some(p => /order gap/.test(p))); assert.ok(bad.problems.some(p => /missing file/.test(p))); assert.ok(bad.problems.some(p => /count/.test(p)));
  const twice = checkImages([{ order: 1, path: a }, { order: 2, path: a }], 2);
  assert.ok(twice.problems.some(p => /twice/.test(p)));
});

test("plan: oldest first, ids after the snapshot, never a protected id, resumes from the ledger", () => {
  const img = tmpImage("p.png");
  const entry = (id, date, extra) => Object.assign({ postId: id, facebookUrl: null, facebookTimeChicago: date + " 17:00 Fri", publishedISO: date, title: "Title " + id, category: "shabbat",
    sourceText: "#ShabbatShalom\nUnique text for " + id + " about a family story.", flags: [], hold: false, approved: true, photos: { expectedCount: 1, expectedIsEstimate: false, files: [{ order: 1, path: img }] } }, extra || {});
  const manifest = { entries: [entry("T103", "2018-04-13"), entry("T102", "2018-03-09"), entry("T101", "2018-02-02", { sourceText: "#ShabbatShalom\nMay your evening be calm and bright." })] };
  const r1 = plan(manifest, snapshot, {});
  assert.deepStrictEqual(r1.items.map(i => i.postId), ["T101", "T102", "T103"]);
  assert.strictEqual(r1.items[0].readiness, "SKIP_DUPLICATE");
  assert.deepStrictEqual(r1.items.slice(1).map(i => i.record.id), [107, 108]);
  assert.deepStrictEqual(r1.items[1].requests.filter(q => q.method === "POST").map(q => q.path), ["/api/stories", "/api/story-photos/107"]);
  assert.strictEqual(r1.items[1].requests[1].primary, true);
  // resume: T102 created as 107 with its image done but not verified -> only read-backs remain
  const r2 = plan(manifest, snapshot, { ledgerState: { T102: { storyId: 107, imagesDone: [1], verified: false } } });
  const p5 = r2.items.find(i => i.postId === "T102");
  assert.strictEqual(p5.readiness, "RESUME"); assert.strictEqual(p5.requests.filter(q => q.method === "POST").length, 0);
  assert.strictEqual(p5.record.id, 107);
  assert.strictEqual(r2.items.find(i => i.postId === "T103").record.id, 108);   // never reuses a ledger id
});

test("ledger records steps and owned ids", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hlled-")), "ledger.jsonl");
  const l = new Ledger(f);
  l.append({ postId: "T102", step: "created", storyId: 107 }); l.append({ postId: "T102", step: "image", order: 1 }); l.append({ postId: "T102", step: "verified" });
  assert.deepStrictEqual(l.state().T102, { storyId: 107, imagesDone: [1], verified: true, lastError: null });
  assert.ok(l.ownedIds().has(107)); assert.ok(!l.ownedIds().has(101));
});

test("API client refuses every write in this build and needs a token to read", async () => {
  const api = new AdminApi({ token: "", fetch: () => { throw new Error("network must not be used"); } });
  assert.throws(() => api.createStory({}), /disabled/);
  assert.throws(() => api.uploadImage(1, "a.jpg", "data:"), /disabled/);
  await assert.rejects(() => api.listStories(), /HL_ADMIN_TOKEN/);
});

test("zero-photo posts: text-only plan uploads nothing; every post must declare photoMode (fails closed)", () => {
  const { preflight, approvalFingerprint } = require("../lib/batch.js");
  const img = tmpImage("01__a.png");
  const entry = (id, date, extra) => Object.assign({ postId: id, facebookUrl: null, facebookTimeChicago: date + " 17:00 Fri", publishedISO: date, title: "Title " + id, category: "shabbat",
    sourceText: "#ShabbatShalom\nUnique zero-photo text for " + id + " about a family story.", flags: [], hold: false, approved: true, photos: { expectedCount: 1, expectedIsEstimate: false, files: [{ order: 1, path: img }] } }, extra || {});
  const manifest = { entries: [entry("T901", "2019-05-03", { excludeImages: true }), entry("T902", "2019-05-10", { photos: { expectedCount: 0, expectedIsEstimate: false, files: [] }, photosConfirmedNone: true }), entry("T903", "2019-05-17")] };
  const r = plan(manifest, snapshot, {});
  const [t, n, w] = r.items;
  assert.deepStrictEqual([t.readiness, n.readiness, w.readiness], ["READY", "READY", "READY"]);
  assert.deepStrictEqual([t.photoMode, n.photoMode, w.photoMode], ["none", "none", "photos"]);
  assert.strictEqual(t.images.length, 0); assert.strictEqual(t.imagesExcluded, 1);
  assert.deepStrictEqual(t.requests.filter(q => q.method === "POST").map(q => q.path), ["/api/stories"]);
  assert.deepStrictEqual(n.requests.filter(q => q.method === "POST").map(q => q.path), ["/api/stories"]);
  const it = x => ({ postId: x.postId, photoMode: x.photoMode, images: x.images, record: x.record });
  const items = r.items.map(it);
  const ok = Object.fromEntries(items.map(i => [i.postId, approvalFingerprint(i)]));
  const read = f => fs.readFileSync(f);
  assert.deepStrictEqual(preflight(items, ok, read), []);
  // photoMode missing (with or without photos) or invalid: stop
  const undecided = Object.assign({}, items[0], { photoMode: undefined });
  assert.match(preflight([undecided], { T901: approvalFingerprint(undecided) }, read).join(), /photoMode missing/);
  const undeclared = Object.assign({}, items[2], { photoMode: undefined });
  assert.match(preflight([undeclared], { T903: approvalFingerprint(undeclared) }, read).join(), /photoMode missing/);
  const invalid = Object.assign({}, items[2], { photoMode: "Photos" });
  assert.match(preflight([invalid], { T903: approvalFingerprint(invalid) }, read).join(), /invalid photoMode "Photos"/);
  // approved without photos, but photos listed (or the reverse): stop
  const both = Object.assign({}, items[2], { photoMode: "none" });
  assert.match(preflight([both], { T903: approvalFingerprint(both) }, read).join(), /approved without photos but 1/);
  const lost = Object.assign({}, items[2], { images: [] });
  assert.match(preflight([lost], { T903: approvalFingerprint(lost) }, read).join(), /approved with photos but none listed/);
  // switching a post from photos to none after approval changes its fingerprint
  assert.notStrictEqual(approvalFingerprint(items[2]), approvalFingerprint(Object.assign({}, items[2], { photoMode: "none", images: [] })));
});
