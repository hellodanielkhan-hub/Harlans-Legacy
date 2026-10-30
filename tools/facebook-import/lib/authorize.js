/* Interactive authorization for a Production import. There is deliberately no other way in:
   - it needs a real interactive terminal (stdin and stdout are TTYs);
   - the person types the exact batch identifier and pastes the exact payload fingerprint;
   - the admin token is entered at a hidden prompt (never an argument, never an environment variable);
   - after a read-only snapshot and id allocation are shown, a final typed phrase is required before the
     first write.
   This module reads no environment variable and no command-line flag. Tests pass a scripted io. */
"use strict";

const crypto = require("crypto");
const { canonical, approvalFingerprint } = require("./batch.js");

const batchIdOf = P => "batch-" + String(P.batch).padStart(2, "0");
const confirmPhrase = batchId => "IMPORT " + batchId + " AS DRAFTS";

// Identifies the approved content of a payload. It does not depend on story ids (those are allocated
// from a fresh snapshot at run time), so re-planning ids never changes it.
function payloadFingerprint(P) {
  return crypto.createHash("sha256").update(canonical({ batch: P.batch, items: P.items.map(it => [it.postId, approvalFingerprint(it)]) })).digest("hex");
}

async function authorizeRun(io, expect) {
  if (!io || !io.isTTY) throw new Error("a Production import needs an interactive terminal; nothing was sent");
  io.print("Production Draft import: " + expect.batchId + " (" + expect.posts + " posts, " + expect.photos + " photos).");
  const b = String(await io.ask("Type the batch identifier: ") || "").trim();
  if (b !== expect.batchId) throw new Error("batch identifier does not match; nothing was sent");
  const f = String(await io.ask("Paste the payload fingerprint: ") || "").trim();
  if (f !== expect.payloadFingerprint) throw new Error("payload fingerprint does not match; nothing was sent");
  const token = String(await io.askHidden("Admin token (input hidden): ") || "");
  if (!token) throw new Error("no token entered; nothing was sent");
  return token;
}

async function confirmWrites(io, batchId, lines) {
  for (const l of lines) io.print(l);
  const phrase = confirmPhrase(batchId);
  const a = String(await io.ask("Type exactly \"" + phrase + "\" to start the first Production write: ") || "").trim();
  if (a !== phrase) throw new Error("confirmation phrase not entered; nothing was written");
}

// Real terminal io for the command line.
function ttyIo() {
  const readline = require("readline");
  const isTTY = !!(process.stdin.isTTY && process.stdout.isTTY);
  const ask = q => new Promise(resolve => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true }); rl.question(q, a => { rl.close(); resolve(a); }); });
  const askHidden = q => new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(q);
    let s = "";
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    const done = v => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener("data", on); process.stdout.write("\n"); v === null ? reject(new Error("cancelled")) : resolve(v); };
    const on = ch => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") return done(s);
        if (c === "\u0003") return done(null);                       // Ctrl+C
        if (c === "\u0008" || c === "\u007f") { s = s.slice(0, -1); continue; }
        s += c;                                                      // nothing is echoed
      }
    };
    stdin.on("data", on);
  });
  return { isTTY, ask, askHidden, print: l => console.log(l) };
}

module.exports = { authorizeRun, confirmWrites, payloadFingerprint, batchIdOf, confirmPhrase, ttyIo };
