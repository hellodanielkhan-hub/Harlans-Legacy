#!/usr/bin/env node
/* Builds the import-ready payload for one approved batch: runBatch() items (with photoMode) plus their
   approval fingerprints, planned with the importer's own plan() from the local manifest. Makes no
   network call and never changes the manifest or the Facebook source texts.

     node build-batch-payload.js --manifest <import/manifest.json> --approved <batch-NN-approved.json>
                                 --snapshot <site-snapshot.json> --out <batch-NN-import-payload.json>

   The approved file lists, per post, the exact website text, title, category and photos (order, Primary,
   SHA-256) the owner approved, plus the SHA-256 of the Facebook source text. Lines the owner left out of
   the website text (for example a hashtag line inside the text) are applied to the payload copy through
   the importer's removeLines, and only if the approved text is the planned text with whole lines removed.
   Any difference in text, title, category, photos, photoMode or source stops the build. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { plan } = require("./import.js");
const { approvalFingerprint, preflight, uploadName } = require("./lib/batch.js");

const arg = k => { const i = process.argv.indexOf("--" + k); if (i < 0 || !process.argv[i + 1]) { console.error("missing --" + k); process.exit(2); } return path.resolve(process.argv[i + 1]); };
const manifest = JSON.parse(fs.readFileSync(arg("manifest"), "utf8"));
const approved = JSON.parse(fs.readFileSync(arg("approved"), "utf8"));
const snapshotFile = arg("snapshot"), outFile = arg("out");
const snapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
const THEME = { "Funny Harlan Stories": "funny", "Grief and Memory": "grief", "Mom and Dad Stories": "momdad", "Toledo Childhood": "toledo", "Jewish Life / Shabbat": "shabbat", "Ordinary Moments": "ordinary" };
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const paragraphsOf = x => x.record ? [x.record.lead].concat(x.record.body) : [];

// The approved text must be the planned text with whole lines left out; returns those lines, or null.
function leftOut(planned, wanted) {
  const out = []; let j = 0;
  for (const p of planned) { if (j < wanted.length && p === wanted[j]) j++; else out.push(p); }
  return j === wanted.length ? out : null;
}

const ids = approved.postIds || approved.posts.map(p => p.postId);
const problems = [];
const base = ids.map(id => {
  const e = manifest.entries.find(x => x.postId === id);
  if (!e) { problems.push(id + ": not in the manifest"); return null; }
  return Object.assign({}, e, { approved: true, excludeImages: !!approved.posts.find(p => p.postId === id).excludeImages });
}).filter(Boolean);
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }

// Pass 1: plan as the manifest stands, and find the lines the owner left out of each approved text.
const corrections = {};
for (const x of plan({ entries: base }, snapshot, { assumeApproved: true }).items) {
  const a = approved.posts.find(p => p.postId === x.postId);
  const extra = leftOut(paragraphsOf(x), a.websiteText);
  if (extra === null) problems.push(x.postId + ": the approved text is not the planned text with whole lines removed");
  else if (extra.length) corrections[x.postId] = extra;
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }

// Pass 2: plan with those removals, then check every post against its approval.
const entries = base.map(e => corrections[e.postId] ? Object.assign({}, e, { removeLines: (e.removeLines || []).concat([...new Set(corrections[e.postId])]) }) : e);
const items = [], checks = [];
for (const x of plan({ entries }, snapshot, { assumeApproved: true }).items) {
  const a = approved.posts.find(p => p.postId === x.postId), e = entries.find(y => y.postId === x.postId);
  const bad = [];
  if (x.readiness !== "READY") bad.push("readiness " + x.readiness + ": " + x.reasons.join("; "));
  const paras = paragraphsOf(x);
  if (JSON.stringify(paras) !== JSON.stringify(a.websiteText)) bad.push("text differs from the approved website text");
  if (x.title !== a.title) bad.push("title differs");
  if (x.category !== THEME[a.category]) bad.push("category differs");
  const want = a.photos.map(p => [p.order, !!p.primary, path.basename(p.file), p.sha256].join("|")), got = x.images.map(im => [im.order, !!im.primary, path.basename(im.file), im.sha256].join("|"));
  if (JSON.stringify(want) !== JSON.stringify(got)) bad.push("photos differ from the approved photos");
  if (x.photoMode !== (a.photos.length ? "photos" : "none")) bad.push("photoMode " + x.photoMode + " vs " + a.photos.length + " approved photos");
  if (a.sourceTextSha256 && sha(e.sourceText) !== a.sourceTextSha256) bad.push("Facebook source text changed since approval");
  if (!a.sourceTextSha256) bad.push("approval has no source-text SHA-256");
  if (bad.length) problems.push(x.postId + ": " + bad.join(", "));
  const it = { postId: x.postId, photoMode: x.photoMode, images: x.images.map(im => ({ order: im.order, primary: im.primary, file: im.file, sha256: im.sha256 })), record: x.record };
  items.push(it);
  checks.push({ postId: x.postId, facebookDateChicago: x.facebookTimeChicago, provisionalStoryId: x.record && x.record.id, title: x.title, category: x.category, photoMode: x.photoMode,
    photos: it.images.map(im => ({ order: im.order, primary: im.primary, uploadName: uploadName(im.file), sha256: im.sha256 })),
    paragraphs: paras.length, removedLines: x.removedLines.map(r => ({ line: r.line, reason: r.reason })), leftOutPerApproval: corrections[x.postId] || [], ok: !bad.length });
}
if (items.map(i => i.postId).join(" ") !== ids.join(" ")) problems.push("order differs from the approved order: " + items.map(i => i.postId).join(" "));
const fingerprints = Object.fromEntries(items.map(it => [it.postId, approvalFingerprint(it)]));
preflight(items, fingerprints, f => fs.readFileSync(f)).forEach(p => problems.push("preflight: " + p));
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }

const out = {
  batch: approved.batch, status: "IMPORT-READY PAYLOAD - local only; not imported. Running it needs separate authorization.",
  built: new Date().toISOString(), plannedWith: "import.js plan() + lib/batch.js approvalFingerprint/preflight",
  snapshot: { file: path.basename(snapshotFile), maxExistingId: Math.max(...snapshot.memories.map(m => m.id)), memories: snapshot.memories.length },
  provisionalIds: "Story ids " + items[0].record.id + "-" + items[items.length - 1].record.id + " are provisional: they follow the snapshot and must be re-planned from a fresh GET-only snapshot immediately before any run.",
  counts: { posts: items.length, withPhotos: items.filter(i => i.photoMode === "photos").length, withoutPhotos: items.filter(i => i.photoMode === "none").length, photos: items.reduce((a, i) => a + i.images.length, 0) },
  leftOutPerApproval: corrections, preflight: "passed (fingerprints, Draft status, photoMode, photo order/Primary, photo SHA-256 on disk)",
  checks, approvedFingerprints: fingerprints, items
};
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ out: outFile, counts: out.counts, ids: items.map(i => i.postId).join(" "), leftOutPerApproval: corrections, provisionalIds: out.provisionalIds }, null, 1));
