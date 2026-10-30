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

const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "site-snapshot-2026-10-30.json"), "utf8"));

// 1x1 PNG
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

function tmpImage(name, buf) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "hlimp-")); const f = path.join(d, name); fs.writeFileSync(f, buf || PNG); return f; }

test("removes standalone hashtag lines and the Facebook label, keeps wording", () => {
  const r = toStory("#ShabbatShalom \nMay your Sabbath be filled with the warm glow of peace and love.\n#HarlansLegacy See less", "The Warm Glow of Peace and Love");
  assert.deepStrictEqual(r.paragraphs, ["May your Sabbath be filled with the warm glow of peace and love."]);
  assert.strictEqual(r.removed.length, 3);
});

test("removes Week/Issue header and a title line that equals the title", () => {
  const r = toStory("#HarlansLegacy #ShabbatShalom #LaZBoy\nWeek #384\nThere’s a certain honesty in furniture.\nIt holds what we don’t always say out loud.", "The Furniture Remembers");
  assert.deepStrictEqual(r.paragraphs, ["There’s a certain honesty in furniture.", "It holds what we don’t always say out loud."]);
  const t = toStory("#HarlansLegacy #ShabbatShalom #GreatGreatGreat\nFollowing the Trail Harlan Left Us\nSix months ago, we shared a post.", "Following the Trail Harlan Left Us", { titleIsHeading: true });
  assert.strictEqual(t.titleLineRemoved, true);
  assert.deepStrictEqual(t.paragraphs, ["Six months ago, we shared a post."]);
  // a title taken from the opening sentence never removes that sentence
  const s = toStory("#ShabbatShalom\nNot all heroes wear capes!\nThis week we reflect.", "Not All Heroes Wear Capes");
  assert.strictEqual(s.titleLineRemoved, false);
  assert.deepStrictEqual(s.paragraphs, ["Not all heroes wear capes!", "This week we reflect."]);
});

test("recognises hyphenated tags and the split '#Shabbat Shalom' tag as tag lines", () => {
  assert.deepStrictEqual(toStory("#HarlansLegcy #shabbatshalom #Hal-a-daze\nFriday night is here.", "X").paragraphs, ["Friday night is here."]);
  assert.deepStrictEqual(toStory("#HarlansLegacy  #Shabbat Shalom #LiveFromNY \nThis Shabbat, we reflect.", "X").paragraphs, ["This Shabbat, we reflect."]);
  assert.deepStrictEqual(toStory("Shabbat Shalom and happy Friday.\nMore.", "X").paragraphs, ["Shabbat Shalom and happy Friday.", "More."]);
});

test("typo'd tag lines are kept and suggested, removed only when approved", () => {
  const raw = "#HarlansLegacy #ShabbatShalom#TheTable\nPerhaps you have more info on this picture than I do.";
  const kept = toStory(raw, "The Yaffe Family Table");
  assert.strictEqual(kept.paragraphs[0], "#HarlansLegacy #ShabbatShalom#TheTable");
  assert.ok(/typos/.test(kept.suggestedRemovals[0].reason));
  const approved = toStory(raw, "The Yaffe Family Table", { removeLines: ["#HarlansLegacy #ShabbatShalom#TheTable"] });
  assert.deepStrictEqual(approved.paragraphs, ["Perhaps you have more info on this picture than I do."]);
  const sentence = toStory("#ShabbatShalom Tonight, as the sun sets and shabbat begins, may you be at peace.", "As the Sun Sets");
  assert.ok(/begins with hashtags/.test(sentence.suggestedRemovals[0].reason));
});

test("keeps hashtags that sit inside a sentence and only reports punctuation", () => {
  const r = toStory("#ShabbatShalom #HarlansLegacy it's ok,, we don't always agree.", "Brave");
  assert.deepStrictEqual(r.paragraphs, ["#ShabbatShalom #HarlansLegacy it's ok,, we don't always agree."]);
  assert.strictEqual(r.inlineHashtags, true);
  assert.ok(r.candidates.some(c => c.issue === "repeated commas"));
});

test("record matches the Editorial Workspace collect() shape", () => {
  const { requestBody: b, storedPreview: s } = buildRecord({ postId: "P003", title: "The Warm Glow of Peace and Love", category: "shabbat", publishedISO: "2019-03-01" }, ["May your Sabbath be filled with the warm glow of peace and love."], 405);
  assert.strictEqual(b.status, "draft"); assert.strictEqual(b.featured, false);
  assert.strictEqual(b.dateLong, "March 1, 2019"); assert.strictEqual(b.dateLabel, "Mar 2019");
  assert.strictEqual(b.lead, "May your Sabbath be filled with the warm glow of peace and love."); assert.deepStrictEqual(b.body, []);
  assert.strictEqual(b.readingTime, 1);
  assert.strictEqual(s.slug, "the-warm-glow-of-peace-and-love");   // server normalize() from this checkout
  assert.strictEqual(longDate("2024-12-27"), "December 27, 2024"); assert.strictEqual(labelDate("2024-12-27"), "Dec 2024");
  assert.strictEqual(readingTime(new Array(500).fill("word")), 3);
});

