/* Which hashtag-only lines may an import text contain?
   The importer (lib/text.js) removes hashtag-only lines only at the START and END of a post; a hashtag-only line
   inside the text is the author's text and is kept by design (e.g. "#HarlansLegacy #ShabbatShalom #255075" in the
   middle of P361). At the start or end, a hashtag-only line may remain ONLY when the owner approved keeping it
   (keepLines, exact line), e.g. a hashtag line that carries Hal's issue number ("#Week233") or a typo'd opening tag line.
   unapprovedHashtagLines() returns the hashtag-only lines at the start or end of the text that are NOT in keepLines:
   those mean the removal rule was skipped or the text was changed without approval. Interior lines are never returned. */
"use strict";
const HASHTAG_ONLY = /^\s*(#\S+\s*)+$/;

function unapprovedHashtagLines(paragraphs, keepLines) {
  const keep = new Set((keepLines || []).map(s => String(s).trim()));
  const p = (paragraphs || []).map(x => String(x == null ? "" : x));
  const out = [];
  let i = 0;
  for (; i < p.length && HASHTAG_ONLY.test(p[i]); i++) if (!keep.has(p[i].trim())) out.push({ index: i, position: "start", line: p[i] });
  for (let j = p.length - 1; j >= i && HASHTAG_ONLY.test(p[j]); j--) if (!keep.has(p[j].trim())) out.push({ index: j, position: "end", line: p[j] });
  return out;
}
module.exports = { unapprovedHashtagLines, HASHTAG_ONLY };
