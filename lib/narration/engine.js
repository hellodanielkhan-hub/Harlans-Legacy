/* =========================================================================
   Harlan's Legacy — Voice Engine Adapter (§5, §22, §24)

   NarrationService talks to this seam and never knows which engine is behind
   it. Two adapters ship:

     • "ingest"  — no synthesis. Reads an already-produced audio + aligned word
                   list (the real Blue Chair assets, or assets you drop in per
                   story). Used to represent existing narration and to test the
                   whole workflow without the synthesis engine present.

     • "command" — invokes the REAL private Harlan engine (Chatterbox synthesis
                   + wav2vec2 forced alignment) as an external process, entirely
                   server-side. Configure via env; if unset it fails truthfully
                   with engine_not_configured — it NEVER fabricates speech.

   No engine secret ever reaches the browser; only this server-side module (and
   the worker that calls it) touches engine config.
   ========================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const paths = require("../paths.js");

class NarrationEngineError extends Error {
  constructor(code, message) { super(message || code); this.code = code; this.name = "NarrationEngineError"; }
}

// Voice IDENTITY (provider-neutral). VOICE_VERSION is the identity version,
// never a provider version — see lib/narration/voice.js.
const { VOICE_ID, VOICE_IDENTITY_VERSION } = require("./voice.js");
const VOICE_VERSION = VOICE_IDENTITY_VERSION;

// Provider self-reported metadata written by the worker (engine, checkpoint,
// voice reference hash, precision, device, stage timings). Optional.
function readProviderMeta(dir) {
  const f = path.join(dir, "narration.provider.json");
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; }
}
function listenDir() { return process.env.HARLAN_LISTEN_DIR || path.join(paths.ROOT, "assets", "listen"); }

/* ---- ingest adapter: use existing aligned assets (no synthesis) ---- */
function ingestAdapter() {
  return {
    name: "ingest",
    voiceId: VOICE_ID, voiceVersion: VOICE_VERSION,
    async generate({ storyId }) {
      const dir = path.join(listenDir(), String(storyId));
      const mp3 = path.join(dir, "narration.mp3");
      const wordsFile = path.join(dir, "narration.words.json");
      if (!fs.existsSync(mp3) || !fs.existsSync(wordsFile)) {
        throw new NarrationEngineError("ingest_assets_missing",
          "No pre-aligned assets to ingest at " + dir + " (need narration.mp3 + narration.words.json).");
      }
      const wj = JSON.parse(fs.readFileSync(wordsFile, "utf8"));
      const words = (wj.words || wj).map((w, i) => ({ i: w.i != null ? w.i : i, w: w.w, start: +w.start, end: +w.end }));
      const audio = fs.readFileSync(mp3);
      return {
        audio, mp3Name: "narration.mp3", words,
        sr: wj.sr || 16000, method: wj.method || "ingested (pre-aligned)",
        duration: words.length ? words[words.length - 1].end : (wj.duration || 0),
        providerMeta: { engine: "ingest", model: "pre-aligned assets", precision: "n/a" }
      };
    }
  };
}

