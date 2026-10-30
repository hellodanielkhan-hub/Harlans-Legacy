/* One import batch through the Admin API (the same endpoints the Editorial Workspace uses).

   1. Preflight, before any request is sent. Any problem stops the batch with nothing written:
      - Every item has only known fields (item, record, importSource, photo); unknown fields are refused.
      - Every post is in the owner's approved list with the same fingerprint. The fingerprint covers the
        complete canonical import record (every record field except the provisional id), the photo
        mode and every photo's file name, order, Primary flag and SHA-256, serialized deterministically.
      - Every record is a non-featured Draft from this importer, for this post.
      - photoMode is declared: "photos" (1..n photos) or "none" (approved to import without any photo).
        Missing or unknown, "none" with photos, or "photos" without photos fails closed.
      - Photos are numbered 1..n, photo 1 is the only Primary, every local file matches its SHA-256.
      - Deferred rebuild mode is required (opts.defer === true). There is no other mode.
      - Protected ids: no item may use an id in PROTECTED_IDS (fixed here, never read from a payload),
        nor any id occupied in the fresh read-only snapshot (opts.snapshot) unless the snapshot shows
        it is this importer's own Draft for this same post (a resumed batch).
      - A batch with photos needs opts.storedPhotoDigest to verify the stored bytes.
   2. Per post: create the Draft (only after GET says the id is free, or adopt this post's own Draft),
      upload its photos in order, read everything back and verify: every record field as stored,
      photo files and order, Primary, and the SHA-256 of every stored photo. Every read-back must
      answer HTTP 200. The first failure of any kind stops the batch.
   3. Only when EVERY post is verified does the batch send its one POST /api/build, and the ledger
      records "batch-built". A stopped batch never builds; its Drafts stay unpublished, and re-running
      the same batch resumes it without duplicates.

   The transport is injected: transport(method, path, body, headers) -> { status, body }. Only the
   isolated rehearsals pass one today; lib/api.js keeps production writes disabled. Messages that reach
   the ledger or the result are scrubbed of opts.secrets and of anything that looks like a credential. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const records = require(path.join(__dirname, "..", "..", "..", "lib", "records.js"));
const { scrub } = require("./secrets.js");

const DEFER = Object.freeze({ "x-defer-rebuild": "1" });
const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");

// Existing memories the importer must never touch, whatever a payload or snapshot says:
// Nos. 303-305 and 388-403 (the live memories) and the pilot Draft No. 404.
const PROTECTED_IDS = Object.freeze([303, 304, 305, ...Array.from({ length: 16 }, (_, i) => 388 + i), 404]);
const IMPORT_SYSTEM = "facebook-shabbat-import";
const SNAPSHOT_MAX_AGE_MS = 6 * 3600 * 1000;

// The complete set of fields an import item may carry (lib/record.js buildRecord + the batch fields).
const ITEM_FIELDS = ["postId", "photoMode", "images", "record"];
const RECORD_FIELDS = ["id", "title", "slug", "status", "featured", "theme", "publishedISO", "dateLong", "dateLabel", "memoryDate", "summary", "description", "ogDescription",
  "lead", "body", "people", "places", "objects", "events", "bookPart", "keywords", "echoStories", "readingTime", "readerImages", "importSource"];
const IMPORT_SOURCE_FIELDS = ["system", "postId", "facebookUrl", "facebookTimeChicago"];
const IMAGE_FIELDS = ["order", "primary", "file", "sha256"];
const PHOTO_MODES = ["photos", "none"];

// Upload under the Facebook file name, without the local "NN__" order prefix (as the pilot did).
function uploadName(file) { return path.basename(file).replace(/^\d+__/, ""); }
// The stored file name the API derives from an upload name (api/[...path].js, story-photos POST).
function storedName(name) { return records.photoSlug(name) + (/\.png$/i.test(name) ? ".png" : ".jpg"); }

// Deterministic JSON: object keys sorted at every level; undefined values dropped.
function canonical(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(x => canonical(x) === undefined ? "null" : canonical(x)).join(",") + "]";
  return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

const unknownKeys = (obj, allowed) => (obj && typeof obj === "object" && !Array.isArray(obj) ? Object.keys(obj).filter(k => !allowed.includes(k)) : []);

// Structural problems with one item (unknown fields at any level, wrong types). Empty = well formed.
function itemProblems(it) {
  const out = [];
  if (!it || typeof it !== "object" || Array.isArray(it)) return ["item is not an object"];
  unknownKeys(it, ITEM_FIELDS).forEach(k => out.push("unknown item field " + JSON.stringify(k)));
  if (typeof it.postId !== "string" || !it.postId) out.push("postId missing");
  const r = it.record;
  if (!r || typeof r !== "object" || Array.isArray(r)) return out.concat(["record missing"]);
  unknownKeys(r, RECORD_FIELDS).forEach(k => out.push("unknown record field " + JSON.stringify(k)));
  if (!Number.isInteger(r.id) || r.id <= 0) out.push("record.id must be a positive integer");
  const src = r.importSource;
  if (!src || typeof src !== "object" || Array.isArray(src)) out.push("record.importSource missing");
  else {
    unknownKeys(src, IMPORT_SOURCE_FIELDS).forEach(k => out.push("unknown importSource field " + JSON.stringify(k)));
    if (src.system !== IMPORT_SYSTEM) out.push("importSource.system must be " + JSON.stringify(IMPORT_SYSTEM));
    if (src.postId !== it.postId) out.push("importSource.postId does not match the post");
  }
  if (!Array.isArray(it.images)) out.push("images must be a list");
  else it.images.forEach((im, i) => {
    if (!im || typeof im !== "object" || Array.isArray(im)) { out.push("photo " + (i + 1) + " is not an object"); return; }
    unknownKeys(im, IMAGE_FIELDS).forEach(k => out.push("unknown photo field " + JSON.stringify(k)));
    if (typeof im.file !== "string" || !/^[0-9a-f]{64}$/.test(String(im.sha256))) out.push("photo " + (i + 1) + " needs a file and a SHA-256");
  });
  return out;
}

// Everything the owner approves for one post: the complete canonical import record (all fields except the
// provisional story id, which is re-planned from a fresh snapshot), the photo mode and every photo.
// Throws on a malformed item, so an unknown field can never be fingerprinted around.
function approvalFingerprint(it) {
  const bad = itemProblems(it);
  if (bad.length) throw new Error("cannot fingerprint " + (it && it.postId) + ": " + bad.join("; "));
  const record = Object.assign({}, it.record); delete record.id;
  return sha256(canonical({
    v: 2, postId: it.postId, photoMode: it.photoMode === undefined ? null : it.photoMode, record,
    images: it.images.map(im => ({ order: im.order, primary: !!im.primary, sha256: im.sha256, name: uploadName(im.file) }))
  }));
}

// A batch item from an import.js plan() item: only the fields a batch accepts.
function toBatchItem(x) {
  return { postId: x.postId, photoMode: x.photoMode, images: (x.images || []).map(im => ({ order: im.order, primary: !!im.primary, file: im.file, sha256: im.sha256 })), record: x.record };
}

class BatchStop extends Error {
  constructor(postId, step, detail) { super((postId ? postId + " " : "") + step + ": " + detail); this.postId = postId; this.step = step; }
}

function preflight(items, approved, readFile) {
  const problems = [];
  const ids = new Set(), posts = new Set();
  if (!Array.isArray(items) || !items.length) return ["no items"];
  for (const it of items) {
    const p = msg => problems.push((it && it.postId) + ": " + msg);
    const shape = itemProblems(it);
    if (shape.length) { shape.forEach(p); continue; }
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

// Ids the batch must not use: the fixed PROTECTED_IDS, plus every id the fresh snapshot shows as occupied,
// except this importer's own Draft for the same post (so an interrupted batch can resume).
function protectionProblems(items, snapshot, now) {
  const problems = [];
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.memories)) return ["no fresh read-only snapshot (opts.snapshot with memories) - cannot rule out occupied ids"];
  const taken = Date.parse(snapshot.takenAt);
  if (!Number.isFinite(taken)) problems.push("snapshot has no valid takenAt time");
  else if (now - taken > SNAPSHOT_MAX_AGE_MS || taken - now > 5 * 60 * 1000) problems.push("snapshot is not fresh (taken " + snapshot.takenAt + "); take a new read-only snapshot");
  const occupied = new Map();
  for (const m of snapshot.memories) {
    if (!m || !Number.isInteger(m.id)) { problems.push("snapshot entry without an integer id"); continue; }
    occupied.set(m.id, m);
  }
  for (const it of items) {
    const id = it.record.id;
    if (PROTECTED_IDS.includes(id)) { problems.push(it.postId + ": id " + id + " is a protected existing memory"); continue; }
    const m = occupied.get(id);
    if (m && !(m.status === "draft" && !m.featured && m.importSource && m.importSource.system === IMPORT_SYSTEM && m.importSource.postId === it.postId)) {
      problems.push(it.postId + ": id " + id + " is occupied in the snapshot by a memory that is not this post's own import Draft");
    }
  }
  return problems;
}

async function runBatch(opts) {
  opts = opts || {};
  const { items, transport, ledger, batchId } = opts;
  const readFile = opts.readFile || fs.readFileSync;
  const secrets = Array.isArray(opts.secrets) ? opts.secrets : [];
  const clean = s => scrub(s, secrets);
  if (!batchId) throw new Error("runBatch needs a batchId");
  const out = { batchId, posts: [], writes: 0, rebuilds: { triggered: 0, deferred: 0, other: 0 }, stopped: null, finalBuild: null };
  const tally = r => { const b = r.body && r.body.build && r.body.build.rebuild; if (b === "triggered") out.rebuilds.triggered++; else if (b === "deferred") out.rebuilds.deferred++; else out.rebuilds.other++; };
  const cleanDeep = v => typeof v === "string" ? clean(v) : Array.isArray(v) ? v.map(cleanDeep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanDeep(x)])) : v;
  const log = e => ledger.append(cleanDeep(Object.assign({ batchId }, e)));
  const digest = opts.storedPhotoDigest;   // async (storyId, galleryItem) -> { status, body: { file, sha256 } } for the stored original

  let problems = preflight(items, opts.approved || {}, readFile);
  if (opts.defer !== true) problems.push("deferred rebuild mode is required (defer: true); a batch never rebuilds per write");
  if (!problems.length) problems = problems.concat(protectionProblems(items, opts.snapshot, Date.now()));
  if (!problems.length && typeof digest !== "function" && items.some(it => it.images.length)) problems.push("no storedPhotoDigest: the batch has photos and could not verify their stored bytes");
  if (problems.length) {
    out.stopped = { postId: null, step: "preflight", error: clean(problems.join("; ")) };
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
      if (PROTECTED_IDS.includes(id)) throw new BatchStop(it.postId, "protected", "id " + id + " is protected");   // belt and braces
      if (mine.verified && mine.storyId === id) { out.posts.push({ postId: it.postId, id, result: "already verified" }); continue; }

      const got = await transport("GET", "/api/stories/" + id);
      if (got.status === 404) {
        const r = await transport("POST", "/api/stories", it.record, DEFER); out.writes++; tally(r);
        if (r.status !== 201) throw new BatchStop(it.postId, "create", r.status + " " + JSON.stringify(r.body).slice(0, 200));
        log({ postId: it.postId, step: "created", storyId: id });
      } else if (got.status === 200 && got.body && got.body.importSource && got.body.importSource.system === IMPORT_SYSTEM && got.body.importSource.postId === it.postId && got.body.status === "draft" && !got.body.featured) {
        if (mine.storyId !== id) log({ postId: it.postId, step: "created", storyId: id, adopted: true });   // create answered, answer lost
      } else {
        throw new BatchStop(it.postId, "create", got.status === 200 ? "id " + id + " already exists and is not this post's Draft" : "could not read id " + id + " (" + got.status + ")");
      }

      const want = it.images.map(im => storedName(uploadName(im.file)));
      const g0 = await transport("GET", "/api/story-photos/" + id);
      if (g0.status !== 200 || !g0.body) throw new BatchStop(it.postId, "gallery read", String(g0.status));
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
        const r = await transport("POST", "/api/story-photos/" + id, { filename: name, data }, DEFER); out.writes++; tally(r);
        if (r.status !== 201) throw new BatchStop(it.postId, "photo " + im.order, r.status + " " + JSON.stringify(r.body).slice(0, 200));
        log({ postId: it.postId, step: "image", storyId: id, order: im.order });
        uploaded++;
      }

      // Read back and check before calling the post done. Every read must answer 200.
      const sr = await transport("GET", "/api/stories/" + id);
      if (sr.status !== 200 || !sr.body) throw new BatchStop(it.postId, "verify", "story read-back answered HTTP " + sr.status);
      const gr = await transport("GET", "/api/story-photos/" + id);
      if (gr.status !== 200 || !gr.body) throw new BatchStop(it.postId, "verify", "gallery read-back answered HTTP " + gr.status);
      const s = sr.body, g = gr.body, bad = [];
      const expected = records.normalize(Object.assign({}, it.record));
      if (s.id !== id) bad.push("id differs");
      for (const k of RECORD_FIELDS) if (k !== "id" && canonical(s[k]) !== canonical(expected[k])) bad.push(k + " differs");
      if (JSON.stringify((g.items || []).map(x => x.file)) !== JSON.stringify(want)) bad.push("photos/order differ");
      if (want.length && (!g.items || !g.items[0] || g.primary !== g.items[0].id)) bad.push("Primary is not photo 1");
      if (!want.length && g.primary != null) bad.push("a Primary is set on a post that should have no photos");
      if (!bad.length) for (let i = 0; i < it.images.length; i++) {
        let d;
        try { d = await digest(id, g.items[i]); } catch (e) { bad.push("photo " + (i + 1) + " stored bytes unreadable (" + String(e.message || e).slice(0, 80) + ")"); break; }
        if (!d || d.status !== 200 || !d.body) { bad.push("photo " + (i + 1) + " stored-bytes read-back answered HTTP " + (d && d.status)); break; }
        if (d.body.file !== g.items[i].file) bad.push("photo " + (i + 1) + " read-back is for another file");
        else if (d.body.sha256 !== it.images[i].sha256) bad.push("photo " + (i + 1) + " stored bytes differ from the approved file");
      }
      if (bad.length) throw new BatchStop(it.postId, "verify", bad.join(", "));
      log({ postId: it.postId, step: "verified", storyId: id, photos: want.length, photoMode: it.photoMode });
      out.posts.push({ postId: it.postId, id, result: "verified", photosUploaded: uploaded, photos: want.length, photoMode: it.photoMode });
    }
  } catch (e) {
    out.stopped = { postId: e.postId || current, step: e.step || "transport", error: clean(String(e.message || e)) };
    try { log({ postId: out.stopped.postId, step: "error", error: out.stopped.error }); } catch (x) {}
  }

  // The one closing build: only when every post of this batch is verified, and only once per batch.
  if (out.stopped) {
    out.finalBuild = { sent: false, reason: "batch incomplete; no build. Drafts stay unpublished. Re-run the same batch to resume." };
  } else if (ledger.batchBuilt(batchId)) {
    out.finalBuild = { sent: false, reason: "this batch's build was already sent" };
  } else {
    let r;
    try { r = await transport("POST", "/api/build", {}); } catch (e) { r = { status: 0, body: { error: clean(String(e.message || e)) } }; }
    out.finalBuild = { sent: true, status: r.status, rebuild: r.body && r.body.rebuild };
    if (r.status === 200 && r.body && r.body.rebuild === "triggered") log({ postId: null, step: "batch-built", posts: items.length });
    else {
      out.stopped = { postId: null, step: "final build", error: "build request failed (HTTP " + r.status + (r.body && r.body.rebuild ? ", rebuild " + r.body.rebuild : "") + "); every post is verified, re-run to send the build" };
      log({ postId: null, step: "error", error: out.stopped.error });
    }
  }
  return out;
}

module.exports = { runBatch, preflight, protectionProblems, approvalFingerprint, itemProblems, toBatchItem, canonical, uploadName, storedName,
  DEFER, PHOTO_MODES, PROTECTED_IDS, RECORD_FIELDS, ITEM_FIELDS, IMAGE_FIELDS, IMPORT_SOURCE_FIELDS, IMPORT_SYSTEM, SNAPSHOT_MAX_AGE_MS };
