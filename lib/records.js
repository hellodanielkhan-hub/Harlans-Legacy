/* =========================================================================
   Harlan's Legacy — shared record logic (Phase 12: Supabase backend)

   Pure, storage-agnostic helpers for the story record model. Extracted from
   server.js so the local dev server AND the Vercel serverless functions use ONE
   implementation — there is no second copy of normalize / single-featured to
   drift. No filesystem, no network: just data → data.
   ========================================================================= */
"use strict";

function slugify(str) {
  return String(str).toLowerCase().trim()
    .replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Slug for an uploaded image filename.
function photoSlug(s) {
  return String(s).toLowerCase().replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// A fresh story record with every field the model defines, so the editor always
// round-trips the full schema even for a brand-new entry.
function normalize(input, existing) {
  const base = existing || {};
  const s = Object.assign({}, base, input);
  s.title = String(s.title || "Untitled").trim();
  s.slug = (s.slug && slugify(s.slug)) || slugify(s.title);
  s.status = ["published", "coming-soon", "draft"].includes(s.status) ? s.status : "coming-soon";
  s.featured = !!s.featured;
  s.theme = s.theme || "ordinary";
  s.publishedISO = s.publishedISO || null;
  s.dateLong = s.dateLong || "";
  s.dateLabel = s.dateLabel || "";
  s.memoryDate = s.memoryDate || null;
  s.summary = s.summary || "";
  s.description = s.description || null;
  s.ogDescription = s.ogDescription || null;
  s.lead = s.lead || null;
  s.body = Array.isArray(s.body) ? s.body : [];
  ["people", "places", "objects", "events", "echoStories", "keywords"].forEach(k => {
    s[k] = Array.isArray(s[k]) ? s[k] : [];
  });
  s.bookPart = s.bookPart || null;
  s.readingTime = (s.readingTime === 0 || s.readingTime) ? s.readingTime : null;
  s.readerImages = Array.isArray(s.readerImages) ? s.readerImages : [];
  return s;
}

function nextId(stories) {
  return stories.reduce((m, s) => Math.max(m, Number(s.id) || 0), 0) + 1;
}

// A published story must be the only featured one.
function enforceSingleFeatured(stories, featuredId) {
  stories.forEach(s => { s.featured = (s.id === featuredId); });
}

// person id -> display name, from the family entities data.
function personNames(entities) {
  const map = {};
  ((entities && entities.family && entities.family.people) || []).forEach(p => { map[p.id] = p.name; });
  return map;
}

// A safe per-story gallery directory key derived from the story id.
function storyKey(id) { return "story-" + String(id).replace(/[^0-9a-zA-Z-]/g, ""); }

module.exports = { slugify, photoSlug, normalize, nextId, enforceSingleFeatured, personNames, storyKey };
