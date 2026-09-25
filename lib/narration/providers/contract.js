/* =========================================================================
   Harlan's Legacy — NARRATION PROVIDER CONTRACT (NARRATION_PROVIDER_SPEC.md §3)

   The ONLY surface a narration provider implements. A provider SYNTHESIZES
   audio. Everything else (emotion plan, finalization, alignment, integrity,
   assets, versioning, Ready/Approve/Publish) is platform-owned.

   Provider kinds:
     • "local-process" — runs inside a platform worker process (dev/benchmark)
     • "remote-async"  — accepts fast (≤5 s), heartbeats, completes by SIGNED callback
     • "remote-sync"   — request/response API; the platform worker awaits it

   A provider can NEVER: write platform job state, write listen.json, mark a job
   Ready or Approved, publish, or touch another generation or the references.
   Structurally enforced: providers only receive a staging/output location and a
   completion channel; the platform alone decides Ready after validation.
   ========================================================================= */
"use strict";

const crypto = require("crypto");

const CONTRACT_VERSION = "provider-contract/1";
const ACCEPT_TIMEOUT_MS = 5000;           // remote-async must accept within this
const HEARTBEAT_INTERVAL_MS = 60000;      // provider must heartbeat at least this often
const HEARTBEAT_MISSES_BEFORE_REAP = 2;   // platform reaps (retryable) after this many misses
const COMPLETION_MAX_SKEW_MS = 5 * 60 * 1000;

const PROVIDER_FORBIDDEN = Object.freeze([
  "write platform job state", "write listen.json", "mark Ready", "mark Approved",
  "publish", "read/write other generations", "read/write immutable references"
]);

// ---- error taxonomy (code → retryable) ----
const ERROR_CODES = Object.freeze({
  invalid_request: false, content_rejected: false, voice_unavailable: false,
  provider_not_configured: false, no_reference_audio: false, result_invalid: false,
  signature_invalid: false, revision_mismatch: false,
  capacity: true, timeout: true, internal: true,
  engine_failed: true, engine_timeout: true, engine_output_missing: true, engine_spawn_failed: true,
  heartbeat_lost: true, postprocess_failed: true
});
class ProviderError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = Object.prototype.hasOwnProperty.call(ERROR_CODES, code) ? ERROR_CODES[code] : true;
  }
}
function isRetryable(code) { return Object.prototype.hasOwnProperty.call(ERROR_CODES, code) ? ERROR_CODES[code] : true; }

// ---- deterministic JSON for signatures (sorted keys, no whitespace) ----
function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}
function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }

