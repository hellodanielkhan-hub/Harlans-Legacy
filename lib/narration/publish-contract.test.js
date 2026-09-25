/* =========================================================================
   Automated test — publishing contract (run: node lib/narration/publish-contract.test.js)

   Proves the strict rule: a story may be published ONLY with an approved, fresh
   narration whose approved generation is intact. Every other state returns a
   blocking response with its specific code, and publishReadiness makes NO
   publication change (it is read-only; the synthetic stories are never saved and
   the test jobs are restored). Also asserts Blue Chair (214) is unchanged.
   Exits non-zero on any failure.
   ========================================================================= */
"use strict";
const svc = require("./service.js");
const jobs = require("./jobs.js");
const store = require("../store.js");
const { sourceRevision } = require("./text.js");

function storyWith(id, narration) {
  return { id, title: "Test " + id, status: "published", lead: "There was a chair in the corner of a quiet room.", body: ["A second paragraph carries the memory forward."], narration };
}

(async () => {
  const results = [];
  const expect = async (name, story, block, code) => { const pr = await svc.publishReadiness(story); results.push({ name, got: { block: pr.block, code: pr.code }, ok: pr.block === block && pr.code === code }); };

  // ---- states with NO job dependency (pure in-memory) ----
  await expect("missing", storyWith(9001, undefined), true, "narration_required");

  { const s = storyWith(9002, null); const rev = sourceRevision(s); s.narration = { status: "ready", voiceId: "harlan-v1", voiceVersion: "1", versions: [{ generationId: "g", status: "ready", sourceRevision: rev, integrity: { ok: true } }] }; await expect("ready/unapproved", s, true, "narration_approval_required"); }

  { const s = storyWith(9003, null); s.narration = { status: "approved", generationId: "g", voiceId: "harlan-v1", voiceVersion: "1", sourceRevision: "sha256:STALESTALESTALE", versions: [{ generationId: "g", status: "approved", sourceRevision: "sha256:STALESTALESTALE" }] }; await expect("outdated", s, true, "narration_stale"); }

  { const s = storyWith(9004, null); const rev = sourceRevision(s); s.narration = { status: "approved", generationId: "g", voiceId: "harlan-v1", voiceVersion: "1", sourceRevision: rev, versions: [{ generationId: "g", status: "superseded", sourceRevision: rev }] }; await expect("superseded", s, true, "narration_superseded"); }

  { const s = storyWith(9005, null); const rev = sourceRevision(s); s.narration = { status: "approved", generationId: "g", voiceId: "harlan-v1", voiceVersion: "1", sourceRevision: rev, duration: 5, versions: [{ generationId: "g", status: "approved", sourceRevision: rev, voiceId: "harlan-v1", voiceVersion: "1", audioUrl: "x", integrity: { ok: true } }] }; const pr = await svc.publishReadiness(s); results.push({ name: "approved+fresh (ALLOW)", got: { block: pr.block, code: pr.code, listening: pr.listening }, ok: pr.block === false && pr.code === null && pr.listening === true }); }

  // ---- states that need jobs (create + restore) ----
  const before = JSON.stringify(await store.getDoc("narration_jobs", { jobs: {} }));
  { const s = storyWith(9006, undefined); const rev = sourceRevision(s); await jobs.create({ storyId: 9006, sourceRevision: rev, voiceId: "harlan-v1", voiceVersion: "1", mode: "auto" }); await expect("processing", s, true, "narration_processing"); }
  { const s = storyWith(9007, undefined); const rev = sourceRevision(s); const r = await jobs.create({ storyId: 9007, sourceRevision: rev, voiceId: "harlan-v1", voiceVersion: "1", mode: "auto", force: true }); await jobs.update(r.job.id, { status: "failed", error: { code: "engine_not_configured" } }); await expect("failed", s, true, "narration_failed"); }
  await store.putDoc("narration_jobs", JSON.parse(before));   // restore — remove test jobs

  // ---- Blue Chair unchanged; no publication change occurred ----
  const bc = (await store.getStories()).find(s => s.id === 214);
  results.push({ name: "blue-chair unchanged", got: { status: bc.narration.status, gen: bc.narration.generationId }, ok: bc.narration.status === "approved" && bc.narration.generationId === "gen_4f94ce2febb7" });

  let failed = 0;
  results.forEach(r => { if (!r.ok) failed++; console.log((r.ok ? "PASS " : "FAIL ") + r.name.padEnd(24) + JSON.stringify(r.got)); });
  console.log(failed ? ("\n" + failed + " FAILED") : "\nALL PASS (" + results.length + ")");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
