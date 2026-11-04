/* Pure checks for the Story Number release and the Batch 1 publication. No network, no files.
   Every function returns a list of problems (empty = passed). */
"use strict";

const path = require("path");
const { canonical } = require(path.join(__dirname, "..", "..", "facebook-import", "lib", "batch.js"));
const { payloadFingerprint } = require(path.join(__dirname, "..", "..", "facebook-import", "lib", "authorize.js"));
const numbering = require(path.join(__dirname, "..", "..", "..", "lib", "numbering.js"));
const { BATCH_1_IDS, BATCH_1_PAYLOAD_FINGERPRINT, BATCH_1_PHOTOS, BATCH_1_TEXT_ONLY, FEATURED_ID, SEPARATE_DRAFT_ID } = require("./batch1.js");

const BOOKKEEPING = ["lastEditedBy", "lastEditedAt"];
const postOf = s => (s && s.importSource && s.importSource.postId) || null;

// Fields that differ between two versions of a record (canonical JSON per field).
function changedFields(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...keys].filter(k => canonical(a ? a[k] : undefined) !== canonical(b ? b[k] : undefined)).sort();
}

// Every record before must still exist after, changed only in the fields allowed for it; no new records.
function compareStories(before, after, allowedById) {
  const problems = [];
  const afterById = new Map(after.map(s => [s.id, s]));
  for (const b of before) {
    const a = afterById.get(b.id);
    if (!a) { problems.push("record " + b.id + " is missing"); continue; }
    const allowed = allowedById[b.id] || [];
    const bad = changedFields(b, a).filter(k => !allowed.includes(k));
    if (bad.length) problems.push("record " + b.id + ": unexpected change to " + bad.join(", "));
  }
  const ids = new Set(before.map(s => s.id));
  for (const a of after) if (!ids.has(a.id)) problems.push("record " + a.id + " appeared during the run");
  return problems;
}

// Exactly one featured story: the This Week story, published. Record 404 exists and is never featured; its
// status is the owner's (published by the owner in the Editorial Workspace on 2026-11-04). These tools never
// write it: it is a protected id, and every run requires it unchanged (compareStories).
// No Story Number twice, none retired.
function invariantProblems(stories) {
  const problems = [];
  const featured = stories.filter(s => s.featured);
  if (featured.length !== 1 || featured[0].id !== FEATURED_ID || featured[0].status !== "published")
    problems.push("This Week must be record " + FEATURED_ID + " alone (featured: " + (featured.map(s => s.id + "/" + s.status).join(", ") || "none") + ")");
  const sep = stories.find(s => s.id === SEPARATE_DRAFT_ID);
  if (!sep) problems.push("record " + SEPARATE_DRAFT_ID + " is missing");
  else if (sep.featured) problems.push("record " + SEPARATE_DRAFT_ID + " must not be featured");
  const nos = stories.map(numbering.storyNo).filter(n => n != null);
  const dup = nos.filter((n, i) => nos.indexOf(n) !== i);
  if (dup.length) problems.push("duplicate Story Numbers: " + [...new Set(dup)].join(", "));
  const retired = nos.filter(n => numbering.isRetired(n));
  if (retired.length) problems.push("retired Story Numbers in use: " + retired.join(", "));
  return problems;
}

// Every record carries exactly its approved numbers (the full 46-record map).
function mapProblems(stories) {
  const problems = [];
  const byId = new Map(stories.map(s => [s.id, s]));
  for (const a of numbering.assignments()) {
    const s = byId.get(a.id);
    if (!s) { problems.push("record " + a.id + " is missing"); continue; }
    if (numbering.storyNo(s) !== a.storyNumber) problems.push("record " + a.id + " has Story No. " + numbering.storyNo(s) + ", expected " + a.storyNumber);
    if (numbering.blogNo(s) !== (a.originalBlogNumber == null ? null : a.originalBlogNumber))
      problems.push("record " + a.id + " has Original Blog No. " + numbering.blogNo(s) + ", expected " + a.originalBlogNumber);
  }
  return problems;
}

// The release: only the two number fields (plus edit bookkeeping) on the mapped records, with the mapped values.
function releaseProblems(before, after) {
  const allowed = {};
  for (const a of numbering.assignments()) allowed[a.id] = ["storyNumber", "originalBlogNumber", ...BOOKKEEPING];
  return compareStories(before, after, allowed).concat(mapProblems(after), invariantProblems(after));
}

