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

async function hydrateBucket(bucket) {
  const objects = await store.listAll(bucket, "");
  let n = 0;
  for (const obj of objects) {
    const buf = await store.downloadObject(bucket, obj);
    const dest = path.join(ROOT, bucket, obj);      // photos/<personId>/<file> | story-photos/story-<id>/<file>
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    n++;
  }
  return n;
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

  let photos = 0, storyPhotos = 0;
  try { photos = await hydrateBucket(store.BUCKET_PHOTOS); } catch (e) { console.warn("hydrate photos:", e.message); }
  try { storyPhotos = await hydrateBucket(store.BUCKET_STORY); } catch (e) { console.warn("hydrate story-photos:", e.message); }

  console.log(`hydrate: ${stories.length} stories · ${photos} family originals · ${storyPhotos} editorial originals.`);
}

module.exports = { hydrate };

if (require.main === module) {
  hydrate().then(() => process.exit(0)).catch(e => { console.error("hydrate failed:", e); process.exit(1); });
}
