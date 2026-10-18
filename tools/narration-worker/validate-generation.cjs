/* =========================================================================
   Read-only validation of ONE generated narration (before owner approval).
   Same checks as the backfill validator, for any story (draft or published)
   and either backend (production Supabase private bucket, or local files):
     • version is ready + unapproved, bound to the CURRENT story text revision
     • recorded integrity ok, 0 missing, 0 duplicated; re-run on the stored words
     • word timings monotonic and within the audio duration
     • MP3: MPEG layer III, mono, 24 kHz; sha256 of every stored asset
     • zones + treatment present; recipe GENERATION_RECIPE.v1; pinned checkpoint
       and pinned voice reference; synthesis device
     • no public manifest (listen.json) while unapproved
   Writes nothing. Exit 1 on any failure.
     node tools/narration-worker/validate-generation.cjs --story 395 [--gen gen_x] [--expect-device cuda]
   ========================================================================= */
"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..", "..");
require(path.join(ROOT, "lib/loadenv.js"));
const store = require(path.join(ROOT, "lib/store.js"));
const paths = require(path.join(ROOT, "lib/paths.js"));
const service = require(path.join(ROOT, "lib/narration/service.js"));
const integrity = require(path.join(ROOT, "lib/narration/integrity.js"));
const hostedA = require(path.join(ROOT, "lib/narration/providers/hosted-a.js"));
const profiles = require(path.join(ROOT, "lib/narration/providers/profiles.js"));

function arg(n) { const i = process.argv.indexOf("--" + n); return i < 0 ? null : process.argv[i + 1]; }
const STORY = Number(arg("story"));
const GEN = arg("gen");
const EXPECT_DEVICE = arg("expect-device");
const FILES = ["narration.mp3", "narration.words.json", "narration.sentences.json", "narration.paragraphs.json", "narration.treatment.json", "narration.zones.json"];

async function read(storyId, rel) {
  if (store.USE_SUPABASE) return store.downloadObject(store.BUCKET_LISTEN, storyId + "/" + rel);
  return fs.readFileSync(path.join(paths.ROOT, "assets", "listen", String(storyId), rel));
}
async function manifestExists(storyId) {
  if (store.USE_SUPABASE) return store.objectExists(store.BUCKET_LISTEN, storyId + "/listen.json");
  return fs.existsSync(path.join(paths.ROOT, "assets", "listen", String(storyId), "listen.json"));
}

