/* =========================================================================
   Harlan's Legacy — narration worker (§19, §20)

   Drains queued narration jobs and runs the (slow) generation pipeline OUTSIDE
   the request/response cycle. Two ways to run it:

     • In-process pump (local dev only): server.js calls pump() after enqueuing
       when HARLAN_INPROCESS_WORKER=1. One job at a time (a lock guards against
       concurrent runs / double-click, §13).

     • Standalone (production — the GPU engine box):
         tools/narration-worker/start-gpu-worker.ps1      # sets the GPU env, runs --loop
         node lib/narration/worker.js         # process the queue once and exit
         node lib/narration/worker.js --loop   # keep polling every few seconds

   The standalone worker refuses to start when it would silently do the wrong
   thing (preflight): no Supabase connection (it would drain a LOCAL file queue),
   no engine configured, or HARLAN_REQUIRE_GPU=1 with an interpreter that has no
   CUDA (the CPU environment). While running it reports its presence every few
   seconds ("narration_worker"), so the API can tell "worker offline" from
   "generating", and it never deletes finished job history.

   The worker never runs inside the Vercel request handler (30s / ephemeral).
   ========================================================================= */
"use strict";

require("../loadenv.js");
const os = require("os");
const { spawnSync } = require("child_process");
const store = require("../store.js");
const jobs = require("./jobs.js");
const service = require("./service.js");
const engine = require("./engine.js");

const WORKER_ID = process.env.HARLAN_WORKER_ID || (os.hostname() + ":" + process.pid);
const PRESENCE_MS = Number(process.env.HARLAN_WORKER_PRESENCE_MS || 20000);
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;   // two identical requests this close together = a double submit

let running = false;
let busyJob = null;

// Commit memory (Windows) the Golden engine needs to load torch/CUDA + the voice
// model — measured ~8.75 GB peak for a short story on the M5000M laptop
// (2026-10-03). 0 disables the check (skipped where it cannot be measured).
const MIN_COMMIT_GB = Number(process.env.HARLAN_WORKER_MIN_COMMIT_GB != null ? process.env.HARLAN_WORKER_MIN_COMMIT_GB : 9);
function lowMemory() {
  if (!(MIN_COMMIT_GB > 0) || process.platform !== "win32") return null;
  const mem = engine.memoryState();
  return mem.commitFreeGB != null && mem.commitFreeGB < MIN_COMMIT_GB ? mem : null;
}

// A second request for the same text + voice moments after an earlier one
// (double-click, two tabs) — don't spend another GPU run on it.
function findTwin(j, all) {
  return all.find(o => o.id !== j.id && o.storyId === j.storyId &&
    o.sourceRevision === j.sourceRevision && String(o.voiceVersion) === String(j.voiceVersion) &&
    (o.createdAt || 0) <= (j.createdAt || 0) && (j.createdAt || 0) - (o.createdAt || 0) <= DUPLICATE_WINDOW_MS &&
    !["failed", "cancelled"].includes(o.status)) || null;
}

