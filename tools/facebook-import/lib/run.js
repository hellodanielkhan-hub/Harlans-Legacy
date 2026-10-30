/* One Production Draft import, start to finish. Nothing is written until every step before the final
   confirmation has passed:

   1. payload    every item matches its approval fingerprint; counts are reported
   2. backup     the local backup verifies (files, hashes, completeness) and is under 6 hours old
   3. authorize  interactive: batch identifier, payload fingerprint, hidden admin token (lib/authorize.js)
   4. snapshot   fresh read-only snapshot; every memory in the backup is unchanged; anything new since the
                 backup must be this batch's own import Draft (a resume)
   5. ids        allocated from the snapshot and the ledger (lib/snapshot.js), each fresh id answers 404
   6. confirm    the summary is shown and the typed phrase is required
   7. import     lib/batch.js runBatch over the live transport (Drafts only, deferred, one closing build)
   8. after      a second read-only snapshot: every pre-existing memory must be unchanged

   A stopped or interrupted run leaves the Drafts it created (unpublished, never on the site) and no build.
   Running the same command again resumes from the ledger without duplicating Drafts or photos. */
"use strict";

const fs = require("fs");
const { runBatch, preflight, approvalFingerprint, IMPORT_SYSTEM } = require("./batch.js");
const { Ledger } = require("./ledger.js");
const { createLiveTransport } = require("./transport.js");
const snap = require("./snapshot.js");
const { authorizeRun, confirmWrites, payloadFingerprint, batchIdOf } = require("./authorize.js");

function checkPayload(P, readFile) {
  const problems = [];
  if (!P || !Array.isArray(P.items) || !P.items.length) return { problems: ["payload has no items"] };
  for (const it of P.items) {
    let fp = null; try { fp = approvalFingerprint(it); } catch (e) { problems.push(e.message); continue; }
    if (!P.approvedFingerprints || P.approvedFingerprints[it.postId] !== fp) problems.push(it.postId + ": does not match its approval fingerprint");
  }
  preflight(P.items, P.approvedFingerprints || {}, readFile).forEach(p => problems.push(p));
  const counts = { posts: P.items.length, withPhotos: P.items.filter(i => i.photoMode === "photos").length,
    withoutPhotos: P.items.filter(i => i.photoMode === "none").length, photos: P.items.reduce((n, i) => n + i.images.length, 0) };
  return { problems, counts };
}

async function runProduction(o) {
  const say = o.io ? o.io.print : () => {};
  const P = JSON.parse(JSON.stringify(o.payload));           // ids are set on a copy; the approved file is never changed
  const batchId = batchIdOf(P);
  const result = { batchId, stage: "payload", stopped: null, ids: null, run: null, after: null };
  const stop = (stage, why) => { result.stage = stage; result.stopped = why; return result; };

  const pc = checkPayload(P, o.readFile || fs.readFileSync);
  if (pc.problems.length) return stop("payload", pc.problems.join("; "));
  result.counts = pc.counts;
  const fingerprint = payloadFingerprint(P);
  result.payloadFingerprint = fingerprint;

  const bk = snap.verifyBackup(o.backupDir, o.now);
  if (!bk.ok) return stop("backup", "backup does not verify: " + bk.problems.slice(0, 5).join("; "));
  if (!bk.fresh) return stop("backup", "backup is older than 6 hours; take a new one");

  let token;
  try { token = await authorizeRun(o.io, { batchId, payloadFingerprint: fingerprint, posts: pc.counts.posts, photos: pc.counts.photos }); }
  catch (e) { return stop("authorize", e.message); }

  const live = createLiveTransport({ base: o.base, token, fetch: o.fetch });
  token = null;
  try {
    result.stage = "snapshot";
    const before = await snap.takeSnapshot(live.transport, live.base);
    const ledger = new Ledger(o.ledgerPath);
    const state = ledger.state();
    const ownIds = new Set(Object.values(state).map(s => s.storyId).filter(Number.isInteger));
    const changed = snap.compareProtected(bk.snapshot, before);
    if (changed.length) return stop("snapshot", "the site changed since the backup: " + changed.join("; "));
    const known = new Set(bk.snapshot.memories.map(m => m.id));
    const postIds = new Set(P.items.map(it => it.postId));
    const isOwnDraft = m => m.status === "draft" && !m.featured && m.importSource && m.importSource.system === IMPORT_SYSTEM && postIds.has(m.importSource.postId);
    const extra = before.memories.filter(m => !known.has(m.id) && !ownIds.has(m.id) && !isOwnDraft(m));
    if (extra.length) return stop("snapshot", "memories added since the backup that this batch did not create: " + extra.map(m => m.id).join(", ") + "; take a new backup");

    result.stage = "ids";
    const alloc = snap.allocateIds(P.items, before, state);
    if (alloc.problems.length) return stop("ids", alloc.problems.join("; "));
    const busy = await snap.confirmFree(live.transport, alloc.fresh);
    if (busy.length) return stop("ids", "ids not free on a direct check: " + busy.join(", "));
    for (const it of P.items) it.record.id = alloc.ids[it.postId];
    live.allow(Object.values(alloc.ids));
    result.ids = alloc;

    result.stage = "confirm";
    const lines = ["", "Read-only checks passed. About to write to " + live.base + ":",
      "  " + pc.counts.posts + " Drafts (" + pc.counts.withPhotos + " with photos, " + pc.counts.withoutPhotos + " text-only), " + pc.counts.photos + " photos, then one build.",
      "  Story ids " + Math.min(...Object.values(alloc.ids)) + "-" + Math.max(...Object.values(alloc.ids)) + (alloc.reused.length ? " (" + alloc.reused.length + " resumed from the ledger)" : "") + ".",
      "  Snapshot " + before.takenAt + ": " + before.count + " memories, highest id " + before.maxId + ".",
      "  If the run stops, the Drafts already created stay unpublished and no build is sent; run the same command again to resume."];
    try { await confirmWrites(o.io, batchId, lines); } catch (e) { return stop("confirm", e.message); }

    result.stage = "import";
    result.run = await runBatch({ items: P.items, transport: live.transport, ledger, batchId, approved: P.approvedFingerprints, defer: true,
      snapshot: before, storedPhotoDigest: live.storedPhotoDigest, secrets: live.secrets() });
    if (result.run.stopped) result.stopped = "import stopped: " + result.run.stopped.postId + " " + result.run.stopped.step + ": " + result.run.stopped.error;

    result.stage = "after";
    const after = await snap.takeSnapshot(live.transport, live.base);
    result.after = { takenAt: after.takenAt, unchangedProblems: snap.compareProtected(bk.snapshot, after) };
    if (result.after.unchangedProblems.length) result.stopped = (result.stopped ? result.stopped + "; " : "") + "PRE-EXISTING MEMORIES CHANGED: " + result.after.unchangedProblems.join("; ");
    result.stage = "done";
    result.requests = live.requests();
    say(result.stopped ? "STOPPED: " + result.stopped : "Done: " + result.run.posts.length + " Drafts verified; build " + JSON.stringify(result.run.finalBuild));
    return result;
  } catch (e) {
    return stop(result.stage, String(e && e.message || e));
  } finally {
    live.close();
  }
}

module.exports = { runProduction, checkPayload };
