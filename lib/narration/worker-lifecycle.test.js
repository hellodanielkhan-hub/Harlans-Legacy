/* =========================================================================
   Automated test — narration queue / worker lifecycle
   (run: node lib/narration/worker-lifecycle.test.js)

   Uses in-memory documents only (never Supabase, never data/*.json):
     • a queued job nobody claims fails as worker_offline (not "no heartbeat")
     • a queued job waits while a worker is live, even past the stale window
     • a claimed job whose heartbeats stop fails as worker_lost, naming its stage
     • a heartbeating job is never reaped
     • worker presence: live / stopped / stale
     • a double-submitted job is recognised as a duplicate (and only the later one)
     • the worker refuses to start without Supabase, and on a CPU-only interpreter
       when HARLAN_REQUIRE_GPU=1 (checked only if that interpreter exists here)
   Exits non-zero on any failure.
   ========================================================================= */
"use strict";
delete process.env.HARLAN_ENV_FILE;
const fs = require("fs");
const jobsLib = require("./jobs.js");

function memStore(staleMs) {
  const mem = {};
  const getDoc = async (k, fb) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : fb);
  const putDoc = async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); };
  return { mem, q: jobsLib.makeStore("narration_jobs_test", { getDoc, putDoc, staleMs, workerPresence: true }) };
}
const job = { storyId: 395, sourceRevision: "sha256:test", voiceId: "harlan-v1", voiceVersion: "1", mode: "auto" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const results = [];
  const check = (name, ok, got) => results.push({ name, ok: !!ok, got });

  { // no worker ever reported
    const { q } = memStore(50);
    const { job: j } = await q.create(job); await sleep(80);
    const s = await q.get(j.id); await q.reap(); const r = await q.get(j.id);
    check("queued, no worker -> worker_offline", r.status === "failed" && r.error.code === "worker_offline" && /not running/.test(r.error.message) && /no worker has reported in/.test(r.error.message) && r.retryable === true, { status: r.status, code: r.error && r.error.code });
    check("never says 'no heartbeat' for an unclaimed job", !/no heartbeat/i.test(r.error.message) && s.stage === "Queued", r.error.message.slice(0, 80));
  }
  { // live worker, busy elsewhere: the queued job waits
    const { q } = memStore(50);
    await q.reportPresence("box:1", { host: "box", gpu: "Quadro M5000M", busyJob: "gen_other" });
    const { job: j } = await q.create(job); await sleep(80); await q.reap(); const r = await q.get(j.id);
    check("queued, live worker -> keeps waiting", r.status === "queued", r.status);
  }
  { // worker stopped cleanly
    const { q } = memStore(50);
    await q.reportPresence("box:1", { host: "box", stoppedAt: Date.now() });
    const { job: j } = await q.create(job); await sleep(80); await q.reap(); const r = await q.get(j.id);
    check("queued, worker stopped -> worker_offline with last seen", r.status === "failed" && r.error.code === "worker_offline" && /last seen/.test(r.error.message) && r.error.lastWorkerSeenAt, r.error && r.error.message.slice(0, 90));
  }
  { // claimed, then silent
    const { q } = memStore(50);
    const { job: j } = await q.create(job);
    await q.update(j.id, { status: "aligning", stage: "Creating word/sentence/paragraph timings", workerId: "box:1" });
    await sleep(80); await q.reap(); const r = await q.get(j.id);
    check("claimed + silent -> worker_lost naming stage + worker", r.status === "failed" && r.error.code === "worker_lost" && /Creating word/.test(r.error.message) && /box:1/.test(r.error.message), r.error && r.error.message.slice(0, 100));
  }
  { // heartbeating job is never reaped
    const { q } = memStore(120);
    const { job: j } = await q.create(job);
    await q.update(j.id, { status: "generating", stage: "Generating voice" });
    for (let i = 0; i < 5; i++) { await sleep(60); await q.heartbeat(j.id, { stage: "Generating voice" }); await q.reap(); }
    const r = await q.get(j.id);
    check("heartbeating job survives 5x the stale window", r.status === "generating", r.status);
  }
  { // presence summary
    const now = Date.now();
    const p = jobsLib.summarizePresence({ a: { id: "a", lastSeenAt: now - 1000 }, b: { id: "b", lastSeenAt: now - 10 * 60 * 1000 }, c: { id: "c", lastSeenAt: now, stoppedAt: now } }, now);
    check("presence: live / stale / stopped", p.live === true && p.workers.find(w => w.id === "a").live && !p.workers.find(w => w.id === "b").live && !p.workers.find(w => w.id === "c").live, p.workers.map(w => w.id + ":" + w.live).join(","));
    const none = jobsLib.summarizePresence({}, now);
    check("presence: none", none.live === false && none.lastSeenAt === null, none);
  }
  { // duplicate detection
    const { findTwin } = require("./worker.js");
    const a = { id: "gen_a", storyId: 394, sourceRevision: "r", voiceVersion: "1", status: "queued", createdAt: 1000 };
    const b = { id: "gen_b", storyId: 394, sourceRevision: "r", voiceVersion: "1", status: "queued", createdAt: 1760 };
    const later = { id: "gen_c", storyId: 394, sourceRevision: "r", voiceVersion: "1", status: "queued", createdAt: 1000 + 10 * 60 * 1000 };
    const otherRev = { id: "gen_d", storyId: 394, sourceRevision: "r2", voiceVersion: "1", status: "queued", createdAt: 1100 };
    const all = [a, b, later, otherRev];
    check("double submit: later twin is the duplicate", findTwin(b, all) === a && findTwin(a, all) === null, [findTwin(b, all) && findTwin(b, all).id, findTwin(a, all)]);
    check("not a duplicate: 10 min apart / other text", findTwin(later, all) === null && findTwin(otherRev, all) === null, null);
    check("a failed first attempt never blocks a retry", findTwin(b, [Object.assign({}, a, { status: "failed" }), b]) === null, null);
  }
  { // engine exit codes are explained, not passed through as raw numbers
    const { explainExit } = require("./engine.js");
    const e1 = explainExit(3221225794, "");
    check("0xC0000142 -> engine_out_of_memory, actionable", e1.code === "engine_out_of_memory" && /0xC0000142/.test(e1.message) && /Close memory-heavy applications/.test(e1.message) && /RAM free/.test(e1.message), e1.message.slice(0, 110));
    const e2 = explainExit(1, "Traceback ...\ntorch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB");
    check("CUDA OOM -> engine_gpu_out_of_memory", e2.code === "engine_gpu_out_of_memory" && /VRAM/.test(e2.message), e2.code);
    const e3 = explainExit(3, "FATAL: HARLAN_REQUIRE_GPU set but CUDA is not available");
    check("other exits keep the engine's own stderr", e3.code === "engine_failed" && /Engine exited 3: FATAL: HARLAN_REQUIRE_GPU/.test(e3.message), e3.message.slice(0, 80));
  }
  { // preflight
    const { preflight } = require("./worker.js");
    const save = Object.assign({}, process.env);
    delete process.env.HARLAN_WORKER_ALLOW_LOCAL; process.env.HARLAN_ENGINE_CMD = "python harlan_golden.py"; process.env.HARLAN_REQUIRE_GPU = "";
    const p1 = preflight();
    check("preflight: refuses without Supabase", !p1.ok && p1.problems.some(x => /LOCAL file queue/.test(x)), p1.problems[0] && p1.problems[0].slice(0, 70));
    const cpuPy = "D:\\DATA\\harlans-legacy-platform\\prototype\\voicelab\\venv\\Scripts\\python.exe";
    if (fs.existsSync(cpuPy)) {
      process.env.HARLAN_WORKER_ALLOW_LOCAL = "1"; process.env.HARLAN_ENGINE_CMD = cpuPy + " harlan_golden.py"; process.env.HARLAN_REQUIRE_GPU = "1";
      const p2 = preflight();
      check("preflight: refuses the CPU-only interpreter when GPU is required", !p2.ok && p2.problems.some(x => /no CUDA/.test(x)), p2.problems[0] && p2.problems[0].slice(0, 90));
    } else check("preflight: CPU interpreter check (skipped — not on this machine)", true, "skipped");
    process.env = save;
  }

  let failed = 0;
  results.forEach(r => { if (!r.ok) failed++; console.log((r.ok ? "PASS " : "FAIL ") + r.name.padEnd(62) + JSON.stringify(r.got)); });
  console.log(failed ? ("\n" + failed + " FAILED") : "\nALL PASS (" + results.length + ")");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
