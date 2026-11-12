/* Duplicate / collision detection against the existing memories and within the manifest. */
"use strict";

const { norm, isHashtagLine, isProbableTagLine, isNumberHeader } = require("./text.js");

// The opening that identifies a story: its first paragraph that is not only hashtags or a Week/Issue header. Hal's tag lines
// ("#HarlansLegacy #ShabbatShalom #Passover") are kept as written and repeat across many posts, so they
// must not make two different stories look like the same one.
function substantiveLead(paragraphs) {
  return (paragraphs || []).find(p => { const l = String(p || "").trim(); return l && !isHashtagLine(l) && !isProbableTagLine(l) && !isNumberHeader(l); }) || "";
}

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
/* An owner-approved distinct repost (entry.distinctRepostOf = { postId, record, originalFacebookUrl, originalDate, approval }):
   a SEPARATE Facebook post that revisits one named, already imported memory. It applies to that one memory only, and only
   when the two are verifiably different source posts (different post id, Facebook URL and date). Never for the same post. */
const URL_RE = /^https:\/\/www\.facebook\.com\/[^\s"<>]+$/, DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// The approval itself: a named memory, a recorded approval, and a source that differs from the original in id, URL and date.
function repostApprovalValid(entry) {
  const d = entry.distinctRepostOf;
  return !!(d && typeof d === "object" && !Array.isArray(d) && typeof d.approval === "string" && d.approval.trim()
    && typeof d.postId === "string" && d.postId && Number.isInteger(d.record) && d.record > 0 && entry.postId !== d.postId
    && URL_RE.test(entry.facebookUrl || "") && URL_RE.test(d.originalFacebookUrl || "") && entry.facebookUrl !== d.originalFacebookUrl
    && DATE_RE.test(entry.publishedISO || "") && DATE_RE.test(d.originalDate || "") && entry.publishedISO !== d.originalDate);
}
// ...and this memory is the one it names (same record AND same source post), with a different story date.
function isApprovedRepostOf(entry, m) {
  const d = entry.distinctRepostOf;
  return repostApprovalValid(entry) && m.id === d.record && !!m.facebookPostId && m.facebookPostId === d.postId && entry.publishedISO !== m.publishedISO;
}
// Memories the approval refers to (by record number or by source post) in this snapshot.
const namedBy = (entry, existing) => existing.filter(m => m.id === entry.distinctRepostOf.record || (m.facebookPostId && m.facebookPostId === entry.distinctRepostOf.postId));

function checkEntry(entry, paragraphs, existing, sourceTexts) {
  const hits = [];
  const lead = norm(substantiveLead(paragraphs));
  const text = paragraphs.join(" ");
  const sh = shingles(text, 5);
  if (entry.distinctRepostOf) {
    const named = repostApprovalValid(entry) ? namedBy(entry, existing) : null;
    if (!named || (named.length && !named.some(m => isApprovedRepostOf(entry, m))))
      hits.push({ kind: "distinct-repost-unverified", severity: "block", detail: "distinctRepostOf does not match a verified, distinct imported memory" });
    else if (!named.length)   // e.g. an older planning snapshot: nothing here to exempt, every normal check still applies
      hits.push({ kind: "distinct-repost-not-in-snapshot", severity: "review", detail: `the memory it revisits (No. ${entry.distinctRepostOf.record}) is not in this snapshot` });
  }
  for (const m of existing) {
    if (m.facebookPostId && m.facebookPostId === entry.postId) {
      hits.push({ kind: "same-facebook-post", severity: "block", detail: `already on the site as No. ${m.id}${m.status === "draft" ? " (Draft)" : ""}` });
      continue;
    }
    if (isApprovedRepostOf(entry, m)) {   // the one approved exception: overlap with this memory is reported, not blocking
      const ml = norm(substantiveLead([m.lead].concat(m.body || [])));
      const src = sourceTexts && sourceTexts[m.facebookPostId];
      const o = src ? overlap(sh, shingles(src, 5)) : 0;
      hits.push({ kind: "approved-distinct-repost", severity: "review", detail: `owner-approved distinct repost of No. ${m.id} (${m.facebookPostId})` +
        (o ? `: ${Math.round(o * 100)}% of 5-word phrases shared` : "") + (ml.length >= 30 && lead.startsWith(ml.slice(0, Math.min(ml.length, 80))) ? "; same opening" : "") });
      continue;
    }
    const ml = norm(substantiveLead([m.lead].concat(m.body || [])));
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

module.exports = { checkEntry, manifestRepeats, overlap, shingles, substantiveLead };
