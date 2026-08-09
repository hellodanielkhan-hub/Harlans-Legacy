/* =========================================================
   Harlan's Legacy — Photo pipeline (archival-quality)
   Reads the archival originals in  photos/{personId}/*  and
   produces optimized, responsive derivatives in
   assets/photos/{personId}/ :

     {photoId}.portrait.{w}.webp   square, face-centred crop (no distortion)
     {photoId}.portrait.{w}.jpg    fallback
     {photoId}.full.{w}.webp       aspect-preserved (for the future gallery)
     {photoId}.full.{w}.jpg        fallback

   It also writes/updates data/photos.json — the DATA LAYER for photos.
   Editorial fields (primary, order, caption, year, location, source, alt)
   are preserved across runs; only new files are added and derivative width
   lists refreshed. Nothing here hardcodes an image path into a template.

   Run:  node lib/photos.js        (or via `npm run build`, which runs this
                                    before the sync site build)
   ========================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

const { ROOT } = require("./paths.js");
const SRC = path.join(ROOT, "photos");
const OUT = path.join(ROOT, "assets", "photos");
const MANIFEST = path.join(ROOT, "data", "photos.json");
// Per-story editorial images (Phase 11A.75) — supporting archival material
// (streets, newspapers, maps, objects…), kept entirely separate from the family
// photo galleries.
const STORY_SRC = path.join(ROOT, "story-photos");
const STORY_OUT = path.join(ROOT, "assets", "story-photos");
const STORY_MANIFEST = path.join(ROOT, "data", "story-photos.json");

// Responsive widths. Square portrait crop powers every circular medallion
// (tree, relationships, profile hero). Full sizes are generated ready for the
// slideshow phase but are not displayed yet.
const PORTRAIT_WIDTHS = [176, 352, 528, 768];
const FULL_WIDTHS = [640, 1280, 1920];
const Q_WEBP = 84;
const Q_JPEG = 88;

let sharp = null;
try { sharp = require("sharp"); } catch (e) { /* pipeline degrades gracefully */ }

function slug(s) {
  return String(s).toLowerCase().replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function readJSON(p, fallback) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return fallback; } }
function personDirs() {
  if (!fs.existsSync(SRC)) return [];
  return fs.readdirSync(SRC).filter(d => { try { return fs.statSync(path.join(SRC, d)).isDirectory(); } catch (e) { return false; } });
}
function imagesIn(dir) {
  return fs.readdirSync(dir).filter(f => /\.(jpe?g|png)$/i.test(f)).sort();
}

/* ---------- face-aware cropping ----------
   The square portrait crop is composed around the subject's face (largest
   face = intended subject) so museum rules hold: whole face + hair kept,
   forehead never cut, chin never cut, shoulders included where possible,
   ears kept unless unavoidable. Uses BlazeFace (pure-JS TensorFlow) at build
   time; if it's unavailable the pipeline falls back to sharp's attention
   strategy, so nothing breaks. */
let _tf = null, _blaze = null, _faceModel = null, _mlTried = false;
async function faceModel() {
  if (_mlTried) return _faceModel;
  _mlTried = true;
  try {
    _tf = require("@tensorflow/tfjs");
    _blaze = require("@tensorflow-models/blazeface");
    _faceModel = await _blaze.load();
  } catch (e) { _faceModel = null; }
  return _faceModel;
}

async function detectLargestFace(src, W, H) {
  const model = await faceModel();
  if (!model) return null;
  try {
    const DET = 640;                                   // detect on a small copy for speed
    const scale = Math.min(1, DET / Math.max(W, H));
    const dw = Math.max(1, Math.round(W * scale)), dh = Math.max(1, Math.round(H * scale));
    const { data, info } = await sharp(src).rotate().removeAlpha()
      .resize(dw, dh, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
    const t = _tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);
    let faces;
    try { faces = await model.estimateFaces(t, false); } finally { t.dispose(); }
    if (!faces || !faces.length) return null;
    const s = 1 / scale;
    const boxes = faces.map(f => ({
      x: f.topLeft[0] * s, y: f.topLeft[1] * s,
      w: (f.bottomRight[0] - f.topLeft[0]) * s, h: (f.bottomRight[1] - f.topLeft[1]) * s
    })).sort((a, b) => (b.w * b.h) - (a.w * a.h));
    return boxes[0];
  } catch (e) { return null; }
}