/* ---- command adapter: spawn the private engine (real) or fail truthfully ---- */
function commandAdapter() {
  const cmd = process.env.HARLAN_ENGINE_CMD;   // e.g. "python D:/voicelab/generate.py"  (configured server-side only)
  return {
    name: "command",
    voiceId: VOICE_ID, voiceVersion: VOICE_VERSION,
    async generate({ storyId, text, treatment }) {
      if (!cmd) {
        throw new NarrationEngineError("engine_not_configured",
          "Harlan voice engine is not configured. Set HARLAN_ENGINE_CMD to the Chatterbox+alignment worker command. " +
          "This environment has no engine, so real narration cannot be synthesised here.");
      }
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "harlan-narr-"));
      const inFile = path.join(work, "story.txt");
      fs.writeFileSync(inFile, text, "utf8");
      const outDir = path.join(work, "out"); fs.mkdirSync(outDir, { recursive: true });
      const timeoutMs = Number(process.env.HARLAN_ENGINE_TIMEOUT_MS || 20 * 60 * 1000);
      let argv = cmd.split(/\s+/).concat(["--text", inFile, "--voice", VOICE_ID, "--story", String(storyId), "--out", outDir]);
      // Golden path: hand the worker the story-specific emotional treatment.
      if (treatment) {
        const trFile = path.join(work, "treatment.json");
        fs.writeFileSync(trFile, JSON.stringify(treatment), "utf8");
        argv = argv.concat(["--treatment", trFile]);
      }
      await runProcess(argv[0], argv.slice(1), timeoutMs);
      const mp3 = path.join(outDir, "narration.mp3");
      const wordsFile = path.join(outDir, "narration.words.json");
      if (!fs.existsSync(mp3) || !fs.existsSync(wordsFile)) {
        throw new NarrationEngineError("engine_output_missing", "Engine finished but did not produce narration.mp3 + narration.words.json in " + outDir);
      }
      const wj = JSON.parse(fs.readFileSync(wordsFile, "utf8"));
      const words = (wj.words || wj).map((w, i) => ({ i: w.i != null ? w.i : i, w: w.w, start: +w.start, end: +w.end }));
      let zones = null;
      const zonesFile = path.join(outDir, "narration.zones.json");
      if (fs.existsSync(zonesFile)) { try { zones = JSON.parse(fs.readFileSync(zonesFile, "utf8")); } catch (e) {} }
      return {
        audio: fs.readFileSync(mp3), mp3Name: "narration.mp3", words, zones,
        sr: wj.sr || 16000, method: wj.method || "chatterbox + forced alignment",
        duration: words.length ? words[words.length - 1].end : (wj.duration || 0),
        providerMeta: readProviderMeta(outDir)
      };
    }
  };
}

function runProcess(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    // stdout is ignored (all outputs are files); only stderr is captured for
    // errors — so a long, chatty GPU job can never deadlock on a full stdout pipe.
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", d => { err = (err + d.toString()).slice(-4000); });
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill("SIGKILL"); } catch (e) {} reject(new NarrationEngineError("engine_timeout", "Engine exceeded " + timeoutMs + "ms")); } }, timeoutMs);
    child.on("error", e => { if (!done) { done = true; clearTimeout(timer); reject(new NarrationEngineError("engine_spawn_failed", String(e.message || e))); } });
    child.on("close", code => { if (done) return; done = true; clearTimeout(timer); code === 0 ? resolve() : reject(new NarrationEngineError("engine_failed", "Engine exited " + code + (err ? ": " + err.trim() : ""))); });
  });
}

/* ---- warm adapter: talk to a RESIDENT harlan_server.py (models load once) ----
   Same Golden recipe + same file contract as the command adapter; the only
   difference is the model stays warm across jobs. Opt-in via HARLAN_WARM_CMD.
   The persistent worker is a server-side implementation detail — the CMS/API and
   moderators never see it; the seam (out-dir files) is unchanged. */
