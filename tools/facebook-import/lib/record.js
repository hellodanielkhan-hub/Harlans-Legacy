/* Build the exact JSON body the Editorial Workspace sends to POST /api/stories.

   Mirrors admin/admin.js collect() (field set, dateLong/dateLabel, lead/body,
   readingTime) and then applies the server's own records.normalize() from this
   checkout, so the preview matches what the API would store. */
"use strict";

const path = require("path");
const records = require(path.join(__dirname, "..", "..", "..", "lib", "records.js"));

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const THEMES = ["funny", "grief", "momdad", "toledo", "shabbat", "ordinary"];

function longDate(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); if (!m) return ""; return MONTHS[+m[2] - 1] + " " + (+m[3]) + ", " + m[1]; }
function labelDate(iso) { const m = /^(\d{4})-(\d{2})/.exec(iso); if (!m) return ""; return MON[+m[2] - 1] + " " + m[1]; }

// admin.js: words of the textarea (paragraphs joined by blank lines), tags stripped, /200, min 1.
function readingTime(paragraphs) {
  const words = paragraphs.join("\n\n").replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function buildRecord(entry, paragraphs, id) {
  const body = {
    id,
    title: String(entry.title || "").trim(),
    slug: "",
    status: "draft",
    featured: false,
    theme: entry.category,
    publishedISO: entry.publishedISO,
    dateLong: longDate(entry.publishedISO),
    dateLabel: labelDate(entry.publishedISO),
    memoryDate: null,
    summary: "",
    description: null,
    ogDescription: null,
    lead: paragraphs.length ? paragraphs[0] : null,
    body: paragraphs.slice(1),
    people: [], places: [], objects: [], events: [],
    bookPart: null,
    keywords: [], echoStories: [],
    readingTime: readingTime(paragraphs),
    readerImages: [],
    // Extra JSONB field (no schema change; build.js ignores it): ties the memory to its source for duplicate checks.
    importSource: { system: "facebook-shabbat-import", postId: entry.postId, facebookUrl: entry.facebookUrl || null, facebookTimeChicago: entry.facebookTimeChicago || null }
  };
  return { requestBody: body, storedPreview: records.normalize(body) };
}

module.exports = { buildRecord, longDate, labelDate, readingTime, THEMES, slugify: records.slugify, photoSlug: records.photoSlug };
