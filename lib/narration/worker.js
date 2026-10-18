/* =========================================================================
   Harlan's Legacy — narration worker (§19, §20)

   Drains queued narration jobs and runs the (slow) generation pipeline OUTSIDE
   the request/response cycle. Two ways to run it:

     • In-process pump (local dev only): server.js calls pump() after enqueuing
       when HARLAN_INPROCESS_WORKER=1. One job at a time (a lock guards against
       concurrent runs / double-click, §13).

     • Standalone (production — the GPU engine box), normally UNDER THE SUPERVISOR
       (lib/narration/supervisor.js, started by tools/narration-worker/start-gpu-worker.ps1),
       which restarts it if it exits and logs why:
         node lib/narration/worker.js --loop   # keep polling every few seconds
         node lib/narration/worker.js          # process the queue once and exit

   The standalone worker refuses to start when it would silently do the wrong thing
   (preflight): no Supabase connection or credentials rejected, no engine, engine
   files not matching their release manifest, or HARLAN_REQUIRE_GPU=1 with an
   interpreter that has no CUDA. One worker per machine (lock). Before it starts and
   before every job it kills engine processes orphaned by a previous worker, so two
   generations never share the GPU. It reports presence every few seconds
   ("narration_worker") and never deletes finished job history.

   Exit codes (read by the supervisor):
     0 stopped on request   1 crashed (restart)   2 configuration error (do not retry blindly)
     3 another worker already runs on this machine   4 transient (network) — retry
   ========================================================================= */
"use strict";

require("../loadenv.js");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const store = require("../store.js");
const jobs = require("./jobs.js");
const service = require("./service.js");
const engine = require("./engine.js");

const EXIT = { OK: 0, CRASH: 1, CONFIG: 2, DUPLICATE: 3, TRANSIENT: 4 };
const WORKER_ID = process.env.HARLAN_WORKER_ID || (os.hostname() + ":" + process.pid);
const PRESENCE_MS = Number(process.env.HARLAN_WORKER_PRESENCE_MS || 20000);
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;   // two identical requests this close together = a double submit
const LOCK_FILE = process.env.HARLAN_WORKER_LOCK || path.join(os.tmpdir(), "harlan-narration-worker.lock");

const ts = () => new Date().toISOString();
const log = (...a) => console.log("[narration-worker]", ts(), ...a);
const logErr = (...a) => console.error("[narration-worker]", ts(), ...a);

let running = false;
let busyJob = null;

// Free system commit (Windows) required before a job starts. Measured on the M5000M laptop
// (2026-10-19) with golden-engine 1.1 (synthesis and alignment in separate processes):
//   synthesis stage 8.79 GB peak for both a 68-word and a 1,037-word story (model load dominates);
//   alignment stage 7.54 GB single-pass @398 s, ≈0.85 GB/min → ≤ ~8.8 GB at the 480 s single-pass
//   limit; windowed (>480 s) ≈4.1 GB at any length.  Worst case ≈ 8.8 GB.
//   Margin 1.7 GB (other applications' commit varied ±1.5 GB during the measurements, Chrome open).
// The previous single-process engine peaked at 14.4 GB (10.45 GB with the model released before
// alignment); run it only with HARLAN_WORKER_MIN_COMMIT_GB ≥ 12.5. 0 disables the check.
const MIN_COMMIT_GB = Number(process.env.HARLAN_WORKER_MIN_COMMIT_GB != null ? process.env.HARLAN_WORKER_MIN_COMMIT_GB : 10.5);
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

