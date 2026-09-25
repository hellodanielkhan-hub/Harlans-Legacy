/* =========================================================================
   Harlan's Legacy — ISOLATED STAGING BENCHMARK (NARRATION_PROVIDER_SPEC.md §10)

   Runs provider candidates against the FROZEN test set and records measured
   results. Hard isolation from production:
     • its own job queue  (key "narration_jobs_staging", idPrefix "stg_")
     • its own storage    (<repo>/staging/narration/ — never under assets/, never
                           copied to public/, never hydrated, never deployed).
                           Supabase staging mode is DISABLED for the Candidate-A
                           benchmark: it would write to the production database
                           (spec §17.9 — no production storage is touched).
     • its own job store  (one JSON file per job, atomic replace — the API process
                           creates, the worker updates; no shared-document races)
     • NEVER reads or writes story records, narration versions, manifests,
       bindings, approvals or the immutable references (references are only
       READ by the harness-validation "replay" provider).
   Nothing here can mark a real story Ready/Approved or publish anything.
   ========================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const paths = require("../paths.js");
const integrity = require("./integrity.js");
const timings = require("./timings.js");
const text = require("./text.js");
const zonesLib = require("./zones.js");
const contract = require("./providers/contract.js");
const profiles = require("./providers/profiles.js");
const registry = require("./providers/registry.js");
const remote = require("./providers/remote-http.js");
const hostedA = require("./providers/hosted-a.js");
const { VOICE_ID, VOICE_IDENTITY_VERSION } = require("./voice.js");

const ROOT = paths.ROOT;
const STAGING_DIR = path.join(ROOT, "staging", "narration");
const RUNS_DIR = path.join(STAGING_DIR, "runs");
const MODE = (process.env.HARLAN_STAGING_STORE || "file").toLowerCase();   // "file" | "supabase"
const TESTSET_PATH = path.join(ROOT, "tools", "narration-bench", "testset.json");
const PLATFORM_AUDIO = path.join(ROOT, "lib", "narration", "platform_audio.py");
const PY = process.env.HARLAN_PLATFORM_PY || (process.platform === "win32"
  ? path.join(ROOT, "prototype", "voicelab", "venv", "Scripts", "python.exe")
  : path.join(ROOT, "prototype", "voicelab", "venv", "bin", "python"));
const REF_TYPICAL = path.join(ROOT, "prototype", "voicelab", "ref_typical.wav");
const REF_304_MP3 = path.join(ROOT, "assets", "listen", "304", "g", "gen_5c11198118da", "narration.mp3");
const REFS = "ref_typical=" + REF_TYPICAL + ",r304=" + REF_304_MP3;   // read-only references for speaker similarity
const PROD_ASSETS = path.resolve(ROOT, "assets");

/* ---------------- isolation guards ---------------- */
function assertStagingPath(p) {
  const r = path.resolve(p);
  if (!r.startsWith(path.resolve(STAGING_DIR) + path.sep) && r !== path.resolve(STAGING_DIR)) throw new Error("staging isolation violation: refusing to write outside " + STAGING_DIR + ": " + r);
  if (r.startsWith(PROD_ASSETS + path.sep)) throw new Error("staging isolation violation: refusing to write under assets/: " + r);
  return r;
}