// Compose a square crop around a face with museum headroom/shoulder ratios.
function museumSquare(face, W, H) {
  const fw = face.w, fh = face.h;
  const fcx = face.x + fw / 2, fcy = face.y + fh / 2;
  // side big enough for hair (0.6·fh) + face (fh) + chin & shoulders (1.2·fh)
  let S = Math.round(Math.max(fh * 2.8, fw * 3.1));
  S = Math.min(S, W, H);
  // place the face in the upper third → headroom above, shoulders below
  let left = Math.round(fcx - S / 2);
  let top = Math.round(fcy - S * 0.42);
  // keep the whole face inside if the square had to shrink
  if (face.y < top) top = Math.round(face.y - 0.08 * S);
  if (face.y + fh > top + S) top = Math.round(face.y + fh - S + 0.08 * S);
  left = Math.max(0, Math.min(left, W - S));
  top = Math.max(0, Math.min(top, H - S));
  // Face centre as a percentage WITHIN the composed square — used as each
  // photo's own object-position so non-square frames stay centred on the face.
  const fx = Math.max(0, Math.min(100, Math.round(((fcx - left) / S) * 100)));
  const fy = Math.max(0, Math.min(100, Math.round(((fcy - top) / S) * 100)));
  return { left, top, size: S, focus: { x: fx, y: fy } };
}

// Auto-pick a sensible primary: prefer a solo shot (a bare-name file, and not a
// group photo) — the editor can always override it in the admin.
function choosePrimary(items, personId) {
  let best = null, bestScore = -Infinity;
  items.forEach(it => {
    let s = 0;
    const st = it.id;
    if (st === personId) s += 3;
    if (/(-and-|-with-|-&-|kids|-2-)/.test(st) || /\band\b|\bwith\b/.test(st)) s -= 2;
    if (s > bestScore) { bestScore = s; best = it; }
  });
  return best ? best.id : (items[0] && items[0].id) || null;
}

async function makeDerivatives(personId, file, photoId) {
  const src = path.join(SRC, personId, file);
  const outDir = path.join(OUT, personId);
  fs.mkdirSync(outDir, { recursive: true });

  const meta = await sharp(src).metadata();
  const W = meta.width || 0, H = meta.height || 0;
  const minSide = Math.min(W, H) || 0;
  const maxSide = Math.max(W, H) || 0;

  // Face-aware square crop region (falls back to attention if no face found).
  const face = await detectLargestFace(src, W, H);
  const rect = face ? museumSquare(face, W, H) : null;
  const cropSide = rect ? rect.size : minSide;
  // Per-photo focal point (face centre) so different photos get different,
  // correct object-position values — never a single global crop.
  const focus = rect ? rect.focus : { x: 50, y: 38 };

  // never upscale beyond the crop region / source
  const pW = PORTRAIT_WIDTHS.filter(w => w <= cropSide);
  if (!pW.length && cropSide) pW.push(cropSide);
  const fW = FULL_WIDTHS.filter(w => w <= maxSide);
  if (!fW.length && maxSide) fW.push(maxSide);

  // portrait pipeline: extract the composed square, then downscale (no cover
  // crop, so the face is never re-cut); attention only when no face detected.
  const portraitPipe = () => rect
    ? sharp(src).rotate().extract({ left: rect.left, top: rect.top, width: rect.size, height: rect.size })
    : sharp(src).rotate();
  for (const w of pW) {
    const base = path.join(outDir, `${photoId}.portrait.${w}`);
    const resize = rect ? { fit: "cover" } : { fit: "cover", position: sharp.strategy.attention };
    await portraitPipe().resize(w, w, resize).webp({ quality: Q_WEBP }).toFile(base + ".webp");
    await portraitPipe().resize(w, w, resize).jpeg({ quality: Q_JPEG, mozjpeg: true }).toFile(base + ".jpg");
  }
  for (const w of fW) {
    const base = path.join(outDir, `${photoId}.full.${w}`);
    if (!fs.existsSync(base + ".webp"))
      await sharp(src).rotate().resize(w, null, { fit: "inside", withoutEnlargement: true }).webp({ quality: Q_WEBP }).toFile(base + ".webp");
    if (!fs.existsSync(base + ".jpg"))
      await sharp(src).rotate().resize(w, null, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: Q_JPEG, mozjpeg: true }).toFile(base + ".jpg");
  }
  return { width: meta.width || null, height: meta.height || null, portrait: pW, full: fW, focus };
}