// ---- engine processes left behind by a dead worker (Windows children outlive parents) ----
function engineScript() {
  const t = (process.env.HARLAN_ENGINE_CMD || "").split(/\s+/).filter(Boolean);
  return t.find(x => /\.py$/i.test(x)) || null;
}
function findEngineProcesses() {
  const script = engineScript();
  if (process.platform !== "win32" || !script) return [];
  const r = spawnSync("powershell", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],
    { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0 || !String(r.stdout).trim()) return [];
  let list; try { list = JSON.parse(r.stdout); } catch (e) { return []; }
  if (!Array.isArray(list)) list = [list];
  const want = path.resolve(script).toLowerCase();
  return list.filter(p => p && p.CommandLine && p.CommandLine.toLowerCase().includes(want));
}
function reapOrphanEngines(when) {
  const procs = findEngineProcesses();
  if (!procs.length) return 0;
  const ids = new Set(procs.map(p => p.ProcessId));
  const roots = procs.filter(p => !ids.has(p.ParentProcessId));          // top of each orphaned engine tree
  for (const p of roots) { logErr("killing orphaned engine process tree (" + when + "): PID " + p.ProcessId + " " + String(p.CommandLine).slice(0, 160)); engine.killTree(p.ProcessId); }
  return roots.length;
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
          error: { code: "worker_low_memory", memory: mem, message: "The GPU worker has only " + mem.commitFreeGB + " GB of memory available; the voice engine needs about " + MIN_COMMIT_GB + " GB. Close memory-heavy applications on the worker (or enlarge its page file), then press Retry." } });
        log("refused " + j.id + " (story " + j.storyId + ", request " + (fresh.requestId || "-") + "): worker_low_memory " + mem.commitFreeGB + " GB < " + MIN_COMMIT_GB + " GB");
        done.push({ id: j.id, status: "failed", error: "worker_low_memory" });
        continue;
      }
      reapOrphanEngines("before job " + j.id);                  // never two engines on the GPU
      busyJob = j.id;
      log("claim " + j.id + " story " + j.storyId + " request " + (fresh.requestId || "-"));
      const t0 = Date.now();
      try {
        const res = await service.processJob(j.id, { workerId: WORKER_ID });
        log("finished " + j.id + " -> " + (res && res.status) + (res && res.error ? " " + res.error.code + ": " + String(res.error.message).slice(0, 300) : "") + " after " + Math.round((Date.now() - t0) / 1000) + "s");
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
async function preflight() {
  const problems = []; let transient = null;
  const requireGpu = ["1", "true", "yes"].includes(String(process.env.HARLAN_REQUIRE_GPU || "").trim());
  const allowLocal = process.env.HARLAN_WORKER_ALLOW_LOCAL === "1";
  const allowCpu = process.env.HARLAN_ALLOW_CPU === "1";
  if (!store.USE_SUPABASE && !allowLocal) problems.push("Not connected to Supabase (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not loaded), so this worker would drain a LOCAL file queue, not production. Point HARLAN_ENV_FILE at the server .env (or set HARLAN_WORKER_ALLOW_LOCAL=1 for a local-only test).");
  if (store.USE_SUPABASE) {                                    // credentials accepted + reachable?
    try { await store.getDoc("narration_worker", { workers: {} }); }
    catch (e) {
      const m = String(e && e.message || e);
      if (/invalid api key|jwt|unauthori[sz]ed|forbidden|401|403|permission denied/i.test(m)) problems.push("Supabase rejected the worker's credentials: " + m);
      else transient = "Supabase not reachable: " + m;
    }
  }
  const py = engineInterpreter();
  if (!py) problems.push("No engine configured (HARLAN_ENGINE_CMD is not set).");
  const rel = engine.verifyEngineRelease();
  if (rel && !rel.ok) problems.push(rel.message);
  let gpu = null;
  if (py && requireGpu) {
    gpu = probeGpu(py);
    if (!gpu.ok) problems.push("HARLAN_REQUIRE_GPU=1 but the engine interpreter could not be probed (" + py + "): " + gpu.error);
    else if (!gpu.cuda) problems.push("HARLAN_REQUIRE_GPU=1 but the engine interpreter has no CUDA (torch " + gpu.torch + " at " + py + ") — that is the CPU environment; use the CUDA venv.");
  } else if (py && !requireGpu && !allowCpu && store.USE_SUPABASE) {
    problems.push("HARLAN_REQUIRE_GPU is not set: production narration must not silently fall back to CPU synthesis. Set HARLAN_REQUIRE_GPU=1 (or HARLAN_ALLOW_CPU=1 to deliberately run on CPU).");
  }
  return { ok: !problems.length && !transient, problems, transient, gpu, requireGpu, release: rel, backend: store.USE_SUPABASE ? "supabase" : "local-files" };
}

// ---- one worker per machine ----
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
function isWorkerPid(pid) {
  if (process.platform !== "win32") return pidAlive(pid);
  const r = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"ProcessId=" + Number(pid) + "\").CommandLine"], { encoding: "utf8", timeout: 20000 });
  return /narration[\\/]worker\.js/i.test(String(r.stdout || ""));
}
function acquireLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (cur && cur.pid && cur.pid !== process.pid && pidAlive(cur.pid) && isWorkerPid(cur.pid)) return { ok: false, holder: cur };
  } catch (e) { /* no lock / unreadable → take it */ }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, workerId: WORKER_ID, startedAt: Date.now() }));
  return { ok: true };
}
function releaseLock() {
  try { const cur = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); if (cur.pid === process.pid) fs.unlinkSync(LOCK_FILE); } catch (e) {}
}

