/* =========================================================================
   Harlan's Legacy — narration text/timing integrity (§6)

   Verifies that the aligner's word list corresponds EXACTLY to the source
   story words, in order. Generation must fail rather than publish mismatched
   timing data. Uses a simple LCS-style sequence diff so a single inserted or
   dropped word is reported precisely (not a cascade of false mismatches).
   ========================================================================= */
"use strict";

const { tokens, narrationText } = require("./text.js");

// Longest-common-subsequence length table walk → aligned ops.
function diff(a, b) {
  const n = a.length, m = b.length;
  // guard against pathological sizes (narration is a few hundred words)
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const missing = [], extra = []; let i = 0, j = 0, matched = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { matched++; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { missing.push({ i, w: a[i] }); i++; }   // in source, not timed
    else { extra.push({ j, w: b[j] }); j++; }                                        // timed, not in source
  }
  while (i < n) { missing.push({ i, w: a[i] }); i++; }
  while (j < m) { extra.push({ j, w: b[j] }); j++; }
  return { matched, missing, extra };
}

/* words: the aligner output [{i,w,start,end}, …]. story: the record.
   tolerance: allowed count of mismatched words (default 0 → exact). */
function check(story, words, tolerance) {
  tolerance = tolerance || 0;
  const src = tokens(narrationText(story));
  const timed = (words || []).map(w => String(w.w));
  const timedToks = tokens(timed.join(" "));
  const d = diff(src, timedToks);
  const mismatches = d.missing.length + d.extra.length;
  return {
    ok: mismatches <= tolerance,
    sourceWords: src.length,
    timedWords: timedToks.length,
    matchedWords: d.matched,
    missingWords: d.missing.slice(0, 25),      // in the story text but never spoken/timed
    duplicateWords: d.extra.slice(0, 25),      // timed but not in the story text (extra/duplicate)
    missingCount: d.missing.length,
    duplicateCount: d.extra.length,
    tolerance
  };
}

module.exports = { check, diff };