// Process every currently-queued job, oldest first. Guarded so overlapping
// pumps (e.g. rapid enqueues) never process the same job twice.
async function pump() {
  if (running) return { skipped: true };
  running = true;
  const done = [];
  try {
    // reap stale, then take a stable snapshot of queued ids
    const all = await jobs.reap();
    const queued = Object.values(all).filter(j => j.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
    for (const j of queued) {
      const fresh = await jobs.get(j.id);
      if (!fresh || fresh.status !== "queued") continue;      // someone else took it
      const twin = findTwin(fresh, Object.values(await jobs.all()));
      if (twin) {
        await jobs.update(j.id, { status: "cancelled", stage: "Duplicate request — same text and voice as " + twin.id, duplicateOf: twin.id });
        done.push({ id: j.id, status: "cancelled", duplicateOf: twin.id });
        continue;
      }
      // Not enough memory on this machine to load the engine right now: fail with
      // the reason (instead of the engine dying mid-start with an opaque code).
      const mem = lowMemory();
      if (mem) {
        await jobs.update(j.id, { status: "failed", stage: "Generation failed", workerId: WORKER_ID, retryable: true,
          error: { code: "worker_low_memory", memory: mem, message: "The GPU worker has only " + mem.commitFreeGB + " GB of memory available; loading the voice engine needs about " + MIN_COMMIT_GB + " GB. Close memory-heavy applications on the worker (or enlarge its page file), then press Retry." } });
        done.push({ id: j.id, status: "failed", error: "worker_low_memory" });
        continue;
      }
      busyJob = j.id;
      try {
        const res = await service.processJob(j.id, { workerId: WORKER_ID });
        done.push({ id: j.id, status: res && res.status, error: res && res.error ? res.error.code : undefined });
      } finally { busyJob = null; }
    }
  } finally { running = false; }
  return { processed: done };
}

// ---- preflight: refuse to run in a configuration that cannot produce a correct
// production narration, and say exactly why (instead of failing jobs later) ----
function engineInterpreter() {
  const cmd = process.env.HARLAN_ENGINE_CMD || process.env.HARLAN_WARM_CMD || "";
  return cmd.split(/\s+/).filter(Boolean)[0] || null;
}
function probeGpu(python) {
  const r = spawnSync(python, ["-c", "import json,torch;c=torch.cuda.is_available();print(json.dumps({'torch':torch.__version__,'cuda':c,'gpu':torch.cuda.get_device_name(0) if c else None,'vramMB':(torch.cuda.get_device_properties(0).total_memory//1048576) if c else None}))"], { encoding: "utf8", timeout: 180000 });
  if (r.error || r.status !== 0) return { ok: false, error: String((r.error && r.error.message) || (r.stderr || "").trim().split(/\r?\n/).pop() || ("exit " + r.status)) };
  try { return Object.assign({ ok: true }, JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop())); } catch (e) { return { ok: false, error: "unreadable probe output" }; }
}
function preflight() {
  const problems = [];
  const requireGpu = ["1", "true", "yes"].includes(String(process.env.HARLAN_REQUIRE_GPU || "").trim());
  const allowLocal = process.env.HARLAN_WORKER_ALLOW_LOCAL === "1";
  const allowCpu = process.env.HARLAN_ALLOW_CPU === "1";
  if (!store.USE_SUPABASE && !allowLocal) problems.push("Not connected to Supabase (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not loaded), so this worker would drain a LOCAL file queue, not production. Point HARLAN_ENV_FILE at the server .env (or set HARLAN_WORKER_ALLOW_LOCAL=1 for a local-only test).");
  const py = engineInterpreter();
  if (!py) problems.push("No engine configured (HARLAN_ENGINE_CMD is not set).");
  let gpu = null;
  if (py && requireGpu) {
    gpu = probeGpu(py);
    if (!gpu.ok) problems.push("HARLAN_REQUIRE_GPU=1 but the engine interpreter could not be probed (" + py + "): " + gpu.error);
    else if (!gpu.cuda) problems.push("HARLAN_REQUIRE_GPU=1 but the engine interpreter has no CUDA (torch " + gpu.torch + " at " + py + ") — that is the CPU environment; use the CUDA venv.");
  } else if (py && !requireGpu && !allowCpu && store.USE_SUPABASE) {
    problems.push("HARLAN_REQUIRE_GPU is not set: production narration must not silently fall back to CPU synthesis. Set HARLAN_REQUIRE_GPU=1 (or HARLAN_ALLOW_CPU=1 to deliberately run on CPU).");
  }
  return { ok: !problems.length, problems, gpu, requireGpu, backend: store.USE_SUPABASE ? "supabase" : "local-files" };
}

function gitVersion() {
  try { const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: __dirname, encoding: "utf8", timeout: 10000 }); return r.status === 0 ? r.stdout.trim() : null; } catch (e) { return null; }
}

async function loop(intervalMs, pre) {
  intervalMs = intervalMs || Number(process.env.HARLAN_WORKER_POLL_MS || 4000);
  const cuda = !!(pre && pre.gpu && pre.gpu.cuda);
  const info = {
    host: os.hostname(), pid: process.pid, startedAt: Date.now(), version: gitVersion(),
    gpu: cuda ? pre.gpu.gpu : null, device: cuda ? "cuda" : "unchecked",
    alignDevice: process.env.HARLAN_ALIGN_DEVICE || "same-as-synthesis", stoppedAt: null
  };
  const beat = () => jobs.reportPresence(WORKER_ID, Object.assign({}, info, { busyJob })).catch(e => console.error("[narration-worker] presence:", e.message));
  await beat();
  const timer = setInterval(beat, PRESENCE_MS);
  const stop = () => { clearInterval(timer); jobs.reportPresence(WORKER_ID, Object.assign({}, info, { busyJob: null, stoppedAt: Date.now() })).catch(() => {}).then(() => process.exit(0)); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { const r = await pump(); if (r.processed && r.processed.length) console.log("[narration-worker]", new Date().toISOString(), JSON.stringify(r.processed)); }
    catch (e) { console.error("[narration-worker] pump error:", e.message); }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

module.exports = { pump, loop, preflight, findTwin, WORKER_ID };

if (require.main === module) {
  const loopMode = process.argv.includes("--loop");
  (async () => {
    const pre = preflight();
    console.log("[narration-worker]", WORKER_ID, "backend=" + pre.backend, pre.gpu && pre.gpu.ok ? ("gpu=" + (pre.gpu.gpu || "none") + " torch=" + pre.gpu.torch) : "", "align=" + (process.env.HARLAN_ALIGN_DEVICE || "same-as-synthesis"));
    if (!pre.ok) { pre.problems.forEach(p => console.error("[narration-worker] REFUSING TO START: " + p)); process.exit(2); }
    if (loopMode) { console.log("[narration-worker] polling…"); await loop(null, pre); }
    else { const r = await pump(); console.log("[narration-worker]", JSON.stringify(r)); process.exit(0); }
  })();
}
