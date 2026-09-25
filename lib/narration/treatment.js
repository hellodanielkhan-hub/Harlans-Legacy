/* =========================================================================
   Harlan's Legacy — Automatic Narration Treatment (emotion-map/v1)

   Content-AWARE emotional mapping. The GOLDEN TECHNICAL RECIPE is fixed for
   every story (model, voice ref, param RANGES, seed, loudness, fades, peak,
   sr, encoding, alignment — see GENERATION_RECIPE.v1.json). What varies per
   story is ONLY the emotional delivery: which zones appear, where, and how
   intense — derived from the actual text.

   Design rules (per product spec):
     • Never force Blue Chair's zones onto a story that doesn't contain them.
     • A humorous story must not be pushed into grief; a neutral story stays
       conversational; a reflective story is allowed restraint.
     • Inference params ALWAYS stay inside the approved Golden ranges.
     • Lightweight + deterministic (pure string analysis, no ML, ~ms) so it
       never affects generation throughput.

   Output = a versioned, PROVIDER-AGNOSTIC treatment (schema 2), stored with the
   generation and reviewable/overridable by a Super Admin BEFORE synthesis:
     • intent        — what the text expresses (classifier emotion + raw intensity)
     • deliveryZone  — how the chunk should be performed (defaults to intent)
     • zone          — canonical SOUNDSCAPE zone for narration.zones.json
                       (lib/narration/zones.js; identity until a mapping passes QI-1)
     • gap_before_s  — pause intent (platform finalizer applies it)
   Provider parameters are NOT part of the treatment. Each provider's rendering
   profile (lib/narration/providers/profiles.js) maps deliveryZone + intensity to
   its own parameters. The Golden Chatterbox profile holds the values that used
   to live here, unchanged.
   ========================================================================= */
"use strict";

const zonesLib = require("./zones.js");

const TREATMENT_VERSION = "emotion-map/v1";   // classifier version (unchanged logic)
const TREATMENT_SCHEMA = 2;                    // intent / deliveryZone / zone split

// Delivery zones: platform-owned pause intent + human description. No provider
// parameters. (Pause values are the same ones the approved Golden map used.)
const DELIVERY_ZONES = {
  conversational: { gap_before_s: 0.24, style: "even, natural narration" },
  warmth:         { gap_before_s: 0.24, style: "warm, fond" },
  tenderness:     { gap_before_s: 0.30, style: "gentle, hushed" },
  reflection:     { gap_before_s: 0.30, style: "considered, restrained" },
  grief:          { gap_before_s: 0.38, style: "weighted, slow" },
  grace:          { gap_before_s: 0.36, style: "soft resolve" },
  acceptance:     { gap_before_s: 0.30, style: "settled, at peace" },
  levity:         { gap_before_s: 0.20, style: "light, amused (not cartoonish)" },
  wonder:         { gap_before_s: 0.26, style: "open, marveling" }
};

// Emotional lexicons. Word-stem cues; scored by density per chunk. Ordered by
// salience for tie-breaks (a grief cue outweighs an incidental warmth cue).
const LEXICON = [
  ["grief",       ["died","death","dead","dying","loss","lost","gone","grave","funeral","mourn","grief","griev","buried","bury","widow","tears","wept","weep","cried","crying","goodbye","farewell","cancer","hospice","passed away","passing","eulogy","casket","cemetery","ashes","gravestone"]],
  ["tenderness",  ["gentle","gently","soft","softly","tender","held","cradl","whisper","fragile","frail","small hand","kissed","tucked","lull","caress"]],
  ["grace",       ["forgav","forgave","forgive","let go","at last","made peace","peace with","reconcil","blessing","grace","mercy","redeem"]],
  ["acceptance",  ["finally","accepted","accept","at peace","let it","enough","healed","moved on","carry on","in time","years later","eventually","came to terms"]],
  ["wonder",      ["amazed","amazing","wonder","awe","marvel","incredible","breathtaking","magic","miracle","astonish","dazzl","stars"]],
  ["levity",      ["laugh","laughed","laughing","joke","joking","funny","hilarious","ridiculous","silly","grin","grinned","chuckl","comic","absurd","teasing","teased","prank","goofy","wheel of fortune","punchline","snort"]],
  ["reflection",  ["remember","remembered","remembering","thought","thinking","wondered","realiz","looking back","memory","memories","recall","used to","i think","seemed","as if","back then","in those days"]],
  ["warmth",      ["love","loved","loving","home","together","family","mother","father","mom","dad","warm","embrace","hug","kitchen","holiday","childhood","dinner","sunday","laughter","dance","song","garden"]]
];

