/* The controlled Story Number release and the Batch 1 publication: two SEPARATE operations, each its own
   interactive session with its own fresh backup and its own single write.

   Both start with the same checks, before anything can be written:
     1. the DEPLOYED code carries this checkout's assignment map (fingerprint);
     2. a fresh, complete snapshot + backup (every record, document and stored photo), verified;
     3. This Week = 405 alone, 404 a Draft, no duplicate or retired Story Number;
     4. Batch 1 identity: the approved payload (fingerprint), records 406–430 carrying its 25 posts one each,
        and every approved number tracing back to the private registry;
     5. every Batch 1 photo against the payload (count, SHA-256, order, Primary).

   releaseNumbers: one POST /api/story-numbers/release after a typed confirmation, then read-back: only
     the two number fields changed, every record as mapped. Nothing is published.
   publishBatch1:  requires the release to be complete and visible on the public site; one POST
     /api/stories/publish (exactly 406–430) after a typed confirmation, then read-back and public pages.

   Every step and every stop is appended to the ledger. A rerun is safe: an applied release has nothing
   to write, and a publication whose answer was lost is detected (all 25 already published) and verified
   instead of being sent again. Server writes are single store writes, so there is no partial state. */
"use strict";

const path = require("path");
const fs = require("fs");
const snapLib = require(path.join(__dirname, "..", "..", "facebook-import", "lib", "snapshot.js"));
const { canonical } = require(path.join(__dirname, "..", "..", "facebook-import", "lib", "batch.js"));
const numbering = require(path.join(__dirname, "..", "..", "..", "lib", "numbering.js"));
const verify = require("./verify.js");
const { BATCH_1_IDS, FEATURED_ID } = require("./batch1.js");

const RELEASE_PHRASE = n => "ASSIGN " + n + " STORY NUMBERS";
const PUBLISH_PHRASE = "PUBLISH 25 BATCH 1 STORIES";

async function getOk(live, p) {
  const r = await live.transport("GET", p);
  if (r.status !== 200) throw new Error("GET " + p + " answered HTTP " + r.status + (r.body && r.body.error ? ": " + r.body.error : ""));
  return r.body;
}

