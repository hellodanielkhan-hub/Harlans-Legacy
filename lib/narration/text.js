/* =========================================================================
   Harlan's Legacy — narration text model (pure, storage-agnostic)

   The single source of truth for "what gets narrated" for a story, plus the
   revision hash used to detect when narration has gone stale (§3, §6, §8).

   The spoken text is: lead + body paragraphs, in order — exactly the reader's
   prose. No SEO/summary fields are narrated. Tokenisation matches the alignment
   pipeline's word list so integrity checks line up (§6).
   ========================================================================= */
"use strict";

const crypto = require("crypto");

// The ordered paragraphs that are actually spoken.
function paragraphs(story) {
  const out = [];
  if (story && typeof story.lead === "string" && story.lead.trim()) out.push(story.lead.trim());
  (Array.isArray(story && story.body) ? story.body : []).forEach(p => {
    if (typeof p === "string" && p.trim()) out.push(p.trim());
  });
  return out;
}

// The full spoken text as one normalized string.
function narrationText(story) {
  return paragraphs(story).join("\n\n");
}

// Word tokens for integrity comparison. Lowercased, apostrophes normalized,
// punctuation stripped — the same shape a forced-aligner emits per word.
function tokens(text) {
  return String(text)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Split a paragraph into sentences (keeps terminal punctuation).
function sentences(paragraph) {
  const parts = [];
  let buf = "", ch = String(paragraph).split("");
  for (let i = 0; i < ch.length; i++) {
    buf += ch[i];
    if (/[.!?]/.test(ch[i])) {
      const nx = ch[i + 1] || "";
      if (/["'”’)]/.test(nx)) { buf += nx; i++; }
      parts.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

// A stable revision hash of the spoken text. Changes iff the narrated prose
// changes — this is the sourceRevision that invalidates stale narration (§8).
function sourceRevision(story) {
  const norm = tokens(narrationText(story)).join(" ");
  return "sha256:" + crypto.createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 24);
}

module.exports = { paragraphs, narrationText, tokens, sentences, sourceRevision };