(async () => {
  if (!STORY) { console.error("usage: --story <id> [--gen <generationId>]"); process.exit(2); }
  const s = (await store.getStories()).find(x => x.id === STORY);
  if (!s) { console.error("No story " + STORY); process.exit(2); }
  const rec = service.record(s);
  const v = GEN ? (rec.versions || []).find(x => x.generationId === GEN)
    : (rec.versions || []).filter(x => x.status === "ready").sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1))[0];
  if (!v) { console.error("No " + (GEN || "ready") + " version for story " + STORY); process.exit(1); }
  const f = []; const ok = []; const hashes = {};
  const golden = profiles.getProfile("golden-chatterbox"); const pin = (golden && golden.engine) || {};

  if (v.status !== "ready" || v.approvedAt) f.push("version is " + v.status + (v.approvedAt ? " (approved)" : "")); else ok.push("ready, unapproved");
  if (rec.status === "approved" && rec.generationId === v.generationId) f.push("story narration is APPROVED on this generation");
  const rev = service.sourceRevision(s);
  if (v.sourceRevision !== rev) f.push("sourceRevision " + v.sourceRevision + " != current " + rev); else ok.push("bound to current text revision " + rev);
  if (!v.integrity || !v.integrity.ok || v.integrity.missingCount !== 0 || v.integrity.duplicateCount !== 0) f.push("recorded integrity not 0/0"); else ok.push("recorded integrity 0 missing / 0 duplicated");

  const got = {};
  for (const n of FILES) {
    try { got[n] = await read(STORY, "g/" + v.generationId + "/" + n); hashes[n] = crypto.createHash("sha256").update(got[n]).digest("hex"); }
    catch (e) { f.push("missing asset " + n); }
  }
  let words = [], dur = v.duration || null, zones = [], treat = null, mp3 = null;
  if (got["narration.mp3"]) {
    mp3 = hostedA.mp3Info(got["narration.mp3"]);
    if (!mp3 || mp3.layer !== 3 || mp3.channels !== 1 || mp3.sampleRate !== 24000) f.push("mp3 format " + JSON.stringify(mp3)); else ok.push("MP3 layer III mono 24 kHz, " + got["narration.mp3"].length + " bytes");
  }
  if (got["narration.words.json"]) {
    const wj = JSON.parse(got["narration.words.json"].toString("utf8"));
    words = (wj.words || []).map((w, i) => ({ i: w.i != null ? w.i : i, w: w.w, start: +w.start, end: +w.end }));
    const mono = words.every((w, k) => w.end >= w.start && (k === 0 || w.start >= words[k - 1].end - 1e-6));
    if (!mono) f.push("word timings not monotonic"); else ok.push("timings monotonic (" + words.length + " words)");
    if (dur && words.length && words[words.length - 1].end > dur + 0.01) f.push("timings exceed duration"); else ok.push("timings within " + dur + " s");
    const integ = integrity.check(s, words, 2);
    if (!integ.ok || integ.missingCount !== 0 || integ.duplicateCount !== 0) f.push("re-check integrity " + integ.missingCount + " missing / " + integ.duplicateCount + " dup"); else ok.push("re-checked integrity on stored words: 0 missing / 0 duplicated");
  }
  if (got["narration.zones.json"]) zones = JSON.parse(got["narration.zones.json"].toString("utf8")).zones || [];
  if (!zones.length) f.push("no zones"); else ok.push(zones.length + " zones");
  if (got["narration.treatment.json"]) { treat = JSON.parse(got["narration.treatment.json"].toString("utf8")); if (!treat.chunks || !treat.chunks.length) f.push("treatment has no chunks"); else ok.push("treatment " + (treat.treatmentVersion || "?") + " (" + treat.source + "), " + treat.chunks.length + " chunks, arc " + (treat.arc || v.emotionalArc || "?")); }
  if ((v.recipeVersion || v.recipe) !== "GENERATION_RECIPE.v1") f.push("recipe " + (v.recipeVersion || v.recipe)); else ok.push("recipe GENERATION_RECIPE.v1");
  const p = v.provider || {};
  if (pin.checkpoint && p.checkpoint !== pin.checkpoint) f.push("checkpoint " + p.checkpoint + " != pinned " + pin.checkpoint); else ok.push("pinned checkpoint " + p.checkpoint);
  if (pin.voiceReferenceSha256 && p.voiceRefSha256 !== pin.voiceReferenceSha256) f.push("voice reference " + p.voiceRefSha256 + " != pinned"); else ok.push("pinned voice reference " + String(p.voiceRefSha256).slice(0, 16) + "…");
  if (!v.voiceVersion || !v.voiceId) f.push("no voice metadata"); else ok.push("voice " + v.voiceId + " v" + v.voiceVersion);
  if (EXPECT_DEVICE && String(p.device || "").indexOf(EXPECT_DEVICE) !== 0) f.push("synthesis device " + p.device + " (expected " + EXPECT_DEVICE + ")"); else ok.push("synthesis device " + p.device);
  if (await manifestExists(STORY) && rec.status !== "approved") f.push("public manifest exists before approval"); else ok.push("no public manifest");
  const er = v.engineRelease;
  if (process.argv.includes("--expect-release")) { if (!er || !er.manifestVerified) f.push("engine release not verified: " + JSON.stringify(er)); }
  if (er) ok.push("engine release " + er.id + (er.manifestVerified ? " (files match manifest)" : " (NOT verified)") + ": harlan_golden.py " + String((er.files || {})["harlan_golden.py"]).slice(0, 16) + "…, platform_audio.py " + String((er.files || {})["platform_audio.py"]).slice(0, 16) + "…");
  else ok.push("engine release: legacy single-file engine (unversioned)");
  if (v.stageMemory) ok.push("stage memory: synth " + JSON.stringify(v.stageMemory.synth) + " · align " + JSON.stringify(v.stageMemory.align));
  if (v.alignMode) ok.push("alignment mode " + JSON.stringify(v.alignMode));

  console.log((f.length ? "FAIL " : "PASS ") + "story " + STORY + " " + v.generationId + " (" + (store.USE_SUPABASE ? "production private bucket" : "local files") + ")");
  ok.forEach(x => console.log("   ok   " + x));
  f.forEach(x => console.log("   FAIL " + x));
  console.log("   sha256:"); Object.keys(hashes).forEach(n => console.log("     " + n.padEnd(28) + hashes[n]));
  process.exitCode = f.length ? 1 : 0;
})().catch(e => { console.error("VALIDATE_ERR", e.message); process.exit(1); });
