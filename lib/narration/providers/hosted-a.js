/* =========================================================================
   Harlan's Legacy — CANDIDATE A pins + platform-side completion checks
   (NARRATION_PROVIDER_SPEC.md §17.2 / §17.3 / §17.7)

   Everything a Candidate-A completion must prove BEFORE the platform accepts it.
   The provider's word is never trusted: pins, parameters, chunk accounting, zone
   boundaries, file hashes and the MP3 format are all re-checked here, and
   integrity/timings are re-derived by the platform's own Node code afterwards.
   ========================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const paths = require("../../paths.js");

const ROOT = paths.ROOT;
const PLATFORM_AUDIO = path.join(ROOT, "lib", "narration", "platform_audio.py");
const REF_TYPICAL = path.join(ROOT, "prototype", "voicelab", "ref_typical.wav");

// Golden pins (GENERATION_RECIPE.v1 + measured stack). Weight-file hashes live in
// deploy/provider-a/pins.json and are verified at image build time.
const PINS = Object.freeze({
  engine: "chatterbox-tts",
  engineVersion: "0.1.7",
  checkpoint: "ResembleAI/chatterbox@5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18",
  torchPrefix: "2.6.0",
  precision: "fp32",
  seed: 0,
  sr: 24000,
  mp3: { version: "MPEG-2", layer: 3, bitrateKbps: 128, sampleRate: 24000, channels: 1 }
});
const FILES = ["narration.mp3", "narration.words.json", "narration.zones.json", "metrics.json"];

const sha256File = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function platformPin() {
  const src = fs.readFileSync(PLATFORM_AUDIO, "utf8");
  const v = k => { const m = src.match(new RegExp("^" + k + ' = "([^"]+)"', "m")); return m ? m[1] : null; };
  return {
    module: "platform_audio.py", sha256: sha256File(PLATFORM_AUDIO), stage: "in-container",
    audioStandardVersion: v("AUDIO_STANDARD_VERSION"), finalizerVersion: v("FINALIZER_VERSION"),
    alignerVersion: v("ALIGNER_VERSION"), encoderVersion: v("ENCODER_VERSION")
  };
}
function voiceRefSha256() { return sha256File(REF_TYPICAL); }

/* ---------- MP3 first-frame header (format check on the delivered artifact) ---------- */
function mp3Info(buf) {
  let o = 0;
  if (buf.length > 10 && buf.toString("latin1", 0, 3) === "ID3") {
    o = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
  }
  for (; o + 4 <= buf.length; o++) {
    if (buf[o] !== 0xff || (buf[o + 1] & 0xe0) !== 0xe0) continue;
    const vb = (buf[o + 1] >> 3) & 3, lb = (buf[o + 1] >> 1) & 3, bi = (buf[o + 2] >> 4) & 15, si = (buf[o + 2] >> 2) & 3, cm = (buf[o + 3] >> 6) & 3;
    if (vb === 1 || lb === 0 || bi === 0 || bi === 15 || si === 3) continue;
    const version = vb === 3 ? "MPEG-1" : vb === 2 ? "MPEG-2" : "MPEG-2.5";
    const layer = 4 - lb;
    const L3 = { "MPEG-1": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], other: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
    const SR = { "MPEG-1": [44100, 48000, 32000], "MPEG-2": [22050, 24000, 16000], "MPEG-2.5": [11025, 12000, 8000] };
    return { version, layer, bitrateKbps: layer === 3 ? (version === "MPEG-1" ? L3["MPEG-1"] : L3.other)[bi] : null,
      sampleRate: SR[version][si], channels: cm === 3 ? 1 : 2, offset: o };
  }
  return null;
}

/* ---------- expected zone marks, recomputed from chunk accounting (finalize() rules) ---------- */
function expectedZones(planChunks, provChunks, sr) {
  const byI = new Map(provChunks.map(c => [c.i, c]));
  let cursor = 0; const marks = [];
  for (const c of planChunks) {
    const pc = byI.get(c.i); if (!pc) return null;
    const gap = Number(c.gap_before_s || 0);
    if (gap > 0) cursor += gap;                        // finalize(): zeros(int(gap*sr)) but cursor += gap
    const start = cursor; cursor += pc.samples / sr;
    marks.push({ zone: c.zone || "conversational", start: +start.toFixed(3), end: +cursor.toFixed(3) });
  }
  const zones = [];
  for (const z of marks) { if (zones.length && zones[zones.length - 1].zone === z.zone) zones[zones.length - 1].end = z.end; else zones.push(Object.assign({}, z)); }
  return zones;
}

/* ---------- the completion checks (pre-download) ---------- */
function checkCompletion(payload, ctx) {
  const f = []; const checks = {};
  const p = payload.provider || {}, plat = payload.platform || {};
  const pin = ctx.platformPin;
  const eq = (name, got, want) => { const ok = got === want; checks[name] = { ok, got, want }; if (!ok) f.push(name); };
  eq("providerId", p.providerId, "golden-chatterbox-hosted");
  eq("engineVersion", p.engineVersion, PINS.engineVersion);
  eq("checkpoint", p.checkpoint, PINS.checkpoint);
  eq("precision", p.precision, PINS.precision);
  eq("seed", p.seed, PINS.seed);
  eq("voiceRefSha256", p.voiceRefSha256, ctx.voiceRefSha256);
  eq("platformSha256", plat.sha256, pin.sha256);
  eq("sampleRate", payload.sr, PINS.sr);
  checks.torch = { ok: String(p.torch || "").startsWith(PINS.torchPrefix), got: p.torch, want: PINS.torchPrefix + "*" }; if (!checks.torch.ok) f.push("torch");
  checks.device = { ok: ctx.requireGpu ? p.device === "cuda" : true, got: p.device, want: ctx.requireGpu ? "cuda" : "any (CPU functional test)" }; if (!checks.device.ok) f.push("device");

  // exactly one chunk per planned chunk, and the EXACT Golden parameters for each
  const plan = ctx.rendered.chunks, got = payload.chunks || [];
  const idx = got.map(c => c.i).sort((a, b) => a - b);
  const chunkSetOk = got.length === plan.length && idx.every((v, k) => v === k);
  checks.chunkSet = { ok: chunkSetOk, got: got.length, want: plan.length }; if (!chunkSetOk) f.push("chunkSet");
  const byI = new Map(got.map(c => [c.i, c]));
  const paramMismatch = [];
  for (const c of plan) {
    const g = byI.get(c.i); if (!g || !g.params) { paramMismatch.push(c.i); continue; }
    for (const k of ["exaggeration", "cfg_weight", "temperature"]) if (Math.abs(Number(g.params[k]) - Number(c[k])) > 1e-9) { paramMismatch.push(c.i); break; }
  }
  checks.goldenParamsExact = { ok: paramMismatch.length === 0, mismatchedChunks: paramMismatch.slice(0, 20) }; if (paramMismatch.length) f.push("goldenParamsExact");
  checks.chunkAudioPresent = { ok: got.every(c => c.samples > 0 && /^[0-9a-f]{64}$/.test(String(c.pcmSha256 || ""))) }; if (!checks.chunkAudioPresent.ok) f.push("chunkAudioPresent");

  const files = ((payload.assets || {}).files || []).map(x => x.name).sort();
  checks.filesListed = { ok: FILES.every(n => files.indexOf(n) >= 0), got: files }; if (!checks.filesListed.ok) f.push("filesListed");
  return { ok: f.length === 0, failures: f, checks };
}

module.exports = { PINS, FILES, platformPin, voiceRefSha256, mp3Info, expectedZones, checkCompletion };