/* ---------------- staging-only job store: one file per job ---------------- */
if (MODE !== "file") throw new Error("HARLAN_STAGING_STORE=" + MODE + " is disabled: the staging benchmark never writes to the production database (spec §17.9). Use file mode.");
const JOBS_DIR = path.join(STAGING_DIR, "jobs");
const STALE_MS = contract.HEARTBEAT_INTERVAL_MS * contract.HEARTBEAT_MISSES_BEFORE_REAP + 30000;
const ACTIVE = ["queued", "generating", "aligning", "finalizing"];   // same lifecycle as lib/narration/jobs.js
const RUNNING = new Set();
const sleepSync = ms => { const t = Date.now() + ms; while (Date.now() < t) { /* brief spin for a Windows rename retry */ } };
function jobFile(id) {
  if (!/^stg_[0-9a-f]{12}$/.test(String(id))) throw new contract.ProviderError("invalid_request", "bad staging job id");
  return assertStagingPath(path.join(JOBS_DIR, id + ".json"));
}
function readJob(id) { try { return JSON.parse(fs.readFileSync(jobFile(id), "utf8")); } catch (e) { return null; } }
function writeJob(j) {
  const p = jobFile(j.id); fs.mkdirSync(JOBS_DIR, { recursive: true });
  const tmp = assertStagingPath(p + "." + process.pid + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(j, null, 1));
  for (let k = 0; ; k++) { try { fs.renameSync(tmp, p); return; } catch (e) { if (k >= 20) throw e; sleepSync(25); } }
}
// Per-process serialization of read-modify-write on job files.
let chain = Promise.resolve();
const serial = fn => (...a) => { const r = chain.then(() => fn(...a)); chain = r.catch(() => {}); return r; };
const sjobs = {
  ACTIVE,
  async get(id) { return readJob(id); },
  async all() {
    const out = {};
    if (!fs.existsSync(JOBS_DIR)) return out;
    for (const f of fs.readdirSync(JOBS_DIR)) if (/^stg_[0-9a-f]{12}\.json$/.test(f)) { const j = readJob(f.slice(0, -5)); if (j) out[j.id] = j; }
    return out;
  },
  create: serial(async fields => {
    const now = Date.now();
    const id = "stg_" + crypto.createHash("sha1").update(fields.storyId + "|" + now + "|" + Math.random()).digest("hex").slice(0, 12);
    const job = Object.assign({}, fields.extra || {}, { id, storyId: fields.storyId, sourceRevision: fields.sourceRevision, voiceId: fields.voiceId,
      voiceVersion: fields.voiceVersion, mode: fields.mode, status: "queued", stage: "Queued", error: null, retryable: false,
      requestedBy: fields.requestedBy || null, result: null, createdAt: now, updatedAt: now });
    writeJob(job); return { job, reused: false };
  }),
  update: serial(async (id, patch) => { const j = readJob(id); if (!j) return null; Object.assign(j, patch, { updatedAt: Date.now() }); writeJob(j); return j; }),
  heartbeat(id, patch) { return sjobs.update(id, Object.assign({ heartbeatAt: Date.now() }, patch || {})); },
  reap: serial(async () => {
    const all = await sjobs.all(); const now = Date.now();
    for (const j of Object.values(all)) if (ACTIVE.includes(j.status) && j.status !== "queued" && !RUNNING.has(j.id) && now - (j.updatedAt || j.createdAt) > STALE_MS) {
      Object.assign(j, { status: "failed", error: { code: "job_timeout", message: "Staging job timed out (no heartbeat)." }, retryable: true, updatedAt: now }); writeJob(j);
    }
    return all;
  })
};

/* ---------------- frozen test set ---------------- */
function loadTestSet() {
  if (!fs.existsSync(TESTSET_PATH)) throw new contract.ProviderError("invalid_request", "Frozen test set missing: run tools/narration-bench/freeze-testset.cjs");
  return JSON.parse(fs.readFileSync(TESTSET_PATH, "utf8"));
}
function caseById(caseId) {
  const ts = loadTestSet();
  const c = (ts.cases || []).find(x => x.caseId === caseId);
  if (!c) throw new contract.ProviderError("invalid_request", "Unknown test case: " + caseId);
  return c;
}
function caseStory(c) { return { id: "case:" + c.caseId, lead: c.snapshot.lead, body: c.snapshot.body }; }

/* ---------------- enqueue (the "Generate" analogue) ---------------- */
async function enqueue(o) {
  const c = caseById(o.caseId);
  const p = registry.get(o.providerId);
  if (!p.isConfigured()) throw new contract.ProviderError("provider_not_configured", "Provider '" + p.id + "' is not configured. Required: " + p.required.join(", "));
  const pr = profiles.getProfile(p.profile);
  if (!pr.configured) throw new contract.ProviderError("provider_not_configured", "Rendering profile '" + pr.id + "' is not configured");
  const fanOut = o.fanOut == null ? 1 : Number(o.fanOut);
  if (!Number.isInteger(fanOut) || fanOut < 1 || fanOut > 64) throw new contract.ProviderError("invalid_request", "fanOut must be an integer 1..64");
  const live = text.sourceRevision(caseStory(c));
  if (live !== c.sourceRevision) throw new contract.ProviderError("revision_mismatch", "Test case text no longer matches its frozen sourceRevision");
  const { job } = await sjobs.create({
    storyId: "case:" + c.caseId, sourceRevision: c.sourceRevision, voiceId: VOICE_ID, voiceVersion: VOICE_IDENTITY_VERSION,
    mode: p.id, force: true, requestedBy: o.actor || null,
    extra: { staging: true, caseId: c.caseId, providerId: p.id, providerKind: p.kind, runLabel: o.runLabel || null, fanOut }
  });
  return job;
}

