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
  const { preflight, approvalFingerprint, toBatchItem } = require("../lib/batch.js");
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
  const it = toBatchItem;
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

/* ---- hardening: complete fingerprint, unknown fields, protected ids, deferred mode, credentials ---- */
const B = require("../lib/batch.js");
function sampleItem() {
  const img = tmpImage("01__sample.png");
  const e = { postId: "T950", facebookUrl: "https://example.invalid/p", facebookTimeChicago: "2019-06-07 17:00 Fri", publishedISO: "2019-06-07", title: "Sample Title", category: "shabbat",
    sourceText: "#ShabbatShalom\nA unique sample paragraph for the fingerprint tests.\nA second paragraph.", flags: [], hold: false, approved: true,
    photos: { expectedCount: 1, expectedIsEstimate: false, files: [{ order: 1, path: img }] } };
  return B.toBatchItem(plan({ entries: [e] }, snapshot, {}).items[0]);
}
const clone = x => JSON.parse(JSON.stringify(x));

test("fingerprint: deterministic, covers every supported field, ignores only the provisional id", () => {
  const it = sampleItem(), fp = B.approvalFingerprint(it);
  const reordered = clone(it); reordered.record = Object.fromEntries(Object.entries(reordered.record).reverse());
  assert.strictEqual(B.approvalFingerprint(reordered), fp, "key order must not matter");
  const idOnly = clone(it); idOnly.record.id = 9999;
  assert.strictEqual(B.approvalFingerprint(idOnly), fp, "the provisional id is re-planned, so it is not fingerprinted");
  const changeValue = v => v === null || v === undefined ? "x" : typeof v === "string" ? v + " changed" : typeof v === "number" ? v + 1 : typeof v === "boolean" ? !v : Array.isArray(v) ? v.concat(["x"]) : Object.assign({}, v, { extra: 1 });
  const unchanged = [];
  for (const k of B.RECORD_FIELDS.filter(k => k !== "id" && k !== "importSource")) {
    const m = clone(it); m.record[k] = changeValue(m.record[k]);
    if (B.approvalFingerprint(m) === fp) unchanged.push(k);
  }
  for (const k of ["facebookUrl", "facebookTimeChicago"]) { const m = clone(it); m.record.importSource[k] = "changed"; if (B.approvalFingerprint(m) === fp) unchanged.push("importSource." + k); }
  const mut = { photoMode: m => { m.photoMode = "none"; }, postId: m => { m.postId = "T951"; m.record.importSource.postId = "T951"; },
    "photo order": m => { m.images[0].order = 2; }, "photo primary": m => { m.images[0].primary = false; }, "photo sha256": m => { m.images[0].sha256 = "0".repeat(64); },
    "photo file name": m => { m.images[0].file = m.images[0].file.replace("sample", "other"); }, "photo removed": m => { m.images = []; } };
  for (const [k, f] of Object.entries(mut)) { const m = clone(it); f(m); if (B.approvalFingerprint(m) === fp) unchanged.push(k); }
  assert.deepStrictEqual(unchanged, [], "these changes did not change the fingerprint: " + unchanged.join(", "));
  assert.ok(B.RECORD_FIELDS.includes("summary") && B.RECORD_FIELDS.includes("description") && B.RECORD_FIELDS.includes("slug"));
});

test("unknown fields are refused at every level, never ignored", () => {
  const it = sampleItem(), read = f => fs.readFileSync(f);
  const cases = { item: m => { m.protectedIds = [1]; }, record: m => { m.record.extraField = "x"; }, importSource: m => { m.record.importSource.extra = 1; }, photo: m => { m.images[0].bytes = 5; } };
  for (const [level, f] of Object.entries(cases)) {
    const m = clone(it); f(m);
    assert.throws(() => B.approvalFingerprint(m), /unknown/, level);
    assert.match(B.preflight([m], { T950: B.approvalFingerprint(it) }, read).join(), /unknown/, level);
  }
  const foreign = clone(it); foreign.record.importSource.system = "other";
  assert.match(B.preflight([foreign], {}, read).join(), /importSource.system/);
  const mismatch = clone(it); mismatch.record.importSource.postId = "T001";
  assert.match(B.preflight([mismatch], {}, read).join(), /does not match the post/);
});

