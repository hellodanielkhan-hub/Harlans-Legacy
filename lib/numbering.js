/* =========================================================================
   Harlan's Legacy — Story Numbers (adopted 2026-10-31, "Scenario 2+")

   Three separate identifiers per memory:
     • storyNumber         the permanent, chronological Harlan's Legacy Story
                           Number shown to readers. Unique; never a retired number;
                           never derived from, or replaced by, the record id.
     • originalBlogNumber  the author's own Facebook issue number, when he stated
                           one. Historical reference only; may repeat (#388 twice).
     • id                  the internal database Record ID. Keys URLs, galleries,
                           narration folders and echoStories. Never shown as a
                           Story Number.

   What this public code knows (data/story-number-policy.json + data/story-number-
   assignments.json): the 56 retired numbers; that every other number below 448 is
   reserved for one historical weekly post; the approved Story / Original Blog
   Number of each of the 46 existing records (by record id); and that new posts
   start at 448. WHICH historical post owns a reserved number lives only in the
   private registry (outside the repository): the importer and the release tool
   check that locally (tools/story-numbers/lib/private-registry.js). The server
   therefore lets a reserved number go only to its approved record, or to a memory
   created by the Facebook importer. A saved number is permanent, and a number
   that was ever issued is never issued again.
   ========================================================================= */
"use strict";

// require() (not a computed fs path) so the serverless bundler always ships both files with the API.
const POLICY = require("../data/story-number-policy.json");
const ASSIGNMENTS = require("../data/story-number-assignments.json").assignments;
const ISSUED_DOC = "story_numbers";               // store doc: { issued: [n, …] } — every number ever saved
const IMPORT_SYSTEM = "facebook-shabbat-import";  // tools/facebook-import (lib/batch.js IMPORT_SYSTEM)

function policy() { return POLICY; }
function assignments() { return ASSIGNMENTS; }

const RETIRED = Object.freeze(POLICY.retired.slice());
const RETIRED_SET = new Set(RETIRED);
const FIRST_NEW_STORY_NUMBER = POLICY.firstNewStoryNumber;
const assignedById = new Map(assignments().map(a => [a.id, a]));
const assignedByNumber = new Map(assignments().map(a => [a.storyNumber, a]));

const isPositiveInt = v => Number.isInteger(v) && v > 0;

// Display helpers: a missing number is shown as nothing — never as the record id.
function storyNo(s) { return s && isPositiveInt(s.storyNumber) ? s.storyNumber : null; }
function blogNo(s) { return s && isPositiveInt(s.originalBlogNumber) ? s.originalBlogNumber : null; }

// Accepts a JSON value for storyNumber / originalBlogNumber.
// Returns { value } (a positive integer or null) or { error }.
function parseNumber(v, label) {
  if (v === null || v === undefined || v === "") return { value: null };
  const n = typeof v === "string" && /^s*d+s*$/.test(v) ? Number(v) : v;
  if (!isPositiveInt(n)) return { error: label + " must be a whole number greater than 0" };
  return { value: n };
}

function isRetired(n) { return RETIRED_SET.has(n); }
// A reserved historical number: below 448 and not retired (one per verified weekly post).
function isHistorical(n) { return isPositiveInt(n) && n < FIRST_NEW_STORY_NUMBER && !isRetired(n); }
// The approved number for this record id (data/story-number-assignments.json), or null.
function reservedForRecord(record) { const a = record && assignedById.get(record.id); return a ? a.storyNumber : null; }
function isImported(record) { return !!(record && record.importSource && record.importSource.system === IMPORT_SYSTEM); }

// Why `n` may not be given to `record`, or null when it may.
// `stories` = every current record; `issued` = every number ever saved.
function assignProblem(n, record, stories, issued) {
  if (!isPositiveInt(n)) return "Story Number must be a whole number greater than 0";
  if (isRetired(n)) return "Story No. " + n + " is retired and can never be used again";
  const other = (stories || []).find(s => s.storyNumber === n && (!record || s.id !== record.id));
  if (other) return "Story No. " + n + " already belongs to another memory";
  if (n < FIRST_NEW_STORY_NUMBER) {
    const mine = reservedForRecord(record);
    if (mine != null && mine !== n) return "Record " + record.id + "'s approved Story No. is " + mine;
    const owner = assignedByNumber.get(n);
    if (owner && (!record || owner.id !== record.id)) return "Story No. " + n + " is reserved for record " + owner.id;
    if (!owner && !isImported(record)) return "Story No. " + n + " is reserved for a historical weekly post; only that post's imported memory can take it";
  } else if ((issued || []).includes(n) && !(record && record.storyNumber === n)) {
    return "Story No. " + n + " was issued before and can never be used again";
  }
  return null;
}

// The next number for a genuinely new weekly post (or a late-discovered one,
// proposed for review): above every number in use or ever issued, never retired.
function nextNewStoryNumber(stories, issued) {
  let n = FIRST_NEW_STORY_NUMBER - 1;
  for (const s of stories || []) if (isPositiveInt(s.storyNumber)) n = Math.max(n, s.storyNumber);
  for (const v of issued || []) if (isPositiveInt(v)) n = Math.max(n, v);
  n++;
  while (isRetired(n)) n++;
  return n;
}

/* Checks a POST/PUT body against the rules. `existing` is null on create.
   Returns { problems: [...], storyNumber, originalBlogNumber } where the two
   numbers are the values to store (undefined = keep the existing value). */
