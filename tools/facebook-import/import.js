#!/usr/bin/env node
/* Harlan's Legacy — Facebook Shabbat Shalom importer (DRY-RUN BUILD).

   node import.js dry-run --manifest <manifest.json> --snapshot <site-snapshot.json>
                          [--inventory <folder with inventory/posts.json>] [--out <runs dir>]
                          [--only P003,P005] [--assume-approved]

   dry-run   Reports exactly what would be created, in order, with the request bodies,
             image upload order (Primary first), duplicate checks and per-post readiness.
             Makes NO network calls. Writes a run folder: plan.json, status.csv, report.md, text-diffs.md.

   Not available in this build (each needs the owner's separate authorization):
     backup  GET-only snapshot of /api/stories, /api/story-photos, /api/site, /api/entities
     run     serial create (POST /api/stories) + image uploads (POST /api/story-photos/:id)
     verify  GET-only read-back of every ledger-created memory against the manifest */
"use strict";

const fs = require("fs");
const path = require("path");
const { toStory } = require("./lib/text.js");
const { buildRecord, THEMES } = require("./lib/record.js");
const { checkEntry, manifestRepeats } = require("./lib/dupes.js");
const { checkImages } = require("./lib/images.js");
const { Ledger } = require("./lib/ledger.js");

function args() {
  const a = { _: [] };
  for (let i = 2; i < process.argv.length; i++) {
    const t = process.argv[i];
    if (t.startsWith("--")) { const k = t.slice(2); const n = process.argv[i + 1]; if (!n || n.startsWith("--")) a[k] = true; else { a[k] = n; i++; } }
    else a._.push(t);
  }
  return a;
}