test("protected ids: fixed list, snapshot occupancy, only the same post's own import Draft may be resumed", () => {
  const now = Date.now(), takenAt = new Date(now).toISOString();
  assert.deepStrictEqual(B.PROTECTED_IDS, [303, 304, 305, 388, 389, 390, 391, 392, 393, 394, 395, 396, 397, 398, 399, 400, 401, 402, 403, 404]);
  assert.ok(Object.isFrozen(B.PROTECTED_IDS));
  const it = sampleItem();
  for (const id of B.PROTECTED_IDS) {
    const m = clone(it); m.record.id = id;
    const own = { takenAt, memories: [{ id, status: "draft", featured: false, importSource: { system: B.IMPORT_SYSTEM, postId: m.postId } }] };
    assert.match(B.protectionProblems([m], own, now).join(), /protected existing memory/, "id " + id + " even when the snapshot calls it this post's Draft");
  }
  const at = id => { const m = clone(it); m.record.id = id; return m; };
  const snap = memories => ({ takenAt, memories });
  assert.match(B.protectionProblems([at(500)], snap([{ id: 500, status: "published" }]), now).join(), /occupied/);
  assert.match(B.protectionProblems([at(500)], snap([{ id: 500, status: "draft" }]), now).join(), /occupied/, "an editor Draft");
  assert.match(B.protectionProblems([at(500)], snap([{ id: 500, status: "draft", importSource: { system: B.IMPORT_SYSTEM, postId: "T001" } }]), now).join(), /occupied/, "another post's import Draft");
  assert.match(B.protectionProblems([at(500)], snap([{ id: 500, status: "draft", featured: true, importSource: { system: B.IMPORT_SYSTEM, postId: "T950" } }]), now).join(), /occupied/, "featured");
  assert.deepStrictEqual(B.protectionProblems([at(500)], snap([{ id: 500, status: "draft", importSource: { system: B.IMPORT_SYSTEM, postId: "T950" } }]), now), [], "own import Draft (resume)");
  assert.deepStrictEqual(B.protectionProblems([at(500)], snap([{ id: 499, status: "published" }]), now), []);
  assert.match(B.protectionProblems([at(500)], undefined, now).join(), /no fresh read-only snapshot/);
  assert.match(B.protectionProblems([at(500)], { memories: [] }, now).join(), /takenAt/);
  assert.match(B.protectionProblems([at(500)], { takenAt: new Date(now - 7 * 3600e3).toISOString(), memories: [] }, now).join(), /not fresh/);
});

test("runBatch requires deferred mode, a fresh snapshot and a stored-photo digest before sending anything", async () => {
  const { Ledger } = require("../lib/ledger.js");
  const it = clone(sampleItem()); it.record.id = 600;
  const approved = { T950: B.approvalFingerprint(it) };
  const fresh = { takenAt: new Date().toISOString(), memories: [] };
  const digest = async () => ({ status: 200, body: {} });
  const calls = [];
  const transport = async (m, p) => { calls.push(m + " " + p); throw new Error("must not be called"); };
  const led = () => new Ledger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hlled-")), "l.jsonl"));
  for (const defer of [undefined, false, "true", 1, "1"]) {
    process.env.HL_IMPORT_DEFER = "1"; process.env.DEFER = "true";   // no environment variable can stand in for it
    const r = await B.runBatch({ items: [it], transport, ledger: led(), batchId: "d", approved, snapshot: fresh, storedPhotoDigest: digest, defer });
    delete process.env.HL_IMPORT_DEFER; delete process.env.DEFER;
    assert.match(r.stopped && r.stopped.error, /deferred rebuild mode is required/, String(defer));
    assert.strictEqual(r.finalBuild.sent, false);
  }
  const noSnap = await B.runBatch({ items: [it], transport, ledger: led(), batchId: "s", approved, defer: true, storedPhotoDigest: digest });
  assert.match(noSnap.stopped.error, /no fresh read-only snapshot/);
  const noDigest = await B.runBatch({ items: [it], transport, ledger: led(), batchId: "g", approved, defer: true, snapshot: fresh });
  assert.match(noDigest.stopped.error, /no storedPhotoDigest/);
  assert.deepStrictEqual(calls, [], "nothing may be sent when preflight fails");
});

