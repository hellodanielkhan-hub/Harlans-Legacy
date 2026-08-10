/* =========================================================================
   Harlan's Legacy — data store (Phase 12: Supabase-backed persistence)

   A small async data layer with TWO interchangeable backends, chosen purely by
   environment. The rest of the codebase (serverless API, build hydration,
   migration) talks to this and never knows or cares which backend is live:

     • FILE backend (default / local dev):
         reads & writes the same data/*.json files in the writable root — i.e.
         exactly today's behaviour. Requires no Supabase, no network.

     • SUPABASE backend (production):
         active when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set. Persists
         to Postgres (JSONB columns — the existing JSON shapes are kept intact)
         and Supabase Storage for uploaded originals. The service-role key is
         used ONLY here, server-side; it is never sent to the browser.

   Schema (see supabase/schema.sql):
     documents(key text pk, data jsonb)   — site, entities, photos, story_photos
     stories(id int pk, data jsonb)        — one row per memory (full record)
   Storage buckets: "photos" (family originals), "story-photos" (editorial).
   ========================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const { ROOT } = require("./paths.js");

const DATA = path.join(ROOT, "data");
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const USE_SUPABASE = !!(SUPA_URL && SUPA_KEY);

const BUCKET_PHOTOS = "photos";
const BUCKET_STORY = "story-photos";

/* ---- Supabase client (lazy; only loaded when actually configured) ---- */
let _sb = null;
function sb() {
  if (_sb) return _sb;
  const { createClient } = require("@supabase/supabase-js");
  _sb = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return _sb;
}

/* ---- file backend helpers ---- */
function fileName(key) { return key === "story_photos" ? "story-photos" : key; }
function fileFor(key) { return path.join(DATA, fileName(key) + ".json"); }
function readFileDoc(key, fallback) { try { return JSON.parse(fs.readFileSync(fileFor(key), "utf8")); } catch (e) { return fallback; } }
function writeFileDoc(key, obj) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(fileFor(key), JSON.stringify(obj, null, 2) + "\n"); }

/* ---- single-JSONB documents: site, entities, photos, story_photos ---- */
async function getDoc(key, fallback) {
  if (!USE_SUPABASE) return readFileDoc(key, fallback);
  const { data, error } = await sb().from("documents").select("data").eq("key", key).maybeSingle();
  if (error) throw new Error("store.getDoc(" + key + "): " + error.message);
  return data && data.data != null ? data.data : fallback;
}
async function putDoc(key, obj) {
  if (!USE_SUPABASE) { writeFileDoc(key, obj); return obj; }
  const { error } = await sb().from("documents").upsert({ key, data: obj, updated_at: new Date().toISOString() });
  if (error) throw new Error("store.putDoc(" + key + "): " + error.message);
  return obj;
}

const getSite = () => getDoc("site", {});
const putSite = (o) => putDoc("site", o);
const getEntities = () => getDoc("entities", {});
const putEntities = (o) => putDoc("entities", o);
const getPhotos = () => getDoc("photos", {});
const putPhotos = (o) => putDoc("photos", o);
const getStoryPhotos = () => getDoc("story_photos", {});
const putStoryPhotos = (o) => putDoc("story_photos", o);

/* ---- stories (one row each) ---- */
async function getStories() {
  if (!USE_SUPABASE) return readFileDoc("stories", []);
  const { data, error } = await sb().from("stories").select("data").order("id", { ascending: true });
  if (error) throw new Error("store.getStories: " + error.message);
  return (data || []).map(r => r.data);
}
async function putStories(list) {                 // bulk (migration / single-featured sweep)
  if (!USE_SUPABASE) { writeFileDoc("stories", list); return list; }
  const rows = list.map(s => ({ id: s.id, data: s, updated_at: new Date().toISOString() }));
  const { error } = await sb().from("stories").upsert(rows);
  if (error) throw new Error("store.putStories: " + error.message);
  return list;
}
async function putStory(rec) {
  if (!USE_SUPABASE) {
    const list = readFileDoc("stories", []);
    const i = list.findIndex(s => s.id === rec.id);
    if (i >= 0) list[i] = rec; else list.push(rec);
    writeFileDoc("stories", list); return rec;
  }
  const { error } = await sb().from("stories").upsert({ id: rec.id, data: rec, updated_at: new Date().toISOString() });
  if (error) throw new Error("store.putStory: " + error.message);
  return rec;
}
async function deleteStory(id) {
  if (!USE_SUPABASE) {
    let list = readFileDoc("stories", []);
    list = list.filter(s => s.id !== id);
    writeFileDoc("stories", list); return;
  }
  const { error } = await sb().from("stories").delete().eq("id", id);
  if (error) throw new Error("store.deleteStory: " + error.message);
}

/* ---- Storage (uploaded originals) — Supabase only ---- */
async function uploadObject(bucket, objPath, buffer, contentType) {
  const { error } = await sb().storage.from(bucket).upload(objPath, buffer, { contentType: contentType || "application/octet-stream", upsert: true });
  if (error) throw new Error("store.upload(" + objPath + "): " + error.message);
}
async function removeObject(bucket, objPath) {
  const { error } = await sb().storage.from(bucket).remove([objPath]);
  if (error && !/not found/i.test(error.message)) throw new Error("store.remove(" + objPath + "): " + error.message);
}
// Recursively list every object under a bucket (for the build hydration step).
async function listAll(bucket, prefix) {
  prefix = prefix || "";
  const out = [];
  const { data, error } = await sb().storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) throw new Error("store.list(" + bucket + "/" + prefix + "): " + error.message);
  for (const item of (data || [])) {
    const full = prefix ? prefix + "/" + item.name : item.name;
    if (item.id === null || (item.metadata == null && !/\./.test(item.name))) {
      out.push(...await listAll(bucket, full));      // folder
    } else {
      out.push(full);                                 // file
    }
  }
  return out;
}
async function downloadObject(bucket, objPath) {
  const { data, error } = await sb().storage.from(bucket).download(objPath);
  if (error) throw new Error("store.download(" + objPath + "): " + error.message);
  return Buffer.from(await data.arrayBuffer());
}

module.exports = {
  USE_SUPABASE, BUCKET_PHOTOS, BUCKET_STORY,
  getSite, putSite, getEntities, putEntities, getPhotos, putPhotos, getStoryPhotos, putStoryPhotos,
  getStories, putStories, putStory, deleteStory,
  uploadObject, removeObject, listAll, downloadObject
};
