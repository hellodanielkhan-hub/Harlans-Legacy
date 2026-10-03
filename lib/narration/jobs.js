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
   production store, which also tracks worker presence ("narration_worker").
   Finished jobs are kept as history (prune() exists but the worker no longer
   calls it).
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

  // Reap stale active jobs → failed (§12), with the TRUE reason. A heartbeat
  // refreshes updatedAt, so a job that is still progressing is never reaped.
  //  • queued, never claimed: only fails when NO worker is alive (a live worker
  //    will claim it — it may be busy with another story) → worker_offline.
  //  • claimed (generating/aligning/finalizing) but silent → worker_lost.
  // (Previously both read "Generation timed out (no heartbeat)", which hid the
  // real failure: no worker was consuming the production queue at all.)
  async function reap() {
    const jobs = await all(); let changed = false; const now = Date.now();
    let presence = null;
    for (const id of Object.keys(jobs)) {
      const j = jobs[id];
      if (!ACTIVE.includes(j.status) || now - (j.updatedAt || j.createdAt || now) <= STALE_MS) continue;
      const mins = Math.round(STALE_MS / 60000);
      if (j.status === "queued") {
        if (opts.workerPresence) {
          presence = presence || await workerPresence();
          if (presence.live) continue;
        }
        const seen = presence && presence.lastSeenAt ? " (last seen " + new Date(presence.lastSeenAt).toISOString() + ")" : " (no worker has reported in)";
        j.error = { code: "worker_offline", message: "No narration worker picked this job up within " + mins + " min — the GPU narration worker is not running" + seen + ". Start it (tools/narration-worker/start-gpu-worker.ps1), then press Retry.", lastWorkerSeenAt: presence ? presence.lastSeenAt : null };
      } else {
        j.error = { code: "worker_lost", message: "The narration worker stopped reporting during \"" + (j.stage || j.status) + "\" (no heartbeat for " + mins + " min" + (j.workerId ? ", worker " + j.workerId : "") + "). The job was abandoned — press Retry.", lastHeartbeatAt: j.heartbeatAt || null };
      }
      j.status = "failed"; j.retryable = true; j.updatedAt = now; changed = true;
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

  // Worker liveness (the standalone worker reports every few seconds, see
  // lib/narration/worker.js). Shares this store's document backend.
  async function workerPresence() { return summarizePresence((await getDoc(PRESENCE_KEY, { workers: {} })).workers, Date.now()); }
  async function reportPresence(workerId, info) {
    const doc = await getDoc(PRESENCE_KEY, { workers: {} }); const workers = doc.workers || {};
    workers[workerId] = Object.assign({}, workers[workerId] || {}, info, { id: workerId, lastSeenAt: Date.now() });
    await putDoc(PRESENCE_KEY, { workers });
  }

  return { key, all, get, create, update, heartbeat, reap, activeFor, latestFor, prune, counts, cancelQueued, workerPresence, reportPresence, ACTIVE };
}

// A worker is "live" if it reported within this window (it reports every ~20 s,
// including while a long job runs, so a busy worker stays live).
const PRESENCE_KEY = "narration_worker";
const WORKER_LIVE_MS = Number(process.env.HARLAN_WORKER_LIVE_MS || 3 * 60 * 1000);
function summarizePresence(workers, now) {
  const list = Object.values(workers || {});
  const isLive = w => !w.stoppedAt && now - (w.lastSeenAt || 0) <= WORKER_LIVE_MS;
  return {
    live: list.some(isLive),
    lastSeenAt: list.reduce((m, w) => Math.max(m, w.lastSeenAt || 0), 0) || null,
    workers: list.map(w => ({ id: w.id, host: w.host, gpu: w.gpu || null, device: w.device || null, version: w.version || null, busyJob: w.busyJob || null, startedAt: w.startedAt || null, lastSeenAt: w.lastSeenAt || null, stoppedAt: w.stoppedAt || null, live: isLive(w) }))
  };
}

// Production store. Queued jobs wait while a worker is live (worker presence).
const production = makeStore("narration_jobs", { workerPresence: true });

module.exports = Object.assign({}, production, { makeStore, summarizePresence, ACTIVE, WORKER_LIVE_MS });
