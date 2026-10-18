/* =========================================================================
   Harlan's Legacy — narration worker SUPERVISOR

   Keeps exactly one narration worker (lib/narration/worker.js --loop) running on
   the GPU machine and records why it ever stopped. Started at logon by
   tools/narration-worker/start-gpu-worker.ps1 (Startup shortcut).

     • logs every start, exit (code, signal, uptime), the worker's stdout/stderr and
       every restart decision to HARLAN_WORKER_LOG_DIR/worker.log (rotated at 5 MB)
     • restarts after an unexpected exit with bounded exponential backoff
       (5 s → 10 s → … ≤ 5 min; reset after 10 min of healthy running)
     • does NOT loop on configuration/authentication errors: after 3 consecutive
       configuration exits (worker exit code 2) it stops restarting and reports the
       reason — Admin shows it — until a person fixes it and restarts the supervisor
     • exits if another worker already owns this machine (exit code 3)
     • one supervisor per machine (lock); on shutdown it stops the worker and the
       worker's engine process tree
     • reports its own state ("narration_worker" entry of kind "supervisor") every
       30 s, so "worker offline" comes with a reason
   ========================================================================= */
"use strict";

require("../loadenv.js");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const jobs = require("./jobs.js");

const CHILD = process.env.HARLAN_SUPERVISOR_CHILD || path.join(__dirname, "worker.js");
const CHILD_ARGS = process.env.HARLAN_SUPERVISOR_CHILD ? [] : ["--loop"];
const LOG_DIR = process.env.HARLAN_WORKER_LOG_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), "harlans-narration", "logs");
const LOG_FILE = path.join(LOG_DIR, "worker.log");
const LOCK_FILE = process.env.HARLAN_SUPERVISOR_LOCK || path.join(os.tmpdir(), "harlan-narration-supervisor.lock");
const SUP_ID = process.env.HARLAN_SUPERVISOR_ID || (os.hostname() + ":supervisor");
const BASE_MS = Number(process.env.HARLAN_SUPERVISOR_BASE_MS || 5000);
const MAX_MS = Number(process.env.HARLAN_SUPERVISOR_MAX_MS || 5 * 60 * 1000);
const HEALTHY_MS = Number(process.env.HARLAN_SUPERVISOR_HEALTHY_MS || 10 * 60 * 1000);
const MAX_CONFIG_FAILURES = Number(process.env.HARLAN_SUPERVISOR_MAX_CONFIG || 3);
const PRESENCE_MS = Number(process.env.HARLAN_SUPERVISOR_PRESENCE_MS || 30000);
const EXIT = { OK: 0, CRASH: 1, CONFIG: 2, DUPLICATE: 3, TRANSIENT: 4 };

fs.mkdirSync(LOG_DIR, { recursive: true });
function write(line) {
  try {
    try { if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + ".1"); } catch (e) {}
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) { /* never crash on logging */ }
  process.stdout.write(line + "\n");
}
const log = msg => write("[supervisor] " + new Date().toISOString() + " " + msg);

// Decide what to do after the worker exits. Pure (unit-tested).
//   returns { action: "restart"|"stop-config"|"exit-duplicate", delayMs, configFailures, quickFailures }
function decide(prev, exit) {
  const configFailures = exit.code === EXIT.CONFIG ? prev.configFailures + 1 : 0;
  if (exit.code === EXIT.DUPLICATE) return { action: "exit-duplicate", delayMs: 0, configFailures, quickFailures: prev.quickFailures };
  if (configFailures >= MAX_CONFIG_FAILURES) return { action: "stop-config", delayMs: 0, configFailures, quickFailures: prev.quickFailures };
  const quickFailures = exit.uptimeMs >= HEALTHY_MS ? 1 : prev.quickFailures + 1;
  const delayMs = Math.min(MAX_MS, BASE_MS * Math.pow(2, Math.max(0, quickFailures - 1)));
  return { action: "restart", delayMs, configFailures, quickFailures };
}

// ---- one supervisor per machine ----
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
function isSupervisorPid(pid) {
  if (process.platform !== "win32") return pidAlive(pid);
  const r = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"ProcessId=" + Number(pid) + "\").CommandLine"], { encoding: "utf8", timeout: 20000 });
  return /supervisor\.js/i.test(String(r.stdout || ""));
}
function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") { try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 20000 }); } catch (e) {} }
  else { try { process.kill(pid, "SIGKILL"); } catch (e) {} }
}

const state = { child: null, startedAt: 0, restarts: 0, configFailures: 0, quickFailures: 0, lastExit: null, phase: "starting", offlineReason: null, stopping: false, refuse: [] };

