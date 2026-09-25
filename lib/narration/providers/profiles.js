/* =========================================================================
   Harlan's Legacy — PROVIDER RENDERING PROFILES

   A rendering profile maps the platform's provider-agnostic emotional plan
   (deliveryZone + intensity per chunk) to ONE provider's parameters. The plan
   itself (treatment.js) never contains provider parameters.

   • golden-chatterbox — the approved Golden profile. Values moved VERBATIM from
     the pre-split treatment.js (GENERATION_RECIPE.v1). Do NOT change them.
   • tts-api — candidate B placeholder. Deliberately UNCONFIGURED: its mapping
     must be defined and frozen before any benchmark (spec §10).
   ========================================================================= */
"use strict";

const { ProviderError } = require("./contract.js");

function clamp(v, r) { return Math.max(r[0], Math.min(r[1], v)); }

/* ---------------- Golden Chatterbox (frozen) ---------------- */
const GC_ID = "golden-chatterbox";
const GC_RANGES = Object.freeze({ exaggeration: [0.40, 0.52], cfg_weight: [0.28, 0.30], temperature: [0.72, 0.80] });
const GC_MID = Object.freeze({ exaggeration: 0.46, cfg_weight: 0.30, temperature: 0.76 });
const GC_BY_DELIVERY_ZONE = Object.freeze({
  conversational: { exaggeration: 0.46, cfg_weight: 0.30, temperature: 0.76 },
  warmth:         { exaggeration: 0.50, cfg_weight: 0.30, temperature: 0.80 },
  tenderness:     { exaggeration: 0.45, cfg_weight: 0.28, temperature: 0.78 },
  reflection:     { exaggeration: 0.46, cfg_weight: 0.30, temperature: 0.78 },
  grief:          { exaggeration: 0.40, cfg_weight: 0.30, temperature: 0.72 },
  grace:          { exaggeration: 0.47, cfg_weight: 0.30, temperature: 0.78 },
  acceptance:     { exaggeration: 0.46, cfg_weight: 0.28, temperature: 0.76 },
  levity:         { exaggeration: 0.50, cfg_weight: 0.30, temperature: 0.80 },
  wonder:         { exaggeration: 0.49, cfg_weight: 0.30, temperature: 0.80 }
});

const goldenChatterbox = {
  id: GC_ID,
  version: "1",
  configured: true,
  recipeVersion: "GENERATION_RECIPE.v1",
  engine: {
    name: "chatterbox-tts", version: "0.1.7",
    checkpoint: "ResembleAI/chatterbox@5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18",
    precision: "fp32", seed: 0,
    voiceReference: "ref_typical.wav",
    voiceReferenceSha256: "ed9ff758694d88558600aa862ec8954748366a775989fc43a3d73b4422367a99"
  },
  ranges: GC_RANGES,
  paramKeys: ["exaggeration", "cfg_weight", "temperature"],

  // One chunk → provider params. Identical math to the pre-split treatment.js:
  // lerp from the neutral midpoint toward the zone's values by (unrounded)
  // intensity, clamp to the Golden ranges, round to 3 dp. An admin override for
  // THIS profile is honored exactly as before (clamped, 3 dp).
  renderChunk(chunk) {
    const ov = chunk.providerOverrides && chunk.providerOverrides[GC_ID];
    if (ov) {
      return {
        exaggeration: +clamp(Number(ov.exaggeration), GC_RANGES.exaggeration).toFixed(3),
        cfg_weight:   +clamp(Number(ov.cfg_weight),   GC_RANGES.cfg_weight).toFixed(3),
        temperature:  +clamp(Number(ov.temperature),  GC_RANGES.temperature).toFixed(3)
      };
    }
    const base = GC_BY_DELIVERY_ZONE[chunk.deliveryZone] || GC_BY_DELIVERY_ZONE.conversational;
    const raw = (chunk.intent && chunk.intent.intensity != null) ? chunk.intent.intensity : chunk.intensity;
    const t = clamp(Number(raw), [0, 1]);
    const lerp = (a, b) => a + (b - a) * t;
    return {
      exaggeration: +clamp(lerp(GC_MID.exaggeration, base.exaggeration), GC_RANGES.exaggeration).toFixed(3),
      cfg_weight:   +clamp(lerp(GC_MID.cfg_weight,   base.cfg_weight),   GC_RANGES.cfg_weight).toFixed(3),
      temperature:  +clamp(lerp(GC_MID.temperature,  base.temperature),  GC_RANGES.temperature).toFixed(3)
    };
  },

  // Validate/clamp an admin-supplied override for this profile.
  normalizeOverride(o) {
    return {
      exaggeration: +clamp(Number(o.exaggeration), GC_RANGES.exaggeration).toFixed(3),
      cfg_weight:   +clamp(Number(o.cfg_weight),   GC_RANGES.cfg_weight).toFixed(3),
      temperature:  +clamp(Number(o.temperature),  GC_RANGES.temperature).toFixed(3)
    };
  }
};

/* ---------------- Candidate B placeholder (unconfigured) ---------------- */
const ttsApi = {
  id: "tts-api",
  version: "0-unconfigured",
  configured: false,
  recipeVersion: null,
  engine: null,
  paramKeys: [],
  renderChunk() {
    throw new ProviderError("provider_not_configured",
      "Candidate B rendering profile is not defined. Define and freeze the deliveryZone/intensity → provider-control mapping before any benchmark (NARRATION_PROVIDER_SPEC.md §10).");
  },
  normalizeOverride() { throw new ProviderError("provider_not_configured", "Candidate B profile not configured"); }
};

const PROFILES = Object.freeze({ [goldenChatterbox.id]: goldenChatterbox, [ttsApi.id]: ttsApi });

function getProfile(id) {
  const p = PROFILES[id];
  if (!p) throw new ProviderError("invalid_request", "Unknown rendering profile: " + id);
  return p;
}

// Render a whole provider-agnostic treatment for one profile. Returns the
// provider-facing plan (flattened chunks, as the Golden worker expects) plus
// the params record stored with the generation.
function renderTreatment(treatment, profileId) {
  const prof = getProfile(profileId);
  const chunks = treatment.chunks.map(c => {
    const params = prof.renderChunk(c);
    return Object.assign({ i: c.i, text: c.text, words: c.words, deliveryZone: c.deliveryZone, zone: c.zone,
      intensity: c.intensity, gap_before_s: c.gap_before_s }, params);
  });
  return {
    treatmentVersion: treatment.treatmentVersion,
    renderingProfile: { id: prof.id, version: prof.version },
    chunkCount: chunks.length,
    chunks: chunks,
    params: chunks.map(c => { const o = { i: c.i }; prof.paramKeys.forEach(k => { o[k] = c[k]; }); return o; })
  };
}

module.exports = { PROFILES, getProfile, renderTreatment, GOLDEN_CHATTERBOX_ID: GC_ID };
