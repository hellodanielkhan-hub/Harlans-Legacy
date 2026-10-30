/* One import batch through the Admin API (the same endpoints the Editorial Workspace uses).

   1. Preflight, before any write: every post must be in the owner's approved manifest with the
      same content fingerprint, be a non-featured Draft, have photos numbered 1..n with photo 1 as
      Primary, and every local photo file must still match its recorded SHA-256. Every post must
      declare its photoMode: "photos" (1..n photos) or "none" (approved to import without any photo:
      a post that has none, or a text-only import whose images were excluded). A missing or unknown
      photoMode, "none" with photos listed, or "photos" with none listed fails closed. photoMode is
      part of the approval fingerprint. Any problem stops the batch with nothing written.
   2. Per post: create the Draft, upload its photos in order, read both back and verify (status,
      featured, title, text, photo files and order, Primary, and the SHA-256 of every stored photo
      through opts.readStoredPhoto). The first failure of any kind stops the batch.
   3. Only when EVERY post of the batch is verified does the batch send its one POST /api/build
      (with `defer`), and the ledger records "batch-built". A stopped batch never builds; its Drafts
      stay unpublished and invisible, and re-running the same batch resumes it.

   Resuming never duplicates: a Draft is created only after GET says the id is free; a Draft whose
   create answer was lost is adopted only if it is this post's own Draft; a photo already stored is
   never re-uploaded, and an existing gallery must be an exact prefix of the expected order.

   The transport is injected: transport(method, path, body, headers) -> { status, body }. Only the
   isolated tests pass one today; lib/api.js keeps production writes disabled. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const records = require(path.join(__dirname, "..", "..", "..", "lib", "records.js"));

const DEFER = { "x-defer-rebuild": "1" };
const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");

// Upload under the Facebook file name, without the local "NN__" order prefix (as the pilot did).
function uploadName(file) { return path.basename(file).replace(/^\d+__/, ""); }
// The stored file name the API derives from an upload name (api/[...path].js, story-photos POST).
function storedName(name) { return records.photoSlug(name) + (/\.png$/i.test(name) ? ".png" : ".jpg"); }

// Declared per post; there is no default. Anything else fails preflight.
const PHOTO_MODES = ["photos", "none"];

// Everything the owner approves for one post: what the website will show. Story ids are left out
// (they are assigned when a batch is planned); the post is identified by its Facebook post id.
function approvalFingerprint(it) {
  const r = it.record;
  return sha256(JSON.stringify({
    postId: it.postId, title: r.title, theme: r.theme, publishedISO: r.publishedISO, lead: r.lead, body: r.body,
    status: r.status, featured: !!r.featured, photoMode: it.photoMode === undefined ? null : it.photoMode,
    images: it.images.map(im => ({ order: im.order, primary: !!im.primary, sha256: im.sha256, name: uploadName(im.file) }))
  }));
}

class BatchStop extends Error {
  constructor(postId, step, detail) { super((postId ? postId + " " : "") + step + ": " + detail); this.postId = postId; this.step = step; }
}

function preflight(items, approved, readFile) {
  const problems = [];
  const ids = new Set(), posts = new Set();
  for (const it of items) {
    const p = msg => problems.push(it.postId + ": " + msg);
    if (posts.has(it.postId)) p("listed twice"); posts.add(it.postId);
    if (ids.has(it.record.id)) p("story id " + it.record.id + " used twice"); ids.add(it.record.id);
    if (!approved[it.postId]) { p("not in the approved manifest"); continue; }
    if (approved[it.postId] !== approvalFingerprint(it)) p("does not match its approved manifest entry");
    if (it.record.status !== "draft" || it.record.featured) p("must be a non-featured draft");
    const mode = it.photoMode;
    if (!PHOTO_MODES.includes(mode)) p(mode === undefined || mode === null ? "photoMode missing (must be \"photos\" or \"none\")" : "invalid photoMode " + JSON.stringify(mode) + " (must be \"photos\" or \"none\")");
    else if (mode === "none" && it.images.length) p("approved without photos but " + it.images.length + " photo(s) listed");
    else if (mode === "photos" && !it.images.length) p("approved with photos but none listed");
    it.images.forEach((im, i) => {
      if (im.order !== i + 1) p("photo order is not 1.." + it.images.length);
      if (!!im.primary !== (i === 0)) p("photo 1 must be the only Primary");
      let buf = null; try { buf = readFile(im.file); } catch (e) { p("photo " + im.order + " missing on disk"); }
      if (buf && sha256(buf) !== im.sha256) p("photo " + im.order + " changed on disk since approval");
    });
  }
  return problems;
}

async function runBatch(opts) {
  const { items, transport, ledger, defer, batchId } = opts;
  const readFile = opts.readFile || fs.readFileSync;
  if (!batchId) throw new Error("runBatch needs a batchId");
  const h = defer ? DEFER : {};
  const out = { batchId, posts: [], writes: 0, rebuilds: { triggered: 0, deferred: 0, other: 0 }, stopped: null, finalBuild: null };
  const tally = r => { const b = r.body && r.body.build && r.body.build.rebuild; if (b === "triggered") out.rebuilds.triggered++; else if (b === "deferred") out.rebuilds.deferred++; else out.rebuilds.other++; };
  const log = e => ledger.append(Object.assign({ batchId }, e));

  const readStored = opts.readStoredPhoto;   // async (storyId, galleryItem) -> Buffer of the stored original
  const problems = preflight(items, opts.approved || {}, readFile);
  if (typeof readStored !== "function" && items.some(it => it.images.length)) problems.push("no readStoredPhoto: the batch has photos and could not verify their stored bytes");
  if (problems.length) {
    out.stopped = { postId: null, step: "preflight", error: problems.join("; ") };
    log({ postId: null, step: "error", error: "preflight: " + out.stopped.error });
    out.finalBuild = { sent: false, reason: "batch stopped in preflight; nothing written" };
    return out;
  }

  const state = ledger.state();
  let current = null;
  try {
    for (const it of items) {
      current = it.postId;
      const id = it.record.id, mine = state[it.postId] || {};
      if (mine.verified && mine.storyId === id) { out.posts.push({ postId: it.postId, id, result: "already verified" }); continue; }

      const got = await transport("GET", "/api/stories/" + id);
      if (got.status === 404) {
        const r = await transport("POST", "/api/stories", it.record, h); out.writes++; tally(r);
        if (r.status !== 201) throw new BatchStop(it.postId, "create", r.status + " " + JSON.stringify(r.body).slice(0, 200));
        log({ postId: it.postId, step: "created", storyId: id });
      } else if (got.status === 200 && got.body && got.body.importSource && got.body.importSource.postId === it.postId && got.body.status === "draft") {
        if (mine.storyId !== id) log({ postId: it.postId, step: "created", storyId: id, adopted: true });   // create answered, answer lost
      } else {
        throw new BatchStop(it.postId, "create", got.status === 200 ? "id " + id + " already exists and is not this post's Draft" : "could not read id " + id + " (" + got.status + ")");
      }

      const want = it.images.map(im => storedName(uploadName(im.file)));
      const g0 = await transport("GET", "/api/story-photos/" + id);
      if (g0.status !== 200) throw new BatchStop(it.postId, "gallery read", String(g0.status));
      const have = (g0.body.items || []).map(x => x.file);
      if (!want.length && have.length) {
        throw new BatchStop(it.postId, "gallery check", "post is approved without photos but its gallery already holds [" + have.join(", ") + "]");
      }
      if (JSON.stringify(have) !== JSON.stringify(want.slice(0, have.length))) {
        throw new BatchStop(it.postId, "gallery check", "stored photos [" + have.join(", ") + "] are not the start of the approved order");
      }
      let uploaded = 0;
      for (const im of it.images.slice(have.length)) {
        const name = uploadName(im.file);
        const mime = /\.png$/i.test(name) ? "image/png" : "image/jpeg";
        const data = "data:" + mime + ";base64," + readFile(im.file).toString("base64");
        const r = await transport("POST", "/api/story-photos/" + id, { filename: name, data }, h); out.writes++; tally(r);
        if (r.status !== 201) throw new BatchStop(it.postId, "photo " + im.order, r.status + " " + JSON.stringify(r.body).slice(0, 200));
        log({ postId: it.postId, step: "image", storyId: id, order: im.order });
        uploaded++;
      }

      // Read back and check before calling the post done.
      const s = (await transport("GET", "/api/stories/" + id)).body || {};
      const g = (await transport("GET", "/api/story-photos/" + id)).body || { items: [] };
      const bad = [];
      if (s.status !== "draft") bad.push("status " + s.status);
      if (s.featured) bad.push("featured");
      if (s.title !== it.record.title) bad.push("title differs");
      if (s.lead !== it.record.lead || JSON.stringify(s.body) !== JSON.stringify(it.record.body)) bad.push("text differs");
      if (s.publishedISO !== it.record.publishedISO || s.theme !== it.record.theme) bad.push("date or category differs");
      if (JSON.stringify((g.items || []).map(x => x.file)) !== JSON.stringify(want)) bad.push("photos/order differ");
      if (want.length && (!g.items || !g.items[0] || g.primary !== g.items[0].id)) bad.push("Primary is not photo 1");
      if (!want.length && g.primary != null) bad.push("a Primary is set on a post that should have no photos");
      if (!bad.length) for (let i = 0; i < it.images.length; i++) {
        let buf; try { buf = await readStored(id, g.items[i]); } catch (e) { bad.push("photo " + (i + 1) + " stored bytes unreadable (" + String(e.message || e).slice(0, 80) + ")"); break; }
        if (!buf || sha256(buf) !== it.images[i].sha256) bad.push("photo " + (i + 1) + " stored bytes differ from the approved file");
      }
      if (bad.length) throw new BatchStop(it.postId, "verify", bad.join(", "));
      log({ postId: it.postId, step: "verified", storyId: id, photos: want.length, photoMode: it.photoMode });
      out.posts.push({ postId: it.postId, id, result: "verified", photosUploaded: uploaded, photos: want.length, photoMode: it.photoMode });
    }
  } catch (e) {
    out.stopped = { postId: e.postId || current, step: e.step || "transport", error: String(e.message || e) };
    try { log({ postId: out.stopped.postId, step: "error", error: out.stopped.error }); } catch (x) {}
  }

  // The one closing build: only when every post of this batch is verified, and only once per batch.
  if (out.stopped) {
    out.finalBuild = { sent: false, reason: "batch incomplete; no build. Drafts stay unpublished. Re-run the same batch to resume." };
  } else if (!defer) {
    out.finalBuild = { sent: false, reason: "not deferring: every write already rebuilt" };
  } else if (ledger.batchBuilt(batchId)) {
    out.finalBuild = { sent: false, reason: "this batch's build was already sent" };
  } else {
    let r;
    try { r = await transport("POST", "/api/build", {}); } catch (e) { r = { status: 0, body: { error: String(e.message || e) } }; }
    out.finalBuild = { sent: true, status: r.status, rebuild: r.body && r.body.rebuild };
    if (r.status === 200 && r.body && r.body.rebuild === "triggered") log({ postId: null, step: "batch-built", posts: items.length });
    else {
      out.stopped = { postId: null, step: "final build", error: "build request failed (HTTP " + r.status + (r.body && r.body.rebuild ? ", rebuild " + r.body.rebuild : "") + "); every post is verified, re-run to send the build" };
      log({ postId: null, step: "error", error: out.stopped.error });
    }
  }
  return out;
}

module.exports = { runBatch, preflight, approvalFingerprint, uploadName, storedName, DEFER, PHOTO_MODES };
