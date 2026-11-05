/* =========================================================================
   Harlan's Legacy — narration audit log

   Durable, attributable record of moderator actions, persisted in the same
   documents store (Supabase JSONB "narration_audit" in prod, local file in dev).
   Records who did what, when, to which story/generation/revision.
   ========================================================================= */
"use strict";

const store = require("../store.js");
const KEY = "narration_audit";
const CAP = 5000;

function event(entry, at) {
  return {
    at,
    action: entry.action || "unknown",
    storyId: entry.storyId != null ? entry.storyId : null,
    actorId: entry.actor && entry.actor.id || "unknown",
    actorName: entry.actor && entry.actor.name || "Unknown",
    via: entry.actor && entry.actor.via || null,
    generationId: entry.generationId || null,
    sourceRevision: entry.sourceRevision || null,
    detail: entry.detail || null
  };
}

// entry: { action, storyId, actor:{id,name}, generationId?, sourceRevision?, detail? }
async function record(entry) {
  try {
    const doc = await store.getDoc(KEY, { events: [] });
    const events = doc.events || [];
    events.push(event(entry, new Date().toISOString()));
    await store.putDoc(KEY, { events: events.slice(-CAP) });
  } catch (e) { /* audit must never break the primary action */ }
}

/* Several entries in ONE read and ONE write of the audit document (instead of one read+write per entry): every
   entry is kept as its own event, in order, with the same timestamp. Like record(), it never throws (an audit
   problem must not undo or block the primary action), but it REPORTS the outcome so the caller can surface it:
   { ok: true, written: n } or { ok: false, written: 0, error }. */
async function recordMany(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return { ok: true, written: 0 };
  try {
    const doc = await store.getDoc(KEY, { events: [] });
    const events = doc.events || [];
    const at = new Date().toISOString();
    for (const e of list) events.push(event(e, at));
    await store.putDoc(KEY, { events: events.slice(-CAP) });
    return { ok: true, written: list.length };
  } catch (e) {
    return { ok: false, written: 0, error: String(e && e.message || e).slice(0, 300) };
  }
}

async function list(opts) {
  opts = opts || {};
  const doc = await store.getDoc(KEY, { events: [] });
  let e = doc.events || [];
  if (opts.storyId != null) e = e.filter(x => x.storyId === opts.storyId);
  return e.slice(-(opts.limit || 200)).reverse();
}

module.exports = { record, recordMany, list };
