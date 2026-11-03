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

// Exactly one featured story: the This Week story, published. The separate Draft stays a Draft.
// No Story Number twice, none retired.
function invariantProblems(stories) {
  const problems = [];
  const featured = stories.filter(s => s.featured);
  if (featured.length !== 1 || featured[0].id !== FEATURED_ID || featured[0].status !== "published")
    problems.push("This Week must be record " + FEATURED_ID + " alone (featured: " + (featured.map(s => s.id + "/" + s.status).join(", ") || "none") + ")");
  const sep = stories.find(s => s.id === SEPARATE_DRAFT_ID);
  if (!sep || sep.status !== "draft") problems.push("record " + SEPARATE_DRAFT_ID + " must remain a Draft (is " + (sep ? sep.status : "missing") + ")");
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

/* Public pages, read from the live site after a build. */
function storyPageProblems(html, rec) {
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
  const n = numbering.storyNo(featured);
  return html.includes('class="tw-stamp">No.&nbsp;' + n + " ") ? [] : ["homepage: This Week does not show No. " + n];
}
function archivePageProblems(html, published) {
  return published.filter(s => !html.includes("No.&nbsp;" + numbering.storyNo(s) + "<br>")).map(s => "archive: record " + s.id + " does not show No. " + numbering.storyNo(s));
}

module.exports = { changedFields, compareStories, invariantProblems, mapProblems, releaseProblems, identityProblems, batch1Problems, publishProblems,
  photoProblems, storyPageProblems, homePageProblems, archivePageProblems };
