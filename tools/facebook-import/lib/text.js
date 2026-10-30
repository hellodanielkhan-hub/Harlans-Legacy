/* Facebook post text -> website story paragraphs.

   Follows the convention the existing memories use (e.g. No. 303, 399, 403):
   standalone hashtag lines and "Week/Issue #" header lines are removed, a
   title line is removed when it IS the memory's title, and every remaining
   line becomes one paragraph. Wording is never changed: punctuation that
   looks accidental is only reported (candidates), never rewritten here. */
"use strict";

const TAG = /^#[\p{L}\p{N}_&'’.?!/-]+[.,]?$/u;
const NUMBER_HEADER = /^(?:harlan[’']s legacy\s*[—-]\s*)?(?:shabbat shalom\s*)?(?:blog\s+)?(?:week|issue|episode)\s*#?\s*\d{2,3}\b.{0,60}$/i;

function isHashtagLine(line) {
  // Split on whitespace and on dashes that stand alone ("#A — #B"); hyphens inside a tag (#Hal-a-daze) stay.
  const tokens = line.replace(/\s[—–-]+\s/g, " ").split(/\s+/).filter(Boolean);
  // "#Shabbat Shalom" (a tag typed with a space) still counts as a tag line.
  const ok = (t, i) => TAG.test(t) || /^[.,·|—–-]+$/.test(t) || (/^shalom[.,]?$/i.test(t) && i > 0 && /^#shabbat$/i.test(tokens[i - 1]));
  return tokens.length > 0 && tokens.every(ok) && tokens.some(t => TAG.test(t));
}

function isNumberHeader(line) {
  return line.length <= 80 && NUMBER_HEADER.test(line.trim());
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9'"]+/g, " ").trim();
}

// A first line that names the title, optionally behind "Shabbat Shalom –" or an issue number.
function isTitleLine(line, title) {
  if (!title) return false;
  const stripped = line
    .replace(/^shabbat shalom\s*[–—-]\s*/i, "")
    .replace(/^(?:blog\s+)?(?:week|issue|episode)\s*#?\s*\d{2,3}\s*[–—-]?\s*/i, "")
    .replace(/^\(|\)$/g, "");
  return norm(stripped) === norm(title) || norm(line) === norm(title);
}

function punctuationCandidates(paragraphs) {
  const found = [];
  paragraphs.forEach((p, i) => {
    const checks = [
      [/,{2,}/g, "repeated commas"],
      [/(?<![.])\.{2}(?!\.)/g, "double full stop"],
      [/\s+([,.;:!?])(?=\s|$)/g, "space before punctuation"],
      [/\*+/g, "stray asterisk"]
    ];                                  // double spaces are not reported: HTML collapses them
    for (const [re, label] of checks) {
      const m = p.match(re);
      if (m) found.push({ paragraph: i + 1, issue: label, count: m.length });
    }
  });
  return found;
}

// A first line that is probably all tags but has typos (#a#b, "# Tag", "#Stanley & Pat"). Never removed
// automatically: it is suggested, and removed only when the owner lists it in the entry's removeLines.
function isProbableTagLine(line) {
  const tags = (line.match(/#/g) || []).length;
  if (!/^#/.test(line) || tags < 2 || line.length > 70) return false;
  const words = line.replace(/#\s*[\p{L}\p{N}_&'’.,:?!/-]*/gu, " ").split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  return words.length <= 3 && !/[.!?]\s+\p{Lu}/u.test(line);
}

/* Returns { paragraphs, removed[], titleLineRemoved, inlineHashtags, candidates[], suggestedRemovals[] }.
   `removed` lists every dropped line with its reason, for the per-post diff.
   opts.removeLines: exact lines the owner approved for removal (e.g. a suggested typo'd tag line). */
function toStory(rawText, title, opts) {
  const approved = new Set(((opts && opts.removeLines) || []).map(s => s.trim()));
  let text = String(rawText || "").replace(/͏/g, "").replace(/\r/g, "");
  const removed = [];
  const tail = text.match(/\s*(?:…\s*)?See (?:less|more)\s*$/);
  if (tail) { removed.push({ line: tail[0].trim(), reason: "Facebook expand/collapse label" }); text = text.slice(0, tail.index); }

  let lines = text.split("\n").map(l => l.replace(/\s+$/, ""));
  const out = [];
  let leading = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (leading && isHashtagLine(line)) { removed.push({ line, reason: "standalone hashtag line" }); continue; }
    if (leading && isNumberHeader(line)) { removed.push({ line, reason: "Week/Issue number header" }); continue; }
    if (approved.has(line)) { removed.push({ line, reason: "approved removal (manifest removeLines)" }); continue; }
    leading = false;
    out.push(line);
  }
  while (out.length && isHashtagLine(out[out.length - 1])) removed.push({ line: out.pop(), reason: "trailing standalone hashtag line" });

  // Only a real heading is dropped (the post's own title, as in No. 303). When the title was derived
  // FROM the opening sentence, that sentence is story text and stays.
  let titleLineRemoved = false;
  if (opts && opts.titleIsHeading && out.length > 1 && isTitleLine(out[0], title)) {
    removed.push({ line: out.shift(), reason: "title line (used as the memory title)" });
    titleLineRemoved = true;
  }
  const inlineHashtags = out.some(l => /(^|\s)#[\p{L}\p{N}]/u.test(l));
  const suggestedRemovals = [];
  if (out.length > 1 && isProbableTagLine(out[0])) suggestedRemovals.push({ line: out[0], reason: "opening line looks like a hashtag line with typos — kept; approve removal via removeLines" });
  else if (out.length && /^#\S+/.test(out[0])) suggestedRemovals.push({ line: out[0].slice(0, 80), reason: "opening sentence begins with hashtags — kept as written" });
  return { paragraphs: out, removed, titleLineRemoved, inlineHashtags, candidates: punctuationCandidates(out), suggestedRemovals };
}

module.exports = { toStory, isHashtagLine, isProbableTagLine, isNumberHeader, isTitleLine, norm };