function checkIncoming(body, existing, stories, issued) {
  const problems = [];
  const out = { problems, storyNumber: undefined, originalBlogNumber: undefined };
  const sn = parseNumber(body.storyNumber, "Story Number");
  const bn = parseNumber(body.originalBlogNumber, "Original Blog Number");
  if (sn.error) problems.push(sn.error);
  if (bn.error) problems.push(bn.error);
  if (problems.length) return out;

  const had = existing ? storyNo(existing) : null;
  if (body.storyNumber === undefined) {
    out.storyNumber = existing ? undefined : null;              // a save without the field never drops it
  } else if (had != null && sn.value !== had) {
    problems.push("Story No. " + had + " is permanent and cannot be changed or removed");
  } else if (sn.value != null && sn.value !== had) {
    // the record as it will be (id, importSource), but with its STORED number, so "already mine" means stored
    const probe = Object.assign({}, existing || {}, body, { storyNumber: had });
    const why = assignProblem(sn.value, probe, stories, issued);
    if (why) problems.push(why);
    out.storyNumber = sn.value;
  } else {
    out.storyNumber = had != null ? had : (existing ? undefined : null);
  }
  out.originalBlogNumber = body.originalBlogNumber === undefined ? (existing ? undefined : null) : bn.value;

  const finalNumber = out.storyNumber === undefined ? had : out.storyNumber;
  const wasPublished = existing && existing.status === "published";
  if (body.status === "published" && !wasPublished && finalNumber == null) {
    problems.push("A Story Number is required before a memory is published");
  }
  return out;
}

/* The controlled release: for each approved assignment, the only two fields it
   may write. Never touches id, status, featured, slug or content. */
function planRelease(stories) {
  const byId = new Map((stories || []).map(s => [s.id, s]));
  const writes = [], problems = [];
  for (const a of assignments()) {
    const s = byId.get(a.id);
    if (!s) { problems.push("record " + a.id + " is missing"); continue; }
    const have = storyNo(s);
    if (have != null && have !== a.storyNumber) { problems.push("record " + a.id + " already has Story No. " + have); continue; }
    const hadBlog = blogNo(s);
    if (hadBlog != null && hadBlog !== a.originalBlogNumber) { problems.push("record " + a.id + " already has Original Blog No. " + hadBlog); continue; }
    if (have === a.storyNumber && hadBlog === a.originalBlogNumber) continue;
    writes.push({ id: a.id, set: { storyNumber: a.storyNumber, originalBlogNumber: a.originalBlogNumber } });
  }
  return { writes, problems };
}

// Every number ever saved, from the store doc (missing doc = none yet).
function issuedList(doc) { return doc && Array.isArray(doc.issued) ? doc.issued.filter(isPositiveInt) : []; }
// The doc with these numbers added (sorted, unique); null when nothing new.
function withIssued(doc, numbers) {
  const have = new Set(issuedList(doc));
  const add = (numbers || []).filter(n => isPositiveInt(n) && !have.has(n));
  if (!add.length) return null;
  return { issued: [...have, ...new Set(add)].sort((a, b) => a - b), updatedAt: new Date().toISOString() };
}

/* Shared by the serverless API and the local server: validate a story write and
   settle the two number fields. `id` is the record id the write will use.
   Returns { problems, apply(story) } — apply() writes the settled values onto the
   normalized record (a save without the fields keeps the stored ones). */
function prepareWrite(body, existing, stories, issued, id) {
  const probe = Object.assign({}, body || {}, id != null ? { id } : {});
  const chk = checkIncoming(probe, existing || null, stories, issued);
  return {
    problems: chk.problems,
    apply(story) {
      story.storyNumber = chk.storyNumber === undefined ? storyNo(existing) : chk.storyNumber;
      story.originalBlogNumber = chk.originalBlogNumber === undefined ? blogNo(existing) : chk.originalBlogNumber;
      return story;
    }
  };
}

// Fingerprint of the approved assignment map, so a release names the exact map it applies.
function assignmentsFingerprint() {
  const rows = assignments().map(a => [a.id, a.storyNumber, a.originalBlogNumber == null ? null : a.originalBlogNumber]).sort((x, y) => x[0] - y[0]);
  return require("crypto").createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/* The whole release, checked: the planned writes, then every resulting number
   re-validated as if it were saved on its own (retired, duplicate, reserved). */
function checkRelease(stories) {
  const plan = planRelease(stories);
  if (plan.problems.length) return plan;
  const after = (stories || []).map(s => {
    const w = plan.writes.find(x => x.id === s.id);
    return w ? Object.assign({}, s, w.set) : s;
  });
  for (const w of plan.writes) {
    const why = assignProblem(w.set.storyNumber, after.find(x => x.id === w.id), after, []);
    if (why) plan.problems.push("record " + w.id + ": " + why);
  }
  return plan;
}

// "No. 447", or "" when the memory has no Story Number — never the record id.
function label(s, prefix) { const n = storyNo(s); return n == null ? "" : (prefix == null ? "No. " : prefix) + n; }

module.exports = {
  RETIRED, FIRST_NEW_STORY_NUMBER, ISSUED_DOC, IMPORT_SYSTEM,
  policy, assignments, storyNo, blogNo, parseNumber, isRetired, isHistorical,
  reservedForRecord, isImported,
  assignProblem, nextNewStoryNumber, checkIncoming, planRelease,
  issuedList, withIssued, prepareWrite, assignmentsFingerprint, checkRelease, label
};