/* ---------------- python platform post-processing ---------------- */
function runPlatform(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [PLATFORM_AUDIO].concat(args), { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "", err = "";
    child.stdout.on("data", d => { out = (out + d.toString()).slice(-8000); });
    child.stderr.on("data", d => { err = (err + d.toString()).slice(-8000); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} reject(new contract.ProviderError("postprocess_failed", "platform post-processing timed out")); }, timeoutMs || 20 * 60 * 1000);
    child.on("error", e => { clearTimeout(timer); reject(new contract.ProviderError("postprocess_failed", String(e.message || e))); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new contract.ProviderError("postprocess_failed", "platform_audio exited " + code + ": " + err.trim().slice(-800))); });
  });
}

/* ---------------- providers runnable inside a staging worker ---------------- */
async function runLocalProvider(j, c, rendered, runDir) {
  if (j.providerId === "replay") {
    // HARNESS VALIDATION ONLY: hand back an immutable reference's EXISTING audio,
    // read-only. No synthesis happens; references are never written.
    if (!c.reference) throw new contract.ProviderError("no_reference_audio", "replay needs a case with an immutable reference (bluechair or r304)");
    return { mode: "F", audioPath: path.join(ROOT, c.reference.audioPath), zonesPath: path.join(ROOT, c.reference.zonesPath),
      provider: { providerId: "replay", providerVersion: "1", model: "reference audio (read-only, " + c.reference.generationId + ")", precision: "n/a" }, usage: {} };
  }
  if (j.providerId === "golden-chatterbox-local") {
    const engine = require("./engine.js");
    const adapter = engine.pickAdapter("engine");
    const gen = await adapter.generate({ storyId: j.storyId, text: text.narrationText(caseStory(c)), treatment: rendered });
    const mp3 = assertStagingPath(path.join(runDir, "provider-output.mp3"));
    fs.writeFileSync(mp3, gen.audio);
    const zf = assertStagingPath(path.join(runDir, "provider-zones.json"));
    fs.writeFileSync(zf, JSON.stringify(gen.zones && gen.zones.zones ? gen.zones : { zones: gen.zones || [] }));
    const pm = gen.providerMeta || {};
    return { mode: "F", audioPath: mp3, zonesPath: zf,
      provider: Object.assign({ providerId: "golden-chatterbox-local", providerVersion: "1", model: pm.model || "chatterbox-tts", precision: pm.precision || "fp32" }, pm),
      usage: { computeSeconds: pm.stageTimings ? Object.values(pm.stageTimings).reduce((a, b) => a + (+b || 0), 0) : null } };
  }
  throw new contract.ProviderError("provider_not_configured", "No local runner for provider " + j.providerId);
}

/* ---------------- cost (measured usage × operator-supplied actual rates) ---------------- */
function costOf(usage, providerId) {
  if (providerId === "replay") return { perNarration: 0, basis: "n/a — harness validation, not a candidate" };
  const gpuRate = Number(process.env.HARLAN_COST_GPU_PER_SECOND || NaN);
  const charRate = Number(process.env.HARLAN_COST_PER_CHARACTER || NaN);
  if (usage && usage.gpuSeconds != null && isFinite(gpuRate)) return { perNarration: +(usage.gpuSeconds * gpuRate).toFixed(5), basis: "gpuSeconds × HARLAN_COST_GPU_PER_SECOND" };
  if (usage && usage.characters != null && isFinite(charRate)) return { perNarration: +(usage.characters * charRate).toFixed(5), basis: "characters × HARLAN_COST_PER_CHARACTER" };
  return { perNarration: null, basis: "unmeasured — needs provider-reported usage + the actual billed rate", usage: usage || null };
}

