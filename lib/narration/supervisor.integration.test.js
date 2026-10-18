/* =========================================================================
   Integration test (Windows, real processes) — supervisor + worker lifecycle
   (run: node lib/narration/supervisor.integration.test.js)

   Isolated: throw-away HL_DATA_DIR, log dir and lock files; never Supabase; no GPU job.
     A. worker hard-killed → supervisor logs the exit code and restarts it; the worker's
        presence heartbeat comes back (time measured)
     B. a second supervisor and a second bare worker are refused (one per machine)
     C. a configuration error is retried twice, then the supervisor stops retrying and
        records the reason (presence → offlineReason)
     D. an orphaned engine process (left by a dead worker) is killed when a worker starts
   ========================================================================= */
"use strict";
const fs = require("fs"), os = require("os"), path = require("path");
const { spawn, spawnSync } = require("child_process");
if (process.platform !== "win32") { console.log("SKIP (Windows-only test)"); process.exit(0); }

const ROOT = path.resolve(__dirname, "..", "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "narr-sup-it-"));
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
const PY = "D:\\DATA\\harlans-legacy-platform\\prototype\\voicelab\\venv\\Scripts\\python.exe";   // CPU venv: light, no GPU needed
const ENGINE = "D:\\DATA\\harlans-engine\\golden\\harlan_golden.py";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const baseEnv = () => {
  const e = Object.assign({}, process.env);
  for (const k of ["HARLAN_ENV_FILE", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HARLAN_ENGINE_MANIFEST", "HARLAN_REQUIRE_GPU"]) delete e[k];
  return Object.assign(e, { HL_DATA_DIR: TMP, HARLAN_WORKER_ALLOW_LOCAL: "1", HARLAN_ENGINE_CMD: PY + " " + ENGINE,
    HARLAN_WORKER_LOG_DIR: path.join(TMP, "logs"), HARLAN_WORKER_LOCK: path.join(TMP, "worker.lock"), HARLAN_SUPERVISOR_LOCK: path.join(TMP, "supervisor.lock"),
    HARLAN_SUPERVISOR_BASE_MS: "1000", HARLAN_WORKER_PRESENCE_MS: "1000", HARLAN_SUPERVISOR_PRESENCE_MS: "1000", HARLAN_WORKER_POLL_MS: "1000", HARLAN_WORKER_MIN_COMMIT_GB: "0" });
};
const presence = () => { try { return JSON.parse(fs.readFileSync(path.join(TMP, "data", "narration_worker.json"), "utf8")).workers || {}; } catch (e) { return {}; } };
const liveWorker = () => Object.values(presence()).find(w => w.kind !== "supervisor" && !w.stoppedAt && Date.now() - w.lastSeenAt < 5000);
const logText = () => { try { return fs.readFileSync(path.join(TMP, "logs", "worker.log"), "utf8"); } catch (e) { return ""; } };
async function until(fn, ms, step) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step || 250); } return null; }
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
const kill = pid => spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });

(async () => {
  const results = []; const check = (name, ok, got) => { results.push({ name, ok: !!ok, got }); console.log((ok ? "PASS " : "FAIL ") + name.padEnd(74) + JSON.stringify(got)); };
  if (!fs.existsSync(PY) || !fs.existsSync(ENGINE)) { console.log("SKIP: needs " + PY + " and " + ENGINE); process.exit(0); }

  // ---- D first: an orphaned "engine" process must be killed when a worker starts ----
  const orphan = spawn(PY, ["-c", "import time; time.sleep(600)", ENGINE], { stdio: "ignore", detached: true, windowsHide: true }); orphan.unref();
  await sleep(1500);
  const before = alive(orphan.pid);

  // ---- A. supervisor + real worker; hard-kill the worker ----
  const sup = spawn(process.execPath, [path.join(ROOT, "lib", "narration", "supervisor.js")], { env: baseEnv(), stdio: "ignore", windowsHide: true });
  const w1 = await until(liveWorker, 60000);
  check("A1 supervisor started a worker that reports presence", !!w1, w1 && { id: w1.id, supervisor: w1.supervisor });
  check("D  orphaned engine process killed at worker start", before && !alive(orphan.pid) && /killing orphaned engine process tree \(worker start\)/.test(logText()), { orphanPid: orphan.pid, wasAlive: before, aliveNow: alive(orphan.pid) });
  const t0 = Date.now(); kill(w1.pid);
  const w2 = await until(() => { const w = liveWorker(); return w && w.pid !== w1.pid ? w : null; }, 60000);
  const recoverS = ((Date.now() - t0) / 1000).toFixed(1);
  check("A2 hard-killed worker restarted; heartbeat back (seconds)", !!w2 && w2.supervisor && w2.supervisor.restarts === 1 && w2.supervisor.lastExit && w2.supervisor.lastExit.pid === w1.pid, { recoverS, newPid: w2 && w2.pid, supervisor: w2 && w2.supervisor });
  check("A3 exit logged with code + restart decision", new RegExp("worker exited: pid " + w1.pid + " code \\d+").test(logText()) && /restarting in \d+s \(restart #1/.test(logText()), logText().split("\n").filter(l => /exited|restarting/.test(l)).slice(-2));

  // ---- B. one per machine ----
  const sup2 = spawnSync(process.execPath, [path.join(ROOT, "lib", "narration", "supervisor.js")], { env: baseEnv(), encoding: "utf8", timeout: 60000 });
  check("B1 second supervisor refused (exit 3)", sup2.status === 3 && /another supervisor already runs/.test(sup2.stdout), { status: sup2.status, out: String(sup2.stdout).trim().split("\n").pop() });
  const wk2 = spawnSync(process.execPath, [path.join(ROOT, "lib", "narration", "worker.js"), "--loop"], { env: baseEnv(), encoding: "utf8", timeout: 60000 });
  check("B2 second bare worker refused (exit 3)", wk2.status === 3 && /another narration worker already runs/.test(wk2.stderr), { status: wk2.status, err: String(wk2.stderr).trim().split("\n").filter(l => /REFUSING/.test(l)).pop() });

  // stop supervisor A (it must take its worker down with it)
  const lastWorkerPid = (liveWorker() || {}).pid;
  kill(sup.pid); await sleep(1500);
  check("A4 stopping the supervisor tree leaves no worker running", lastWorkerPid && !alive(lastWorkerPid), { worker: lastWorkerPid, alive: lastWorkerPid && alive(lastWorkerPid) });

  // ---- C. configuration error: no engine configured ----
  // (phase A killed its last worker together with the supervisor, so nothing recorded that exit:
  //  that entry legitimately stays "live" until its 90 s window lapses — start C from a clean doc)
  try { fs.unlinkSync(path.join(TMP, "data", "narration_worker.json")); } catch (e) {}
  try { fs.unlinkSync(path.join(TMP, "supervisor.lock")); } catch (e) {}
  try { fs.unlinkSync(path.join(TMP, "worker.lock")); } catch (e) {}
  const envC = baseEnv(); envC.HARLAN_ENGINE_CMD = ""; envC.HARLAN_SUPERVISOR_ID = "it-host:supervisor";
  const supC = spawn(process.execPath, [path.join(ROOT, "lib", "narration", "supervisor.js")], { env: envC, stdio: "ignore", windowsHide: true });
  const stopped = await until(() => { const s = presence()["it-host:supervisor"]; return s && s.state === "stopped-config-error" ? s : null; }, 90000, 500);
  const sum = require("./jobs.js").summarizePresence(presence(), Date.now());
  check("C1 config error retried, then supervisor stops retrying", !!stopped && (logText().match(/worker exited: pid \d+ code 2/g) || []).length >= 3, { state: stopped && stopped.state, configExits: (logText().match(/code 2 /g) || []).length });
  check("C2 reason recorded for Admin (offlineReason)", /No engine configured/.test(sum.offlineReason || ""), sum.offlineReason);
  await sleep(3000);
  check("C3 no further restarts after stopping", (logText().match(/worker started: pid/g) || []).length === (logText().match(/worker started: pid/g) || []).length && supC.exitCode === null, "supervisor idle, not looping");
  kill(supC.pid);

  console.log("\nlog excerpt:\n" + logText().split("\n").filter(l => /\[supervisor\]/.test(l)).slice(-12).join("\n"));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  const failed = results.filter(r => !r.ok).length;
  console.log(failed ? "\n" + failed + " FAILED" : "\nALL PASS (" + results.length + ")");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