async function processPhotos() {
  const manifest = readJSON(MANIFEST, {});
  const ids = personDirs();

  for (const personId of ids) {
    const dir = path.join(SRC, personId);
    const files = imagesIn(dir);
    const prev = manifest[personId] || { primary: null, items: [] };
    const prevByFile = {};
    (prev.items || []).forEach(it => { prevByFile[it.file] = it; });

    const items = [];
    for (const file of files) {
      const photoId = slug(file);
      const existing = prevByFile[file] || {};
      const item = {
        id: photoId,
        file,
        caption: existing.caption || "",
        year: existing.year != null ? existing.year : null,
        location: existing.location != null ? existing.location : null,
        source: existing.source != null ? existing.source : null,
        alt: existing.alt != null ? existing.alt : null
      };
      // Reprocess only when derivatives are missing — face detection (slow) is
      // skipped for photos already generated, so rebuilds stay fast.
      const sentinel = path.join(OUT, personId, `${photoId}.portrait.${PORTRAIT_WIDTHS[0]}.webp`);
      if (sharp && !fs.existsSync(sentinel)) {
        const d = await makeDerivatives(personId, file, photoId);
        item.width = d.width; item.height = d.height;
        item.portrait = d.portrait; item.full = d.full; item.focus = d.focus;
      } else {
        item.width = existing.width || null; item.height = existing.height || null;
        item.portrait = existing.portrait || []; item.full = existing.full || [];
        item.focus = existing.focus || { x: 50, y: 38 };
      }
      items.push(item);
    }

    // preserve the editor's ordering where it still applies, new files appended
    const order = (prev.items || []).map(it => it.file).filter(f => files.includes(f));
    files.forEach(f => { if (!order.includes(f)) order.push(f); });
    const byFile = {}; items.forEach(it => { byFile[it.file] = it; });
    const ordered = order.map(f => byFile[f]).filter(Boolean);

    let primary = prev.primary;
    if (!primary || !ordered.find(it => it.id === primary)) primary = choosePrimary(ordered, personId);

    manifest[personId] = { primary, items: ordered };
  }

  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/* ---------- per-story editorial images ----------
   No face detection (these are objects / places / documents, not portraits):
   a centred square "cover" set (so the reader can use them as pulls / diptychs)
   plus aspect-preserved "full" derivatives. Editorial fields + a focal point
   (for reframing) are preserved across runs. */
async function makeStoryDerivatives(storyKey, file, photoId) {
  const src = path.join(STORY_SRC, storyKey, file);
  const outDir = path.join(STORY_OUT, storyKey);
  fs.mkdirSync(outDir, { recursive: true });
  const meta = await sharp(src).metadata();
  const W = meta.width || 0, H = meta.height || 0;
  const minSide = Math.min(W, H) || 0, maxSide = Math.max(W, H) || 0;
  const pW = PORTRAIT_WIDTHS.filter(w => w <= minSide); if (!pW.length && minSide) pW.push(minSide);
  const fW = FULL_WIDTHS.filter(w => w <= maxSide); if (!fW.length && maxSide) fW.push(maxSide);
  for (const w of pW) {
    const base = path.join(outDir, `${photoId}.portrait.${w}`);
    await sharp(src).rotate().resize(w, w, { fit: "cover", position: sharp.strategy.attention }).webp({ quality: Q_WEBP }).toFile(base + ".webp");
    await sharp(src).rotate().resize(w, w, { fit: "cover", position: sharp.strategy.attention }).jpeg({ quality: Q_JPEG, mozjpeg: true }).toFile(base + ".jpg");
  }
  for (const w of fW) {
    const base = path.join(outDir, `${photoId}.full.${w}`);
    await sharp(src).rotate().resize(w, null, { fit: "inside", withoutEnlargement: true }).webp({ quality: Q_WEBP }).toFile(base + ".webp");
    await sharp(src).rotate().resize(w, null, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: Q_JPEG, mozjpeg: true }).toFile(base + ".jpg");
  }
  return { width: meta.width || null, height: meta.height || null, portrait: pW, full: fW, focus: { x: 50, y: 50 } };
}