/* ---------------- platform Node checks (identical for every provider) ---------------- */
// Integrity, timings derivation, zone vocabulary and reader/cinematic structural
// compatibility — the platform's own code, re-run on whatever the provider delivered.
function platformChecks(c, outDir, durationS, expectZones) {
  const wj = JSON.parse(fs.readFileSync(path.join(outDir, "narration.words.json"), "utf8"));
  const words = wj.words.map((w, i) => ({ i: w.i != null ? w.i : i, w: w.w, start: +w.start, end: +w.end }));
  const cs = caseStory(c);
  const integ = integrity.check(cs, words, 2);
  const derived = timings.derive(cs, words);
  fs.writeFileSync(assertStagingPath(path.join(outDir, "narration.sentences.json")), JSON.stringify({ count: derived.sentences.length, sentences: derived.sentences }));
  fs.writeFileSync(assertStagingPath(path.join(outDir, "narration.paragraphs.json")), JSON.stringify({ count: derived.paragraphs.length, paragraphs: derived.paragraphs }));
  const zonesDoc = JSON.parse(fs.readFileSync(path.join(outDir, "narration.zones.json"), "utf8"));
  const vocab = zonesLib.vocabularyReport(zonesDoc);
  const zoneBounds = (zonesDoc.zones || []).every(z => z.start >= 0 && z.end >= z.start && z.end <= durationS + 0.01);
  const monotonic = words.every((w, k) => w.end >= w.start && (k === 0 || w.start >= words[k - 1].end - 1e-6));
  // Emotional-zone validation: delivered zone runs must equal the treatment's
  // zone runs, at the boundaries the chunk accounting implies (±2 ms).
  let zoneMatch = null;
  if (expectZones) {
    const got = zonesDoc.zones || [];
    const namesOk = got.length === expectZones.length && got.every((z, k) => z.zone === expectZones[k].zone);
    const maxDelta = namesOk ? Math.max(0, ...got.map((z, k) => Math.max(Math.abs(z.start - expectZones[k].start), Math.abs(z.end - expectZones[k].end)))) : null;
    zoneMatch = { ok: namesOk && maxDelta <= 0.002, namesOk, maxBoundaryDeltaS: maxDelta == null ? null : +maxDelta.toFixed(4),
      expected: expectZones.map(z => z.zone), delivered: got.map(z => z.zone) };
  }
  const manifest = { audio: "narration.mp3", words: "narration.words.json", sentences: "narration.sentences.json",
    paragraphs: "narration.paragraphs.json", duration: durationS, voiceId: VOICE_ID, voiceVersion: VOICE_IDENTITY_VERSION,
    label: "STAGING BENCHMARK — NOT PUBLISHED", zones: "narration.zones.json" };
  fs.writeFileSync(assertStagingPath(path.join(outDir, "listen.staging.json")), JSON.stringify(manifest));
  const readerCompat = {
    filesPresent: ["narration.mp3", "narration.words.json", "narration.sentences.json", "narration.paragraphs.json", "narration.zones.json"].every(f => fs.existsSync(path.join(outDir, f))),
    wordShape: words.every(w => typeof w.w === "string" && isFinite(w.start) && isFinite(w.end)),
    wordsCoverText: integ.ok,
    durationCoversWords: words.length ? durationS + 1e-3 >= words[words.length - 1].end : false,
    zonesWithinDuration: zoneBounds,
    visualPlaybackCheck: "manual (Tier 3): open via Preview harness"
  };
  readerCompat.pass = readerCompat.filesPresent && readerCompat.wordShape && readerCompat.wordsCoverText && readerCompat.durationCoversWords && readerCompat.zonesWithinDuration;
  return {
    integrity: { ok: integ.ok, sourceWords: integ.sourceWords, timedWords: integ.timedWords, missingCount: integ.missingCount, duplicateCount: integ.duplicateCount, tolerance: 2 },
    timings: { monotonic, withinDuration: words.length ? words[words.length - 1].end <= durationS + 1e-3 : false },
    zones: Object.assign({ boundariesValid: zoneBounds, match: zoneMatch }, vocab),
    readerCompat
  };
}