test("credentials: never in URLs, env, serialized clients, errors, ledgers or results", async () => {
  const util = require("util");
  const { scrub, assertNoUrlCredentials } = require("../lib/secrets.js");
  const SECRET = "tok_" + "9f8e7d6c5b4a39281706";
  process.env.HL_ADMIN_TOKEN = SECRET;
  const api = new AdminApi({ fetch: async (url) => { throw new Error("connect failed for " + url + " with x-admin-token: " + SECRET); } });
  assert.strictEqual(process.env.HL_ADMIN_TOKEN, undefined, "the variable is cleared as soon as it is read");
  assert.ok(!JSON.stringify(api).includes(SECRET) && !util.inspect(api, { depth: 5, showHidden: true }).includes(SECRET), "not visible on the client object");
  await assert.rejects(() => api.listStories(), e => !e.message.includes(SECRET) && /\[redacted\]/.test(e.message));
  await assert.rejects(() => api.get("/api/stories?token=abc"), /refusing a URL that carries a credential/);
  assert.throws(() => new AdminApi({ base: "https://x.invalid/?token=abc", token: "t" }), /destination refused/);
  api.close();
  await assert.rejects(() => api.listStories(), /HL_ADMIN_TOKEN is not set/);
  assert.throws(() => assertNoUrlCredentials("https://x.invalid/a?admin_token=1"));
  assert.doesNotThrow(() => assertNoUrlCredentials("https://x.invalid/api/stories/5"));
  assert.ok(!scrub("GET /a?token=" + SECRET + " x-admin-token: " + SECRET, [SECRET]).includes(SECRET));
  // a server error body that echoes a secret never reaches the ledger or the result
  const { Ledger } = require("../lib/ledger.js");
  const it = clone(sampleItem()); it.record.id = 601; it.images = []; it.photoMode = "none";
  const ledFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hlled-")), "l.jsonl");
  const transport = async (m) => m === "GET" ? { status: 404, body: {} } : { status: 500, body: { error: "bad token " + SECRET + " x-admin-token: \"" + SECRET + "\" ?token=" + SECRET } };
  const r = await B.runBatch({ items: [it], transport, ledger: new Ledger(ledFile), batchId: "x", approved: { T950: B.approvalFingerprint(it) }, defer: true,
    snapshot: { takenAt: new Date().toISOString(), memories: [] }, secrets: [SECRET] });
  assert.ok(r.stopped && !JSON.stringify(r).includes(SECRET) && !fs.readFileSync(ledFile, "utf8").includes(SECRET));
});

test("live transport: only new Drafts, their photos and one build; everything else refused before a request", async () => {
  const { createLiveTransport } = require("../lib/transport.js");
  const sent = [];
  const fetch = async (url, init) => { sent.push((init && init.method) + " " + url); return { status: 201, text: async () => "{}", arrayBuffer: async () => new ArrayBuffer(0) }; };
  const t = createLiveTransport({ token: "tok", fetch, allowIds: [700] });
  const draft = { id: 700, status: "draft", featured: false, importSource: { system: B.IMPORT_SYSTEM, postId: "T950" } };
  const D = { "x-defer-rebuild": "1" };
  for (const [m, p, body, h] of [["PUT", "/api/stories/700", draft, D], ["DELETE", "/api/stories/700", null, D], ["POST", "/api/stories", Object.assign({}, draft, { status: "published" }), D],
    ["POST", "/api/stories", Object.assign({}, draft, { id: 701 }), D], ["POST", "/api/stories", draft, {}], ["POST", "/api/story-photos/305", { filename: "a.jpg" }, D], ["PUT", "/api/story-photos/700", {}, D], ["GET", "/api/narration/1", null, null]])
    await assert.rejects(() => t.transport(m, p, body, h), /transport refused/, m + " " + p);
  assert.deepStrictEqual(sent, [], "nothing reached the network");
  await t.transport("POST", "/api/stories", draft, D);
  await t.transport("POST", "/api/story-photos/700", { filename: "a.jpg", data: "x" }, D);
  await t.transport("POST", "/api/build", {});
  await assert.rejects(() => t.transport("POST", "/api/build", {}), /second build/);
  assert.strictEqual(sent.length, 3);
  for (const id of B.PROTECTED_IDS) {
    const tp = createLiveTransport({ token: "tok", fetch, allowIds: [id] });
    await assert.rejects(() => tp.transport("POST", "/api/stories", Object.assign({}, draft, { id }), D), /protected/);
  }
  assert.ok(sent.every(x => x.includes(" https://www.harlanslegacy.com/api/")), "only the production origin is used");
});

