/* =========================================================================
   Harlan's Legacy — moderator identity (§ per-moderator auth + attribution)

   Replaces the single shared ADMIN_TOKEN model with per-moderator tokens so
   every action is attributable to a named moderator. Configure via env:

     HARLAN_MODERATORS = {"<token>":{"id":"jane","name":"Jane Doe"}, ...}

   The legacy ADMIN_TOKEN still authorizes (as the "admin" identity) for
   backward compatibility. Suitable for a small moderator team; a full SSO/login
   can layer on later without changing callers (they only use resolve/authorize).
   ========================================================================= */
"use strict";

function moderators() {
  try { return JSON.parse(process.env.HARLAN_MODERATORS || "{}") || {}; }
  catch (e) { return {}; }
}

function tokenFrom(headers, query) {
  const h = headers || {};
  return (h["x-moderator-token"] || h["x-admin-token"] || (query && query.token) || "").toString();
}

// Resolve the acting moderator from the request (never throws).
function resolveActor(headers, query) {
  const tok = tokenFrom(headers, query);
  const map = moderators();
  if (tok && map[tok]) return { id: map[tok].id || "moderator", name: map[tok].name || map[tok].id || "Moderator", via: "moderator" };
  if (tok && process.env.ADMIN_TOKEN && tok === process.env.ADMIN_TOKEN) return { id: "admin", name: "Shared Admin", via: "admin-token" };
  return { id: "unknown", name: "Unknown", via: "none" };
}

// Is the request authorized to act? True when a token gate is configured and the
// token matches a moderator or the admin token; also true when no gate is set
// (local dev). Returns { ok, actor }.
function authorize(headers, query) {
  const gated = !!(process.env.ADMIN_TOKEN || Object.keys(moderators()).length);
  const actor = resolveActor(headers, query);
  if (!gated) return { ok: true, actor: actor.via === "none" ? { id: "local", name: "Local Dev", via: "no-gate" } : actor };
  return { ok: actor.via !== "none", actor };
}

module.exports = { resolveActor, authorize, moderators };