/* ---- public site (no token) ---- */
async function publicStories(fetchFn, origin) {
  const r = await fetchFn(origin + "/stories.js?v=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error("public stories.js answered HTTP " + r.status);
  const t = await r.text();
  const m = /window\.HL_STORIES = (\[[\s\S]*?\]);\s*\n\s*window\.HL_ARCHIVE/.exec(t);
  if (!m) throw new Error("public stories.js has no story list");
  return JSON.parse(m[1]);
}
async function publicPage(fetchFn, origin, rel) {
  const r = await fetchFn(origin + "/" + rel + (rel.includes("?") ? "&" : "?") + "v=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error("public " + rel + " answered HTTP " + r.status);
  return r.text();
}
async function verifyPublic(fetchFn, origin, expected) {
  const problems = [];
  const list = await publicStories(fetchFn, origin);
  const byId = new Map(list.map(s => [s.id, s]));
  for (const e of expected) {
    const p = byId.get(e.id);
    if (!p || !p.published) { problems.push("record " + e.id + " is not published on the public site"); continue; }
    const want = numbering.DISPLAY_STORY_NUMBERS ? e.storyNumber : null;      // nothing is shown while display is paused
    if (p.storyNumber !== want) { problems.push("record " + e.id + " shows Story No. " + p.storyNumber + " publicly, expected " + want); continue; }
    problems.push(...verify.storyPageProblems(await publicPage(fetchFn, origin, p.url), Object.assign({}, p, e)));
  }
  const featured = expected.find(e => e.id === FEATURED_ID);
  if (featured) problems.push(...verify.homePageProblems(await publicPage(fetchFn, origin, "index.html"), featured));
  problems.push(...verify.archivePageProblems(await publicPage(fetchFn, origin, "archive.html"), expected));
  return { problems, checked: expected.length };
}
async function waitForPublic(io, fetchFn, origin, expected, opts) {
  const tries = opts.publicTries == null ? 40 : opts.publicTries, waitMs = opts.publicWaitMs == null ? 30000 : opts.publicWaitMs;
  let last = null;
  for (let i = 0; i < tries; i++) {
    try { last = await verifyPublic(fetchFn, origin, expected); } catch (e) { last = { problems: [e.message] }; }
    if (!last.problems.length) return last;
    io.print("  public site not ready yet (" + last.problems.length + " open item(s), e.g. " + last.problems[0] + "); checking again…");
    if (i < tries - 1) await new Promise(r => setTimeout(r, waitMs));
  }
  return last;
}
const expectedPublic = stories => stories.filter(s => s.status === "published").map(s => ({ id: s.id, storyNumber: numbering.storyNo(s), slug: s.slug }));

// The data is written and verified, but the site will not change until it is rebuilt.
const buildNotTriggered = b => "the write is complete and verified, but the server did not trigger the site rebuild (" + JSON.stringify(b || null).slice(0, 300) +
  "). Start a rebuild from the Editorial Workspace, then check with verify-public. A rerun will not write again.";

/* ---- session scaffolding: every step and every stop goes to the ledger ---- */
function session(opts, operation) {
  const report = { operation, started: new Date().toISOString(), destination: opts.live.base, steps: [] };
  const step = (name, detail) => {
    report.steps.push(Object.assign({ step: name, at: new Date().toISOString() }, detail || {}));
    opts.ledger.append(Object.assign({ operation, step: name }, detail || {}));
    opts.io.print("✓ " + name + (detail && detail.summary ? " — " + detail.summary : ""));
  };
  const stop = (stage, why) => {
    opts.ledger.append({ operation, step: "stopped", stage, reason: String(why).slice(0, 2000) });
    return Object.assign(report, { stopped: why, stage, finished: new Date().toISOString() });
  };
  return { report, step, stop };
}

// Checks 1–5 (see the header). Returns { before, galleries, manifest } or { stopped }.
async function prepare(opts, s, operation) {
  const { live, payload, registry } = opts;
  if (live.operation !== operation) return { stopped: s.stop("setup", "the transport was not opened for " + operation) };
  if (!registry) return { stopped: s.stop("setup", "the private registry is required") };
  const info = await getOk(live, "/api/story-numbers");
  const fp = numbering.assignmentsFingerprint();
  if (info.assignmentsFingerprint !== fp) return { stopped: s.stop("deployed-map", "the deployed code's assignment map (" + info.assignmentsFingerprint + ") is not this checkout's (" + fp + ")") };
  s.step("deployed-map", { fingerprint: fp, summary: "the deployed code carries this map" });

  const snap = await snapLib.takeSnapshot(live.transport, live.base);
  const b = await snapLib.backup(live, snap, opts.backupDir);
  const vb = snapLib.verifyBackup(opts.backupDir);
  if (!vb.ok) return { stopped: s.stop("backup", "backup not verified: " + vb.problems.join("; ")) };
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.backupDir, "manifest.json"), "utf8"));
  s.step("backup", { dir: b.dir, counts: b.counts, summary: b.counts.memories + " records, " + b.counts.photos + " photos, " + b.counts.files + " files, verified" });

  const before = await getOk(live, "/api/stories");
  const galleries = await getOk(live, "/api/story-photos");
  // the backup must describe exactly the state the write will start from
  if (before.length !== b.counts.memories || before.some(r => !snap.memories.some(m => m.id === r.id && m.sha256 === snapLib.recordSha(r))))
    return { stopped: s.stop("backup", "a record changed after the backup; run again") };
  const inv = verify.invariantProblems(before);
  if (inv.length) return { stopped: s.stop("preconditions", inv.join("; ")) };
  const idp = verify.identityProblems(before, payload, registry, opts.payloadFingerprint);   // the CLI never sets it
  if (idp.length) return { stopped: s.stop("batch-1-identity", idp.join("; ")) };
  s.step("batch-1-identity", { summary: "records 406–430 carry the 25 approved posts; every approved number traces to the private registry" });
  const ph = verify.photoProblems(payload, before, galleries, manifest);
  if (ph.problems.length) return { stopped: s.stop("photos", ph.problems.join("; ")) };
  s.step("photos", { photos: ph.photos, textOnly: ph.textOnly, summary: ph.photos + " Batch 1 photos match the approved payload; " + ph.textOnly + " text-only posts have none" });
  return { before, galleries, manifest };
}

