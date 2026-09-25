/* =========================================================================
   Harlan's Legacy — NarrationService (§3-§14, §19-§21)

   Orchestrates: request → job → engine adapter → alignment/timing → integrity
   → asset storage → story record. Separate from publication: generation makes
   a "ready" version; the admin approves it explicitly (§10). Story edits or a
   voice-version change make an approved narration OUTDATED (§8).

   Engine-agnostic: the heavy synthesis is done by engine.js adapters, invoked
   inside processJob() (which a worker or the local pump runs — never the request
   handler, §19). Idempotency + caching in jobs.js (§13/§14).
   ========================================================================= */
"use strict";

const store = require("../store.js");
const engine = require("./engine.js");
const jobs = require("./jobs.js");
const integrity = require("./integrity.js");
const timings = require("./timings.js");
const assets = require("./assets.js");
const { sourceRevision, narrationText } = require("./text.js");
const treatmentLib = require("./treatment.js");
const { deriveTreatment, upgradeTreatment, viewForProfile, treatmentFromView } = treatmentLib;
const { VOICE_ID, VOICE_IDENTITY_VERSION } = require("./voice.js");
const contract = require("./providers/contract.js");
const profiles = require("./providers/profiles.js");
const registry = require("./providers/registry.js");

// The PROVIDER-AGNOSTIC narration treatment (intent / deliveryZone / zone /
// pause) for a job's story: an approved Super-Admin OVERRIDE (only when it
// matches this exact text revision), else the auto-derived plan. Provider
// parameters are applied later by the active provider's rendering profile.
function treatmentFor(story, rev) {
  const ov = story.narrationTreatment;
  if (ov && ov.source === "admin-override" && ov.sourceRevision === rev) {
    const t = upgradeTreatment(ov);
    t.sourceRevision = rev;
    return t;
  }
  const t = deriveTreatment(narrationText(story));
  t.sourceRevision = rev;
  return t;
}

// The configured rendering profile of the production provider (null if the
// profile is not configured, e.g. candidate B before its mapping is frozen).
function activeProfile() {
  try { const pr = profiles.getProfile(registry.productionProvider().profile); return pr.configured ? pr : null; }
  catch (e) { return null; }
}

const INTEGRITY_TOLERANCE = Number(process.env.HARLAN_INTEGRITY_TOLERANCE || 2); // small allowance for a hyphen/contraction split

function emptyRecord() {
  return { status: "none", voiceId: VOICE_ID, voiceVersion: VOICE_IDENTITY_VERSION, versions: [] };
}
function record(story) { return (story && story.narration) || emptyRecord(); }

// The approved version currently pointed at, if any.
function approvedVersion(rec) { return (rec.versions || []).find(v => v.generationId === rec.generationId && v.status === "approved") || null; }

// Is the approved narration still valid for the current story text + voice? (§8)
function freshness(story) {
  const rec = record(story);
  const rev = sourceRevision(story);
  if (rec.status !== "approved") return { state: rec.status === "none" ? "none" : rec.status, sourceRevision: rev, narrationRevision: rec.sourceRevision || null };
  const sameText = rec.sourceRevision === rev;
  const sameVoice = String(rec.voiceVersion) === String(VOICE_IDENTITY_VERSION);
  return { state: (sameText && sameVoice) ? "approved" : "outdated", sourceRevision: rev, narrationRevision: rec.sourceRevision || null, sameText, sameVoice };
}

// Combined status for the admin panel, merging any active job.
async function statusFor(story) {
  const rec = record(story);
  const fresh = freshness(story);
  const rev = fresh.sourceRevision;
  const active = await jobs.activeFor(story.id, rev, VOICE_IDENTITY_VERSION);
  let ready = (rec.versions || []).filter(v => v.status === "ready" && v.sourceRevision === rev);
  // Surface the most recent FAILED job when nothing better exists for the current
  // text — otherwise a failure would silently read as "none" (§12).
  let failed = null;
  if (!active && ready.length === 0 && fresh.state !== "approved") {
    const last = await jobs.latestFor(story.id, rev);
    if (last && last.status === "failed") failed = last;
  }
  const state = active ? "processing" : failed ? "failed" : fresh.state;
  return {
    storyId: story.id,
    state,   // none | processing | ready | approved | outdated | failed
    job: active ? publicJob(active) : failed ? publicJob(failed) : null,
    approved: approvedVersion(rec),
    readyVersions: ready,
    freshness: fresh,
    voiceId: rec.voiceId || VOICE_ID,
    voiceVersion: VOICE_IDENTITY_VERSION,
    hasText: narrationText(story).trim().length > 0
  };
}