/* ---------------- platform post-processing for LOCAL providers → staging assets + metrics ---------------- */
async function postprocess(j, c, rendered, result, runDir) {
  const errs = contract.validateSynthesisResult(result, { generationId: j.id, sourceRevision: j.sourceRevision, treatment: rendered });
  if (errs.length) throw new contract.ProviderError("result_invalid", errs.join("; "));
  const outDir = assertStagingPath(path.join(runDir, "assets"));
  const planPath = assertStagingPath(path.join(runDir, "plan.json"));
  fs.writeFileSync(planPath, JSON.stringify(rendered));
  const t0 = Date.now();
  if (result.mode === "F") {
    await runPlatform(["verify", "--audio", result.audioPath, "--plan", planPath, "--out", outDir, "--zones", result.zonesPath || "", "--refs", REFS]);
  } else {
    await runPlatform(["finalize", "--chunks-dir", result.chunksDir, "--plan", planPath, "--out", outDir, "--refs", REFS]);
  }
  const platformAudioMs = Date.now() - t0;
  const t1 = Date.now();
  const metrics = JSON.parse(fs.readFileSync(path.join(outDir, "metrics.json"), "utf8"));
  const chk = platformChecks(c, outDir, metrics.durationS, null);
  return Object.assign({
    runDir: path.relative(ROOT, runDir).split(path.sep).join("/"),
    provider: result.provider, mode: result.mode, metrics, sourceRevisionOk: j.sourceRevision === c.sourceRevision,
    cost: costOf(result.usage, j.providerId),
    platformTimings: { platformAudioMs, platformNodeMs: Date.now() - t1 }
  }, chk);
}

/* ---------------- Candidate A: await signed completion (poll, or pushed callback) ---------------- */
const PROVIDER_POLL_MS = Number(process.env.HARLAN_STAGING_PROVIDER_POLL_MS || 1000);
const LOST_MS = contract.HEARTBEAT_INTERVAL_MS * contract.HEARTBEAT_MISSES_BEFORE_REAP;
async function awaitRemote(jobId, cfg, providerJobId, deadlineMs, secret) {
  const t0 = Date.now(); let lastBeat = null, lastBeatSeen = Date.now(), lastErrAt = null, lastStage = null, lastWrite = 0;
  for (;;) {
    if (Date.now() - t0 > deadlineMs) { remote.cancel(cfg, providerJobId).catch(() => {}); throw new contract.ProviderError("timeout", "provider exceeded deadline"); }
    const j = await sjobs.get(jobId);
    let env = j && j.callbackEnvelope, st = null;
    if (!env) {
      try { st = await remote.poll(cfg, providerJobId); lastErrAt = null; }
      catch (e) {
        if (e.code === "signature_invalid") throw e;
        lastErrAt = lastErrAt || Date.now();
        if (Date.now() - lastErrAt > LOST_MS) throw new contract.ProviderError("heartbeat_lost", "provider unreachable for " + Math.round(LOST_MS / 1000) + " s: " + e.message);
      }
      if (st) {
        if (st.heartbeatAt !== lastBeat) { lastBeat = st.heartbeatAt; lastBeatSeen = Date.now(); }
        else if (Date.now() - lastBeatSeen > LOST_MS) throw new contract.ProviderError("heartbeat_lost", "provider heartbeat stalled");
        const stage = "Provider: " + (st.stage || st.state) + (st.chunksTotal ? " (" + st.chunksDone + "/" + st.chunksTotal + " chunks)" : "");
        if (stage !== lastStage || Date.now() - lastWrite > 15000) { await sjobs.heartbeat(jobId, { stage, providerState: st.state, providerColdStart: st.coldStart }); lastStage = stage; lastWrite = Date.now(); }
        if (st.completion) env = st.completion;
        else if (st.state === "cancelled") throw new contract.ProviderError("internal", "provider cancelled the job");
      }
    }
    if (env) {
      // Polled completions travel over an authenticated pull, so the replay window is the job deadline.
      const v = contract.verifyEnvelope(env, secret, { maxSkewMs: deadlineMs + 10 * 60 * 1000 });
      if (!v.ok) throw new contract.ProviderError("signature_invalid", "completion signature: " + v.reason);
      return env;
    }
    await new Promise(r => setTimeout(r, PROVIDER_POLL_MS));
  }
}