/* Batch 1 identity: the approved payload (by its fingerprint), and records 406–430 carrying exactly its 25
   posts, one each, each record's approved Story No. being its post's number in the private registry. */
// `expectedFingerprint` defaults to the approved payload's; only the local tests pass their synthetic one.
function identityProblems(stories, payload, registry, expectedFingerprint) {
  const want = expectedFingerprint || BATCH_1_PAYLOAD_FINGERPRINT;
  const problems = [];
  let fp = null;
  try { fp = payloadFingerprint(payload); } catch (e) { problems.push("payload unreadable: " + e.message); }
  if (fp && fp !== want) problems.push("payload fingerprint " + fp + " is not the approved Batch 1 payload");
  const items = (payload && payload.items) || [];
  if (items.length !== BATCH_1_IDS.length) problems.push("payload has " + items.length + " items, expected " + BATCH_1_IDS.length);
  const used = new Set();
  for (const id of BATCH_1_IDS) {
    const s = stories.find(x => x.id === id), post = postOf(s);
    if (!s) { problems.push("Batch 1 record " + id + " is missing"); continue; }
    if (!numbering.isImported(s) || !post) { problems.push("record " + id + " is not a Facebook-import record"); continue; }
    if (used.has(post)) problems.push("record " + id + " carries a post another Batch 1 record already carries");
    used.add(post);
    if (!items.some(it => it.postId === post)) problems.push("record " + id + " carries a post that is not in the approved payload");
    if (registry.sourceOfRecord(id) !== post) problems.push("record " + id + " is not the record the approved map was derived from");
    if (registry.numberFor(post) !== numbering.reservedForRecord(s)) problems.push("record " + id + ": its approved Story No. is not its post's registry number");
  }
  for (const it of items) if (!used.has(it.postId)) problems.push("an approved payload post is on none of records 406–430");
  return problems;
}

// Batch 1 records in `status`, non-featured, with their approved Story Number and a story date.
function batch1Problems(stories, status) {
  const problems = [];
  for (const id of BATCH_1_IDS) {
    const s = stories.find(x => x.id === id);
    if (!s) { problems.push("Batch 1 record " + id + " is missing"); continue; }
    if (s.status !== status) problems.push("record " + id + " is " + s.status + ", expected " + status);
    if (s.featured) problems.push("record " + id + " is featured");
    if (numbering.storyNo(s) == null || numbering.storyNo(s) !== numbering.reservedForRecord(s)) problems.push("record " + id + " has Story No. " + numbering.storyNo(s) + ", expected " + numbering.reservedForRecord(s));
    if (!s.publishedISO) problems.push("record " + id + " has no story date");
  }
  return problems;
}

// The publication: only `status` (draft -> published) and bookkeeping on the 25 records.
function publishProblems(before, after) {
  const allowed = {};
  for (const id of BATCH_1_IDS) allowed[id] = ["status", ...BOOKKEEPING];
  return compareStories(before, after, allowed).concat(batch1Problems(after, "published"), mapProblems(after), invariantProblems(after));
}

/* Every Batch 1 post's stored photos against the approved payload: same count, same SHA-256 in the same
   order, the same Primary; text-only posts have none. `galleries` = GET /api/story-photos;
   `backupManifest` = the backup's manifest.json (the server digest of every stored original). */
