/* =========================================================================
   Automated test — narration queue / worker lifecycle
   (run: node lib/narration/worker-lifecycle.test.js)

   Uses in-memory documents, or a throw-away local data dir (never Supabase):
     • a queued job nobody can claim fails as worker_offline — after the short
       orphan window, not the full stale window — and never says "no heartbeat"
     • a queued job waits while a worker is live, even past the stale window
     • a claimed job whose heartbeats stop fails as worker_lost, naming its stage;
       sooner when its own worker is offline; never while heartbeating
     • worker presence: live / stopped / stale; supervisor entries never count as a
       live worker but explain why none is (config error / restarting)
     • Generate fails fast with worker_offline when no worker is live (job + request
       id recorded), and queues normally when one is
     • a double-submitted job is recognised as a duplicate (and only the later one)
     • supervisor restart policy: backoff, reset after healthy uptime, stop after
       repeated configuration errors, exit on a duplicate worker
     • engine release manifest: matching files pass, a tampered file is named
     • engine exit codes are explained
     • the worker refuses to start without Supabase, and on a CPU-only interpreter
       when HARLAN_REQUIRE_GPU=1 (checked only if that interpreter exists here)
   Exits non-zero on any failure.
   ========================================================================= */
"use strict";
delete process.env.HARLAN_ENV_FILE;
const fs = require("fs");
const os = require("os");
const path = require("path");
// a throw-away local data root for the parts that use the real (file-backed) store
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "narr-lifecycle-"));
process.env.HL_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
const jobsLib = require("./jobs.js");