async function ingestHosted(j, c, rendered, payload, runDir, cfg, providerJobId) {
  if (payload.error) throw new contract.ProviderError(payload.error.code || "internal", "provider: " + (payload.error.message || payload.error.code));
  if (payload.sourceRevision !== j.sourceRevision || j.sourceRevision !== c.sourceRevision) throw new contract.ProviderError("revision_mismatch", "sourceRevision mismatch");
  const errs = contract.validateSynthesisResult(payload, { generationId: j.id, sourceRevision: j.sourceRevision, treatment: rendered });
  if (errs.length) throw new contract.ProviderError("result_invalid", errs.join("; "));
  const pin = hostedA.platformPin();
  const cpuTest = process.env.HARLAN_STAGING_ALLOW_CPU === "1";
  const pre = hostedA.checkCompletion(payload, { platformPin: pin, voiceRefSha256: hostedA.voiceRefSha256(), rendered, requireGpu: !cpuTest });
  if (!pre.ok) throw new contract.ProviderError("result_invalid", "Candidate-A completion checks failed: " + pre.failures.join(", "));

  // Pull the outputs into staging storage; every byte is hash-verified.
  const outDir = assertStagingPath(path.join(runDir, "assets")); fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(assertStagingPath(path.join(runDir, "plan.json")), JSON.stringify(rendered));
  fs.writeFileSync(assertStagingPath(path.join(runDir, "provider-completion.json")), JSON.stringify(payload, null, 1));
  const tX = Date.now(); let bytes = 0;
  for (const f of payload.assets.files) {
    if (hostedA.FILES.indexOf(f.name) < 0) continue;
    const buf = await remote.fetchFile(cfg, providerJobId, f.name);
    const h = crypto.createHash("sha256").update(buf).digest("hex");
    if (buf.length !== f.bytes || h !== f.sha256) throw new contract.ProviderError("result_invalid", "file " + f.name + " failed hash/size verification");
    fs.writeFileSync(assertStagingPath(path.join(outDir, f.name === "metrics.json" ? "metrics.provider.json" : f.name)), buf); bytes += buf.length;
  }
  const transferMs = Date.now() - tX;
  const t1 = Date.now();
  const mp3 = hostedA.mp3Info(fs.readFileSync(path.join(outDir, "narration.mp3")));
  const want = hostedA.PINS.mp3;
  const audioFormat = { ok: !!mp3 && ["version", "layer", "bitrateKbps", "sampleRate", "channels"].every(k => mp3[k] === want[k]), got: mp3, want };
  const provMetrics = JSON.parse(fs.readFileSync(path.join(outDir, "metrics.provider.json"), "utf8"));
  const expect = hostedA.expectedZones(rendered.chunks, payload.chunks, payload.sr);
  const chk = platformChecks(c, outDir, provMetrics.durationS, expect);
  return Object.assign({
    runDir: path.relative(ROOT, runDir).split(path.sep).join("/"),
    provider: payload.provider, mode: payload.mode, remote: true, cpuFunctionalTest: cpuTest,
    completionChecks: pre.checks, audioFormat, sourceRevisionOk: true,
    providerMetrics: provMetrics, metrics: null,              // decoded-artifact metrics arrive with the post-Ready quality pass
    chunks: payload.chunks.map(x => ({ i: x.i, slot: x.slot, gpu: x.gpu, durationS: x.durationS, synthS: x.synthS, pcmSha256: x.pcmSha256 })),
    usage: payload.usage || null, cost: costOf(payload.usage, j.providerId),
    transfer: { bytes, ms: transferMs }, platformTimings: { platformNodeMs: Date.now() - t1 }
  }, chk);
}

/* ---------------- post-Ready quality pass (off the latency path, serialized) ---------------- */
let qualityChain = Promise.resolve();
function queueQuality(jobId) {
  qualityChain = qualityChain.then(async () => {
    const j = await sjobs.get(jobId); if (!j || j.status !== "ready") return;
    const runDir = path.join(ROOT, j.result.runDir), outDir = path.join(runDir, "assets");
    const t0 = Date.now();
    try {
      await runPlatform(["measure", "--audio", path.join(outDir, "narration.mp3"), "--plan", path.join(runDir, "plan.json"),
        "--words", path.join(outDir, "narration.words.json"), "--zones", path.join(outDir, "narration.zones.json"),
        "--out", assertStagingPath(path.join(outDir, "metrics.json")), "--refs", REFS]);
      const metrics = JSON.parse(fs.readFileSync(path.join(outDir, "metrics.json"), "utf8"));
      await sjobs.update(jobId, { quality: { status: "done", measureMs: Date.now() - t0 }, result: Object.assign({}, j.result, { metrics }) });
    } catch (e) {
      await sjobs.update(jobId, { quality: { status: "failed", error: String(e.message || e) } });
    }
  }).catch(() => {});
  return qualityChain;
}