// Signature = HMAC-SHA256(secret, `${timestamp}.${sha256(canonicalJson(payload))}`)
function signPayload(payload, secret, timestamp) {
  const ts = String(timestamp || Date.now());
  const sig = crypto.createHmac("sha256", String(secret)).update(ts + "." + sha256(canonicalJson(payload))).digest("hex");
  return { payload, timestamp: ts, signature: sig };
}
function verifyEnvelope(envelope, secret, opts) {
  opts = opts || {};
  if (!secret) return { ok: false, code: "provider_not_configured", reason: "no completion secret configured" };
  if (!envelope || typeof envelope !== "object" || !envelope.payload || !envelope.signature || !envelope.timestamp)
    return { ok: false, code: "signature_invalid", reason: "missing payload/signature/timestamp" };
  const ts = Number(envelope.timestamp);
  const now = opts.now || Date.now();
  if (!isFinite(ts) || Math.abs(now - ts) > (opts.maxSkewMs || COMPLETION_MAX_SKEW_MS))
    return { ok: false, code: "signature_invalid", reason: "timestamp outside allowed window" };
  const expect = crypto.createHmac("sha256", String(secret)).update(String(envelope.timestamp) + "." + sha256(canonicalJson(envelope.payload))).digest("hex");
  const a = Buffer.from(expect, "hex"), b = Buffer.from(String(envelope.signature), "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, code: "signature_invalid", reason: "bad signature" };
  return { ok: true };
}

// Signed plain requests (poll / file pull / cancel / health): the signed payload is
// { method, path } and travels in X-Harlan-Timestamp / X-Harlan-Signature headers.
function signRequest(method, pathname, secret, timestamp) {
  const e = signPayload({ method: method, path: pathname }, secret, timestamp);
  return { "X-Harlan-Timestamp": e.timestamp, "X-Harlan-Signature": e.signature };
}

// ---- request (platform → provider) ----
function buildSynthesisRequest(o) {
  const req = {
    contract: CONTRACT_VERSION,
    generationId: o.generationId,                       // idempotency key
    storyId: o.storyId,
    sourceRevision: o.sourceRevision,
    voice: { voiceId: o.voiceId, voiceVersion: o.voiceVersion },
    treatment: {                                        // provider-agnostic intent + frozen rendering
      treatmentVersion: o.treatment.treatmentVersion,
      chunks: o.treatment.chunks.map(c => ({
        i: c.i, text: c.text, deliveryZone: c.deliveryZone, zone: c.zone,
        intensity: c.intensity, gap_before_s: c.gap_before_s
      }))
    },
    renderingProfile: o.renderingProfile,               // { id, version, params: [{i, ...providerParams}] }
    providerProfile: o.providerProfile,                 // { id, version }
    output: o.output,                                   // staging destination (write-only, scoped to this generation)
    completion: o.completion || null,                   // { url } for remote-async; null otherwise
    deadlineMs: o.deadlineMs || 30 * 60 * 1000
  };
  // Optional (spec §17.3): execution hints (fan-out) and the PINNED platform audio
  // module a provider that runs the platform stage in its container must execute.
  if (o.execution) req.execution = o.execution;         // { fanOut }
  if (o.platform) req.platform = o.platform;            // { module, sha256, …versions }
  const errs = validateSynthesisRequest(req);
  if (errs.length) throw new ProviderError("invalid_request", errs.join("; "));
  return req;
}
function validateSynthesisRequest(r) {
  const e = [];
  if (!r.generationId) e.push("generationId required");
  if (r.storyId == null) e.push("storyId required");
  if (!/^sha256:/.test(String(r.sourceRevision || ""))) e.push("sourceRevision must be sha256:…");
  if (!r.voice || !r.voice.voiceId || !r.voice.voiceVersion) e.push("voice identity required");
  if (!r.treatment || !Array.isArray(r.treatment.chunks) || !r.treatment.chunks.length) e.push("treatment.chunks required");
  if (!r.renderingProfile || !r.renderingProfile.id) e.push("renderingProfile required");
  if (!r.providerProfile || !r.providerProfile.id) e.push("providerProfile required");
  if (!r.output) e.push("output (staging destination) required");
  return e;
}

// ---- result (provider → platform) ----
// Mode C: { mode:"C", chunks:[{i, audioPath|audioRef, sr}] , provider:{…} }
// Mode F: { mode:"F", audioPath|audioRef, sr, chunkBoundaries?:[{i,start,end}], words?:[…], zones?:{…}, provider:{…} }
const REQUIRED_PROVIDER_META = ["providerId", "providerVersion", "model", "precision"];
function validateSynthesisResult(res, req) {
  const e = [];
  if (!res || typeof res !== "object") return ["result missing"];
  if (req && res.generationId && res.generationId !== req.generationId) e.push("generationId mismatch");
  if (req && res.sourceRevision && res.sourceRevision !== req.sourceRevision) e.push("sourceRevision mismatch");
  if (res.mode === "C") {
    if (!Array.isArray(res.chunks) || (req && res.chunks.length !== req.treatment.chunks.length)) e.push("Mode C requires one audio per requested chunk");
  } else if (res.mode === "F") {
    if (!res.audioPath && !res.audioRef) e.push("Mode F requires a final mix");
  } else e.push("mode must be 'C' or 'F'");
  const p = res.provider || {};
  for (const k of REQUIRED_PROVIDER_META) if (!p[k]) e.push("provider." + k + " required");
  return e;
}

module.exports = {
  CONTRACT_VERSION, ACCEPT_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_MISSES_BEFORE_REAP,
  COMPLETION_MAX_SKEW_MS, PROVIDER_FORBIDDEN, ERROR_CODES, ProviderError, isRetryable,
  canonicalJson, signPayload, verifyEnvelope, signRequest,
  buildSynthesisRequest, validateSynthesisRequest, validateSynthesisResult, REQUIRED_PROVIDER_META
};