function publicJob(j) {
  return { id: j.id, storyId: j.storyId, status: j.status, stage: j.stage, mode: j.mode, error: j.error, retryable: j.retryable, generationId: (j.result && j.result.generationId) || null, updatedAt: j.updatedAt };
}

// Request a generation. Returns {job, reused, cached}. Caching: if an approved
// version already matches this exact source+voice, offer it instead (§14).
async function requestGeneration(story, opts) {
  opts = opts || {};
  const rev = sourceRevision(story);
  const rec = record(story);
  if (!opts.force) {
    const appr = approvedVersion(rec);
    if (appr && appr.sourceRevision === rev && String(rec.voiceVersion) === String(VOICE_IDENTITY_VERSION)) {
      return { cached: true, version: appr, message: "Approved narration already exists for this exact text and voice." };
    }
  }
  const { job, reused } = await jobs.create({
    storyId: story.id, sourceRevision: rev, voiceId: VOICE_ID, voiceVersion: VOICE_IDENTITY_VERSION,
    mode: opts.mode || "engine", force: !!opts.force, requestedBy: opts.actor || null
  });
  return { job: publicJob(job), reused };
}

// The worker step. Loads the CURRENT story, runs the engine + alignment, verifies
// integrity, stores versioned assets, attaches a "ready" (unapproved) version.
async function processJob(jobId) {
  const j = await jobs.get(jobId);
  if (!j || !jobs.ACTIVE.includes(j.status)) return j;
  const tStart = Date.now();
  try {
    await jobs.update(jobId, { status: "generating", stage: "Generating voice" });
    const stories = await store.getStories();
    const story = stories.find(s => s.id === j.storyId);
    if (!story) throw Object.assign(new Error("Story " + j.storyId + " not found"), { code: "story_missing" });
    const text = narrationText(story);
    if (!text.trim()) throw Object.assign(new Error("Story has no narratable text"), { code: "empty_text" });
    // guard: the story text must still match the revision the job was created for (§8)
    if (sourceRevision(story) !== j.sourceRevision) throw Object.assign(new Error("Story text changed after this job was queued"), { code: "revision_changed" });

    // resolve "auto": use the real engine when configured, else ingest existing
    // pre-aligned assets when present, else engine (which fails truthfully).
    let mode = j.mode;
    if (mode === "auto") {
      mode = process.env.HARLAN_ENGINE_CMD ? "engine"
        : (assets.existsLocal(j.storyId, "narration.mp3") && assets.existsLocal(j.storyId, "narration.words.json")) ? "ingest"
        : "engine";
    }
    // Provider = configuration only (HARLAN_PROVIDER). Remote providers are
    // staging-benchmark only until promoted (NARRATION_PROVIDER_SPEC.md §11).
    const provider = registry.productionProvider();
    if (provider.kind !== "local-process") throw new contract.ProviderError("provider_not_configured", "Provider '" + provider.id + "' (" + provider.kind + ") is not wired for production narration yet — staging benchmark only until promoted.");
    const adapter = engine.pickAdapter(mode);
    // Provider-agnostic plan (auto or approved admin override) → the provider's
    // rendering profile. The Golden profile reproduces the approved values exactly.
    const treatment = treatmentFor(story, j.sourceRevision);
    const prof = profiles.getProfile(provider.profile);
    const rendered = profiles.renderTreatment(treatment, provider.profile);
    // Heartbeat while the provider works (contract §3.2) so the reaper never
    // false-fails a job that is still progressing.
    const hb = setInterval(function () { jobs.heartbeat(jobId, { stage: "Generating voice" }).catch(function () {}); }, contract.HEARTBEAT_INTERVAL_MS);
    const tSynth0 = Date.now();
    let gen;
    try { gen = await adapter.generate({ storyId: j.storyId, text, treatment: rendered }); }
    finally { clearInterval(hb); }
    const synthesisMs = Date.now() - tSynth0;

    await jobs.update(jobId, { status: "aligning", stage: "Creating word/sentence/paragraph timings" });
    const tDerive0 = Date.now();
    const derived = timings.derive(story, gen.words);
    const integ = integrity.check(story, gen.words, INTEGRITY_TOLERANCE);
    const deriveIntegrityMs = Date.now() - tDerive0;
    if (!integ.ok) throw Object.assign(new Error("Timing/text integrity failed: " + integ.missingCount + " missing, " + integ.duplicateCount + " extra word(s)"), { code: "integrity_failed", integrity: integ });

    await jobs.update(jobId, { status: "finalizing", stage: "Finalizing" });
    const generationId = j.id;
    const wordsDoc = { count: gen.words.length, sr: gen.sr, method: gen.method, generationId, voiceId: adapter.voiceId, words: gen.words };
    const files = {
      "narration.mp3": gen.audio,
      "narration.words.json": wordsDoc,
      "narration.sentences.json": { count: derived.sentences.length, sentences: derived.sentences },
      "narration.paragraphs.json": { count: derived.paragraphs.length, paragraphs: derived.paragraphs },
      // the provider-agnostic plan + the exact rendering used, stored WITH the generation
      "narration.treatment.json": Object.assign({}, treatment, { renderingProfile: rendered.renderingProfile, renderedParams: rendered.params })
    };
    // emotional zone map (from the engine) drives the cinematic soundscape
    if (gen.zones) files["narration.zones.json"] = gen.zones.zones ? gen.zones : { zones: gen.zones };
    const tUp0 = Date.now();
    const urls = await assets.writeAssets(j.storyId, files, { subdir: "g/" + generationId, generationId });
    const uploadMs = Date.now() - tUp0;
    const pm = gen.providerMeta || {};
    const isIngest = mode === "ingest";
    const eng = prof.engine || {};
    const recipeVersion = isIngest ? "ingest" : (prof.recipeVersion || null);

    const version = {
      generationId, status: "ready", mode: j.mode,
      sourceRevision: j.sourceRevision, voiceId: VOICE_ID, voiceVersion: VOICE_IDENTITY_VERSION,   // voice IDENTITY (never provider)
      audioUrl: urls["narration.mp3"], wordsUrl: urls["narration.words.json"],
      sentencesUrl: urls["narration.sentences.json"], paragraphsUrl: urls["narration.paragraphs.json"],
      treatmentUrl: urls["narration.treatment.json"], zonesUrl: urls["narration.zones.json"] || null,
      recipe: recipeVersion, recipeVersion: recipeVersion, method: gen.method || null,
      provider: {
        id: isIngest ? "ingest" : provider.id, version: isIngest ? "1" : provider.version,
        kind: isIngest ? "ingest" : provider.kind, adapter: adapter.name,
        engine: pm.engine || eng.name || null, engineVersion: pm.engineVersion || eng.version || null,
        model: pm.model || eng.checkpoint || null, checkpoint: pm.checkpoint || eng.checkpoint || null,
        voiceRefSha256: pm.voiceRefSha256 || eng.voiceReferenceSha256 || null,
        precision: pm.precision || eng.precision || null, device: pm.device || null,
        seed: pm.seed != null ? pm.seed : (eng.seed != null ? eng.seed : null)
      },
      renderingProfile: isIngest ? null : rendered.renderingProfile,
      pipeline: { finalizerVersion: pm.finalizerVersion || null, alignerVersion: pm.alignerVersion || null, encoderVersion: pm.encoderVersion || null, audioStandardVersion: pm.audioStandardVersion || null },
      stageTimings: { queueMs: tStart - (j.createdAt || tStart), synthesisMs: synthesisMs, providerReported: pm.stageTimings || null, deriveIntegrityMs: deriveIntegrityMs, uploadMs: uploadMs, totalMs: Date.now() - (j.createdAt || tStart) },
      treatmentVersion: treatment.treatmentVersion, treatmentSchema: treatment.treatmentSchema || 1, treatmentSource: treatment.source,
      emotionalArc: treatment.arc, dominantEmotion: treatment.dominantEmotion,
      duration: +(gen.duration || derived.duration || 0), integrity: integ,
      generatedAt: new Date().toISOString(), approvedAt: null
    };
    await attachVersion(j.storyId, version);
    await jobs.update(jobId, { status: "ready", stage: "Ready", result: { generationId } });
    return await jobs.get(jobId);
  } catch (e) {
    const retryable = (e && typeof e.retryable === "boolean") ? e.retryable : !["empty_text", "story_missing", "engine_not_configured", "ingest_assets_missing", "integrity_failed", "provider_not_configured"].includes(e.code);
    await jobs.update(jobId, { status: "failed", stage: "Generation failed", error: { code: e.code || "error", message: String(e.message || e), integrity: e.integrity || null }, retryable });
    return await jobs.get(jobId);
  }
}

