/* =========================================================================
   Carry the owner-approved 304 narration (gen_5c11198118da) into PRODUCTION
   byte-for-byte — NO regeneration, NO approval.
   1. production story 304 must exist, be published, and have the SAME
      sourceRevision as the approved version (identical text)
   2. upload the six generation files as Buffers (bytes unchanged) to
      listen/304/g/gen_5c11198118da/
   3. download every object back and require sha256 equality with the local file
   4. attach the version as READY (production approval stays with the owner's
      admin Preview) with production URLs; provenance recorded; audited
   Local files are only READ. Refuses anything unexpected.
     node tools/narration-backfill/carryover-304.cjs [--dry-run]
   ========================================================================= */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..", "..");
require(path.join(ROOT, "lib/loadenv.js"));
const store = require(path.join(ROOT, "lib/store.js"));
const assets = require(path.join(ROOT, "lib/narration/assets.js"));
const service = require(path.join(ROOT, "lib/narration/service.js"));
const audit = require(path.join(ROOT, "lib/narration/audit.js"));

const ID = 304, GEN = "gen_5c11198118da";
const SRC = path.join(ROOT, "assets", "listen", String(ID), "g", GEN);
const FILES = ["narration.mp3", "narration.words.json", "narration.sentences.json", "narration.paragraphs.json", "narration.treatment.json", "narration.zones.json"];
const DRY = process.argv.includes("--dry-run");
const ACTOR = { id: "claude-operator", name: "Claude (carry-over on owner instruction)", via: "backfill-script" };
const sha = b => crypto.createHash("sha256").update(b).digest("hex");

(async () => {
  if (!store.USE_SUPABASE) throw new Error("REFUSED: not Supabase-backed");
  const local = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "stories.json"), "utf8"));
  const lstory = (Array.isArray(local) ? local : local.stories).find(s => s.id === ID);
  const lv = lstory && (lstory.narration.versions || []).find(v => v.generationId === GEN);
  if (!lv || lv.status !== "approved" || !lv.integrity || !lv.integrity.ok) throw new Error("REFUSED: local approved version not found or not integrity-ok");
  const prod = (await store.getStories()).find(s => s.id === ID);
  if (!prod || prod.status !== "published") throw new Error("REFUSED: production story 304 missing or not published");
  const prodRev = service.sourceRevision(prod);
  if (prodRev !== lv.sourceRevision) throw new Error("REFUSED: production text revision " + prodRev + " != approved " + lv.sourceRevision);
  if ((service.record(prod).versions || []).some(v => v.generationId === GEN)) throw new Error("REFUSED: production already has " + GEN);

  const bufs = {}, hashes = {};
  for (const f of FILES) { bufs[f] = fs.readFileSync(path.join(SRC, f)); hashes[f] = sha(bufs[f]); }
  console.log("local approved files:", JSON.stringify(Object.fromEntries(FILES.map(f => [f, hashes[f].slice(0, 16) + " " + bufs[f].length + "B"]))));
  if (DRY) { console.log("dry run — revision matches (" + prodRev.slice(0, 19) + "); nothing written"); return; }

  const urls = await assets.writeAssets(ID, bufs, { subdir: "g/" + GEN });
  for (const f of FILES) {
    const back = await store.downloadObject(store.BUCKET_LISTEN, ID + "/g/" + GEN + "/" + f);
    if (sha(back) !== hashes[f]) throw new Error("VERIFY FAILED for " + f + " — version NOT attached");
  }
  console.log("production objects verified byte-identical (6/6)");

  const version = Object.assign({}, lv, {
    status: "ready",
    audioUrl: urls["narration.mp3"], wordsUrl: urls["narration.words.json"], sentencesUrl: urls["narration.sentences.json"],
    paragraphsUrl: urls["narration.paragraphs.json"], treatmentUrl: urls["narration.treatment.json"], zonesUrl: urls["narration.zones.json"],
    carriedOver: { from: "local dev store (owner-approved)", originalApprovedAt: lv.approvedAt, carriedAt: new Date().toISOString(),
      sha256: hashes, note: "Byte-identical copy of the owner-approved generation; production approval pending owner's admin Preview." }
  });
  delete version.approvedAt; delete version.approvedBy;
  await service.attachVersion(ID, version);
  await audit.record({ action: "narration.carryover", storyId: ID, actor: ACTOR, generationId: GEN, sourceRevision: lv.sourceRevision,
    detail: "byte-identical carry-over of owner-approved generation; attached as ready" });
  const after = (await store.getStories()).find(s => s.id === ID);
  const rec = service.record(after);
  console.log("attached:", JSON.stringify({ status: rec.status, versions: rec.versions.map(v => v.generationId + ":" + v.status) }));
})().catch(e => { console.error("CARRYOVER_ERR", e.message); process.exit(1); });
