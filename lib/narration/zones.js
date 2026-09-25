/* =========================================================================
   Harlan's Legacy — SOUNDSCAPE ZONE VOCABULARY (platform-owned, provider-neutral)

   Tracked quality issue QI-1 (NARRATION_PROVIDER_SPEC.md §7).

   The frozen soundscape (assets/listen-soundscape.js, ZMAP) understands exactly
   the six CANONICAL zones below. Any other zone name falls back to a neutral mix
   [0.6, 0.6, 0.36]. The treatment currently emits some non-canonical delivery
   zones (tenderness, conversational, levity, wonder).

   Mappings from delivery zones to canonical zones are PROPOSALS ONLY. Nothing is
   active: soundscapeZone() is the identity function, so current behavior is
   unchanged. A proposal may be activated only after it passes a recorded
   listening check (see ACTIVATION RULE); approved generations are never touched.
   ========================================================================= */
"use strict";

// Exactly the ZMAP keys of the frozen soundscape. Never edit without the engine.
const CANONICAL_SOUNDSCAPE_ZONES = Object.freeze(["warmth", "tender", "reflection", "grief", "grace", "acceptance"]);

// PROPOSALS — documented, NOT active. Each requires a passed listening check.
const PROPOSED_ZONE_MAPPINGS = Object.freeze({
  tenderness:     { to: "tender",     basis: "Same meaning; naming defect", listeningCheck: null },
  conversational: { to: "acceptance", basis: "ZMAP [0.6,0.55,0.34] is the nearest defined mix to today's neutral fallback [0.6,0.6,0.36]", listeningCheck: null },
  levity:         { to: "warmth",     basis: "ZMAP [0.85,0.7,0.5]: light, fond, bright", listeningCheck: null },
  wonder:         { to: "grace",      basis: "ZMAP [0.82,0.7,0.4]: open, uplifting", listeningCheck: null }
});

/* ACTIVATION RULE: an entry may be added here only when its proposal has a
   recorded listening check { result: "pass", approvedBy, date, raters, notes }.
   Activation affects FUTURE generations only. EMPTY by design today. */
const ACTIVE_ZONE_MAPPINGS = Object.freeze({});

for (const k of Object.keys(ACTIVE_ZONE_MAPPINGS)) {
  const m = ACTIVE_ZONE_MAPPINGS[k];
  if (!m || !m.listeningCheck || m.listeningCheck.result !== "pass" || CANONICAL_SOUNDSCAPE_ZONES.indexOf(m.to) < 0) {
    throw new Error("zones.js: mapping '" + k + "' is active without a passed listening check or targets a non-canonical zone");
  }
}

// Delivery zone → soundscape zone written to narration.zones.json.
// Identity today (no mapping is active).
function soundscapeZone(deliveryZone) {
  const m = ACTIVE_ZONE_MAPPINGS[deliveryZone];
  return m ? m.to : deliveryZone;
}

function isCanonical(zone) { return CANONICAL_SOUNDSCAPE_ZONES.indexOf(zone) >= 0; }

// Measurement only (never enforcement): how much of a zone track the frozen
// soundscape will not recognize.
function vocabularyReport(zonesDoc) {
  const zones = (zonesDoc && (zonesDoc.zones || zonesDoc)) || [];
  let total = 0, unknownSeconds = 0; const unknown = {};
  for (const z of zones) {
    const d = Math.max(0, (+z.end || 0) - (+z.start || 0)); total += d;
    if (!isCanonical(z.zone)) { unknownSeconds += d; unknown[z.zone] = +((unknown[z.zone] || 0) + d).toFixed(3); }
  }
  return {
    canonical: unknownSeconds === 0,
    zonesSeen: Array.from(new Set(zones.map(z => z.zone))),
    unknownZones: unknown,
    unknownSeconds: +unknownSeconds.toFixed(3),
    totalSeconds: +total.toFixed(3),
    unknownShare: total ? +(unknownSeconds / total).toFixed(4) : 0
  };
}

module.exports = { CANONICAL_SOUNDSCAPE_ZONES, PROPOSED_ZONE_MAPPINGS, ACTIVE_ZONE_MAPPINGS, soundscapeZone, isCanonical, vocabularyReport };