/* ---------------- process one staging job ---------------- */
async function processJob(jobId) {
  const j0 = await sjobs.get(jobId);
  if (!j0 || j0.status !== "queued" || RUNNING.has(jobId)) return j0;
  RUNNING.add(jobId);
  const startedAt = Date.now();
  await sjobs.update(jobId, { status: "generating", stage: "Provider synthesizing", startedAt });
  const hb = setInterval(() => { sjobs.heartbeat(jobId).catch(() => {}); }, contract.HEARTBEAT_INTERVAL_MS);
  try {
    const j = await sjobs.get(jobId);
    const c = caseById(j.caseId);
    const p = registry.get(j.providerId);
    const rendered = profiles.renderTreatment(c.treatment, p.profile);
    const runDir = assertStagingPath(path.join(RUNS_DIR, j.id)); fs.mkdirSync(runDir, { recursive: true });

    if (p.kind === "remote-async") {
      const cfg = { endpoint: process.env.HARLAN_PROVIDER_A_ENDPOINT, secret: process.env.HARLAN_PROVIDER_A_SECRET };
      const req = contract.buildSynthesisRequest({
        generationId: j.id, storyId: j.storyId, sourceRevision: j.sourceRevision, voiceId: VOICE_ID, voiceVersion: VOICE_IDENTITY_VERSION,
        treatment: c.treatment, renderingProfile: Object.assign({}, rendered.renderingProfile, { params: rendered.params }),
        providerProfile: { id: p.id, version: p.version },
        output: { kind: "staging", delivery: "pull" },
        completion: { url: process.env.HARLAN_STAGING_COMPLETION_URL || null },
        execution: { fanOut: j.fanOut || 1 },
        platform: hostedA.platformPin(),
        deadlineMs: Number(process.env.HARLAN_STAGING_DEADLINE_MS || 60 * 60 * 1000)
      });
      const tDispatch = Date.now();
      const d = await remote.dispatch(req, cfg);
      await sjobs.update(jobId, { stage: "Provider accepted", providerJobId: d.providerJobId, providerAcceptMs: d.acceptMs, providerColdAtAccept: !!(d.accepted && d.accepted.coldStart), fanOutEffective: d.accepted && d.accepted.fanOut });
      const env = await awaitRemote(jobId, cfg, d.providerJobId, req.deadlineMs, cfg.secret);
      const completionSeenAt = Date.now();
      await sjobs.update(jobId, { status: "aligning", stage: "Platform: pull + verify" });
      const out = await ingestHosted(await sjobs.get(jobId), c, rendered, env.payload, runDir, cfg, d.providerJobId);
      const readyAt = Date.now();
      out.stageTimings = { queueMs: startedAt - j.createdAt, dispatchAcceptMs: d.acceptMs,
        providerObservedMs: completionSeenAt - tDispatch, transferMs: out.transfer.ms, platformNodeMs: out.platformTimings.platformNodeMs,
        enqueueToReadyMs: readyAt - j.createdAt, providerReported: env.payload.provider && env.payload.provider.stageTimings };
      await sjobs.update(jobId, { status: "ready", stage: "Ready (staging)", readyAt, result: out, quality: { status: "pending" } });
      queueQuality(jobId);
      return await sjobs.get(jobId);
    }
    if (p.kind === "remote-sync") throw new contract.ProviderError("provider_not_configured", "Candidate B runner is not implemented until an API, consented voice and frozen rendering profile exist (spec §10)");

    const tProv = Date.now();
    const result = await runLocalProvider(j, c, rendered, runDir);
    result.generationId = j.id; result.sourceRevision = j.sourceRevision;
    const providerMs = Date.now() - tProv;
    await sjobs.update(jobId, { status: "aligning", stage: "Platform finalize/align/measure" });
    const out = await postprocess(j, c, rendered, result, runDir);
    const readyAt = Date.now();
    out.stageTimings = { queueMs: startedAt - j.createdAt, providerMs, platformAudioMs: out.platformTimings.platformAudioMs,
      platformNodeMs: out.platformTimings.platformNodeMs, uploadMs: 0, enqueueToReadyMs: readyAt - j.createdAt,
      providerReported: (result.provider && result.provider.stageTimings) || null };
    await sjobs.update(jobId, { status: "ready", stage: "Ready (staging)", readyAt, result: out, quality: { status: "done" } });
    return await sjobs.get(jobId);
  } catch (e) {
    const code = e.code || "internal";
    await sjobs.update(jobId, { status: "failed", stage: "Failed", error: { code, message: String(e.message || e) }, retryable: contract.isRetryable(code) });
    return await sjobs.get(jobId);
  } finally { clearInterval(hb); RUNNING.delete(jobId); }
}