function photoProblems(payload, stories, galleries, backupManifest) {
  const problems = [];
  const items = (payload && payload.items) || [];
  const digests = new Map(((backupManifest && backupManifest.memories) || []).map(m => [m.id, m.gallery || []]));
  let photos = 0, textOnly = 0;
  for (const id of BATCH_1_IDS) {
    const s = stories.find(x => x.id === id), post = postOf(s);
    const it = items.find(x => x.postId === post);
    if (!it) { problems.push("record " + id + ": its post is not in the approved payload"); continue; }
    const want = [...(it.images || [])].sort((x, y) => x.order - y.order);
    const g = galleries["story-" + id] || { primary: null, items: [] };
    const have = (g.items || []).map(p => { const d = (digests.get(id) || []).find(x => x.id === p.id); return { id: p.id, sha256: d && d.serverSha256 }; });
    if (!want.length) {
      textOnly++;
      if (have.length) problems.push("record " + id + " is text-only but has " + have.length + " photo(s)");
      continue;
    }
    photos += want.length;
    if (have.length !== want.length) { problems.push("record " + id + ": " + have.length + " stored photo(s), expected " + want.length); continue; }
    want.forEach((w, i) => { if (have[i].sha256 !== w.sha256) problems.push("record " + id + " photo " + (i + 1) + ": stored SHA-256 " + (have[i].sha256 || "unknown") + " is not the approved " + w.sha256); });
    const wp = want.find(w => w.primary);
    const hp = have.find(h => h.id === g.primary);
    if (wp && (!hp || hp.sha256 !== wp.sha256)) problems.push("record " + id + ": the Primary photo is not the approved one");
  }
  if (!problems.length && (photos !== BATCH_1_PHOTOS || textOnly !== BATCH_1_TEXT_ONLY))
    problems.push(photos + " photos / " + textOnly + " text-only posts, expected " + BATCH_1_PHOTOS + " / " + BATCH_1_TEXT_ONLY);
  return { problems, photos, textOnly };
}

/* ---- Batches 02+ (publish-batch): the same checks, for the exact records one import batch created ---- */
const { approvalFingerprint, RECORD_FIELDS, IMPORT_SYSTEM, PROTECTED_IDS } = require(path.join(__dirname, "..", "..", "facebook-import", "lib", "batch.js"));
const { batchIdOf } = require(path.join(__dirname, "..", "..", "facebook-import", "lib", "authorize.js"));
const records = require(path.join(__dirname, "..", "..", "..", "lib", "records.js"));
const NEVER_BATCH_PUBLISHED = new Set([...PROTECTED_IDS, FEATURED_ID, ...BATCH_1_IDS]);

/* Which records this batch may publish: the approved payload (its fingerprint, every item's approval
   fingerprint), the import ledger's verified story id for each post of THIS batch, and exactly one live
   import record per post with that id. Returns { problems, targets: [{ postId, id }], state }, where
   state is "draft" (all Drafts: ready to publish), "published" (all published: a completed or resumed
   run) or "mixed". `importEntries` = the batch's import ledger lines (lib/ledger.js). */
function batchIdentityProblems(stories, payload, importEntries, expectedFingerprint) {
  const problems = [], targets = [];
  const items = (payload && payload.items) || [];
  if (!payload || !Number.isInteger(payload.batch) || payload.batch < 2) return { problems: ["the payload is not an import batch 02 or later (Batch 1 has its own operation, publish-batch-1)"], targets, state: null };
  const batchId = batchIdOf(payload);
  let fp = null;
  try { fp = payloadFingerprint(payload); } catch (e) { problems.push("payload unreadable: " + e.message); }
  if (!expectedFingerprint || fp !== expectedFingerprint) problems.push("payload fingerprint " + fp + " is not the approved fingerprint given for " + batchId);
  if (!items.length) problems.push("the payload has no posts");
  if (new Set(items.map(it => it.postId)).size !== items.length) problems.push("the payload lists a post twice");
  const approved = (payload && payload.approvedFingerprints) || {};
  for (const it of items) if (approved[it.postId] !== approvalFingerprint(it)) problems.push(it.postId + ": the item does not match its approval fingerprint (edited after approval)");
  // the import ledger: every post verified in THIS batch, and the batch's one closing build sent
  const mine = (importEntries || []).filter(e => e.batchId === batchId);
  if (!mine.some(e => e.step === "batch-built")) problems.push("the import ledger has no completed import (batch-built) for " + batchId);
  const verifiedId = {};
  for (const e of mine) if (e.step === "verified" && e.postId) verifiedId[e.postId] = e.storyId;
  for (const it of items) {
    const id = verifiedId[it.postId];
    if (!Number.isInteger(id)) { problems.push(it.postId + ": no verified import of this post in " + batchId); continue; }
    const claimants = stories.filter(s => s.importSource && s.importSource.system === IMPORT_SYSTEM && s.importSource.postId === it.postId);
    if (claimants.length !== 1) { problems.push(it.postId + ": " + claimants.length + " records carry this post (" + claimants.map(s => s.id).join(", ") + "), expected exactly 1"); continue; }
    const s = claimants[0];
    if (s.id !== id) { problems.push(it.postId + ": the record carrying it is " + s.id + ", but the import ledger verified " + id); continue; }
    if (NEVER_BATCH_PUBLISHED.has(id)) { problems.push("record " + id + " is protected, This Week or Batch 1 and is never batch-published"); continue; }
    if (s.featured) problems.push("record " + id + " is featured");
    if (numbering.storyNo(s) != null || numbering.blogNo(s) != null) problems.push("record " + id + " carries a Story Number or Original Blog Number (imports in Unnumbered Publishing Mode carry none)");
    if (!s.publishedISO) problems.push("record " + id + " has no story date");
    targets.push({ postId: it.postId, id });
  }
  if (new Set(targets.map(t => t.id)).size !== targets.length) problems.push("two posts point to the same record");
  const statuses = new Set(targets.map(t => stories.find(s => s.id === t.id).status));
  const state = statuses.size === 1 ? [...statuses][0] : statuses.size ? "mixed" : null;
  if (state !== "draft" && state !== "published") problems.push("the batch records are not all Drafts (or, after a completed run, all published): " + [...statuses].join(", "));
  return { problems, targets, state };
}