// --- helpers (mirror the pipeline's paragraph/sentence tokenizers) ---
function paragraphs(text) {
  const ps = String(text || "").split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return ps.length ? ps : (String(text || "").trim() ? [String(text).trim()] : []);
}
function sentences(p) {
  const out = []; let start = 0;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if ((ch === "." || ch === "!" || ch === "?") && (i + 1 >= p.length || p[i + 1] === " ")) { out.push(p.slice(start, i + 1).trim()); start = i + 1; }
  }
  if (start < p.length) out.push(p.slice(start).trim());
  return out.filter(Boolean);
}
function wordCount(s) { return (s.match(/\S+/g) || []).length; }
function clamp(v, [lo, hi]) { return Math.max(lo, Math.min(hi, v)); }

// Group sentences into delivery chunks: keep paragraphs together, but split a
// long paragraph into ~<=45-word chunks so intensity can shift within it.
function chunkText(text) {
  const chunks = [];
  for (const para of paragraphs(text)) {
    const sents = sentences(para);
    let buf = [], bufWords = 0;
    for (const s of sents) {
      const w = wordCount(s);
      if (buf.length && bufWords + w > 45) { chunks.push(buf.join(" ")); buf = []; bufWords = 0; }
      buf.push(s); bufWords += w;
    }
    if (buf.length) chunks.push(buf.join(" "));
  }
  return chunks.length ? chunks : (text.trim() ? [text.trim()] : []);
}

