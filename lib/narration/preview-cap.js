/* =========================================================================
   Harlan's Legacy — Admin Preview capability (Ready/unapproved narration audio)

   The cinematic engine fetches its assets with plain GETs (no auth headers), so
   the preview-asset route cannot use the moderator header gate. Instead the
   moderator-gated /preview route ISSUES a short-lived capability bound to
   (storyId, generationId, expiry), signed with a server-side key, and the
   preview-asset route requires it. Without a valid, unexpired capability,
   Ready/unapproved audio is not reachable. Keys never leave the server.
   ========================================================================= */
"use strict";
const crypto = require("crypto");

const TTL_MS = 2 * 60 * 60 * 1000;   // one listening/review session
let KEY = null;
function key() {
  if (KEY) return KEY;
  const root = process.env.HARLAN_PREVIEW_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.ADMIN_TOKEN || "";
  // No configured secret (local dev only): a per-process random key.
  KEY = crypto.createHmac("sha256", root || crypto.randomBytes(32)).update("harlan-preview-capability/v1").digest();
  return KEY;
}
function mac(storyId, gen, exp) { return crypto.createHmac("sha256", key()).update(storyId + "|" + gen + "|" + exp).digest("hex"); }

function issue(storyId, gen, ttlMs) {
  const exp = Date.now() + (ttlMs || TTL_MS);
  return exp + "." + mac(String(storyId), String(gen), exp);
}
function verify(storyId, gen, cap) {
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(String(cap || ""));
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > Date.now())) return false;
  const want = Buffer.from(mac(String(storyId), String(gen), exp), "hex"), got = Buffer.from(m[2], "hex");
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
module.exports = { issue, verify, TTL_MS };