function presence() {
  return jobs.reportPresence(SUP_ID, { kind: "supervisor", host: os.hostname(), pid: process.pid, state: state.phase, restarts: state.restarts,
    lastExit: state.lastExit, offlineReason: state.offlineReason, childPid: state.child ? state.child.pid : null, logFile: LOG_FILE })
    .catch(e => log("presence report failed: " + e.message));
}

function start() {
  if (state.stopping) return;
  state.refuse = [];
  const env = Object.assign({}, process.env, {
    HARLAN_SUPERVISOR_PID: String(process.pid), HARLAN_SUPERVISOR_RESTARTS: String(state.restarts),
    HARLAN_SUPERVISOR_LAST_EXIT: JSON.stringify(state.lastExit)
  });
  const child = spawn(process.execPath, [CHILD].concat(CHILD_ARGS), { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  state.child = child; state.startedAt = Date.now(); state.phase = "running"; state.offlineReason = null;
  log("worker started: pid " + child.pid + " (start #" + (state.restarts + 1) + ") " + CHILD);
  const pipe = (stream, tag) => {
    let buf = "";
    stream.on("data", d => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
        if (!line) continue;
        write("[worker:" + child.pid + ":" + tag + "] " + line);
        const m = line.match(/REFUSING TO START: (.*)$/); if (m) state.refuse.push(m[1]);
      }
    });
    stream.on("end", () => { if (buf.trim()) write("[worker:" + child.pid + ":" + tag + "] " + buf.trim()); });
  };
  pipe(child.stdout, "out"); pipe(child.stderr, "err");
  presence();
  child.on("exit", (code, signal) => {
    const uptimeMs = Date.now() - state.startedAt;
    state.child = null;
    state.lastExit = { code: code == null ? null : code, signal: signal || null, at: Date.now(), uptimeS: Math.round(uptimeMs / 1000), pid: child.pid };
    log("worker exited: pid " + child.pid + " code " + code + (signal ? " signal " + signal : "") + " after " + Math.round(uptimeMs / 1000) + "s");
    if (state.stopping) return;
    const d = decide(state, { code, signal, uptimeMs });
    state.configFailures = d.configFailures; state.quickFailures = d.quickFailures;
    if (d.action === "exit-duplicate") {
      state.phase = "stopped-duplicate"; state.offlineReason = "another narration worker already runs on this machine";
      log("not restarting: " + state.offlineReason + ". Supervisor exits.");
      presence().then(() => process.exit(EXIT.DUPLICATE));
      return;
    }
    if (d.action === "stop-config") {
      state.phase = "stopped-config-error";
      state.offlineReason = (state.refuse.join(" | ") || ("worker exited with configuration error code " + code)).slice(0, 600);
      log("NOT restarting after " + state.configFailures + " consecutive configuration failures: " + state.offlineReason + " — fix the configuration, then restart the supervisor (start-gpu-worker.ps1).");
      presence();
      return;
    }
    state.phase = "restarting"; state.restarts++;
    log("restarting in " + Math.round(d.delayMs / 1000) + "s (restart #" + state.restarts + ", " + d.quickFailures + " quick failure(s) in a row)");
    presence();
    setTimeout(start, d.delayMs);
  });
}

function shutdown(sig) {
  if (state.stopping) return; state.stopping = true;
  log("supervisor stopping on " + sig + (state.child ? "; stopping worker pid " + state.child.pid + " and its engine processes" : ""));
  if (state.child) killTree(state.child.pid);
  state.phase = "stopped"; state.offlineReason = "supervisor stopped (" + sig + ")";
  presence().then(() => { releaseLock(); process.exit(0); });
  setTimeout(() => { releaseLock(); process.exit(0); }, 5000).unref();
}
function releaseLock() { try { const c = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); if (c.pid === process.pid) fs.unlinkSync(LOCK_FILE); } catch (e) {} }

module.exports = { decide, EXIT, MAX_CONFIG_FAILURES };

if (require.main === module) {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (cur && cur.pid !== process.pid && pidAlive(cur.pid) && isSupervisorPid(cur.pid)) {
      log("REFUSING TO START: another supervisor already runs (pid " + cur.pid + "). Log: " + LOG_FILE);
      process.exit(EXIT.DUPLICATE);
    }
  } catch (e) { /* no lock */ }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  process.on("exit", releaseLock);
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) process.on(sig, () => shutdown(sig));
  process.on("uncaughtException", e => { log("supervisor uncaught exception: " + (e && e.stack || e)); });
  process.on("unhandledRejection", e => { log("supervisor unhandled rejection: " + (e && e.stack || e)); });
  log("supervisor started: pid " + process.pid + " on " + os.hostname() + "; log " + LOG_FILE);
  setInterval(presence, PRESENCE_MS);
  start();
}