// Score a chunk against every lexicon; return {zone, intensity, scores}.
function classify(chunkText) {
  const low = " " + chunkText.toLowerCase().replace(/[^a-z0-9'\s]/g, " ") + " ";
  const scores = {};
  let best = null, bestScore = 0, totalHits = 0;
  for (const [zone, cues] of LEXICON) {
    let s = 0;
    for (const cue of cues) {
      // count occurrences (word-ish boundary for single tokens, substring for phrases)
      if (cue.indexOf(" ") >= 0) { let idx = low.indexOf(cue); while (idx >= 0) { s++; idx = low.indexOf(cue, idx + cue.length); } }
      else { const re = new RegExp("[^a-z]" + cue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"); const m = low.match(re); if (m) s += m.length; }
    }
    scores[zone] = s; totalHits += s;
    if (s > bestScore) { bestScore = s; best = zone; }
  }
  const words = Math.max(1, wordCount(chunkText));
  const density = totalHits / words;             // signals per word
  // Require a real signal to leave conversational: either multiple cues, or one
  // cue that is dense enough for a short chunk. A lone incidental keyword (e.g.
  // "home" in a plain errand) must NOT invent an emotion — stay conversational.
  const hasSignal = bestScore >= 2 || (bestScore >= 1 && density >= 0.06);
  const zone = hasSignal ? best : "conversational";
  // intensity 0..1 from signal density (capped); conversational is low-intensity
  const intensity = zone === "conversational" ? 0.25 : clamp(0.35 + density * 6, [0.3, 1.0]);
  return { zone, intensity, scores };
}

function pauseFor(deliveryZone) { return (DELIVERY_ZONES[deliveryZone] || DELIVERY_ZONES.conversational).gap_before_s; }

// Arc / summary fields computed from delivery zones (same rules as before).
function summarize(chunks) {
  const spend = {};
  chunks.forEach(c => { spend[c.deliveryZone] = (spend[c.deliveryZone] || 0) + (c.words || 0); });
  const ranked = Object.keys(spend).sort((a, b) => spend[b] - spend[a]);
  const emotional = ranked.filter(z => z !== "conversational");
  const arc = (emotional.length ? emotional : ranked).slice(0, 3);
  const dominant = arc[0] || "conversational";
  return {
    arc: arc,
    dominantEmotion: dominant,
    zonesPresent: Array.from(new Set(chunks.map(c => c.deliveryZone))),
    avgIntensity: +(chunks.reduce((s, c) => s + (c.intensity || 0), 0) / Math.max(1, chunks.length)).toFixed(2),
    deliveryStyle: (DELIVERY_ZONES[dominant] || DELIVERY_ZONES.conversational).style
  };
}

function envelope(chunks, source, extra) {
  return Object.assign({
    treatmentVersion: TREATMENT_VERSION,
    treatmentSchema: TREATMENT_SCHEMA,
    generatedAt: new Date().toISOString(),
    source: source || "auto",                      // "auto" | "admin-override"
    zoneMapping: { active: Object.keys(zonesLib.ACTIVE_ZONE_MAPPINGS), note: "QI-1: proposals inactive until a listening check passes" }
  }, summarize(chunks), {
    pauseStrategy: { unit: "per-chunk gap_before_s (by delivery zone/transition)", endSilence_s: 1.5, intraFade_ms: 6 },
    chunkCount: chunks.length,
    chunks: chunks
  }, extra || {});
}

/* Derive the full provider-agnostic treatment for a story's narrated text. */
function deriveTreatment(text, opts) {
  opts = opts || {};
  const raw = chunkText(text);
  const chunks = raw.map(function (ct, i) {
    const c = classify(ct);
    return {
      i: i, text: ct, words: wordCount(ct),
      intent: { emotion: c.zone, intensity: c.intensity },   // raw (unrounded) intensity drives rendering
      deliveryZone: c.zone,
      intensity: +c.intensity.toFixed(2),
      gap_before_s: i === 0 ? 0.0 : pauseFor(c.zone),
      zone: zonesLib.soundscapeZone(c.zone)
    };
  });
  return envelope(chunks, opts.source || "auto");
}

// Upgrade a stored schema-1 treatment (pre-split: chunks carried Golden params
// and `zone` meant the delivery zone). Explicit params become a Golden
// Chatterbox override so their effect is preserved exactly.
function upgradeTreatment(t) {
  if (!t || t.treatmentSchema === TREATMENT_SCHEMA) return t;
  const chunks = (t.chunks || []).map(function (c, i) {
    const dz = c.deliveryZone || c.zone || "conversational";
    const out = {
      i: i, text: String(c.text || ""), words: c.words != null ? c.words : wordCount(String(c.text || "")),
      intent: { emotion: dz, intensity: c.intensity != null ? Number(c.intensity) : 0.5 },
      deliveryZone: dz,
      intensity: c.intensity != null ? Number(c.intensity) : 0.5,
      gap_before_s: i === 0 ? 0.0 : (c.gap_before_s != null ? Number(c.gap_before_s) : pauseFor(dz)),
      zone: zonesLib.soundscapeZone(dz)
    };
    if (c.exaggeration != null || c.cfg_weight != null || c.temperature != null) {
      out.providerOverrides = { "golden-chatterbox": { exaggeration: c.exaggeration, cfg_weight: c.cfg_weight, temperature: c.temperature } };
    }
    return out;
  });
  return envelope(chunks, t.source, { sourceRevision: t.sourceRevision, upgradedFromSchema: 1, editedAt: t.editedAt });
}

// Flattened view for the Super Admin Treatment page (unchanged UI shape):
// `zone` in the view is the DELIVERY zone; params come from one profile.
function viewForProfile(t, profile) {
  const chunks = (t.chunks || []).map(function (c) {
    const params = profile ? profile.renderChunk(c) : {};
    return Object.assign({ i: c.i, text: c.text, words: c.words, zone: c.deliveryZone, deliveryZone: c.deliveryZone,
      soundscapeZone: c.zone, intensity: c.intensity, gap_before_s: c.gap_before_s }, params);
  });
  return Object.assign({}, t, { chunks: chunks, renderingProfile: profile ? { id: profile.id, version: profile.version, ranges: profile.ranges } : null });
}

// Convert an edited view back into a schema-2 treatment (pure). Provider
// params the admin edited are stored as an override for that profile only.
function treatmentFromView(view, profile) {
  const chunks = (view.chunks || []).map(function (c, i) {
    const dz = DELIVERY_ZONES[c.deliveryZone || c.zone] ? (c.deliveryZone || c.zone) : "conversational";
    const intensity = Number(c.intensity); const inten = isFinite(intensity) ? intensity : 0.5;
    const out = {
      i: i, text: String(c.text || ""), words: wordCount(String(c.text || "")),
      intent: { emotion: dz, intensity: inten },
      deliveryZone: dz, intensity: inten,
      gap_before_s: i === 0 ? 0.0 : (isFinite(Number(c.gap_before_s)) ? Number(c.gap_before_s) : pauseFor(dz)),
      zone: zonesLib.soundscapeZone(dz)
    };
    if (profile && profile.paramKeys.some(k => c[k] != null)) {
      const o = {}; profile.paramKeys.forEach(k => { o[k] = c[k]; });
      out.providerOverrides = { [profile.id]: profile.normalizeOverride(o) };
    }
    return out;
  });
  return envelope(chunks, "admin-override");
}

module.exports = {
  deriveTreatment, upgradeTreatment, viewForProfile, treatmentFromView,
  TREATMENT_VERSION, TREATMENT_SCHEMA, DELIVERY_ZONES
};