// Merge a new version into the story's narration record (does not approve).
async function attachVersion(storyId, version) {
  const stories = await store.getStories();
  const story = stories.find(s => s.id === storyId);
  if (!story) return;
  const rec = record(story);
  rec.voiceId = version.voiceId; rec.voiceVersion = version.voiceVersion;
  rec.versions = (rec.versions || []).filter(v => v.generationId !== version.generationId).concat([version]);
  // keep the newest ~6 versions
  rec.versions = rec.versions.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1)).slice(0, 6);
  if (rec.status !== "approved") { rec.status = "ready"; rec.sourceRevision = rec.sourceRevision || null; }
  story.narration = rec;
  await store.putStory(story);
}

// Approve a ready version → it becomes the public narration. The previously
// approved version is marked superseded but its assets are NOT deleted (§11).
async function approve(storyId, generationId, opts) {
  opts = opts || {};
  const actor = opts.actor || null;
  const stories = await store.getStories();
  const story = stories.find(s => s.id === storyId);
  if (!story) throw Object.assign(new Error("Story not found"), { code: "story_missing" });
  const rec = record(story);
  const v = (rec.versions || []).find(x => x.generationId === generationId);
  if (!v) throw Object.assign(new Error("No such generation"), { code: "no_version" });
  if (!v.integrity || !v.integrity.ok) throw Object.assign(new Error("Cannot approve: integrity check did not pass"), { code: "integrity_failed" });
  (rec.versions || []).forEach(x => { if (x.status === "approved") x.status = "superseded"; });
  v.status = "approved"; v.approvedAt = new Date().toISOString(); v.approvedBy = actor;
  rec.status = "approved";
  rec.generationId = v.generationId;
  rec.sourceRevision = v.sourceRevision;
  rec.voiceId = v.voiceId; rec.voiceVersion = v.voiceVersion;
  rec.audioUrl = v.audioUrl; rec.wordsUrl = v.wordsUrl; rec.sentencesUrl = v.sentencesUrl; rec.paragraphsUrl = v.paragraphsUrl;
  rec.duration = v.duration; rec.integrity = v.integrity;
  rec.generatedAt = v.generatedAt; rec.approvedAt = v.approvedAt; rec.approvedBy = actor;
  story.narration = rec;
  // bind the approved generation to this exact story revision (§5)
  story.narrationPublication = { storyId: story.id, sourceRevision: v.sourceRevision, generationId: v.generationId, voiceId: v.voiceId, voiceVersion: v.voiceVersion, manifest: "assets/listen/" + story.id + "/listen.json", boundAt: new Date().toISOString(), approvedBy: actor };
  await store.putStory(story);

  // Write the PUBLIC manifest the reader's Listening engine loads. Paths are
  // relative to assets/listen/<id>/ and point at the approved generation only.
  // Exposes just playback data (§5) — no engine/worker/secret/admin details.
  const rel = function (name) { return "g/" + v.generationId + "/" + name; };
  const manifest = {
    audio: rel("narration.mp3"),
    words: rel("narration.words.json"),
    sentences: rel("narration.sentences.json"),
    paragraphs: rel("narration.paragraphs.json"),
    duration: v.duration,
    voiceId: v.voiceId, voiceVersion: v.voiceVersion,
    label: "Narrated by the voice of Harlan's Legacy"
  };
  // keep an existing emotional-zone track (atmosphere) if the story has one
  // storage-aware (Supabase in prod, fs in dev) so a remote worker's zones are seen
  if (await assets.exists(storyId, "g/" + v.generationId + "/narration.zones.json")) manifest.zones = "g/" + v.generationId + "/narration.zones.json";
  else if (await assets.exists(storyId, "narration.zones.json")) manifest.zones = "narration.zones.json";
  try { await assets.writeAssets(storyId, { "listen.json": manifest }, {}); } catch (e) { /* non-fatal: record is approved; manifest can be rewritten */ }
  return rec;
}

