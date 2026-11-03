/* Isolated fixture for the Story Number tests: a throwaway copy of this checkout with a synthetic
   46-record archive shaped like Production (same record ids, statuses, This Week = 405, 404 a Draft,
   Batch 1 = Drafts 406–430 carrying import sources and photos), a SYNTHETIC private registry folder and a
   synthetic Batch 1 payload. No real post ids, dates, titles, text or photos; no network beyond
   127.0.0.1, no Supabase, random tokens. */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const WT = path.resolve(__dirname, "..", "..", "..");
const numbering = require(path.join(WT, "lib", "numbering.js"));
const { BATCH_1_IDS } = require("../lib/batch1.js");
const SKIP = new Set([".git", "node_modules"]);
const THEMES = ["funny", "grief", "momdad", "toledo", "shabbat", "ordinary"];
const TEXT_ONLY = new Set([406, 408, 412, 415]);          // 4 text-only posts; record 418 has 3 photos; the rest 1
const PUBLISHED = [303, 304, 305, ...Array.from({ length: 16 }, (_, i) => 388 + i), 405];

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (SKIP.has(name)) continue;
    const s = path.join(src, name), d = path.join(dst, name), st = fs.statSync(s);
    if (st.isDirectory()) copyTree(s, d); else fs.copyFileSync(s, d);
  }
}

// A synthetic private registry: 391 entries "S001".."S391" by the numbering rule, and the 46-record map
// with each record's source being the synthetic post of its approved number.
function syntheticRegistry(dir) {
  const entries = [];
  let n = 0;
  for (let i = 1; i <= numbering.policy().historicalEntries; i++) {
    n++; while (numbering.isRetired(n)) n++;
    const d = new Date(Date.UTC(2019, 0, 4) + i * 7 * 86400000).toISOString().slice(0, 10);
    entries.push({ position: i, sourcePostId: "S" + String(i).padStart(3, "0"), date: d, storyNumber: n, verification: "synthetic" });
  }
  const byNumber = new Map(entries.map(e => [e.storyNumber, e]));
  const assignments = numbering.assignments().map(a => Object.assign({}, a, { sourcePostId: byNumber.get(a.storyNumber).sourcePostId }));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "story-number-registry.full.json"), JSON.stringify({ retired: numbering.RETIRED, policy: { firstNewStoryNumber: 448 }, entries }, null, 1));
  fs.writeFileSync(path.join(dir, "story-number-assignments.full.json"), JSON.stringify({ assignments }, null, 1));
  return { dir, sourceOf: id => assignments.find(a => a.id === id).sourcePostId };
}

const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
function story(id, status, i, extra) {
  return Object.assign({
    id, title: "Synthetic memory " + id, slug: "synthetic-memory-" + id, status, featured: id === 405, theme: THEMES[i % THEMES.length],
    publishedISO: iso(2026, 1 + (i % 9), 1 + (i % 27)), dateLong: "", dateLabel: "", memoryDate: null,
    summary: "A synthetic test memory " + id + ".", description: null, ogDescription: null,
    lead: "This is synthetic memory " + id + ", used only by the local Story Number tests.", body: ["A second synthetic paragraph."],
    people: [], places: [], objects: [], events: [], bookPart: null, keywords: [], echoStories: [], readingTime: 1, readerImages: []
  }, extra || {});
}

/* Creates the root and returns { root, payload, records, registryDir }. */
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hl-story-numbers-"));
  copyTree(WT, root);
  for (const d of ["story", "story-photos"]) fs.rmSync(path.join(root, d), { recursive: true, force: true });
  const reg = syntheticRegistry(root + "-private-registry");
  const recs = [];
  PUBLISHED.forEach((id, i) => recs.push(story(id, "published", i)));
  recs.push(story(404, "draft", 30));
  BATCH_1_IDS.forEach((id, i) => recs.push(story(id, "draft", 40 + i, { publishedISO: iso(2019 + Math.floor(i / 6), 1 + (i % 12), 1 + (i % 27)),
    importSource: { system: numbering.IMPORT_SYSTEM, postId: reg.sourceOf(id), facebookUrl: null, facebookTimeChicago: null } })));
  recs.sort((a, b) => a.id - b.id);
  const galleries = {}, payloadItems = [];
  for (const id of BATCH_1_IDS) {
    const rec = recs.find(r => r.id === id), postId = rec.importSource.postId;
    const n = TEXT_ONLY.has(id) ? 0 : id === 418 ? 3 : 1;
    const images = [], items = [];
    for (let k = 1; k <= n; k++) {
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(1500 + k)]);
      const file = "synth-" + id + "-" + k + ".jpg", pid = "synth-" + id + "-" + k;
      fs.mkdirSync(path.join(root, "story-photos", "story-" + id), { recursive: true });
      fs.writeFileSync(path.join(root, "story-photos", "story-" + id, file), bytes);
      items.push({ id: pid, file, caption: "", year: null, location: null, source: null, alt: null, focus: { x: 50, y: 50 }, url: "", portrait: [], full: [] });
      images.push({ order: k, primary: k === 1, file: "C:/synthetic/" + file, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
    }
    if (items.length) galleries["story-" + id] = { primary: items[0].id, items };
    payloadItems.push({ postId, photoMode: n ? "photos" : "none", images, record: Object.assign({}, rec) });
  }
  fs.writeFileSync(path.join(root, "data", "stories.json"), JSON.stringify(recs, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "data", "story-photos.json"), JSON.stringify(galleries, null, 2) + "\n");
  for (const f of ["narration_jobs.json", "narration_audit.json", "story_numbers.json"]) fs.rmSync(path.join(root, "data", f), { force: true });
  return { root, payload: { batch: 1, items: payloadItems }, records: recs, registryDir: reg.dir };
}

function removeRoot(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(root + "-private-registry", { recursive: true, force: true });
}

// Remove every credential/backend variable before any module reads them.
function cleanEnv() {
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HARLAN_ENV_FILE", "HL_ADMIN_TOKEN", "VERCEL_DEPLOY_HOOK_URL", "HARLAN_NARRATION_PUBLISH_GATE", "ADMIN_TOKEN", "HARLAN_MODERATORS", "NODE_ENV"]) delete process.env[k];
}

module.exports = { WT, makeRoot, removeRoot, cleanEnv, PUBLISHED };