/* Pure planning step shared by dry-run and (later) run. No I/O except reading local image files. */
function plan(manifest, snapshot, opts) {
  opts = opts || {};
  const sourceTexts = opts.sourceTexts || {};
  const ledgerState = opts.ledgerState || {};
  const only = opts.only ? new Set(opts.only) : null;
  const protectedIds = new Set(snapshot.protectedIds || snapshot.memories.map(m => m.id));
  // New ids continue after every id already on the site AND every id this importer has created (ledger).
  const ledgerIds = Object.values(ledgerState).map(s => s.storyId).filter(id => id != null);
  let nextId = Math.max(...snapshot.memories.map(m => m.id), ...ledgerIds) + 1;

  const entries = manifest.entries
    .filter(e => !only || only.has(e.postId))
    .slice()
    .sort((a, b) => (a.facebookTimeChicago < b.facebookTimeChicago ? -1 : 1));   // oldest first

  const prepared = entries.map(entry => {
    const story = toStory(entry.sourceText, entry.title, { removeLines: entry.removeLines, titleIsHeading: entry.titleSource === "original title" });
    return { entry, ...story };
  });
  const repeats = manifestRepeats(prepared);

  const items = prepared.map(p => {
    const e = p.entry;
    const reasons = [], reviews = [];
    if (!e.title) reasons.push("no title");
    if (!THEMES.includes(e.category)) reasons.push("category missing/invalid");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.publishedISO || "")) reasons.push("story date missing");
    else if (new Date(e.publishedISO + "T12:00:00Z").getUTCDay() !== 5) reviews.push("story date is not a Friday");
    if (!p.paragraphs.length) reasons.push("no story text after removing hashtag lines");
    if (e.hold) reasons.push("on hold: " + e.flags.filter(f => /needs decision|repeats|full text|video|review before import/i.test(f)).join("; "));
    e.flags.filter(f => !/needs decision|repeats|full text|video|review before import/i.test(f)).forEach(f => reviews.push(f));
    p.suggestedRemovals.forEach(s => {
      if (/typos/.test(s.reason) && !e.keepFirstLine) reasons.push("decide opening tag line: remove (removeLines) or keep (keepFirstLine) — " + JSON.stringify(s.line));
      else reviews.push(s.reason + ": " + JSON.stringify(s.line));
    });
    if (p.inlineHashtags) reviews.push("hashtags inside a text line kept as written");
    if (p.candidates.length) reviews.push("punctuation candidates (not changed): " + p.candidates.map(c => `¶${c.paragraph} ${c.issue}`).join(", "));

    const dupes = checkEntry(e, p.paragraphs, snapshot.memories, sourceTexts);
    repeats.filter(r => r.a === e.postId || r.b === e.postId).forEach(r =>
      dupes.push({ kind: r.note ? "duplicate-title-in-manifest" : "repeat-in-manifest", severity: "review", detail: r.note || `${r.overlap}% shared with ${r.a === e.postId ? r.b : r.a}` }));
    if (dupes.some(d => d.severity === "block")) reasons.unshift("duplicate: " + dupes.filter(d => d.severity === "block").map(d => d.detail).join("; "));
    dupes.filter(d => d.severity === "review").forEach(d => reviews.push(d.kind + ": " + d.detail));

    // A text-only import (owner's editorial decision): every Facebook image stays out, nothing is uploaded.
    const excluded = e.excludeImages ? e.photos.files.length : 0;
    const img = e.excludeImages ? { files: [], problems: [] } : checkImages(e.photos.files, e.photos.expectedCount, e.photos.expectedIsEstimate);
    if (e.excludeImages) reviews.push("text-only import: " + excluded + " image(s) excluded by editorial decision");
    else if (e.photos.expectedCount > 0 && !e.photos.files.length) reasons.push(`photos not downloaded yet (Facebook shows ${e.photos.expectedCount}${e.photos.expectedIsEstimate ? ", estimated" : ""})`);
    else if (!e.photos.expectedCount && !e.photos.files.length && !e.photosConfirmedNone) {
      // Search capture can miss photos that were not rendered; a link preview or video is not a photo either.
      const media = /https?:\/\/|youtu|video|watch|click on the link/i.test(e.sourceText || "") ? " — text mentions a link/video" : "";
      reasons.push("no Facebook photo recorded: confirm on Facebook that the post has no photos" + media + " (set photosConfirmedNone)");
    }
    else img.problems.forEach(pr => (/missing file|not a JPEG|too large|appears twice|order gap/.test(pr) ? reasons : reviews).push(pr));

    const led = ledgerState[e.postId];
    let readiness;
    if (led && led.verified) readiness = "DONE";
    else if (reasons.some(r => r.startsWith("duplicate"))) readiness = "SKIP_DUPLICATE";
    else if (reasons.length) readiness = "BLOCKED";
    else if (!e.approved && !opts.assumeApproved) readiness = "READY_PENDING_APPROVAL";
    else readiness = led ? "RESUME" : "READY";

    let record = null, requests = [];
    if (readiness === "READY" || readiness === "READY_PENDING_APPROVAL" || readiness === "RESUME") {
      const id = led && led.storyId != null ? led.storyId : nextId++;
      if (protectedIds.has(id)) throw new Error(`planned id ${id} is an existing memory — refusing`);
      record = buildRecord(e, p.paragraphs, id);
      if (!(led && led.storyId != null)) requests.push({ method: "POST", path: "/api/stories", bytes: Buffer.byteLength(JSON.stringify(record.requestBody)), rebuild: true });
      img.files.forEach(f => {
        if (led && led.imagesDone.includes(f.order)) return;
        requests.push({ method: "POST", path: `/api/story-photos/${id}`, file: path.basename(f.path), order: f.order, primary: f.order === 1, bytes: f.base64Bytes + 64, rebuild: true });
      });
      requests.push({ method: "GET", path: `/api/stories/${id}`, rebuild: false }, { method: "GET", path: `/api/story-photos/${id}`, rebuild: false }, { method: "GET", path: `/api/narration/${id}`, rebuild: false });
    }
    return { postId: e.postId, facebookUrl: e.facebookUrl, facebookTimeChicago: e.facebookTimeChicago, publishedISO: e.publishedISO, title: e.title, category: e.category,
      readiness, reasons, reviews, duplicates: dupes, removedLines: p.removed, suggested: p.suggestedRemovals, paragraphs: p.paragraphs.length, titleLineRemoved: p.titleLineRemoved,
      photoMode: img.files.length ? "photos" : "none", imagesExcluded: excluded,
      images: img.files.map(f => ({ order: f.order, primary: f.order === 1, file: f.path, bytes: f.bytes, width: f.width, height: f.height, sha256: f.sha256 })),
      expectedPhotos: e.photos.expectedCount, expectedIsEstimate: e.photos.expectedIsEstimate,
      record: record && record.requestBody, storedPreview: record && record.storedPreview, requests };
  });
  return { items, repeats };
}

