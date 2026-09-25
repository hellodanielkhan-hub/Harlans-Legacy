/* =========================================================================
   Harlan's Legacy — derive sentence & paragraph timings from word timings (§4)

   Uses the ACTUAL aligned word start/end times (never text-length estimates).
   Source tokens are labelled with (paragraph, sentence); the label-carrying
   sequence alignment maps each timed word to its structural home, then we take
   min(start)/max(end) per sentence and per paragraph.
   ========================================================================= */
"use strict";

const { paragraphs, sentences, tokens } = require("./text.js");

// Build labelled source tokens: [{tok, p, s}] over paragraphs → sentences → words.
function labelledSource(story) {
  const labels = [];
  paragraphs(story).forEach((para, p) => {
    sentences(para).forEach((sent, s) => {
      tokens(sent).forEach(tok => labels.push({ tok, p, s }));
    });
  });
  return labels;
}

// Map each timed word to a source label via LCS alignment (robust to a stray word).
function mapWordsToLabels(story, words) {
  const src = labelledSource(story);
  const a = src.map(x => x.tok);
  const b = (words || []).map(w => tokens(String(w.w))[0] || String(w.w).toLowerCase());
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = new Array(m).fill(null);
  let i = 0, j = 0, last = { p: 0, s: 0 };
  while (i < n && j < m) {
    if (a[i] === b[j]) { last = { p: src[i].p, s: src[i].s }; out[j] = last; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { i++; }             // dropped source word
    else { out[j] = last; j++; }                                // extra timed word → inherit
  }
  while (j < m) { out[j] = last; j++; }
  return out;
}

function derive(story, words) {
  const labels = mapWordsToLabels(story, words);
  const sentMap = new Map();     // "p:s" → {p,s,start,end,wordStart,wordEnd}
  const paraMap = new Map();     // p → {p,start,end,wordStart,wordEnd}
  (words || []).forEach((w, j) => {
    const L = labels[j]; if (!L) return;
    const sk = L.p + ":" + L.s;
    if (!sentMap.has(sk)) sentMap.set(sk, { p: L.p, s: L.s, start: w.start, end: w.end, wordStart: j, wordEnd: j });
    else { const e = sentMap.get(sk); e.start = Math.min(e.start, w.start); e.end = Math.max(e.end, w.end); e.wordEnd = j; }
    if (!paraMap.has(L.p)) paraMap.set(L.p, { p: L.p, start: w.start, end: w.end, wordStart: j, wordEnd: j });
    else { const e = paraMap.get(L.p); e.start = Math.min(e.start, w.start); e.end = Math.max(e.end, w.end); e.wordEnd = j; }
  });
  const sents = [...sentMap.values()].sort((x, y) => x.start - y.start).map((e, i) => ({ i, start: +e.start.toFixed(3), end: +e.end.toFixed(3), wordStart: e.wordStart, wordEnd: e.wordEnd }));
  const paras = [...paraMap.values()].sort((x, y) => x.start - y.start).map((e, i) => ({ i, start: +e.start.toFixed(3), end: +e.end.toFixed(3), wordStart: e.wordStart, wordEnd: e.wordEnd }));
  const duration = (words && words.length) ? +words[words.length - 1].end.toFixed(3) : 0;
  return { sentences: sents, paragraphs: paras, duration };
}

module.exports = { derive, labelledSource, mapWordsToLabels };
