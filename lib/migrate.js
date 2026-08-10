/* =========================================================================
   Harlan's Legacy — one-time data migration into Supabase (Phase 12)

   Reads the existing local data/*.json and photo originals and writes them to
   Supabase (Postgres JSONB + Storage). Idempotent (upserts), so it is safe to
   re-run. Nothing is deleted from local; the JSON files remain as the local-dev
   source and as a backup.

   Requires (in the shell environment):
       SUPABASE_URL
       SUPABASE_SERVICE_ROLE_KEY
   Run once the schema (supabase/schema.sql) has been applied:
       SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run migrate
   ========================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const { ROOT } = require("./paths.js");
const store = require("./store.js");

const DATA = path.join(ROOT, "data");
function readJSON(rel, fallback) { try { return JSON.parse(fs.readFileSync(path.join(DATA, rel), "utf8")); } catch (e) { return fallback; } }
function ctype(file) { return /\.png$/i.test(file) ? "image/png" : "image/jpeg"; }

async function uploadTree(srcDir, bucket) {
  if (!fs.existsSync(srcDir)) return 0;
  let n = 0;
  for (const group of fs.readdirSync(srcDir)) {
    const gdir = path.join(srcDir, group);
    if (!fs.statSync(gdir).isDirectory()) continue;
    for (const file of fs.readdirSync(gdir)) {
      if (!/\.(jpe?g|png)$/i.test(file)) continue;
      const buf = fs.readFileSync(path.join(gdir, file));
      await store.uploadObject(bucket, group + "/" + file, buf, ctype(file));
      n++;
    }
  }
  return n;
}

async function migrate() {
  if (!store.USE_SUPABASE) {
    console.error("migrate: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Aborting.");
    process.exit(1);
  }
  console.log("migrate: writing documents…");
  await store.putSite(readJSON("site.json", {}));
  await store.putEntities(readJSON("entities.json", {}));
  await store.putPhotos(readJSON("photos.json", {}));
  await store.putStoryPhotos(readJSON("story-photos.json", {}));

  const stories = readJSON("stories.json", []);
  await store.putStories(stories);
  console.log(`migrate: ${stories.length} stories written.`);

  console.log("migrate: uploading photo originals to Storage…");
  const fam = await uploadTree(path.join(ROOT, "photos"), store.BUCKET_PHOTOS);
  const ed = await uploadTree(path.join(ROOT, "story-photos"), store.BUCKET_STORY);
  console.log(`migrate: uploaded ${fam} family originals + ${ed} editorial originals.`);

  console.log("migrate: done. Supabase is now the source of truth.");
}

if (require.main === module) migrate().then(() => process.exit(0)).catch(e => { console.error("migrate failed:", e); process.exit(1); });
module.exports = { migrate };