test("id allocation: fresh ids after every occupied/protected id; ledger and lost-answer Drafts are kept, never duplicated", () => {
  const S = require("../lib/snapshot.js");
  const mem = (id, extra) => Object.assign({ id, status: "published", featured: false, importSource: null }, extra || {});
  const snapshot = { memories: [mem(303), mem(404, { status: "draft" }), mem(500), mem(502), mem(503, { status: "draft", importSource: { system: B.IMPORT_SYSTEM, postId: "T2" } })] };
  const items = ["T1", "T2", "T3", "T4"].map(postId => ({ postId }));
  const a = S.allocateIds(items, snapshot, { T1: { storyId: 501 } });
  assert.deepStrictEqual(a.ids, { T1: 501, T2: 503, T3: 504, T4: 505 });
  assert.deepStrictEqual(a.adopted, [503]);
  assert.deepStrictEqual(a.problems, []);
  assert.strictEqual(S.allocateIds(items, snapshot, { T1: { storyId: 303 } }).problems.length, 1, "a protected id in the ledger is refused");
  const two = { memories: snapshot.memories.concat([mem(510, { status: "draft", importSource: { system: B.IMPORT_SYSTEM, postId: "T2" } })]) };
  assert.match(S.allocateIds(items, two, {}).problems.join(), /2 import Drafts/);
});

test("authorization: needs a TTY, the exact batch id, fingerprint, a hidden token and the typed phrase; no env or flag bypass", async () => {
  const A = require("../lib/authorize.js");
  const P = { batch: 1, items: [] };
  const exp = { batchId: A.batchIdOf(P), payloadFingerprint: "f".repeat(64), posts: 25, photos: 23, destination: "https://www.harlanslegacy.com" };
  const io = (answers, o) => { const q = answers.slice(); const asked = []; return { isTTY: !(o && o.notTTY), asked, ask: async x => { asked.push(x); return q.shift(); }, askHidden: async () => (o && "token" in o ? o.token : "tok"), print: () => {} }; };
  const saved = Object.assign({}, process.env);
  Object.assign(process.env, { HL_IMPORT_CONFIRM: "1", HL_CONFIRM: "yes", CI: "1", FORCE: "1", HL_ADMIN_TOKEN: "env-token" });
  try {
    await assert.rejects(() => A.authorizeRun(io([exp.batchId, exp.payloadFingerprint], { notTTY: true }), exp), /interactive terminal/);
    await assert.rejects(() => A.authorizeRun(io(["batch-02", exp.payloadFingerprint]), exp), /batch identifier/);
    await assert.rejects(() => A.authorizeRun(io([exp.batchId, "e".repeat(64)]), exp), /fingerprint/);
    await assert.rejects(() => A.authorizeRun(io([exp.batchId, exp.payloadFingerprint], { token: "" }), exp), /no token/);
    assert.strictEqual(await A.authorizeRun(io([exp.batchId, exp.payloadFingerprint]), exp), "tok", "the token comes from the hidden prompt, not HL_ADMIN_TOKEN");
    await assert.rejects(() => A.confirmWrites(io(["yes"]), exp.batchId, []), /confirmation phrase/);
    await assert.rejects(() => A.confirmWrites(io([A.confirmPhrase(exp.batchId).toLowerCase()]), exp.batchId, []), /confirmation phrase/);
    await A.confirmWrites(io([A.confirmPhrase(exp.batchId)]), exp.batchId, []);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "authorize.js"), "utf8") + fs.readFileSync(path.join(__dirname, "..", "lib", "run.js"), "utf8");
  assert.ok(!/process\.env/.test(src) && !/process\.argv/.test(src), "authorization and the run read no environment variable or argument");
});

test("payload fingerprint ignores story ids but changes with any approved content", () => {
  const A = require("../lib/authorize.js");
  const it = sampleItem();
  const P = { batch: 1, items: [it] };
  const f0 = A.payloadFingerprint(P);
  const moved = clone(P); moved.items[0].record.id = 9999;
  assert.strictEqual(A.payloadFingerprint(moved), f0);
  const edited = clone(P); edited.items[0].record.summary += ".";
  assert.notStrictEqual(A.payloadFingerprint(edited), f0);
});