// Every approved field of every target record, as stored, equals the approved payload record (as the API
// normalizes it), apart from the record id (allocated at import) and the status.
function batchContentProblems(stories, payload, targets) {
  const problems = [];
  for (const t of targets) {
    const s = stories.find(x => x.id === t.id), it = payload.items.find(x => x.postId === t.postId);
    const expected = records.normalize(Object.assign({}, it.record, { id: t.id }));
    const bad = RECORD_FIELDS.filter(k => k !== "id" && k !== "status" && canonical(s[k]) !== canonical(expected[k]));
    if (bad.length) problems.push("record " + t.id + " (" + t.postId + "): " + bad.join(", ") + " differ from the approved payload");
  }
  return problems;
}

// Stored photos of every target against the payload: count, SHA-256 (server digest from the fresh backup)
// in the approved order, the approved Primary; text-only posts have none. Totals must match the payload.
function batchPhotoProblems(payload, targets, galleries, backupManifest) {
  const problems = [];
  const digests = new Map(((backupManifest && backupManifest.memories) || []).map(m => [m.id, m.gallery || []]));
  let photos = 0, textOnly = 0;
  for (const t of targets) {
    const it = payload.items.find(x => x.postId === t.postId);
    const want = [...(it.images || [])].sort((x, y) => x.order - y.order);
    const g = galleries["story-" + t.id] || { primary: null, items: [] };
    const have = (g.items || []).map(p => { const d = (digests.get(t.id) || []).find(x => x.id === p.id); return { id: p.id, sha256: d && d.serverSha256, ok: d && !d.error && d.backupSha256 === d.serverSha256 }; });
    if (!want.length) { textOnly++; if (have.length || g.primary != null) problems.push("record " + t.id + " is text-only but has a photo or Primary"); continue; }
    photos += want.length;
    if (have.length !== want.length) { problems.push("record " + t.id + ": " + have.length + " stored photo(s), expected " + want.length); continue; }
    want.forEach((w, i) => {
      if (have[i].sha256 !== w.sha256) problems.push("record " + t.id + " photo " + (i + 1) + ": stored SHA-256 " + (have[i].sha256 || "unknown") + " is not the approved " + w.sha256);
      else if (!have[i].ok) problems.push("record " + t.id + " photo " + (i + 1) + ": not fully backed up");
    });
    const wp = want.filter(w => w.primary);
    if (wp.length !== 1 || !want[0].primary) problems.push("record " + t.id + ": the approved payload does not make photo 1 the only Primary");
    if (g.primary !== (g.items[0] && g.items[0].id)) problems.push("record " + t.id + ": the stored Primary is not photo 1");
  }
  const c = (payload && payload.counts) || {};
  if (!problems.length && (photos !== c.photos || textOnly !== c.withoutPhotos)) problems.push(photos + " photos / " + textOnly + " text-only posts, the payload says " + c.photos + " / " + c.withoutPhotos);
  return { problems, photos, textOnly };
}