function csvCell(v) { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

function writeRun(outDir, result, meta) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "plan.json"), JSON.stringify({ meta, items: result.items }, null, 1));
  const cols = ["postId", "publishedISO", "readiness", "plannedId", "title", "category", "paragraphs", "images", "expectedPhotos", "writeRequests", "rebuilds", "reasons", "reviews"];
  const rows = result.items.map(i => [i.postId, i.publishedISO, i.readiness, i.record ? i.record.id : "", i.title, i.category, i.paragraphs, i.images.length,
    (i.expectedPhotos ?? "") + (i.expectedIsEstimate ? "~" : ""), i.requests.filter(r => r.method !== "GET").length, i.requests.filter(r => r.rebuild).length, i.reasons.join(" | "), i.reviews.join(" | ")].map(csvCell).join(","));
  fs.writeFileSync(path.join(outDir, "status.csv"), "﻿" + cols.join(",") + "\n" + rows.join("\n") + "\n");
  const diffs = result.items.map(i => `## ${i.postId} — ${i.title} (${i.publishedISO})\n` +
    (i.removedLines.length ? i.removedLines.map(r => `- removed (${r.reason}): \`${r.line.replace(/`/g, "'")}\``).join("\n") : "- nothing removed") +
    (i.suggested.length ? "\n" + i.suggested.map(s => `- **kept, needs a look** (${s.reason}): \`${s.line.replace(/`/g, "'")}\``).join("\n") : "") +
    `\n- paragraphs kept: ${i.paragraphs}\n`).join("\n");
  fs.writeFileSync(path.join(outDir, "text-diffs.md"), "# Text changes per post (only removals; wording is never edited)\n\n" + diffs);
}

function summarize(result, meta) {
  const by = {}; result.items.forEach(i => { by[i.readiness] = (by[i.readiness] || 0) + 1; });
  const reasonCount = {}; result.items.forEach(i => i.reasons.forEach(r => { const k = r.replace(/\(.*\)|: .*/g, "").trim(); reasonCount[k] = (reasonCount[k] || 0) + 1; }));
  const creatable = result.items.filter(i => i.record);
  const writes = creatable.reduce((n, i) => n + i.requests.filter(r => r.method !== "GET").length, 0);
  const photosAll = result.items.reduce((n, i) => n + (i.expectedPhotos || 0), 0);
  const lines = [
    `# Dry run — ${meta.started}`, "",
    `Manifest: ${meta.manifest}`, `Snapshot: ${meta.snapshot}`, `Network calls made: **0** (dry-run)`, "",
    "## Readiness", "", "| Readiness | Posts |", "|---|---|",
    ...Object.entries(by).map(([k, v]) => `| ${k} | ${v} |`), "",
    "## Why posts are blocked", "", "| Reason | Posts |", "|---|---|",
    ...Object.entries(reasonCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`), "",
    "## Duplicates found", "",
    ...(result.items.filter(i => i.readiness === "SKIP_DUPLICATE").map(i => `- ${i.postId} ${i.title}: ${i.reasons[0]}`).concat(["(none)"]).slice(0, Math.max(1, result.items.filter(i => i.readiness === "SKIP_DUPLICATE").length))), "",
    "## Repeats / review matches inside the manifest", "",
    ...(result.repeats.length ? result.repeats.map(r => `- ${r.a} ↔ ${r.b}${r.overlap != null ? ` (${r.overlap}% shared phrases)` : ""}${r.note ? " — " + r.note : ""}`) : ["(none)"]), "",
    "## Rebuild impact of the normal Admin save workflow", "",
    `- Posts that would be created now (ready, pending approval): ${creatable.length}; production write requests: ${writes}; each triggers one Vercel production build.`,
    `- Whole backlog once photos are downloaded: ≈ ${result.items.length} creates + ≈ ${photosAll} image uploads ≈ ${result.items.length + photosAll} builds.`, ""
  ];
  return lines.join("\n");
}

function main() {
  const a = args();
  const cmd = a._[0];
  if (cmd !== "dry-run") {
    console.error(cmd ? `"${cmd}" is not available in this dry-run build. Only "dry-run" is enabled.` : "usage: node import.js dry-run --manifest <file> --snapshot <file>");
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(a.manifest, "utf8"));
  const snapshot = JSON.parse(fs.readFileSync(a.snapshot, "utf8"));
  const sourceTexts = {};
  if (a.inventory) {
    for (const p of JSON.parse(fs.readFileSync(path.join(a.inventory, "inventory", "posts.json"), "utf8"))) {
      if (/^on website/.test(p.status)) sourceTexts[p.id] = p.text;
    }
  }
  const runsDir = a.out || path.join(path.dirname(a.manifest), "runs");
  const ledger = new Ledger(path.join(runsDir, "ledger.jsonl"));
  const started = new Date().toISOString();
  const result = plan(manifest, snapshot, { sourceTexts, ledgerState: ledger.state(), only: a.only ? String(a.only).split(",") : null, assumeApproved: !!a["assume-approved"] });
  const meta = { started, mode: "dry-run", manifest: a.manifest, snapshot: a.snapshot, networkCalls: 0 };
  const outDir = path.join(runsDir, "dry-run-" + started.replace(/[:.]/g, "-"));
  writeRun(outDir, result, meta);
  const summary = summarize(result, meta);
  fs.writeFileSync(path.join(outDir, "report.md"), summary);
  console.log(summary);
  console.log("\nRun folder: " + outDir);
}

if (require.main === module) main();
module.exports = { plan, summarize };