/* ---------------- destination security: the admin token can only ever go to the production origin ---------------- */
const BAD_DESTINATIONS = [
  "https://attacker.example", "https://www.harlanslegacy.com.attacker.example", "https://harlanslegacy.com",
  "https://www.harIanslegacy.com", "https://www.harlanslegacy.co", "https://xn--hrlanslegacy-pcb.com", "https://wwwharlanslegacy.com",
  "https://76.76.21.21", "https://[2606:4700::1111]", "http://www.harlanslegacy.com",
  "https://www.harlanslegacy.com:8443", "https://www.harlanslegacy.com:443", "https://www.harlanslegacy.com:80",
  "https://user:pw-secret@www.harlanslegacy.com", "https://admin@www.harlanslegacy.com",
  "https://www.harlanslegacy.com/", "https://www.harlanslegacy.com/api", "https://www.harlanslegacy.com?token=x",
  "https://www.harlanslegacy.com?x=1", "https://www.harlanslegacy.com#frag", "https://www.harlanslegacy.com/.attacker.example",
  "http://127.0.0.1:3000", "http://localhost", "https://localhost", " https://www.harlanslegacy.com", "HTTPS://WWW.HARLANSLEGACY.COM", ""
];

test("destination: only the exact production origin is accepted; every other destination is refused before any request", async () => {
  const T = require("../lib/transport.js");
  assert.strictEqual(T.PRODUCTION_ORIGIN, "https://www.harlanslegacy.com");
  assert.strictEqual(T.productionDestination(undefined), T.PRODUCTION_ORIGIN);
  assert.strictEqual(T.productionDestination("https://www.harlanslegacy.com"), T.PRODUCTION_ORIGIN);
  const calls = []; const fetch = async (url) => { calls.push(url); return { status: 200, text: async () => "[]" }; };
  for (const bad of BAD_DESTINATIONS) {
    assert.throws(() => T.productionDestination(bad), /destination refused/, bad);
    assert.throws(() => T.createLiveTransport({ base: bad, token: "tok-SECRET", fetch }), /destination refused/, bad);
    assert.throws(() => new AdminApi({ base: bad, token: "tok-SECRET", fetch }), /destination refused/, bad);
    try { T.productionDestination(bad); } catch (e) { assert.ok(!/pw-secret|tok-SECRET|token=x/.test(e.message), "refusal never echoes a credential: " + e.message); }
  }
  assert.deepStrictEqual(calls, [], "no request to any refused destination");
  // the accepted transport sends only to the production origin, with redirects refused
  const seen = []; const t = T.createLiveTransport({ token: "tok", fetch: async (url, init) => { seen.push([url, init.redirect, init.headers["x-admin-token"]]); return { status: 200, text: async () => "{}" }; } });
  await t.transport("GET", "/api/stories");
  assert.deepStrictEqual(seen, [["https://www.harlanslegacy.com/api/stories", "error", "tok"]]);
});

test("destination: a Production run refuses a requested base before the payload, backup or token prompt; the destination is shown first", async () => {
  const { runProduction } = require("../lib/run.js");
  const A = require("../lib/authorize.js");
  for (const bad of ["https://attacker.example", "https://www.harlanslegacy.com/", "https://user:pw@www.harlanslegacy.com", "http://127.0.0.1:8080"]) {
    const asked = []; const calls = [];
    const io = { isTTY: true, ask: async q => { asked.push(q); return ""; }, askHidden: async q => { asked.push(q); return "tok"; }, print: () => {} };
    const r = await runProduction({ payload: { batch: 1, items: [] }, backupDir: "nope", ledgerPath: "nope", base: bad, io, fetch: async u => { calls.push(u); return {}; } });
    assert.strictEqual(r.stage, "destination", bad);
    assert.match(r.stopped, /destination refused/);
    assert.deepStrictEqual(asked, [], "no prompt (and no token) for " + bad);
    assert.deepStrictEqual(calls, [], "no request for " + bad);
  }
  // the authorization shows the destination before asking anything; without a validated destination it asks nothing
  const events = [];
  const io = { isTTY: true, print: l => events.push("print " + l), ask: async q => { events.push("ask " + q); return "batch-01"; }, askHidden: async q => { events.push("hidden " + q); return "tok"; } };
  await assert.rejects(() => A.authorizeRun(io, { batchId: "batch-01", payloadFingerprint: "a".repeat(64), posts: 1, photos: 0, destination: "https://www.harlanslegacy.com" }), /fingerprint/);
  assert.match(events[0], /^print Destination: https:\/\/www\.harlanslegacy\.com /);
  assert.ok(events.findIndex(e => e.startsWith("ask")) > 0 && !events.some(e => e.startsWith("hidden")), events.join(" | "));
  const none = [];
  await assert.rejects(() => A.authorizeRun({ isTTY: true, print: l => none.push(l), ask: async () => { none.push("ask"); }, askHidden: async () => { none.push("hidden"); } }, { batchId: "x" }), /no validated destination/);
  assert.deepStrictEqual(none, []);
});