// Is the real Harlan synthesis engine configured on this worker? (§8 honesty)
function engineConfigured() { return !!process.env.HARLAN_ENGINE_CMD; }

// Bind the approved generation to the current story revision, and stamp it as the
// published narration IFF it is approved+fresh. Prevents rev-B story + rev-A
// narration ever reading as "published narration" (§5). Mutates + persists.
async function bindPublication(story) {
  const rec = record(story);
  const fresh = freshness(story);
  if (fresh.state === "approved") {
    story.narrationPublication = {
      storyId: story.id, sourceRevision: fresh.sourceRevision,
      generationId: rec.generationId, voiceId: rec.voiceId, voiceVersion: rec.voiceVersion,
      manifest: "assets/listen/" + story.id + "/listen.json", boundAt: new Date().toISOString()
    };
  } else {
    // never leave a stale binding claiming the current text is narrated
    if (story.narrationPublication) delete story.narrationPublication;
  }
  await store.putStory(story);
  return story.narrationPublication || null;
}

// Pure: the publication binding for a story IFF approved+fresh, else null (no persist).
function bindingFor(story) {
  const fresh = freshness(story); const rec = record(story);
  if (fresh.state !== "approved") return null;
  return { storyId: story.id, sourceRevision: fresh.sourceRevision, generationId: rec.generationId, voiceId: rec.voiceId, voiceVersion: rec.voiceVersion, manifest: "assets/listen/" + story.id + "/listen.json", boundAt: new Date().toISOString() };
}