let _warm = null;
function getWarm() {
  if (_warm && _warm.alive) return _warm;
  const cmd = process.env.HARLAN_WARM_CMD;
  const argv = cmd.split(/\s+/);
  const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  const w = { child, alive: true, ready: false, fatal: null, buf: "", errbuf: "", current: null, queue: [], env: null };
  child.stdout.on("data", d => {
    w.buf += d.toString(); let nl;
    while ((nl = w.buf.indexOf("\n")) >= 0) {
      const line = w.buf.slice(0, nl).trim(); w.buf = w.buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      if (m.event === "env") { w.env = m; }
      else if (m.event === "ready") { w.ready = true; _drain(w); }
      else if (m.event === "fatal") { w.fatal = m.error || "warm worker fatal"; }
      else if (m.event === "done" && w.current) { const c = w.current; w.current = null; clearTimeout(c.timer); c.resolve(m); _drain(w); }
      else if (m.event === "error" && w.current) { const c = w.current; w.current = null; clearTimeout(c.timer); c.reject(new NarrationEngineError("engine_failed", String(m.error || "warm job error"))); _drain(w); }
    }
  });
  child.stderr.on("data", d => { w.errbuf = (w.errbuf + d.toString()).slice(-2000); });
  const failAll = (code, msg) => {
    w.alive = false;
    const err = new NarrationEngineError(code, msg + (w.fatal ? (": " + w.fatal) : (w.errbuf ? (": " + w.errbuf.trim()) : "")));
    if (w.current) { const c = w.current; w.current = null; clearTimeout(c.timer); c.reject(err); }
    while (w.queue.length) { const c = w.queue.shift(); c.reject(err); }
    if (_warm === w) _warm = null;
  };
  child.on("error", e => failAll("engine_spawn_failed", String(e.message || e)));
  child.on("exit", code => failAll(w.fatal ? "engine_not_configured" : "engine_failed", "warm worker exited " + code));
  _warm = w; return w;
}
function _drain(w) {
  if (!w.ready || w.current || !w.queue.length || !w.alive) return;
  const c = w.queue.shift(); w.current = c;
  const timeoutMs = Number(process.env.HARLAN_ENGINE_TIMEOUT_MS || 20 * 60 * 1000);
  c.timer = setTimeout(() => {
    if (w.current === c) { w.current = null; try { w.child.kill("SIGKILL"); } catch (e) {} w.alive = false; if (_warm === w) _warm = null; c.reject(new NarrationEngineError("engine_timeout", "Warm worker exceeded " + timeoutMs + "ms")); }
  }, timeoutMs);
  try { w.child.stdin.write(JSON.stringify(c.req) + "\n"); }
  catch (e) { w.current = null; clearTimeout(c.timer); c.reject(new NarrationEngineError("engine_failed", "warm stdin write failed: " + String(e.message || e))); }
}
function warmAdapter() {
  return {
    name: "warm",
    voiceId: VOICE_ID, voiceVersion: VOICE_VERSION,
    async generate({ storyId, text, treatment }) {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "harlan-warm-"));
      const outDir = path.join(work, "out"); fs.mkdirSync(outDir, { recursive: true });
      const trFile = path.join(work, "treatment.json");
      fs.writeFileSync(trFile, JSON.stringify(treatment || {}), "utf8");
      const w = getWarm();
      if (w.fatal) throw new NarrationEngineError("engine_not_configured", w.fatal);
      const req = { cmd: "gen", treatment: trFile, out: outDir, voice: VOICE_ID, story: String(storyId) };
      await new Promise((resolve, reject) => { w.queue.push({ req, resolve, reject }); _drain(w); });
      const mp3 = path.join(outDir, "narration.mp3");
      const wordsFile = path.join(outDir, "narration.words.json");
      if (!fs.existsSync(mp3) || !fs.existsSync(wordsFile)) throw new NarrationEngineError("engine_output_missing", "Warm worker finished but did not produce narration.mp3 + narration.words.json in " + outDir);
      const wj = JSON.parse(fs.readFileSync(wordsFile, "utf8"));
      const words = (wj.words || wj).map((wd, i) => ({ i: wd.i != null ? wd.i : i, w: wd.w, start: +wd.start, end: +wd.end }));
      let zones = null; const zf = path.join(outDir, "narration.zones.json");
      if (fs.existsSync(zf)) { try { zones = JSON.parse(fs.readFileSync(zf, "utf8")); } catch (e) {} }
      return {
        audio: fs.readFileSync(mp3), mp3Name: "narration.mp3", words, zones,
        sr: wj.sr || 16000, method: wj.method || "chatterbox + wav2vec2 forced alignment (golden)",
        duration: words.length ? words[words.length - 1].end : (wj.duration || 0),
        providerMeta: readProviderMeta(outDir)
      };
    }
  };
}

// mode: "ingest" → existing assets; else real synthesis via the WARM worker when
// HARLAN_WARM_CMD is set (models resident), otherwise spawn-per-job command adapter.
function pickAdapter(mode) {
  if (mode === "ingest") return ingestAdapter();
  if (process.env.HARLAN_WARM_CMD) return warmAdapter();
  return commandAdapter();
}

module.exports = { pickAdapter, ingestAdapter, commandAdapter, warmAdapter, NarrationEngineError, VOICE_ID, VOICE_VERSION };