/* Operation 1: assign the 46 approved Story Numbers. Never publishes.
   opts: { live (operation "release"), io, ledger, backupDir, payload, registry } */
async function releaseNumbers(opts) {
  const s = session(opts, "release-numbers");
  try {
    const p = await prepare(opts, s, "release");
    if (p.stopped) return p.stopped;
    const { before, galleries } = p;
    const plan = numbering.checkRelease(before);
    if (plan.problems.length) return s.stop("plan", plan.problems.join("; "));
    if (!plan.writes.length) {
      const rp = verify.releaseProblems(before, before);
      if (rp.length) return s.stop("release-verify", rp.join("; "));
      s.step("release-already-applied", { summary: "all " + numbering.assignments().length + " numbers are already assigned exactly as mapped; nothing to write" });
      return Object.assign(s.report, { finished: new Date().toISOString() });
    }
    opts.io.print("\nThe release writes ONLY storyNumber and originalBlogNumber on " + plan.writes.length + " records:");
    for (const w of plan.writes) { const r = before.find(x => x.id === w.id); opts.io.print("  record " + w.id + "  →  Story No. " + w.set.storyNumber + (w.set.originalBlogNumber ? "  (Original Blog No. " + w.set.originalBlogNumber + ")" : "") + "  [" + r.status + "]"); }
    const phrase = RELEASE_PHRASE(plan.writes.length);
    const a = String(await opts.io.ask("\nType exactly \"" + phrase + "\" to write them: ") || "").trim();
    if (a !== phrase) return s.stop("release", "confirmation phrase not entered; nothing was written");
    opts.ledger.append({ operation: "release-numbers", step: "release-sent", writes: plan.writes.length });
    const r = await opts.live.transport("POST", "/api/story-numbers/release", { fingerprint: numbering.assignmentsFingerprint() });
    if (r.status !== 200) return s.stop("release", "release answered HTTP " + r.status + ": " + JSON.stringify(r.body).slice(0, 600) + " — rerun to check the state (a rerun never writes twice)");
    s.step("release", { written: r.body.written.length, build: r.body.build, summary: r.body.written.length + " records written in one store write; build " + (r.body.build && r.body.build.rebuild) });
    const after = await getOk(opts.live, "/api/stories");
    const rp = verify.releaseProblems(before, after);
    if (canonical(await getOk(opts.live, "/api/story-photos")) !== canonical(galleries)) rp.push("galleries changed during the release");
    if (rp.length) return s.stop("release-verify", rp.join("; "));
    s.step("release-verified", { summary: "every record as mapped; nothing else changed; This Week = record " + FEATURED_ID + "; record 404 a Draft; nothing published" });
    if (!r.body.build || r.body.build.rebuild !== "triggered") return s.stop("build", buildNotTriggered(r.body.build));
    return Object.assign(s.report, { finished: new Date().toISOString() });
  } catch (e) { return s.stop("error", e && e.message || e); }
}

/* Operation 2: publish exactly records 406–430. Requires the release to be complete and live.
   opts: { live (operation "publish"), io, ledger, backupDir, payload, registry, fetch, origin } */
