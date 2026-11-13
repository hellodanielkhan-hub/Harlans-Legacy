/* Issue numbers — the one editorial number of a memory, shown to readers as "Issue #N".

   Source of truth (one value per story):
     1. the story record's own `issueNumber` field, set in the Admin Panel ("Issue Number") or by the importer:
          a positive whole number  -> that issue number
          null                     -> deliberately no issue number
     2. only when a record has NO `issueNumber` field at all: the approved historical map in
        data/issue-numbers.json (record id -> issue number). That map is frozen: it seeds the 397 historical stories
        published before the field existed, and is never edited for new posts. Saving a story in the Admin Panel
        writes its number onto the record, which from then on is the value used.
   The internal record id is never an issue number, and the old calculated Story Number (lib/numbering.js) is not
   an issue number either; neither is shown to readers.

   display ("on" / "preview" / "off" in the data file): whether story pages show the number. "preview" shows it on
   Preview and local builds only (Vercel sets VERCEL_ENV=production on Production builds).
   HL_ISSUE_NUMBERS_DISPLAY=on|preview|off overrides the file (tests and local checks). */
"use strict";

const DATA = require("../data/issue-numbers.json");
const MODES = ["on", "preview", "off"];
const SEED = DATA.issues || {};

const isIssue = v => Number.isInteger(v) && v > 0;

function mode() {
  const m = process.env.HL_ISSUE_NUMBERS_DISPLAY || DATA.display;
  return MODES.includes(m) ? m : "off";
}
function showing() {
  const m = mode();
  return m === "on" || (m === "preview" && process.env.VERCEL_ENV !== "production");
}

// The story's issue number (whatever the display setting), or null.
function effective(s) {
  if (!s) return null;
  if (Object.prototype.hasOwnProperty.call(s, "issueNumber")) return isIssue(s.issueNumber) ? s.issueNumber : null;
  const n = SEED[String(s.id)];
  return isIssue(n) ? n : null;
}
// Where the number comes from: "record" (its own field), "historical-map" (data/issue-numbers.json) or null.
function source(s) {
  if (!s) return null;
  if (Object.prototype.hasOwnProperty.call(s, "issueNumber")) return "record";
  return isIssue(SEED[String(s.id)]) ? "historical-map" : null;
}
// The number a public page shows, or null.
function issueNo(s) { return s && showing() ? effective(s) : null; }

// Accepts a JSON value for issueNumber: { value } (positive integer or null) or { error }.
function parse(v) {
  if (v === null || v === undefined || v === "") return { value: null };
  const n = typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
  if (!isIssue(n)) return { error: "Issue Number must be a whole number greater than 0" };
  return { value: n };
}

// Other memories that already carry issue number n (Hal sometimes repeated a number on purpose, so this warns, never blocks).
function usedBy(n, stories, exceptId) {
  if (!isIssue(n)) return [];
  return (stories || []).filter(s => s.id !== exceptId && effective(s) === n)
    .map(s => ({ id: s.id, title: s.title || "Untitled", status: s.status || "" }));
}

/* The issue number to suggest for a new post: the number of the most recent PUBLISHED memory (by story date) that
   has one, plus one. Not the record id, not a count of stories, not the highest number ever used (historical
   reconstructions or drafts never push it forward), so opening, saving or abandoning a draft never consumes or skips
   a number. Drafts already holding the suggested number are listed so the editor can see them. */
function suggestNext(stories) {
  const pub = (stories || []).filter(s => s.status === "published" && effective(s) != null)
    .sort((a, b) => String(b.publishedISO || "").localeCompare(String(a.publishedISO || "")) || b.id - a.id);
  const latest = pub[0] || null;
  if (!latest) return { next: null, latest: null, draftsUsingNext: [] };
  const next = effective(latest) + 1;
  return {
    next,
    latest: { issue: effective(latest), id: latest.id, title: latest.title || "Untitled", date: latest.publishedISO || null },
    draftsUsingNext: usedBy(next, stories, null).filter(x => x.status !== "published"),
  };
}

// Everything the Admin Panel needs: the suggestion and each memory's issue number (by record id).
function summary(stories) {
  const byId = {};
  for (const s of stories || []) { const n = effective(s); if (n != null) byId[s.id] = n; }
  return Object.assign(suggestNext(stories), { byId, display: mode() });
}

module.exports = { issueNo, effective, source, showing, mode, parse, usedBy, suggestNext, summary, data: () => DATA };