function gitVersion() {
  try { const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: __dirname, encoding: "utf8", timeout: 10000 }); return r.status === 0 ? r.stdout.trim() : null; } catch (e) { return null; }
}
function supervisorInfo() {
  if (!process.env.HARLAN_SUPERVISOR_PID) return null;
  let lastExit = null; try { lastExit = JSON.parse(process.env.HARLAN_SUPERVISOR_LAST_EXIT || "null"); } catch (e) {}
  return { pid: Number(process.env.HARLAN_SUPERVISOR_PID), restarts: Number(process.env.HARLAN_SUPERVISOR_RESTARTS || 0), lastExit };
}

let shuttingDown = false;
function shutdown(code, why, info) {
  if (shuttingDown) return; shuttingDown = true;
  log("stopping (" + why + ")");
  try { engine.killRunning(); } catch (e) {}
  const done = () => { releaseLock(); process.exit(code); };
  if (info) jobs.reportPresence(WORKER_ID, Object.assign({}, info, { busyJob: null, stoppedAt: Date.now(), stopReason: why })).catch(() => {}).then(done);
  else done();
  setTimeout(done, 5000).unref();
}

async function loop(intervalMs, pre) {
  intervalMs = intervalMs || Number(process.env.HARLAN_WORKER_POLL_MS || 4000);
  const cuda = !!(pre && pre.gpu && pre.gpu.cuda);
  const info = {
    kind: "worker", host: os.hostname(), pid: process.pid, startedAt: Date.now(), version: gitVersion(),
    gpu: cuda ? pre.gpu.gpu : null, device: cuda ? "cuda" : "unchecked",
    engineRelease: pre && pre.release ? pre.release.release : "legacy (unversioned)",
    alignDevice: process.env.HARLAN_ALIGN_DEVICE || "same-as-synthesis", minCommitGB: MIN_COMMIT_GB,
    supervisor: supervisorInfo(), stoppedAt: null
  };
  const beat = () => jobs.reportPresence(WORKER_ID, Object.assign({}, info, { busyJob })).catch(e => logErr("presence:", e.message));
  await beat();
  const timer = setInterval(beat, PRESENCE_MS);
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) process.on(sig, () => { clearInterval(timer); shutdown(EXIT.OK, sig, info); });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await pump(); }
    catch (e) { logErr("pump error:", e && e.stack || e); }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

module.exports = { pump, loop, preflight, findTwin, reapOrphanEngines, findEngineProcesses, WORKER_ID, EXIT };

if (require.main === module) {
  const loopMode = process.argv.includes("--loop");
  process.on("uncaughtException", e => { logErr("FATAL uncaught exception:", e && e.stack || e); shutdown(EXIT.CRASH, "uncaughtException"); });
  process.on("unhandledRejection", e => { logErr("FATAL unhandled rejection:", e && e.stack || e); shutdown(EXIT.CRASH, "unhandledRejection"); });
  process.on("exit", code => { releaseLock(); try { console.error("[narration-worker]", ts(), "exit code " + code); } catch (e) {} });
  (async () => {
    log(WORKER_ID, "pid " + process.pid, "starting; engine " + (process.env.HARLAN_ENGINE_CMD || "(none)"));
    const lock = acquireLock();
    if (!lock.ok) { logErr("REFUSING TO START: another narration worker already runs on this machine (PID " + lock.holder.pid + ", " + lock.holder.workerId + ")."); process.exit(EXIT.DUPLICATE); }
    const pre = await preflight();
    log(WORKER_ID, "backend=" + pre.backend, pre.gpu && pre.gpu.ok ? ("gpu=" + (pre.gpu.gpu || "none") + " torch=" + pre.gpu.torch) : "", "engineRelease=" + (pre.release ? pre.release.release + (pre.release.ok ? " (verified)" : " (MISMATCH)") : "legacy"), "align=" + (process.env.HARLAN_ALIGN_DEVICE || "same-as-synthesis"), "minCommitGB=" + MIN_COMMIT_GB);
    if (pre.problems.length) { pre.problems.forEach(p => logErr("REFUSING TO START: " + p)); releaseLock(); process.exit(EXIT.CONFIG); }
    if (pre.transient) { logErr("NOT STARTING (transient): " + pre.transient); releaseLock(); process.exit(EXIT.TRANSIENT); }
    const killed = reapOrphanEngines("worker start");
    if (killed) log("killed " + killed + " orphaned engine process tree(s) at start");
    if (loopMode) { log("polling…"); await loop(null, pre); }
    else { const r = await pump(); log(JSON.stringify(r)); releaseLock(); process.exit(EXIT.OK); }
  })();
}