/* ---------------- optional pushed callbacks (signed) — recorded, never trusted to set Ready ---------------- */
function secretFor(providerId) {
  if (providerId === "golden-chatterbox-hosted") return process.env.HARLAN_PROVIDER_A_SECRET;
  if (providerId === "tts-api") return process.env.HARLAN_PROVIDER_B_SECRET;
  return null;
}
async function heartbeat(envelope) {
  const jobId = envelope && envelope.payload && envelope.payload.generationId;
  const j = jobId && /^stg_[0-9a-f]{12}$/.test(jobId) && await sjobs.get(jobId);
  if (!j) return { status: 404, body: { error: "unknown staging job" } };
  const v = contract.verifyEnvelope(envelope, secretFor(j.providerId));
  if (!v.ok) return { status: 401, body: { error: v.reason, code: v.code } };
  await sjobs.heartbeat(jobId, { stage: "Provider: " + String(envelope.payload.stage || "working") });
  return { status: 200, body: { ok: true } };
}
async function complete(envelope) {
  const jobId = envelope && envelope.payload && envelope.payload.generationId;
  const j = jobId && /^stg_[0-9a-f]{12}$/.test(jobId) && await sjobs.get(jobId);
  if (!j) return { status: 404, body: { error: "unknown staging job" } };
  const v = contract.verifyEnvelope(envelope, secretFor(j.providerId));
  if (!v.ok) return { status: 401, body: { error: v.reason, code: v.code } };
  if (j.status !== "generating" || j.callbackEnvelope) return { status: 409, body: { error: "job not awaiting completion", status: j.status } };   // late/duplicate → ignored
  if (envelope.payload.sourceRevision !== j.sourceRevision) return { status: 409, body: { error: "sourceRevision mismatch", code: "revision_mismatch" } };
  // Recorded only. The worker awaiting this job verifies it again, pulls and
  // hash-checks the outputs, re-runs the platform checks, and alone decides Ready.
  await sjobs.update(jobId, { callbackEnvelope: envelope });
  return { status: 202, body: { ok: true, recorded: "completion received — platform verification pending" } };
}

async function providerHealth(providerId) {
  if (providerId !== "golden-chatterbox-hosted") return { status: 400, body: { error: "health is defined for golden-chatterbox-hosted only" } };
  const cfg = { endpoint: process.env.HARLAN_PROVIDER_A_ENDPOINT, secret: process.env.HARLAN_PROVIDER_A_SECRET };
  try { return { status: 200, body: await remote.health(cfg) }; }
  catch (e) { return { status: e.code === "provider_not_configured" ? 409 : 502, body: { error: String(e.message || e), code: e.code } }; }
}

async function get(jobId) { return /^stg_[0-9a-f]{12}$/.test(String(jobId)) ? sjobs.get(jobId) : null; }
async function list(limit) { const all = await sjobs.all(); return Object.values(all).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit || 50); }

// Remote jobs run concurrently (the worker only dispatches and waits); local
// synthesis runs one at a time on this host.
const REMOTE_CONCURRENCY = Number(process.env.HARLAN_STAGING_CONCURRENCY || 32);
async function pump() {
  const all = await sjobs.reap();
  const queued = Object.values(all).filter(j => j.status === "queued" && !RUNNING.has(j.id)).sort((a, b) => a.createdAt - b.createdAt);
  const started = [];
  for (const j of queued) {
    const kind = registry.get(j.providerId).kind;
    if (kind === "remote-async") {
      if (RUNNING.size >= REMOTE_CONCURRENCY) break;
      processJob(j.id).catch(() => {}); started.push({ id: j.id, status: "dispatched" });
    } else {
      const r = await processJob(j.id); started.push({ id: j.id, status: r && r.status });
    }
  }
  return started;
}
async function drain() { while (RUNNING.size) await new Promise(r => setTimeout(r, 500)); await qualityChain; }

module.exports = { STAGING_DIR, MODE, enqueue, processJob, pump, drain, get, list, complete, heartbeat, providerHealth, loadTestSet, assertStagingPath, jobs: sjobs,
  platformChecks, runPlatform, caseById };   // platform stage + checks reused by staging probes (e.g. tools/narration-bench/q1-zerogpu.cjs)
