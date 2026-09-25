/* =========================================================================
   Harlan's Legacy — narration job store (§2, §12, §13)

   A tiny async job queue persisted in the existing `documents` table under the
   key "narration_jobs" (no schema migration). Locally it is data/narration_jobs.json.

   Job lifecycle (truthful states — never a fake percentage, §23):
     queued → generating → aligning → finalizing → ready
                        ↘ failed (with error + retryable)
   Idempotency: at most one ACTIVE job per (storyId, sourceRevision, voiceVersion)
   unless force is set (§13). Timeout reaping moves stuck jobs to failed (§12).
   `voiceVersion` here is the VOICE IDENTITY version (lib/narration/voice.js) —
   never a provider version.

   makeStore(key, opts) builds an independent store (used by the isolated STAGING
   benchmark queue, NARRATION_PROVIDER_SPEC.md §10). The default export is the
   production store, unchanged.
   ========================================================================= */
"use strict";

const crypto = require("crypto");
const store = require("../store.js");

const ACTIVE = ["queued", "generating", "aligning", "finalizing"];

function makeStore(key, opts) {
  opts = opts || {};
  const getDoc = opts.getDoc || store.getDoc;
  const putDoc = opts.putDoc || store.putDoc;
  const STALE_MS = Number(opts.staleMs || process.env.HARLAN_JOB_TIMEOUT_MS || 25 * 60 * 1000);
  const idPrefix = opts.idPrefix || "gen_";

  async function all() { return (await getDoc(key, { jobs: {} })).jobs || {}; }
  async function save(jobs) { await putDoc(key, { jobs }); }

  function idFor(storyId, sourceRevision, voiceVersion) {
    return idPrefix + crypto.createHash("sha1").update(storyId + "|" + sourceRevision + "|" + voiceVersion + "|" + Date.now() + "|" + Math.random()).digest("hex").slice(0, 12);
  }

  async function get(jobId) { const j = await all(); return j[jobId] || null; }

  // Reap timed-out active jobs → failed (§12). A heartbeat refreshes updatedAt.
  async function reap() {
    const jobs = await all(); let changed = false; const now = Date.now();
    for (const id of Object.keys(jobs)) {
      const j = jobs[id];
      if (ACTIVE.includes(j.status) && now - (j.updatedAt || j.createdAt || now) > STALE_MS) {
        j.status = "failed"; j.error = { code: "job_timeout", message: "Generation timed out (no heartbeat)." }; j.retryable = true; j.updatedAt = now; changed = true;
      }
    }
    if (changed) await save(jobs);
    return jobs;
  }

  // Find an active job for this exact source+voice identity (idempotency, §13/§14).
  async function activeFor(storyId, sourceRevision, voiceVersion) {
    const jobs = await reap();
    return Object.values(jobs).find(j => j.storyId === storyId && j.sourceRevision === sourceRevision && j.voiceVersion === voiceVersion && ACTIVE.includes(j.status)) || null;
  }

  // The most recent job for a story (optionally a specific revision), any status.
  async function latestFor(storyId, sourceRevision) {
    const jobs = await reap();
    return Object.values(jobs)
      .filter(j => j.storyId === storyId && (!sourceRevision || j.sourceRevision === sourceRevision))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
  }

  async function create(fields) {
    const { storyId, sourceRevision, voiceId, voiceVersion, mode, force, requestedBy } = fields;
    if (!force) {
      const existing = await activeFor(storyId, sourceRevision, voiceVersion);
      if (existing) return { job: existing, reused: true };
    }
    const jobs = await all();
    const id = idFor(storyId, sourceRevision, voiceVersion);
    const now = Date.now();
    const job = Object.assign({}, fields.extra || {}, {
      id, storyId, sourceRevision, voiceId, voiceVersion, mode: mode || "engine",
      status: "queued", stage: "Queued", error: null, retryable: false,
      requestedBy: requestedBy || null,
      result: null, createdAt: now, updatedAt: now
    });
    jobs[id] = job; await save(jobs);
    return { job, reused: false };
  }

  async function update(jobId, patch) {
    const jobs = await all(); const j = jobs[jobId]; if (!j) return null;
    Object.assign(j, patch, { updatedAt: Date.now() });
    await save(jobs); return j;
  }

  // Liveness signal while a provider works (contract §3.2). Refreshes updatedAt
  // so the reaper never false-fails a job that is still progressing.
  async function heartbeat(jobId, patch) {
    return update(jobId, Object.assign({ heartbeatAt: Date.now() }, patch || {}));
  }

  // Keep the store tidy: drop finished jobs older than a day.
  async function prune() {
    const jobs = await all(); const now = Date.now(); let changed = false;
    for (const id of Object.keys(jobs)) {
      const j = jobs[id];
      if (!ACTIVE.includes(j.status) && now - (j.updatedAt || 0) > 24 * 3600 * 1000) { delete jobs[id]; changed = true; }
    }
    if (changed) await save(jobs);
  }

  // Aggregate job counts for the batch dashboard (§7).
  async function counts() {
    const jobs = await reap();
    const c = { total: 0, queued: 0, running: 0, ready: 0, failed: 0, cancelled: 0 };
    for (const id of Object.keys(jobs)) {
      const s = jobs[id].status; c.total++;
      if (s === "queued") c.queued++;
      else if (s === "generating" || s === "aligning" || s === "finalizing") c.running++;
      else if (s === "ready") c.ready++;
      else if (s === "failed") c.failed++;
      else if (s === "cancelled") c.cancelled++;
    }
    return c;
  }

  // Cancel QUEUED jobs (optionally only for one story). Running jobs are left to
  // finish (the worker owns them); cancelled jobs are inert (§7).
  async function cancelQueued(storyId) {
    const jobs = await all(); let n = 0;
    for (const id of Object.keys(jobs)) {
      const j = jobs[id];
      if (j.status === "queued" && (storyId == null || j.storyId === storyId)) { j.status = "cancelled"; j.stage = "Cancelled"; j.updatedAt = Date.now(); n++; }
    }
    if (n) await save(jobs);
    return n;
  }

  return { key, all, get, create, update, heartbeat, reap, activeFor, latestFor, prune, counts, cancelQueued, ACTIVE };
}

// Production store — same key, same behavior as before.
const production = makeStore("narration_jobs");

module.exports = Object.assign({}, production, { makeStore, ACTIVE });
