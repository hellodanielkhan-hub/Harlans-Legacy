/* Duplicate / collision detection against the existing memories and within the manifest. */
"use strict";

const { norm } = require("./text.js");

function shingles(text, n) {
  const w = norm(text).split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i + n <= w.length; i++) set.add(w.slice(i, i + n).join(" "));
  return set;
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return common / Math.min(a.size, b.size);
}

/* existing: snapshot memories (+ optional full source text per memory via sourceTexts[postId]).
   Returns a list of { kind, severity, detail } for this entry. "block" = never create. */
function checkEntry(entry, paragraphs, existing, sourceTexts) {
  const hits = [];
  const lead = norm(paragraphs[0] || "");
  const text = paragraphs.join(" ");
  const sh = shingles(text, 5);
  for (const m of existing) {
    if (m.facebookPostId && m.facebookPostId === entry.postId) {
      hits.push({ kind: "same-facebook-post", severity: "block", detail: `already on the site as No. ${m.id}${m.status === "draft" ? " (Draft)" : ""}` });
      continue;
    }
    const ml = norm(m.lead);
    if (ml.length >= 30 && lead.startsWith(ml.slice(0, Math.min(ml.length, 80)))) {
      hits.push({ kind: "same-opening-text", severity: "block", detail: `opening matches No. ${m.id} "${m.title}"` });
    }
    if (norm(m.title) === norm(entry.title)) {
      hits.push({ kind: "same-title", severity: "review", detail: `title equals No. ${m.id}` });
    }
    if (m.publishedISO === entry.publishedISO) {
      hits.push({ kind: "same-date", severity: "review", detail: `story date equals No. ${m.id} (${m.publishedISO})` });
    }
    const src = sourceTexts && sourceTexts[m.facebookPostId];
    if (src) {
      const o = overlap(sh, shingles(src, 5));
      if (o >= 0.5) hits.push({ kind: "text-overlap", severity: "block", detail: `${Math.round(o * 100)}% of 5-word phrases shared with No. ${m.id}` });
    }
  }
  return hits;
}

// Within-manifest repeats (e.g. a later post reusing an earlier post's text).
function manifestRepeats(prepared) {
  const out = [];
  const sh = prepared.map(p => shingles(p.paragraphs.join(" "), 5));
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const o = overlap(sh[i], sh[j]);
      if (o >= 0.5) out.push({ a: prepared[i].entry.postId, b: prepared[j].entry.postId, overlap: Math.round(o * 100) });
    }
    if (prepared.filter(p => norm(p.entry.title) === norm(prepared[i].entry.title)).length > 1) {
      out.push({ a: prepared[i].entry.postId, b: "(title)", overlap: null, note: "duplicate proposed title" });
    }
  }
  return out;
}

module.exports = { checkEntry, manifestRepeats, overlap, shingles };
