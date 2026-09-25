/* =========================================================================
   Harlan's Legacy — NARRATION PROVIDER REGISTRY

   Provider = WHERE/HOW synthesis runs. Rendering profile = HOW intent becomes
   parameters. Candidate A reuses the Golden profile on hosted GPUs; candidate B
   needs its own profile.

   PRODUCTION SELECTION IS CONFIGURATION ONLY:
       HARLAN_PROVIDER=<id>   (default: golden-chatterbox-local — unchanged behavior)
   ROLLBACK = set HARLAN_PROVIDER back to the previous id. That changes which
   provider runs NEW generations only; approved narration assets, manifests and
   bindings are never modified (freshness ignores provider version).
   ========================================================================= */
"use strict";

const { ProviderError } = require("./contract.js");
const { getProfile } = require("./profiles.js");

const PROVIDERS = Object.freeze({
  "golden-chatterbox-local": {
    id: "golden-chatterbox-local", version: "1", kind: "local-process",
    profile: "golden-chatterbox", candidate: null, stagingOnly: false,
    description: "Golden Chatterbox via engine.js command/warm adapter on the host running the worker (dev/benchmark; not a production target per spec §0)",
    required: ["HARLAN_ENGINE_CMD (or HARLAN_WARM_CMD)"],
    isConfigured: () => !!(process.env.HARLAN_ENGINE_CMD || process.env.HARLAN_WARM_CMD)
  },
  "golden-chatterbox-hosted": {
    id: "golden-chatterbox-hosted", version: "1", kind: "remote-async",
    profile: "golden-chatterbox", candidate: "A", stagingOnly: false,
    description: "Candidate A: hosted GPU container (deploy/provider-a) executing the unchanged Golden pipeline + the pinned platform_audio.py — accepts fast, heartbeats, signed completion by poll/pull (push optional); platform re-verifies everything (spec §17)",
    required: ["HARLAN_PROVIDER_A_ENDPOINT", "HARLAN_PROVIDER_A_SECRET"],
    isConfigured: () => !!(process.env.HARLAN_PROVIDER_A_ENDPOINT && process.env.HARLAN_PROVIDER_A_SECRET)
  },
  "tts-api": {
    id: "tts-api", version: "0", kind: "remote-sync",
    profile: "tts-api", candidate: "B", stagingOnly: false,
    description: "Candidate B: specialized high-speed TTS API with a consented voice clone; platform finalizes + aligns",
    required: ["HARLAN_PROVIDER_B_ENDPOINT", "HARLAN_PROVIDER_B_API_KEY", "HARLAN_PROVIDER_B_VOICE_ID", "a defined+frozen tts-api rendering profile"],
    isConfigured: () => !!(process.env.HARLAN_PROVIDER_B_ENDPOINT && process.env.HARLAN_PROVIDER_B_API_KEY && process.env.HARLAN_PROVIDER_B_VOICE_ID && getProfile("tts-api").configured)
  },
  "replay": {
    id: "replay", version: "1", kind: "local-process",
    profile: "golden-chatterbox", candidate: null, stagingOnly: true,
    description: "HARNESS VALIDATION ONLY — returns an immutable reference's existing audio (read-only). Not a candidate; never selectable for production.",
    required: [],
    isConfigured: () => true
  }
});

function get(id) {
  const p = PROVIDERS[id];
  if (!p) throw new ProviderError("invalid_request", "Unknown narration provider: " + id);
  return p;
}

function productionProviderId() { return process.env.HARLAN_PROVIDER || "golden-chatterbox-local"; }

function productionProvider() {
  const p = get(productionProviderId());
  if (p.stagingOnly) throw new ProviderError("invalid_request", "Provider '" + p.id + "' is staging-only and can never run production narration");
  return p;
}

function describe() {
  return Object.values(PROVIDERS).map(p => ({
    id: p.id, version: p.version, kind: p.kind, profile: p.profile, candidate: p.candidate,
    stagingOnly: p.stagingOnly, configured: p.isConfigured(), required: p.required, description: p.description
  }));
}

module.exports = { PROVIDERS, get, productionProviderId, productionProvider, describe };
