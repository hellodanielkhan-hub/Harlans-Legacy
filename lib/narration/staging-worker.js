/* =========================================================================
   Harlan's Legacy — STAGING benchmark worker (isolated from production)

   Drains ONLY the staging queue (lib/narration/staging.js). Never touches the
   production narration queue, story records, manifests or approvals.

     node lib/narration/staging-worker.js --once    # drain once and exit
     node lib/narration/staging-worker.js --loop    # keep polling
   ========================================================================= */
"use strict";

require("../loadenv.js");
const staging = require("./staging.js");

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { const r = await staging.pump(); if (r.length) console.log("[staging-worker]", JSON.stringify(r)); }
  catch (e) { console.error("[staging-worker] error:", e.message); }
  finally { running = false; }
}

if (require.main === module) {
  const loop = process.argv.includes("--loop");
  console.log("[staging-worker] store=" + staging.MODE + " dir=" + staging.STAGING_DIR + (loop ? " (polling)" : " (once)"));
  if (loop) { tick(); setInterval(tick, Number(process.env.HARLAN_STAGING_POLL_MS || 1000)); }
  else tick().then(() => staging.drain()).then(() => process.exit(0));   // --once waits for dispatched remote jobs + quality pass
}

module.exports = { tick };