function memStore(staleMs, orphanMs) {
  const mem = {};
  const getDoc = async (k, fb) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : fb);
  const putDoc = async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); };
  return { mem, q: jobsLib.makeStore("narration_jobs_test", { getDoc, putDoc, staleMs, orphanMs, workerPresence: true }) };
}
const job = { storyId: 395, sourceRevision: "sha256:test", voiceId: "harlan-v1", voiceVersion: "1", mode: "auto" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const results = [];
  const check = (name, ok, got) => results.push({ name, ok: !!ok, got });

  { // no worker ever reported → fails after the orphan window
    const { q } = memStore(60000, 50);
    const { job: j } = await q.create(job); await sleep(80);
    const s = await q.get(j.id); await q.reap(); const r = await q.get(j.id);
    check("queued, no worker -> worker_offline after orphan window (not stale window)", r.status === "failed" && r.error.code === "worker_offline" && /offline/.test(r.error.message) && /no worker has reported in/.test(r.error.message) && r.retryable === true, { status: r.status, code: r.error && r.error.code });
    check("never says 'no heartbeat' for an unclaimed job", !/no heartbeat/i.test(r.error.message) && s.stage === "Queued", r.error.message.slice(0, 80));
  }
  { // live worker, busy elsewhere: the queued job waits
    const { q } = memStore(50, 50);
    await q.reportPresence("box:1", { host: "box", gpu: "Quadro M5000M", busyJob: "gen_other" });
    const { job: j } = await q.create(job); await sleep(80); await q.reap(); const r = await q.get(j.id);
    check("queued, live worker -> keeps waiting", r.status === "queued", r.status);
  }
  { // worker stopped cleanly
    const { q } = memStore(60000, 50);
    await q.reportPresence("box:1", { host: "box", stoppedAt: Date.now() });
    const { job: j } = await q.create(job); await sleep(80); await q.reap(); const r = await q.get(j.id);
    check("queued, worker stopped -> worker_offline with last seen", r.status === "failed" && r.error.code === "worker_offline" && /last seen/.test(r.error.message) && r.error.lastWorkerSeenAt, r.error && r.error.message.slice(0, 90));
  }
  { // supervisor says the worker refused to start: reason surfaces in the job error
    const { q } = memStore(60000, 50);
    await q.reportPresence("box:supervisor", { kind: "supervisor", state: "stopped-config-error", offlineReason: "HARLAN_REQUIRE_GPU=1 but the engine interpreter has no CUDA" });
    const { job: j } = await q.create(job); await sleep(80); await q.reap(); const r = await q.get(j.id);
    check("worker_offline carries the supervisor's reason", r.status === "failed" && /no CUDA/.test(r.error.message) && /stopped retrying/.test(r.error.message), r.error && r.error.message.slice(0, 160));
  }
  { // claimed, then silent (claimer offline) → worker_lost quickly
    const { q } = memStore(60000, 50);
    const { job: j } = await q.create(job);
    await q.update(j.id, { status: "aligning", stage: "Creating word/sentence/paragraph timings", workerId: "box:1" });
    await sleep(80); await q.reap(); const r = await q.get(j.id);
    check("claimed + silent + its worker offline -> worker_lost after orphan window", r.status === "failed" && r.error.code === "worker_lost" && /Creating word/.test(r.error.message) && /box:1/.test(r.error.message), r.error && r.error.message.slice(0, 120));
  }
  { // claimed by a LIVE worker, quiet for less than the stale window → kept
    const { q } = memStore(60000, 50);
    await q.reportPresence("box:1", { host: "box" });
    const { job: j } = await q.create(job);
    await q.update(j.id, { status: "generating", stage: "Generating voice", workerId: "box:1" });
    await sleep(80); await q.reap(); const r = await q.get(j.id);
    check("claimed by a live worker, inside stale window -> kept", r.status === "generating", r.status);
  }
  { // heartbeating job is never reaped
    const { q } = memStore(120, 120);
    const { job: j } = await q.create(job);
    await q.update(j.id, { status: "generating", stage: "Generating voice" });
    for (let i = 0; i < 5; i++) { await sleep(60); await q.heartbeat(j.id, { stage: "Generating voice" }); await q.reap(); }
    const r = await q.get(j.id);
    check("heartbeating job survives 5x the stale window", r.status === "generating", r.status);
  }
  { // presence summary
    const now = Date.now();
    const p = jobsLib.summarizePresence({ a: { id: "a", lastSeenAt: now - 1000 }, b: { id: "b", lastSeenAt: now - 10 * 60 * 1000 }, c: { id: "c", lastSeenAt: now, stoppedAt: now }, s: { id: "s", kind: "supervisor", lastSeenAt: now, state: "running" } }, now);
    check("presence: live / stale / stopped; supervisor not a worker", p.live === true && p.workers.length === 3 && p.workers.find(w => w.id === "a").live && !p.workers.find(w => w.id === "b").live && !p.workers.find(w => w.id === "c").live, p.workers.map(w => w.id + ":" + w.live).join(","));
    const none = jobsLib.summarizePresence({}, now);
    check("presence: none", none.live === false && none.lastSeenAt === null && none.offlineReason === null, none);
    const sup = jobsLib.summarizePresence({ s: { id: "s", kind: "supervisor", lastSeenAt: now, state: "restarting", lastExit: { code: 1, at: now - 2000 } } }, now);
    check("presence: supervisor alone is not live; explains restart", sup.live === false && /exit code 1/.test(sup.offlineReason) && /restarted/.test(sup.offlineReason), sup.offlineReason);
    const dead = jobsLib.summarizePresence({ w: { id: "h:42", host: "h", pid: 42, startedAt: now - 60000, lastSeenAt: now - 5000 }, s: { id: "h:supervisor", kind: "supervisor", host: "h", lastSeenAt: now, state: "restarting", lastExit: { pid: 42, code: 1, at: now - 3000 } } }, now);
    check("presence: a worker whose exit the supervisor recorded is not live (no 90 s ghost)", dead.live === false && dead.workers[0].live === false, dead.workers[0]);
  }
  { // Generate fails fast with no live worker; queues normally with one (file-backed store in TMP)
    const svc = require("./service.js");
    const story = { id: 99101, title: "t", status: "draft", lead: "A short synthetic lead.", body: ["A synthetic body paragraph."] };
    const r1 = await svc.requestGeneration(story, { mode: "auto", requestId: "req_test_offline" });
    check("Generate with no live worker -> refused at once (job recorded failed)", r1.workerOffline === true && r1.job.status === "failed" && r1.job.error.code === "worker_offline" && r1.job.requestId === "req_test_offline" && /Retry/.test(r1.job.error.message), { status: r1.job.status, code: r1.job.error && r1.job.error.code });
    await jobsLib.reportPresence("box:9", { host: "box", gpu: "Quadro M5000M" });
    const r2 = await svc.requestGeneration(Object.assign({}, story, { id: 99102 }), { mode: "auto", requestId: "req_test_live" });
    check("Generate with a live worker -> queued with request id", !r2.workerOffline && r2.job.status === "queued" && r2.job.requestId === "req_test_live", { status: r2.job.status });
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
  { // supervisor restart policy (pure)
    const { decide, EXIT } = require("./supervisor.js");
    let s = { configFailures: 0, quickFailures: 0 }; const delays = [];
    for (let i = 0; i < 9; i++) { const d = decide(s, { code: 1, uptimeMs: 1000 }); delays.push(d.delayMs); s = d; }
    check("crash loop: exponential backoff 5s,10s,20s… capped at 5 min", delays[0] === 5000 && delays[1] === 10000 && delays[2] === 20000 && delays[8] === 300000 && delays.every((x, i) => i === 0 || x >= delays[i - 1]), delays.join(","));
    const healthy = decide(s, { code: 1, uptimeMs: 11 * 60 * 1000 });
    check("crash after healthy uptime: backoff resets to 5s", healthy.action === "restart" && healthy.delayMs === 5000, healthy);
    let c = { configFailures: 0, quickFailures: 0 }; const acts = [];
    for (let i = 0; i < 3; i++) { c = decide(c, { code: EXIT.CONFIG, uptimeMs: 500 }); acts.push(c.action); }
    check("configuration error: retried twice, then stop (no endless loop)", acts.join(",") === "restart,restart,stop-config", acts.join(","));
    check("another worker already running: supervisor exits", decide({ configFailures: 0, quickFailures: 0 }, { code: EXIT.DUPLICATE, uptimeMs: 100 }).action === "exit-duplicate", null);
    check("transient (network) exit: restart", decide({ configFailures: 0, quickFailures: 0 }, { code: EXIT.TRANSIENT, uptimeMs: 100 }).action === "restart", null);
  }
  { // engine release manifest verification
    const eng = require("./engine.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "narr-rel-"));
    fs.mkdirSync(path.join(dir, "golden"));
    fs.writeFileSync(path.join(dir, "golden", "harlan_golden.py"), "print('x')\n");
    const sha = p => require("crypto").createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    fs.writeFileSync(path.join(dir, "MANIFEST.json"), JSON.stringify({ release: "golden-engine-test", files: { "golden/harlan_golden.py": sha(path.join(dir, "golden", "harlan_golden.py")) } }));
    const save = process.env.HARLAN_ENGINE_MANIFEST; process.env.HARLAN_ENGINE_MANIFEST = path.join(dir, "MANIFEST.json");
    const ok1 = eng.verifyEngineRelease();
    fs.writeFileSync(path.join(dir, "golden", "harlan_golden.py"), "print('tampered')\n");
    const bad = eng.verifyEngineRelease();
    if (save == null) delete process.env.HARLAN_ENGINE_MANIFEST; else process.env.HARLAN_ENGINE_MANIFEST = save;
    check("engine release: matching files verify", ok1 && ok1.ok === true && ok1.release === "golden-engine-test", ok1);
    check("engine release: a changed file is refused and named", bad && bad.ok === false && /harlan_golden\.py/.test(bad.message), bad && bad.message.slice(0, 120));
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
  { // preflight (async)
    const { preflight } = require("./worker.js");
    const save = Object.assign({}, process.env);
    delete process.env.HARLAN_WORKER_ALLOW_LOCAL; process.env.HARLAN_ENGINE_CMD = "python harlan_golden.py"; process.env.HARLAN_REQUIRE_GPU = "";
    const p1 = await preflight();
    check("preflight: refuses without Supabase", !p1.ok && p1.problems.some(x => /LOCAL file queue/.test(x)), p1.problems[0] && p1.problems[0].slice(0, 70));
    const cpuPy = "D:\\DATA\\harlans-legacy-platform\\prototype\\voicelab\\venv\\Scripts\\python.exe";
    if (fs.existsSync(cpuPy)) {
      process.env.HARLAN_WORKER_ALLOW_LOCAL = "1"; process.env.HARLAN_ENGINE_CMD = cpuPy + " harlan_golden.py"; process.env.HARLAN_REQUIRE_GPU = "1";
      const p2 = await preflight();
      check("preflight: refuses the CPU-only interpreter when GPU is required", !p2.ok && p2.problems.some(x => /no CUDA/.test(x)), p2.problems[0] && p2.problems[0].slice(0, 90));
    } else check("preflight: CPU interpreter check (skipped — not on this machine)", true, "skipped");
    process.env = save;
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  let failed = 0;
  results.forEach(r => { if (!r.ok) failed++; console.log((r.ok ? "PASS " : "FAIL ") + r.name.padEnd(78) + JSON.stringify(r.got)); });
  console.log(failed ? ("\n" + failed + " FAILED") : "\nALL PASS (" + results.length + ")");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