// The publication of a batch: only `status` (draft -> published) and bookkeeping on its records; every
// other record unchanged; the batch published and non-featured; This Week and record 404 as before.
function batchPublishProblems(before, after, targetIds) {
  const allowed = {};
  for (const id of targetIds) allowed[id] = ["status", ...BOOKKEEPING];
  const problems = compareStories(before, after, allowed).concat(invariantProblems(after));
  for (const id of targetIds) {
    const s = after.find(x => x.id === id);
    if (!s || s.status !== "published") problems.push("record " + id + " is " + (s ? s.status : "missing") + ", expected published");
    else if (s.featured) problems.push("record " + id + " became featured");
  }
  return problems;
}

/* Public pages, read from the live site after a build. */
// While Story Numbers are not displayed (Unnumbered Publishing Mode), the page must show NO number at all.
function unnumberedPageProblems(html, rec) {
  const problems = [];
  if (!html.includes('data-record-id="' + rec.id + '"')) problems.push("story " + rec.id + ": page is not from this build (no data-record-id)");
  if (!html.includes('data-story-id=""')) problems.push("story " + rec.id + ": the listening badge would show a number");
  if (html.includes("No.&nbsp;<b>")) problems.push("story " + rec.id + ": provenance shows a number");
  const footer = (/<div class="footer-bottom">([\s\S]*?)<\/div>/.exec(html) || [])[1] || "";
  if (/Story No\./.test(footer)) problems.push("story " + rec.id + ": footer shows a Story No.");
  if (/Story No\. \d+ of \d+/.test(html)) problems.push("story " + rec.id + ": still shows the old \"Story No. N of total\" line");
  if (/class="(tw-stamp|tw-kicker|arc-date|xc-meta|st-meta|cp-label)">[^<]*No\.(&nbsp;| )\d/.test(html)) problems.push("story " + rec.id + ": a card or label shows a number");
  return problems;
}
function storyPageProblems(html, rec) {
  if (!numbering.DISPLAY_STORY_NUMBERS) return unnumberedPageProblems(html, rec);
  const n = numbering.storyNo(rec), problems = [];
  if (n == null) return ["record " + rec.id + " has no Story Number"];
  if (!html.includes('data-record-id="' + rec.id + '"')) problems.push("story " + rec.id + ": page is not from this build (no data-record-id)");
  if (!html.includes('data-story-id="' + n + '"')) problems.push("story " + rec.id + ": listening badge would not show No. " + n);
  if (!html.includes("No.&nbsp;<b>" + n + "</b>")) problems.push("story " + rec.id + ": provenance does not show No. " + n);
  if (!html.includes("Story No. " + n + "<")) problems.push("story " + rec.id + ": footer does not show Story No. " + n);
  if (/Story No\. \d+ of \d+/.test(html)) problems.push("story " + rec.id + ": still shows the old \"Story No. N of total\" line");
  if (rec.id !== n && html.includes("No.&nbsp;<b>" + rec.id + "</b>")) problems.push("story " + rec.id + ": shows the record id as a Story Number");
  return problems;
}
function homePageProblems(html, featured) {
  if (!numbering.DISPLAY_STORY_NUMBERS) return /class="(tw-stamp|tw-kicker)">[^<]*No\.(&nbsp;| )\d/.test(html) || html.includes('class="ai-nos"') ? ["homepage shows a Story Number"] : [];
  const n = numbering.storyNo(featured);
  return html.includes('class="tw-stamp">No.&nbsp;' + n + " ") ? [] : ["homepage: This Week does not show No. " + n];
}
function archivePageProblems(html, published) {
  if (!numbering.DISPLAY_STORY_NUMBERS) return /class="arc-date">No\./.test(html) ? ["archive cards show Story Numbers"] : [];
  return published.filter(s => !html.includes("No.&nbsp;" + numbering.storyNo(s) + "<br>")).map(s => "archive: record " + s.id + " does not show No. " + numbering.storyNo(s));
}

module.exports = { changedFields, compareStories, invariantProblems, mapProblems, releaseProblems, identityProblems, batch1Problems, publishProblems,
  photoProblems, storyPageProblems, homePageProblems, archivePageProblems,
  batchIdentityProblems, batchContentProblems, batchPhotoProblems, batchPublishProblems };