test("detects the pilot Draft and on-site posts as duplicates", () => {
  const pilot = checkEntry({ postId: "P003", title: "Anything", publishedISO: "2019-03-01" }, ["May your Sabbath be filled with the warm glow of peace and love."], snapshot.memories, {});
  assert.ok(pilot.some(d => d.severity === "block"));
  const site = checkEntry({ postId: "P999", title: "New", publishedISO: "2020-01-01" }, ["Somewhere around 1970, a photographer captured a celebration at Northwood Villa in Erie, Michigan, just across the state line."], snapshot.memories, {});
  assert.ok(site.some(d => d.kind === "same-opening-text"));
  const fresh = checkEntry({ postId: "P005", title: "Kindness and Love for All", publishedISO: "2019-03-08" }, ["May your world be filled with kindness and love for all."], snapshot.memories, {});
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
  const manifest = { entries: [entry("P010", "2019-04-12"), entry("P005", "2019-03-08"), entry("P003", "2019-03-01", { sourceText: "#ShabbatShalom\nMay your Sabbath be filled with the warm glow of peace and love." })] };
  const r1 = plan(manifest, snapshot, {});
  assert.deepStrictEqual(r1.items.map(i => i.postId), ["P003", "P005", "P010"]);
  assert.strictEqual(r1.items[0].readiness, "SKIP_DUPLICATE");
  assert.deepStrictEqual(r1.items.slice(1).map(i => i.record.id), [405, 406]);
  assert.deepStrictEqual(r1.items[1].requests.filter(q => q.method === "POST").map(q => q.path), ["/api/stories", "/api/story-photos/405"]);
  assert.strictEqual(r1.items[1].requests[1].primary, true);
  // resume: P005 created as 405 with its image done but not verified -> only read-backs remain
  const r2 = plan(manifest, snapshot, { ledgerState: { P005: { storyId: 405, imagesDone: [1], verified: false } } });
  const p5 = r2.items.find(i => i.postId === "P005");
  assert.strictEqual(p5.readiness, "RESUME"); assert.strictEqual(p5.requests.filter(q => q.method === "POST").length, 0);
  assert.strictEqual(p5.record.id, 405);
  assert.strictEqual(r2.items.find(i => i.postId === "P010").record.id, 406);   // never reuses a ledger id
});

test("ledger records steps and owned ids", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hlled-")), "ledger.jsonl");
  const l = new Ledger(f);
  l.append({ postId: "P005", step: "created", storyId: 405 }); l.append({ postId: "P005", step: "image", order: 1 }); l.append({ postId: "P005", step: "verified" });
  assert.deepStrictEqual(l.state().P005, { storyId: 405, imagesDone: [1], verified: true, lastError: null });
  assert.ok(l.ownedIds().has(405)); assert.ok(!l.ownedIds().has(396));
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
  const manifest = { entries: [entry("P901", "2019-05-03", { excludeImages: true }), entry("P902", "2019-05-10", { photos: { expectedCount: 0, expectedIsEstimate: false, files: [] }, photosConfirmedNone: true }), entry("P903", "2019-05-17")] };
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
  assert.match(preflight([undecided], { P901: approvalFingerprint(undecided) }, read).join(), /photoMode missing/);
  const undeclared = Object.assign({}, items[2], { photoMode: undefined });
  assert.match(preflight([undeclared], { P903: approvalFingerprint(undeclared) }, read).join(), /photoMode missing/);
  const invalid = Object.assign({}, items[2], { photoMode: "Photos" });
  assert.match(preflight([invalid], { P903: approvalFingerprint(invalid) }, read).join(), /invalid photoMode "Photos"/);
  // approved without photos, but photos listed (or the reverse): stop
  const both = Object.assign({}, items[2], { photoMode: "none" });
  assert.match(preflight([both], { P903: approvalFingerprint(both) }, read).join(), /approved without photos but 1/);
  const lost = Object.assign({}, items[2], { images: [] });
  assert.match(preflight([lost], { P903: approvalFingerprint(lost) }, read).join(), /approved with photos but none listed/);
  // switching a post from photos to none after approval changes its fingerprint
  assert.notStrictEqual(approvalFingerprint(items[2]), approvalFingerprint(Object.assign({}, items[2], { photoMode: "none", images: [] })));
});