// Publish-time contract. A story may be published ONLY with an approved, fresh
// narration whose approved generation is intact. Every other state BLOCKS publish
// with a specific, actionable code + message. Never silently publishes without
// Listening. Read-only (no mutation).
//   { state, listening, block, code, message, action, binding }
async function publishReadiness(story) {
  const rec = record(story);
  const fresh = freshness(story);
  const rev = fresh.sourceRevision;
  const allow = (binding) => ({ state: "approved", listening: true, block: false, code: null, action: "publish", message: "Narration is approved and matches the current text — Listening will publish with the story.", binding });
  const blk = (state, code, message, action) => ({ state, listening: false, block: true, code, message, action });

  // a job in flight for the current text
  const active = await jobs.activeFor(story.id, rev, VOICE_IDENTITY_VERSION);
  if (active) return blk("processing", "narration_processing", "Voice narration is still being generated. Publish becomes available after narration is ready and approved.", "wait");

  // approved record
  if (rec.status === "approved") {
    if (fresh.state === "outdated") return blk("outdated", "narration_stale", "Story text changed. Regenerate and approve narration before publishing.", "regenerate");
    // approved + fresh — but the approved generation must still be intact
    const appr = approvedVersion(rec);
    if (!appr) return blk("superseded", "narration_superseded", "The current narration is no longer the approved generation for this story. Regenerate or approve the current generation before publishing.", "regenerate");
    return allow(bindingFor(story));
  }

  // not approved: ready (awaiting approval) → failed → missing
  const readyForRev = (rec.versions || []).some(v => v.status === "ready" && v.sourceRevision === rev);
  if (readyForRev) return blk("ready", "narration_approval_required", "Voice narration is ready, but it must be previewed and approved before publishing.", "approve");
  const last = await jobs.latestFor(story.id, rev);
  if (last && last.status === "failed") return blk("failed", "narration_failed", "Voice narration generation failed. Retry generation before publishing.", "retry");
  return blk("none", "narration_required", "Voice narration must be generated and approved before this story can be published.", "generate");
}

// A compact per-story summary for the Narration Library (§7). Public-safe fields only.
function libraryRow(story) {
  const rec = record(story);
  const fresh = freshness(story);
  const appr = approvedVersion(rec);
  return {
    id: story.id, title: story.title, storyStatus: story.status,
    state: fresh.state,                     // none | ready | approved | outdated | failed (before active-job merge)
    generationId: rec.generationId || null,
    voiceId: rec.voiceId || VOICE_ID, voiceVersion: VOICE_IDENTITY_VERSION,
    duration: appr ? appr.duration : (rec.duration || null),
    audioUrl: appr ? appr.audioUrl : null,          // public, approved only
    generatedAt: rec.generatedAt || null, approvedAt: rec.approvedAt || null,
    fresh: fresh.state === "approved", hasText: narrationText(story).trim().length > 0
  };
}

