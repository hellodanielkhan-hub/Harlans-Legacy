/* Read-only snapshot, collision-free id allocation, local backup and its verification.

   Everything here reads through the Admin API (GET only, via the live transport's allow-list) and writes
   only to a local folder. Nothing touches Supabase directly, and nothing is written to the site.

   Backup folder:
     snapshot.json              the snapshot the backup was taken from
     documents/*.json           GET /api/site, /api/entities, /api/photos, /api/story-photos
     records/<id>.json          GET /api/stories/<id> for every existing memory
     images/story-<id>/<file>   every stored gallery original, read through the admin-only /original route
     manifest.json              per-file SHA-256, each photo's server-side digest, counts
     MANIFEST.sha256            SHA-256 of manifest.json */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { canonical, PROTECTED_IDS, IMPORT_SYSTEM, SNAPSHOT_MAX_AGE_MS } = require("./batch.js");

const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const recordSha = r => sha(canonical(r));
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*\.(jpe?g|png|webp|gif)$/i;

async function getOk(transport, p) {
  const r = await transport("GET", p);
  if (r.status !== 200) throw new Error("GET " + p + " answered HTTP " + r.status);
  return r.body;
}

// Fresh read-only snapshot: every memory (id, status, featured, title, importSource, record hash) and every gallery.
async function takeSnapshot(transport, base) {
  const stories = await getOk(transport, "/api/stories");
  const galleries = await getOk(transport, "/api/story-photos");
  if (!Array.isArray(stories) || !stories.length) throw new Error("snapshot: the story list is empty or not a list");
  const memories = stories.map(s => ({ id: s.id, status: s.status, featured: !!s.featured, title: s.title || "", importSource: s.importSource || null, sha256: recordSha(s) }))
    .sort((a, b) => a.id - b.id);
  const ids = new Set(memories.map(m => m.id));
  const missingProtected = PROTECTED_IDS.filter(id => !ids.has(id));
  if (missingProtected.length) throw new Error("snapshot: protected ids missing from the live list: " + missingProtected.join(", ") + " - stopping");
  const gal = {};
  for (const [key, g] of Object.entries(galleries || {})) gal[key] = { primary: g.primary || null, files: (g.items || []).map(it => ({ id: it.id, file: it.file })) };
  const snap = { takenAt: new Date().toISOString(), source: "GET /api/stories + /api/story-photos", base: base || null, count: memories.length,
    maxId: Math.max(...memories.map(m => m.id)), memories, galleries: gal };
  snap.sha256 = sha(canonical(Object.assign({}, snap, { sha256: undefined })));
  return snap;
}

function snapshotAgeOk(snap, now) { return snap && snap.takenAt && (now || Date.now()) - Date.parse(snap.takenAt) <= SNAPSHOT_MAX_AGE_MS; }

/* Collision-free ids for a batch.
   - A post this ledger already created keeps its id, but only if the snapshot shows that id as this
     importer's own non-featured Draft for the same post (or the id is free, e.g. creation never landed).
   - A post whose import Draft exists without a ledger line (the create's answer was lost) keeps that id.
   - Every other post gets the next id after the highest of: every occupied id, every protected id and
     every id in the ledger. Occupied and protected ids are skipped.
   Returns { ids: { postId: id }, fresh: [ids not yet created], reused: [ids from the ledger], problems }. */
