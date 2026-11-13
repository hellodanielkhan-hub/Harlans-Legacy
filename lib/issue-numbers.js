/* Issue numbers — the "Issue #N" shown in a story's date row.

   data/issue-numbers.json maps an internal record id to the issue number shown for that story. The number follows
   Hal Yaffe's weekly issue numbering (see the file's _about note). It is presentation data only:
     • it never changes a story's text, title, URL, date or record id;
     • it is separate from the calculated Story Number (lib/numbering.js), which stays hidden;
     • a record id is never shown in its place — a story without an entry simply shows no issue number.
   Correcting a number is an edit to the data file; no story is re-imported or republished.

   display: "on" shows the numbers on every build; "preview" shows them on Preview and local builds but not on
   Production builds (Vercel sets VERCEL_ENV=production there); "off" hides them everywhere.
   HL_ISSUE_NUMBERS_DISPLAY=on|preview|off overrides the file (tests and local checks). */
"use strict";

const DATA = require("../data/issue-numbers.json");
const MODES = ["on", "preview", "off"];

function mode() {
  const m = process.env.HL_ISSUE_NUMBERS_DISPLAY || DATA.display;
  return MODES.includes(m) ? m : "off";
}
function showing() {
  const m = mode();
  return m === "on" || (m === "preview" && process.env.VERCEL_ENV !== "production");
}
// The issue number to show for a story, or null.
function issueNo(s) {
  if (!s || !showing()) return null;
  const n = DATA.issues[String(s.id)];
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = { issueNo, showing, mode, data: () => DATA };
