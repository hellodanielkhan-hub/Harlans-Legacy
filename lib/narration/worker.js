/* =========================================================================
   Harlan's Legacy — narration worker (§19, §20)

   Drains queued narration jobs and runs the (slow) generation pipeline OUTSIDE
   the request/response cycle. Two ways to run it:

     • In-process pump (local dev): server.js calls pump() after enqueuing, so a
       single `node server.js` processes jobs. One job at a time (a lock guards
       against concurrent runs / double-click, §13).

     • Standalone (production / a real engine box):
         node lib/narration/worker.js         # process the queue once and exit
         node lib/narration/worker.js --loop   # keep polling every few seconds

   The worker never runs inside the Vercel request handler (30s / ephemeral).
   ========================================================================= */
"use strict";

require("../loadenv.js");
const jobs = require("./jobs.js");
const service = require("./service.js");

let running = false;

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
      const res = await service.processJob(j.id);
      done.push({ id: j.id, status: res && res.status });
    }
    await jobs.prune();
  } finally { running = false; }
  return { processed: done };
}

async function loop(intervalMs) {
  intervalMs = intervalMs || Number(process.env.HARLAN_WORKER_POLL_MS || 4000);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { const r = await pump(); if (r.processed && r.processed.length) console.log("[narration-worker]", JSON.stringify(r.processed)); }
    catch (e) { console.error("[narration-worker] pump error:", e.message); }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

module.exports = { pump, loop };

if (require.main === module) {
  const loopMode = process.argv.includes("--loop");
  (async () => {
    if (loopMode) { console.log("[narration-worker] polling…"); await loop(); }
    else { const r = await pump(); console.log("[narration-worker]", JSON.stringify(r)); process.exit(0); }
  })();
}