async function publishBatch1(opts) {
  const s = session(opts, "publish-batch-1");
  const fetchFn = opts.fetch || globalThis.fetch, origin = opts.origin || opts.live.base;
  try {
    const p = await prepare(opts, s, "publish");
    if (p.stopped) return p.stopped;
    const { before, galleries } = p;
    const mp = verify.mapProblems(before);
    if (mp.length || numbering.checkRelease(before).writes.length) return s.stop("release-required", "the Story Number release is not complete — run release-numbers first: " + mp.slice(0, 5).join("; "));
    const statuses = new Set(BATCH_1_IDS.map(id => before.find(x => x.id === id).status));
    const already = statuses.size === 1 && statuses.has("published");
    if (!already) {
      const bp = verify.batch1Problems(before, "draft");
      if (bp.length) return s.stop("publish-preconditions", bp.join("; "));
      opts.io.print("\nChecking that the public site shows the new Story Numbers before publishing…");
      const pub0 = await waitForPublic(opts.io, fetchFn, origin, expectedPublic(before), opts);
      if (pub0.problems.length) return s.stop("public-numbers", "the public site does not show the new numbers yet: " + pub0.problems.slice(0, 5).join("; ") + " — run publish-batch-1 again later");
      s.step("public-numbers", { checked: pub0.checked, summary: pub0.checked + " published pages show their new Story Number" });
      opts.io.print("\nPublishing exactly these 25 approved Batch 1 records (status Draft → Published; nothing else changes):");
      for (const id of BATCH_1_IDS) opts.io.print("  record " + id + "  Story No. " + numbering.storyNo(before.find(x => x.id === id)));
      const a = String(await opts.io.ask("\nType exactly \"" + PUBLISH_PHRASE + "\" to publish them: ") || "").trim();
      if (a !== PUBLISH_PHRASE) return s.stop("publish", "confirmation phrase not entered; nothing was published");
      opts.ledger.append({ operation: "publish-batch-1", step: "publish-sent", ids: BATCH_1_IDS.slice() });
      const r = await opts.live.transport("POST", "/api/stories/publish", { ids: BATCH_1_IDS.slice() });
      if (r.status !== 200) return s.stop("publish", "publish answered HTTP " + r.status + ": " + JSON.stringify(r.body).slice(0, 600) + " — rerun to check the state (a rerun never publishes twice)");
      s.step("publish", { published: r.body.published, build: r.body.build, summary: r.body.published.length + " records published in one store write; build " + (r.body.build && r.body.build.rebuild) });
      const post = await getOk(opts.live, "/api/stories");
      const pp = verify.publishProblems(before, post);
      if (canonical(await getOk(opts.live, "/api/story-photos")) !== canonical(galleries)) pp.push("galleries changed during the publication");
      if (pp.length) return s.stop("publish-verify", pp.join("; "));
      s.step("publish-verified", { summary: "25 published with their Story Numbers; nothing else changed; This Week = record " + FEATURED_ID + "; record 404 a Draft" });
      if (!r.body.build || r.body.build.rebuild !== "triggered") return s.stop("build", buildNotTriggered(r.body.build));
    } else {
      const bp = verify.batch1Problems(before, "published");
      if (bp.length) return s.stop("publish-verify", bp.join("; "));
      s.step("publish-already-applied", { summary: "all 25 are already published with their Story Numbers; nothing to send" });
    }
    const now = already ? before : await getOk(opts.live, "/api/stories");
    opts.io.print("\nWaiting for the rebuilt public site to show every published page…");
    const pub1 = await waitForPublic(opts.io, fetchFn, origin, expectedPublic(now), opts);
    if (pub1.problems.length) return s.stop("public-final", "published, but the public site does not show everything yet: " + pub1.problems.slice(0, 5).join("; ") + " — check again with: node tools/story-numbers/release.js verify-public");
    s.step("public-final", { checked: pub1.checked, summary: pub1.checked + " published pages verified on the public site" });
    return Object.assign(s.report, { finished: new Date().toISOString() });
  } catch (e) { return s.stop("error", e && e.message || e); }
}

module.exports = { releaseNumbers, publishBatch1, verifyPublic, publicStories, expectedPublic, RELEASE_PHRASE, PUBLISH_PHRASE };