// Whole-archive view + live job state (§7).
async function library() {
  const stories = await store.getStories();
  const jobsAll = await jobs.reap();
  const rows = stories.map(libraryRow).map(function (r) {
    const active = Object.values(jobsAll).find(function (j) { return j.storyId === r.id && jobs.ACTIVE.includes(j.status); });
    if (active) { r.state = "processing"; r.job = publicJob(active); }
    else { const last = Object.values(jobsAll).filter(function (j) { return j.storyId === r.id; }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })[0]; if (last && last.status === "failed" && r.state !== "approved") { r.state = "failed"; r.job = publicJob(last); } }
    return r;
  });
  return { engineConfigured: engineConfigured(), voiceId: VOICE_ID, voiceVersion: VOICE_IDENTITY_VERSION, counts: await jobs.counts(), stories: rows };
}

// Queue generation for every story that needs it (missing/outdated/failed) — never
// touches approved+fresh narration (§7, §17). Returns the ids queued.
async function generateMissing(opts) {
  opts = opts || {};
  const stories = await store.getStories();
  const includeDrafts = !!opts.includeDrafts;
  const queued = [];
  for (const s of stories) {
    if (!includeDrafts && s.status === "draft") continue;
    if (!narrationText(s).trim()) continue;                 // nothing to narrate
    const fresh = freshness(s);
    if (fresh.state === "approved") continue;               // do NOT regenerate approved+fresh
    const active = await jobs.activeFor(s.id, fresh.sourceRevision, VOICE_IDENTITY_VERSION);
    if (active) continue;                                    // already in flight
    const r = await requestGeneration(s, { mode: "auto" });
    if (r.job) queued.push(s.id);
  }
  return { queued: queued, count: queued.length };
}

/* ---- Super-Admin narration treatment: review + optional override (§4) ----
   The auto-derived treatment is the default; an admin may review and override
   it BEFORE synthesis. Overrides are clamped into the Golden ranges so a manual
   edit can never leave the approved technical recipe. */
async function getTreatment(story) {
  const rev = sourceRevision(story);
  const t = treatmentFor(story, rev);
  // Flattened view (unchanged UI shape): delivery zone + the ACTIVE provider
  // profile's parameters for display/edit.
  return { storyId: story.id, sourceRevision: rev, effective: t.source || "auto", treatment: viewForProfile(t, activeProfile()) };
}
async function setTreatmentOverride(storyId, incoming) {
  const stories = await store.getStories();
  const story = stories.find(s => s.id === storyId);
  if (!story) throw Object.assign(new Error("Story not found"), { code: "story_missing" });
  const rev = sourceRevision(story);
  // Intent edits (delivery zone / intensity / pause) are provider-agnostic.
  // Edited parameters are stored as an override for the ACTIVE profile only,
  // clamped to that profile's ranges.
  const t = treatmentFromView(incoming || {}, activeProfile());
  if (!t.chunks.length) throw Object.assign(new Error("Treatment must have at least one chunk"), { code: "bad_treatment" });
  t.sourceRevision = rev; t.editedAt = new Date().toISOString();
  story.narrationTreatment = t;
  await store.putStory(story);
  return t;
}
async function clearTreatmentOverride(storyId) {
  const stories = await store.getStories();
  const story = stories.find(s => s.id === storyId);
  if (!story) throw Object.assign(new Error("Story not found"), { code: "story_missing" });
  if (story.narrationTreatment) delete story.narrationTreatment;
  await store.putStory(story);
  return treatmentFor(story, sourceRevision(story));
}

// Re-queue every failed job's story at its CURRENT revision (§7).
async function retryFailed() {
  const jobsAll = await jobs.all();
  const stories = await store.getStories();
  const seen = {}, requeued = [];
  for (const id of Object.keys(jobsAll)) {
    const j = jobsAll[id];
    if (j.status !== "failed" || seen[j.storyId]) continue;
    seen[j.storyId] = true;
    const s = stories.find(function (x) { return x.id === j.storyId; });
    if (!s || !narrationText(s).trim()) continue;
    if (freshness(s).state === "approved") continue;
    const r = await requestGeneration(s, { mode: "auto" });
    if (r.job) requeued.push(s.id);
  }
  return { requeued: requeued, count: requeued.length };
}

module.exports = {
  emptyRecord, record, freshness, statusFor, requestGeneration, processJob, attachVersion, approve, publicJob, sourceRevision,
  engineConfigured, bindPublication, bindingFor, publishReadiness, library, libraryRow, generateMissing, retryFailed,
  treatmentFor, getTreatment, setTreatmentOverride, clearTreatmentOverride
};