async function processStoryPhotos() {
  const manifest = readJSON(STORY_MANIFEST, {});
  if (fs.existsSync(STORY_SRC)) {
    const keys = fs.readdirSync(STORY_SRC).filter(d => { try { return fs.statSync(path.join(STORY_SRC, d)).isDirectory(); } catch (e) { return false; } });
    for (const key of keys) {
      const dir = path.join(STORY_SRC, key);
      const files = imagesIn(dir);
      const prev = manifest[key] || { primary: null, items: [] };
      const prevByFile = {}; (prev.items || []).forEach(it => { prevByFile[it.file] = it; });
      const items = [];
      for (const file of files) {
        const photoId = slug(file);
        const existing = prevByFile[file] || {};
        const item = {
          id: photoId, file,
          caption: existing.caption || "", year: existing.year != null ? existing.year : null,
          location: existing.location != null ? existing.location : null,
          source: existing.source != null ? existing.source : null, alt: existing.alt != null ? existing.alt : null
        };
        const sentinel = path.join(STORY_OUT, key, `${photoId}.portrait.${PORTRAIT_WIDTHS[0]}.webp`);
        const sentinel2 = path.join(STORY_OUT, key, `${photoId}.full.${FULL_WIDTHS[0]}.webp`);
        if (sharp && !fs.existsSync(sentinel) && !fs.existsSync(sentinel2)) {
          const d = await makeStoryDerivatives(key, file, photoId);
          item.width = d.width; item.height = d.height; item.portrait = d.portrait; item.full = d.full; item.focus = existing.focus || d.focus;
        } else {
          item.width = existing.width || null; item.height = existing.height || null;
          item.portrait = existing.portrait || []; item.full = existing.full || []; item.focus = existing.focus || { x: 50, y: 50 };
        }
        items.push(item);
      }
      const order = (prev.items || []).map(it => it.file).filter(f => files.includes(f));
      files.forEach(f => { if (!order.includes(f)) order.push(f); });
      const byFile = {}; items.forEach(it => { byFile[it.file] = it; });
      const ordered = order.map(f => byFile[f]).filter(Boolean);
      let primary = prev.primary;
      if (!primary || !ordered.find(it => it.id === primary)) primary = ordered[0] ? ordered[0].id : null;
      manifest[key] = { primary, items: ordered };
    }
  }
  fs.writeFileSync(STORY_MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

module.exports = { processPhotos, processStoryPhotos, PORTRAIT_WIDTHS, FULL_WIDTHS, hasSharp: !!sharp };

if (require.main === module) {
  console.log("Harlan's Legacy — processing photos…" + (sharp ? "" : " (sharp not installed — metadata only)"));
  processPhotos().then(m => {
    Object.keys(m).forEach(id => console.log(`  ${id}: ${m[id].items.length} photo(s), primary = ${m[id].primary}`));
    console.log("  data/photos.json written.");
    return processStoryPhotos();
  }).then(sm => {
    Object.keys(sm).forEach(id => console.log(`  [story] ${id}: ${sm[id].items.length} image(s)`));
    console.log("  data/story-photos.json written.");
  }).catch(e => { console.error(e); process.exit(1); });
}