function allocateIds(items, snap, ledgerState) {
  const occupied = new Map(snap.memories.map(m => [m.id, m]));
  const ledgerIds = Object.values(ledgerState || {}).map(s => s && s.storyId).filter(Number.isInteger);
  let next = Math.max(0, ...occupied.keys(), ...PROTECTED_IDS, ...ledgerIds) + 1;
  const ids = {}, fresh = [], reused = [], adopted = [], problems = [];
  const taken = new Set();
  const ownDraft = (m, postId) => m.status === "draft" && !m.featured && m.importSource && m.importSource.system === IMPORT_SYSTEM && m.importSource.postId === postId;
  for (const it of items) {
    const mine = ledgerState && ledgerState[it.postId];
    // A Draft this importer created whose answer was lost (no ledger line) is found by its importSource
    // and kept, so a resume never creates a second Draft for the same post.
    const existing = [...occupied.values()].filter(m => ownDraft(m, it.postId));
    if (existing.length > 1) { problems.push(it.postId + ": " + existing.length + " import Drafts already exist (" + existing.map(m => m.id).join(", ") + ")"); continue; }
    if (existing.length === 1 && !(mine && Number.isInteger(mine.storyId))) {
      ids[it.postId] = existing[0].id; adopted.push(existing[0].id); reused.push(existing[0].id); taken.add(existing[0].id);
      continue;
    }
    if (existing.length === 1 && mine && mine.storyId !== existing[0].id) { problems.push(it.postId + ": ledger says " + mine.storyId + " but the site holds its import Draft at " + existing[0].id); continue; }
    if (mine && Number.isInteger(mine.storyId)) {
      const m = occupied.get(mine.storyId);
      if (PROTECTED_IDS.includes(mine.storyId)) problems.push(it.postId + ": ledger id " + mine.storyId + " is protected");
      else if (m && !(m.status === "draft" && !m.featured && m.importSource && m.importSource.system === IMPORT_SYSTEM && m.importSource.postId === it.postId))
        problems.push(it.postId + ": ledger id " + mine.storyId + " is occupied by something that is not this post's import Draft");
      ids[it.postId] = mine.storyId; reused.push(mine.storyId); taken.add(mine.storyId);
      continue;
    }
    while (occupied.has(next) || PROTECTED_IDS.includes(next) || taken.has(next)) next++;
    ids[it.postId] = next; fresh.push(next); taken.add(next); next++;
  }
  return { ids, fresh, reused, adopted, problems };
}

// Each fresh id must answer 404 right now (a second, direct collision check after the snapshot).
async function confirmFree(transport, ids) {
  const busy = [];
  for (const id of ids) { const r = await transport("GET", "/api/stories/" + id); if (r.status !== 404) busy.push(id + " (HTTP " + r.status + ")"); }
  return busy;
}

function writeFile(dir, rel, data, files) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  files[rel.split(path.sep).join("/")] = sha(data);
}

/* Back up every existing memory record, the site documents and every stored gallery original.
   live = { transport, readOriginal(storyId, photoId), storedPhotoDigest(storyId, item) } */
async function backup(live, snap, dir) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error("backup folder is not empty: " + dir);
  fs.mkdirSync(dir, { recursive: true });
  const files = {}, memories = [], problems = [];
  writeFile(dir, "snapshot.json", JSON.stringify(snap, null, 1), files);
  for (const [name, p] of [["site", "/api/site"], ["entities", "/api/entities"], ["photos", "/api/photos"], ["story-photos", "/api/story-photos"]])
    writeFile(dir, path.join("documents", name + ".json"), JSON.stringify(await getOk(live.transport, p), null, 1), files);
  for (const m of snap.memories) {
    const rec = await getOk(live.transport, "/api/stories/" + m.id);
    writeFile(dir, path.join("records", m.id + ".json"), JSON.stringify(rec, null, 1), files);
    const entry = { id: m.id, status: m.status, featured: m.featured, recordSha256: recordSha(rec), snapshotSha256: m.sha256, gallery: [] };
    if (entry.recordSha256 !== m.sha256) problems.push("No. " + m.id + " changed between the snapshot and the backup");
    const g = snap.galleries["story-" + m.id];
    for (const f of (g ? g.files : [])) {
      const p = { id: f.id, file: f.file };
      if (!SAFE_FILE.test(f.file)) { p.error = "unsafe stored file name; not backed up"; problems.push("No. " + m.id + " " + f.file + ": " + p.error); entry.gallery.push(p); continue; }
      const d = await live.storedPhotoDigest(m.id, f);
      if (d.status !== 200 || !d.body || !d.body.sha256) { p.error = "digest HTTP " + d.status; problems.push("No. " + m.id + " " + f.file + ": " + p.error); entry.gallery.push(p); continue; }
      p.serverSha256 = d.body.sha256; p.bytes = d.body.bytes;
      const o = await live.readOriginal(m.id, f.id);
      if (o.status !== 200) { p.error = "original HTTP " + o.status; problems.push("No. " + m.id + " " + f.file + ": " + p.error); entry.gallery.push(p); continue; }
      const rel = path.join("images", "story-" + m.id, f.file);
      writeFile(dir, rel, o.bytes, files);
      p.backupSha256 = sha(o.bytes); p.path = rel.split(path.sep).join("/");
      if (p.backupSha256 !== p.serverSha256) { p.error = "downloaded bytes differ from the server digest"; problems.push("No. " + m.id + " " + f.file + ": " + p.error); }
      entry.gallery.push(p);
    }
    memories.push(entry);
  }
  const manifest = { takenAt: snap.takenAt, backedUpAt: new Date().toISOString(), base: snap.base, snapshotSha256: snap.sha256,
    counts: { memories: memories.length, photos: memories.reduce((n, m) => n + m.gallery.length, 0), files: Object.keys(files).length }, memories, files, problems };
  const mj = JSON.stringify(manifest, null, 1);
  fs.writeFileSync(path.join(dir, "manifest.json"), mj);
  fs.writeFileSync(path.join(dir, "MANIFEST.sha256"), sha(mj) + "  manifest.json\n");
  return { dir, counts: manifest.counts, problems };
}

