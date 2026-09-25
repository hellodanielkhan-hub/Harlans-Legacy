/* =========================================================================
   Harlan's Legacy — build hydration (Phase 12)

   Runs FIRST in the production build (before lib/photos.js and build.js).
   Pulls the current source of truth out of Supabase into the local working
   tree the existing generators already expect:

       Supabase `documents` + `stories`  →  data/*.json
       Supabase Storage buckets          →  photos/… and story-photos/… originals

   Then the UNCHANGED pipeline runs: lib/photos.js regenerates responsive
   derivatives from the downloaded originals, and build.js produces the static
   site — so no generated files ever need to persist on Vercel between builds.

   Locally (no SUPABASE_URL / SERVICE_ROLE_KEY) this is a deliberate no-op: the
   build uses the existing data/*.json exactly as before.
   ========================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const store = require("./store.js");
const { ROOT } = require("./paths.js");

function writeJSON(rel, obj) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

async function hydrateBucket(bucket, destRoot) {
  const objects = await store.listAll(bucket, "");
  let n = 0;
  for (const obj of objects) {
    const buf = await store.downloadObject(bucket, obj);
    const dest = path.join(destRoot || path.join(ROOT, bucket), obj);   // photos/… | story-photos/… | assets/listen/…
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    n++;
  }
  return n;
}

// Narration: ONLY approved generations enter the static site. For each story whose
// record is approved, download its public manifest (listen.json, written at
// approval) and exactly the files that manifest references. Ready/unapproved
// generations stay in PRIVATE storage and are never copied into the build.
async function hydrateApprovedNarration(stories) {
  const destRoot = path.join(ROOT, "assets", "listen");
  let files = 0, approved = 0;
  for (const s of stories) {
    const n = s && s.narration;
    if (!n || n.status !== "approved" || !n.generationId) continue;
    let manBuf;
    try { manBuf = await store.downloadObject(store.BUCKET_LISTEN, s.id + "/listen.json"); }
    catch (e) { console.warn("hydrate listen: story " + s.id + " approved but has no manifest — skipped"); continue; }
    const man = JSON.parse(manBuf.toString("utf8"));
    const refs = [man.audio, man.words, man.sentences, man.paragraphs, man.zones].filter(Boolean);
    const gen = n.generationId;
    if (!refs.every(r => r.indexOf("g/" + gen + "/") === 0 || r === "narration.zones.json")) {
      console.warn("hydrate listen: story " + s.id + " manifest does not match its approved generation — skipped"); continue;
    }
    const dir = path.join(destRoot, String(s.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "listen.json"), manBuf); files++;
    for (const rel of refs) {
      const buf = await store.downloadObject(store.BUCKET_LISTEN, s.id + "/" + rel);
      const dest = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf); files++;
    }
    approved++;
  }
  return { approved, files };
}

async function hydrate() {
  if (!store.USE_SUPABASE) {
    console.log("hydrate: Supabase not configured — building from local data/*.json (unchanged).");
    return;
  }
  console.log("hydrate: pulling source of truth from Supabase…");
  writeJSON("data/site.json", await store.getSite());
  writeJSON("data/entities.json", await store.getEntities());
  writeJSON("data/photos.json", await store.getPhotos());
  writeJSON("data/story-photos.json", await store.getStoryPhotos());
  const stories = await store.getStories();
  writeJSON("data/stories.json", stories);

  let photos = 0, storyPhotos = 0, listen = { approved: 0, files: 0 };
  try { photos = await hydrateBucket(store.BUCKET_PHOTOS); } catch (e) { console.warn("hydrate photos:", e.message); }
  try { storyPhotos = await hydrateBucket(store.BUCKET_STORY); } catch (e) { console.warn("hydrate story-photos:", e.message); }
  // APPROVED narration only → assets/listen/<id>/… (where the reader loads them)
  try { listen = await hydrateApprovedNarration(stories); } catch (e) { console.warn("hydrate listen:", e.message); }

  console.log(`hydrate: ${stories.length} stories · ${photos} family originals · ${storyPhotos} editorial originals · ${listen.approved} approved narration(s), ${listen.files} narration files (unapproved generations are never copied).`);
}

module.exports = { hydrate };

if (require.main === module) {
  hydrate().then(() => process.exit(0)).catch(e => { console.error("hydrate failed:", e); process.exit(1); });
}