test("destination: the CLI refuses --api for snapshot, backup and run before the token prompt and before any connection", async () => {
  const cp = require("child_process"), http = require("http");
  let connections = 0;
  const trap = http.createServer((q, s) => { s.end("{}"); }); trap.on("connection", () => connections++);
  await new Promise(r => trap.listen(0, "127.0.0.1", r));
  const local = "http://127.0.0.1:" + trap.address().port;
  const cli = path.join(__dirname, "..", "import.js"), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hlcli-"));
  const runCli = args => new Promise(res => cp.execFile(process.execPath, [cli, ...args], { env: Object.assign({}, process.env, { HL_ADMIN_TOKEN: "env-SECRET" }) }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
  for (const dest of [local, "https://attacker.example", "https://www.harlanslegacy.com.attacker.example", "https://www.harlanslegacy.com:8443", "https://user:pw@www.harlanslegacy.com", "https://www.harlanslegacy.com"]) {
    for (const args of [["snapshot", "--out", path.join(tmp, "s.json")], ["backup", "--out", path.join(tmp, "b")], ["run", "--payload", "p.json", "--backup", tmp, "--ledger", path.join(tmp, "l.jsonl")]]) {
      const r = await runCli(args.concat(["--api", dest]));
      assert.strictEqual(r.code, 1, args[0] + " " + dest);
      assert.match(r.stderr, /--api is not accepted/, args[0] + " " + dest);
      assert.ok(!/Admin token|Destination:/.test(r.stdout), "refused before the destination banner and the token prompt: " + args[0] + " " + dest);
    }
  }
  // without --api: the fixed destination is shown first; with no terminal there is no token prompt and nothing is sent
  const plain = await runCli(["snapshot", "--out", path.join(tmp, "s.json")]);
  assert.match(plain.stdout, /^Destination: https:\/\/www\.harlanslegacy\.com /m);
  assert.match(plain.stderr, /interactive terminal/);
  await new Promise(r => setTimeout(r, 100));
  trap.close();
  assert.strictEqual(connections, 0, "the local trap server never saw a connection");
});

test("destination: a redirect is refused and the token is never forwarded; the CLI never loads the rehearsal transport", async () => {
  const http = require("http"), T = require("../lib/transport.js");
  const got = [];
  const target = http.createServer((q, s) => { got.push(q.headers["x-admin-token"] || "(none)"); s.end("[]"); });
  await new Promise(r => target.listen(0, "127.0.0.1", r));
  const hop = http.createServer((q, s) => { s.writeHead(302, { Location: "http://127.0.0.1:" + target.address().port + "/api/stories" }); s.end(); });
  await new Promise(r => hop.listen(0, "127.0.0.1", r));
  const t = T.createRehearsalTransport({ base: "http://127.0.0.1:" + hop.address().port, token: "tok-REDIRECT" });
  await assert.rejects(() => t.transport("GET", "/api/stories"), e => !e.message.includes("tok-REDIRECT"));
  hop.close(); target.close();
  assert.deepStrictEqual(got, [], "the redirect target received nothing");
  assert.throws(() => T.createRehearsalTransport({ base: "https://www.harlanslegacy.com", token: "t" }), /loopback only/);
  assert.throws(() => T.createRehearsalTransport({ base: "http://attacker.example", token: "t" }), /loopback only/);
  for (const f of ["import.js", path.join("lib", "run.js"), path.join("lib", "snapshot.js"), path.join("lib", "authorize.js")]) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    assert.ok(!/createRehearsalTransport/.test(src), f + " must not reference the rehearsal transport");
  }
  assert.ok(!/connect\s*:/.test(fs.readFileSync(path.join(__dirname, "..", "import.js"), "utf8")), "the CLI never passes a connect override");
});
