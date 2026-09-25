/* =========================================================================
   Controlled narration BACKFILL — enqueue (production, Supabase-backed).
   Queues Golden narration jobs for the given PUBLISHED stories, one job each,
   through the platform's own service.requestGeneration (engine mode, never
   "auto"/ingest), with the same audit record the admin API writes.
   Refuses: non-published stories, stories with an approved+fresh narration,
   and any run that is not Supabase-backed. Never approves or publishes.
     node tools/narration-backfill/enqueue.cjs --ids 389,388,392 [--dry-run]
   ========================================================================= */
"use strict";
const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
require(path.join(ROOT, "lib/loadenv.js"));                  // BEFORE store.js → Supabase-backed
const store = require(path.join(ROOT, "lib/store.js"));
const service = require(path.join(ROOT, "lib/narration/service.js"));
const audit = require(path.join(ROOT, "lib/narration/audit.js"));

function arg(n) { const i = process.argv.indexOf("--" + n); return i < 0 ? null : process.argv[i + 1]; }
const IDS = String(arg("ids") || "").split(",").map(Number).filter(Boolean);
const DRY = process.argv.includes("--dry-run");
const ACTOR = { id: "claude-operator", name: "Claude (backfill on owner instruction)", via: "backfill-script" };

(async () => {
  if (!store.USE_SUPABASE) { console.error("REFUSED: not Supabase-backed"); process.exit(2); }
  if (!IDS.length) { console.error("--ids required"); process.exit(2); }
  const stories = await store.getStories();
  for (const id of IDS) {
    const s = stories.find(x => x.id === id);
    if (!s) { console.log(id + ": NOT FOUND — skipped (reported)"); continue; }
    if (s.status !== "published") { console.log(id + ": status " + s.status + " — refused (published only)"); continue; }
    const fr = service.freshness(s);
    if (fr.state === "approved") { console.log(id + ": already approved + fresh — not regenerated"); continue; }
    if (DRY) { console.log(id + ": would queue (" + fr.sourceRevision.slice(0, 19) + ")"); continue; }
    const r = await service.requestGeneration(s, { mode: "engine", actor: ACTOR });
    await audit.record({ action: "narration.generate.request", storyId: id, actor: ACTOR, generationId: r.job && r.job.id,
      sourceRevision: r.job && r.job.sourceRevision, detail: "published-archive backfill (owner instruction)" });
    console.log(id + ": " + (r.cached ? "cached (approved exists)" : (r.reused ? "already queued " : "queued ") + (r.job && r.job.id)));
  }
})().catch(e => { console.error("ENQUEUE_ERR", e.message); process.exit(1); });
