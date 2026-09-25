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

// entry: { action, storyId, actor:{id,name}, generationId?, sourceRevision?, detail? }
async function record(entry) {
  try {
    const doc = await store.getDoc(KEY, { events: [] });
    const events = doc.events || [];
    events.push({
      at: new Date().toISOString(),
      action: entry.action || "unknown",
      storyId: entry.storyId != null ? entry.storyId : null,
      actorId: entry.actor && entry.actor.id || "unknown",
      actorName: entry.actor && entry.actor.name || "Unknown",
      via: entry.actor && entry.actor.via || null,
      generationId: entry.generationId || null,
      sourceRevision: entry.sourceRevision || null,
      detail: entry.detail || null
    });
    await store.putDoc(KEY, { events: events.slice(-CAP) });
  } catch (e) { /* audit must never break the primary action */ }
}

async function list(opts) {
  opts = opts || {};
  const doc = await store.getDoc(KEY, { events: [] });
  let e = doc.events || [];
  if (opts.storyId != null) e = e.filter(x => x.storyId === opts.storyId);
  return e.slice(-(opts.limit || 200)).reverse();
}

module.exports = { record, list };
