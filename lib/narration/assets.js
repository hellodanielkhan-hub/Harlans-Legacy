/* =========================================================================
   Harlan's Legacy — narration asset storage

   Writes the produced audio + timing JSONs to the right place and returns the
   PUBLIC urls Listening Mode will load:

     • local dev (file store): assets/listen/<storyId>/…   served at /assets/listen/<storyId>/…
     • production (Supabase):  the "listen" storage bucket, public object urls.

   Blue Chair's existing files already live at assets/listen/214/ and are reused
   verbatim — nothing is overwritten unless a generation explicitly stores there.
   ========================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const store = require("../store.js");
const paths = require("../paths.js");

function localDir(storyId) { return path.join(paths.ROOT, "assets", "listen", String(storyId)); }
function publicBase(storyId) {
  if (store.USE_SUPABASE) return (process.env.SUPABASE_URL || "").replace(/\/$/, "") + "/storage/v1/object/public/" + store.BUCKET_LISTEN + "/" + storyId;
  return "/assets/listen/" + storyId;
}

// files: { "narration.mp3": Buffer, "narration.words.json": Buffer|obj, ... }
// opts.subdir keeps each generation self-contained (e.g. "g/<generationId>") so an
// approved version is never overwritten before its replacement is approved (§11).
async function writeAssets(storyId, files, opts) {
  opts = opts || {};
  const sub = opts.subdir ? String(opts.subdir).replace(/^\/+|\/+$/g, "") : "";
  const base = publicBase(storyId) + (sub ? "/" + sub : "");
  const urls = {};
  for (const name of Object.keys(files)) {
    const val = files[name];
    const buf = Buffer.isBuffer(val) ? val : Buffer.from(JSON.stringify(val, null, 0), "utf8");
    const contentType = name.endsWith(".mp3") ? "audio/mpeg" : name.endsWith(".json") ? "application/json" : "application/octet-stream";
    const rel = (sub ? sub + "/" : "") + name;
    if (store.USE_SUPABASE) {
      await store.uploadObject(store.BUCKET_LISTEN, storyId + "/" + rel, buf, contentType);
    } else {
      const dir = path.join(localDir(storyId), sub); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), buf);
    }
    urls[name] = base + "/" + name;
  }
  return urls;
}

function existsLocal(storyId, name) { return fs.existsSync(path.join(localDir(storyId), name)); }

// Storage-aware existence check: Supabase object in production, local fs in dev.
// Lets the (possibly serverless) API host see assets a remote worker finalized.
async function exists(storyId, name) {
  if (store.USE_SUPABASE) return await store.objectExists(store.BUCKET_LISTEN, String(storyId) + "/" + name);
  return existsLocal(storyId, name);
}

module.exports = { writeAssets, publicBase, existsLocal, exists, localDir };