/* Verify a backup folder on its own: manifest integrity, every file's SHA-256, completeness against its
   snapshot (every memory has a record; every gallery photo has bytes equal to the server digest). */
function verifyBackup(dir, now) {
  const problems = [];
  let manifest, snap;
  try {
    const mj = fs.readFileSync(path.join(dir, "manifest.json"));
    const want = fs.readFileSync(path.join(dir, "MANIFEST.sha256"), "utf8").split(/\s+/)[0];
    if (sha(mj) !== want) problems.push("manifest.json does not match MANIFEST.sha256");
    manifest = JSON.parse(mj);
    snap = JSON.parse(fs.readFileSync(path.join(dir, "snapshot.json"), "utf8"));
  } catch (e) { return { ok: false, problems: ["cannot read the backup: " + e.message] }; }
  for (const [rel, h] of Object.entries(manifest.files || {})) {
    let b; try { b = fs.readFileSync(path.join(dir, rel)); } catch (e) { problems.push("missing file " + rel); continue; }
    if (sha(b) !== h) problems.push("changed file " + rel);
  }
  if (manifest.snapshotSha256 !== snap.sha256) problems.push("snapshot.json is not the snapshot this backup was taken from");
  const byId = new Map((manifest.memories || []).map(m => [m.id, m]));
  for (const m of snap.memories) {
    const e = byId.get(m.id);
    if (!e) { problems.push("No. " + m.id + " has no backed-up record"); continue; }
    if (!manifest.files["records/" + m.id + ".json"]) problems.push("No. " + m.id + " record file not listed");
    const g = snap.galleries["story-" + m.id];
    for (const f of (g ? g.files : [])) {
      const p = e.gallery.find(x => x.id === f.id);
      if (!p || p.error || !p.path || p.backupSha256 !== p.serverSha256) problems.push("No. " + m.id + " photo " + f.file + " not fully backed up" + (p && p.error ? ": " + p.error : ""));
    }
  }
  for (const p of (manifest.problems || [])) if (!problems.includes(p)) problems.push(p);
  const fresh = snapshotAgeOk(snap, now);
  return { ok: !problems.length, fresh, takenAt: snap.takenAt, counts: manifest.counts, snapshot: snap, problems };
}

// After a run: every memory that existed in the backup must be unchanged (record hash and gallery files).
function compareProtected(backupSnap, afterSnap) {
  const after = new Map(afterSnap.memories.map(m => [m.id, m]));
  const problems = [];
  for (const m of backupSnap.memories) {
    const a = after.get(m.id);
    if (!a) { problems.push("No. " + m.id + " is missing after the run"); continue; }
    if (a.sha256 !== m.sha256) problems.push("No. " + m.id + " record changed");
    const g0 = JSON.stringify(backupSnap.galleries["story-" + m.id] || null), g1 = JSON.stringify(afterSnap.galleries["story-" + m.id] || null);
    if (g0 !== g1) problems.push("No. " + m.id + " gallery changed");
  }
  return problems;
}

module.exports = { takeSnapshot, snapshotAgeOk, allocateIds, confirmFree, backup, verifyBackup, compareProtected, recordSha };
