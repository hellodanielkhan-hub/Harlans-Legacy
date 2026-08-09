#!/usr/bin/env node
/* =========================================================
   Harlan's Legacy — Static Site Generator
   Zero dependencies (Node built-ins only).

   Turns data/stories.json + data/site.json into:
     - story/{id}-{slug}.html         (one page per published story)
     - index.html                     (This Week, Archive, Quote, Book,
                                        Archive count — injected between
                                        <!-- HL:NAME:START/END --> markers,
                                        everything else preserved byte-for-byte)
     - stories.js                     (public window.HL_STORIES mirror)

   The public frontend is never redesigned here. The generator only
   writes content INSIDE the named markers and emits markup identical
   in class/structure to the original hand-authored HTML.
   ========================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

const { buildFamily } = require("./lib/family.js");
const { buildGraph, KIND, entityUrl } = require("./lib/graph.js");
const journeysLib = require("./lib/journeys.js");
const exploreLib = require("./lib/explore.js");
const readerLib = require("./lib/reader.js");

const { ROOT } = require("./lib/paths.js");   // app dir locally; a writable dir on read-only hosts
const DATA = path.join(ROOT, "data");
const STORY_DIR = path.join(ROOT, "story");

/* ---------- tiny helpers ---------- */
function readJSON(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

// Escape for use in an HTML attribute / meta content value.
function attr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
// Escape for HTML text where the source is plain text (titles, summaries).
// Story body strings are authored HTML (may contain <em>) and are NOT escaped.
function text(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Replace the content between <!-- HL:NAME:START --> and <!-- HL:NAME:END -->,
// keeping the markers in place so the operation is idempotent.
function injectRegion(html, name, inner) {
  const start = `<!-- HL:${name}:START -->`;
  const end = `<!-- HL:${name}:END -->`;
  const re = new RegExp(
    start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
    "[\\s\\S]*?" +
    end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  if (!re.test(html)) {
    console.warn(`  ! marker HL:${name} not found in index.html — skipped`);
    return html;
  }
  // Inline content (no newlines) stays on one line so it can live inside
  // an inline element like the archive count <span>; block content is padded.
  const body = inner.indexOf("\n") === -1
    ? start + inner + end
    : start + "\n" + inner + "\n            " + end;
  return html.replace(re, body);
}

/* ---------- derived data ---------- */
function loadData() {
  const site = readJSON(path.join(DATA, "site.json"));
  const stories = readJSON(path.join(DATA, "stories.json"));
  const entities = readJSON(path.join(DATA, "entities.json"));
  // Attach the photo data layer (data/photos.json) to each family member.
  const photosPath = path.join(DATA, "photos.json");
  const photos = fs.existsSync(photosPath) ? readJSON(photosPath) : {};
  if (entities.family && entities.family.people) {
    entities.family.people.forEach(p => { p.photos = photos[p.id] || { primary: null, items: [] }; });
  }
  // Attach each story's own editorial image gallery (data/story-photos.json).
  const storyPhotosPath = path.join(DATA, "story-photos.json");
  const storyPhotos = fs.existsSync(storyPhotosPath) ? readJSON(storyPhotosPath) : {};
  stories.forEach(s => {
    s.storyPhotos = storyPhotos["story-" + s.id] || { primary: null, items: [] };
    s.readerImages = Array.isArray(s.readerImages) ? s.readerImages : [];
  });
  stories.forEach(s => {
    const t = site.themes[s.theme] || { label: "", thread: "#B8B4A8" };
    s.themeLabel = t.label;
    s.threadHex = t.thread;
    s.published = s.status === "published";
    s.url = s.published ? `story/${s.id}-${s.slug}.html` : null;
  });
  return { site, stories, entities };
}

function pickFeatured(stories) {
  const flagged = stories.find(s => s.featured && s.published);
  if (flagged) return flagged;
  // Fallback: newest published by date.
  const pub = stories.filter(s => s.published && s.publishedISO)
    .sort((a, b) => (a.publishedISO < b.publishedISO ? 1 : -1));
  return pub[0] || null;
}

/* ---------- renderers: homepage regions ---------- */
function renderThisWeekTitle(s) {
  return `            <h2 class="story-title">${text(s.title)}</h2>`;
}

function renderThisWeekBody(s) {
  const more = (s.body || []).map(p => `              <p>${p}</p>`).join("\n");
  return [
    `            <p class="dropcap">${s.lead || ""}</p>`,
    ``,
    `            <details class="story-details">`,
    `              <summary class="story-toggle">`,
    `                <span class="label-closed">Continue reading</span>`,
    `                <span class="label-open">Close this story</span>`,
    `                <svg class="toggle-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    `              </summary>`,
    `              <div class="story-more">`,
    more,
    `                <div class="ending-mark" aria-hidden="true"></div>`,
    `              </div>`,
    `            </details>`
  ].join("\n");
}

function renderArchiveCard(s) {
  const tab = `--tab-color:var(--thread-${s.theme})`;
  const dot = `background:var(--thread-${s.theme})`;
  const inner = [
    `          <span class="stamp">Story No. ${s.id} &middot; ${text(s.dateLabel)}</span>`,
    `          <h3>${text(s.title)}</h3>`,
    `          <p class="teaser">${text(s.summary)}</p>`,
    `          <span class="theme-label"><span class="dot" style="${dot}"></span>${text(s.themeLabel)}</span>`
  ].join("\n");
  if (s.published) {
    return `        <a class="card-catalogue" data-theme="${s.theme}" style="${tab}" href="${s.url}">\n${inner}\n        </a>`;
  }
  return `        <article class="card-catalogue" data-theme="${s.theme}" style="${tab}">\n${inner}\n        </article>`;
}

// The archive lists EVERY story — including This Week's featured one — so a
// newly published memory always surfaces here (and in the theme filters /
// categories), never buried. Order: published first, then newest first, so
// fresh publications lead the grid instead of sitting under coming-soon cards.
function renderArchiveCards(stories) {
  const rank = s => (s.published ? 0 : 1);
  const dkey = s => s.publishedISO || "0000-00-00";
  return stories.slice()
    .sort((a, b) => rank(a) - rank(b) || (dkey(a) < dkey(b) ? 1 : dkey(a) > dkey(b) ? -1 : 0) || b.id - a.id)
    .map(renderArchiveCard)
    .join("\n\n");
}

function renderQuote(site) {
  const q = site.featuredQuote;
  return [
    `        <blockquote class="resolve quote-held">&ldquo;${text(q.text)}&rdquo;</blockquote>`,
    `        <cite class="reveal pace-primary quote-held">${text(q.cite)}</cite>`
  ].join("\n");
}

function renderBookProgress(site) {
  return `        <p class="book-progress">${text(site.book.progress)}</p>`;
}

// Rotating framed portraits for the About exhibit (homepage only). Data-driven
// from the visible family members who have a primary photograph; the rotation
// itself (crossfade, pause, reduced-motion) is handled in experience.js.
function renderHomePortraits(entities) {
  const people = ((entities.family && entities.family.people) || []).filter(p => !p.hidden);
  const withPhoto = people.filter(p => p.photos && !Array.isArray(p.photos) && p.photos.items && p.photos.items.length && p.photos.primary);
  const sizes = "(max-width:720px) 60vw, 300px";
  return withPhoto.map((p, i) => {
    const ph = p.photos;
    const it = ph.items.find(x => x.id === ph.primary) || ph.items[0];
    if (!it || !it.portrait || !it.portrait.length) return "";
    const dir = `assets/photos/${p.id}/`;
    const set = ext => it.portrait.map(w => `${dir}${it.id}.portrait.${w}.${ext} ${w}w`).join(", ");
    const largest = it.portrait[it.portrait.length - 1];
    const f = it.focus || { x: 50, y: 42 };
    const pic = `<picture><source type="image/webp" srcset="${set("webp")}" sizes="${sizes}">` +
      `<img src="${dir}${it.id}.portrait.${largest}.jpg" srcset="${set("jpg")}" sizes="${sizes}" ` +
      `width="${largest}" height="${largest}" style="object-position:${f.x}% ${f.y}%" alt="" loading="lazy" decoding="async"></picture>`;
    return `          <span class="ap-slide${i === 0 ? " is-visible" : ""}" data-name="${attr(p.name)}" data-role="${attr(p.role || "")}">${pic}</span>`;
  }).filter(Boolean).join("\n");
}

/* ---------- index.html ---------- */
function buildIndex(site, stories, featured, journeys, entities) {
  const file = path.join(ROOT, "index.html");
  let html = fs.readFileSync(file, "utf8");

  if (featured) {
    html = injectRegion(html, "TW_TITLE", renderThisWeekTitle(featured));
    html = injectRegion(html, "TW_BODY", renderThisWeekBody(featured));
  }
  html = injectRegion(html, "ABOUT_PORTRAITS", renderHomePortraits(entities));
  html = injectRegion(html, "DISCOVER", journeysLib.renderDiscoverCards(journeys || [], ""));
  html = injectRegion(html, "ARCHIVE_CARDS", renderArchiveCards(stories));
  html = injectRegion(html, "ARCHIVE_COUNT", `${site.archiveTotal}`);
  html = injectRegion(html, "QUOTE", renderQuote(site));
  html = injectRegion(html, "BOOK_PROGRESS", renderBookProgress(site));

  fs.writeFileSync(file, html);
  return file;
}

/* ---------- story page: knowledge-graph blocks ---------- */
function renderStoryConnections(conn) {
  if (!conn || !conn.total) return "";
  const groups = Object.keys(KIND).map(kind => {
    const list = conn.groups[kind] || [];
    if (!list.length) return "";
    const chips = list.map(e =>
      `<a class="entity-chip" data-entity-id="${attr(e.id)}" data-kind="${kind}" href="../${entityUrl(e)}"><span class="ec-dot" style="background:${KIND[kind].color}"></span>${text(e.name)}</a>`
    ).join("\n            ");
    return `          <div class="entity-group">
            <h3>${text(KIND[kind].label)}</h3>
            <div class="entity-chips">
            ${chips}
            </div>
          </div>`;
  }).filter(Boolean).join("\n");
  if (!groups) return "";
  return `
  <section class="story-connections" aria-label="In this memory">
    <div class="container reveal">
      <p class="eyebrow">Woven through this memory</p>
      <h2>People, places &amp; things</h2>
      <div class="entity-groups">
${groups}
      </div>
    </div>
  </section>`;
}

function renderRelatedMemories(rels) {
  if (!rels || !rels.length) return "";
  const cards = rels.slice(0, 4).map(r => {
    const via = r.via.slice(0, 4).map(e => text(e.name)).join(", ");
    const href = r.story.published ? `../${r.story.url}` : "../index.html#archive";
    const meta = r.story.published ? `Story No. ${r.story.id}` : "Coming soon";
    return `        <a class="related-card" href="${href}">
          <span class="rc-title">${text(r.story.title)}</span>
          <span class="rc-via">Shares ${via}</span>
          <span class="rc-meta">${meta} →</span>
        </a>`;
  }).join("\n");
  return `
  <section class="related-memories" aria-label="Related memories">
    <div class="container reveal">
      <p class="eyebrow">Threads that cross here</p>
      <h2>Related memories</h2>
      <div class="related-grid">
${cards}
      </div>
    </div>
  </section>`;
}

/* ---------- story pages ---------- */
function storyPageHTML(s, site, graph, journey, journeys) {
  const canonical = `${site.domain}/story/${s.id}-${s.slug}.html`;
  const titleTag = `${s.title} — Harlan's Legacy`;
  const desc = s.description || s.summary || "";
  const ogDesc = s.ogDescription || desc;
  // Immersive reader: prose woven with data-driven photo & memory modules.
  const composedBody = graph
    ? readerLib.composeBody(s, graph, "../")
    : [s.lead, ...(s.body || [])].filter(Boolean).map(p => `          <p>${p}</p>`).join("\n\n");
  const mastheadMeta = readerLib.mastheadMeta(s);
  const codaHTML = readerLib.endingCoda(s, site);
  const moreCount = Math.max(0, site.archiveTotal - 1);
  const connectionsHTML = graph ? renderStoryConnections(graph.storyConnections[s.id]) : "";
  const relatedHTML = graph ? renderRelatedMemories(graph.relatedMemories[s.id]) : "";
  const exploreHTML = graph ? exploreLib.renderContinueExploring(
    { type: "story", story: s, selfKey: "s:" + s.id }, graph, journeys || [], "../") : "";
  const journeyHTML = journey ? `
  <section class="story-journey" aria-label="Memory journey">
    <div class="container reveal">
      <a class="journey-belong" href="../${attr(journey.url)}"><span class="jb-dot" style="background:var(--thread)"></span><span class="jb-label">Part of the journey</span><span class="jb-topic">${text(journey.topic)} →</span></a>
    </div>
  </section>` : "";

  return `<!DOCTYPE html>
<html lang="en" data-theme="day">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script>
(function(){
  try {
    var saved = window.localStorage.getItem("hl-theme");
    if (saved === "night" || saved === "day") {
      document.documentElement.setAttribute("data-theme", saved);
    } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      document.documentElement.setAttribute("data-theme", "night");
    }
  } catch(e) {}
})();
</script>
<title>${text(titleTag)}</title>
<meta name="description" content="${attr(desc)}">
<meta name="theme-color" content="#F7F2E9">
<link rel="canonical" href="${attr(canonical)}">

<meta property="og:type" content="article">
<meta property="og:site_name" content="Harlan's Legacy">
<meta property="og:title" content="${attr(titleTag)}">
<meta property="og:description" content="${attr(ogDesc)}">
<meta property="og:url" content="${attr(canonical)}">
<meta property="og:locale" content="en_US">

<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${attr(titleTag)}">
<meta name="twitter:description" content="${attr(ogDesc)}">

<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23F7F2E9'/%3E%3Cpath d='M16 6c-2 4-4 6-4 9a4 4 0 0 0 8 0c0-3-2-5-4-9z' fill='%23B5502E'/%3E%3Crect x='13' y='19' width='6' height='7' rx='1' fill='%234A5261'/%3E%3C/svg%3E" type="image/svg+xml">
<link rel="icon" href="../assets/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="../assets/apple-touch-icon.png">
<link rel="manifest" href="../site.webmanifest">

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "identifier": "story-${s.id}",
  "headline": ${JSON.stringify(s.title)},
  "description": ${JSON.stringify(ogDesc)},
  "datePublished": ${JSON.stringify(s.publishedISO || "")},
  "author": { "@type": "Person", "name": "Hal" },
  "about": { "@type": "Person", "name": "Harlan" },
  "isPartOf": { "@type": "WebSite", "name": "Harlan's Legacy", "url": "${site.domain}/" },
  "mainEntityOfPage": "${canonical}"
}
</script>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,340;0,9..144,440;0,9..144,560;1,9..144,440;1,9..144,560&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400;1,6..72,500&family=Special+Elite&display=swap" rel="stylesheet">

<style>
@font-face{
  font-family: "Fraunces Fallback";
  src: local("Georgia"), local("Times New Roman");
  size-adjust: 103%;
  ascent-override: 92%;
  descent-override: 24%;
}
@font-face{
  font-family: "Newsreader Fallback";
  src: local("Georgia"), local("Times New Roman");
  size-adjust: 100%;
  ascent-override: 90%;
  descent-override: 22%;
}

:root{
  --paper-base:   #F7F2E9;
  --paper-raised: #FBF7EF;
  --paper-deep:   #EDE5D4;
  --ink-primary:  #1C2430;
  --ink-secondary:#4A5261;
  --ink-muted:    #6C6F71;
  --ink-whisper:  #B8B4A8;

  --ember-core:  #B5502E;
  --ember-deep:  #8C3D22;
  --ember-glow:  #E2A46B;

  --thread:   ${s.threadHex}; /* this story's own thread */

  --font-display: "Fraunces", "Fraunces Fallback", Georgia, serif;
  --font-reading: "Newsreader", "Newsreader Fallback", Georgia, serif;
  --font-voice:   "Special Elite", "Courier New", monospace;

  --text-h1:      clamp(2.1rem, 1.7rem + 1.8vw, 3.1rem);
  --text-h2:      clamp(1.6rem, 1.4rem + 0.9vw, 2.1rem);
  --text-body-lg: clamp(1.15rem, 1.08rem + 0.3vw, 1.3rem);
  --text-body:    clamp(1.0625rem, 1rem + 0.25vw, 1.1875rem);
  --text-caption: 0.9rem;
  --text-label:   0.78rem;

  --sp-1: 0.5rem;  --sp-2: 1rem;   --sp-3: 1.5rem; --sp-4: 2rem;
  --sp-5: 3rem;    --sp-6: 4rem;   --sp-7: 6rem;   --sp-8: 8rem;

  --measure: 68ch;
  --ease-settle: cubic-bezier(.22,.61,.36,1);
  --dur-quiet: 320ms;
  --dur-slow: 520ms;
  --radius-soft: 6px;
  --header-height: 72px;
  color-scheme: light;
}
html[data-theme="night"]{
  --paper-base:   #161B24;
  --paper-raised: #1D2430;
  --paper-deep:   #10141C;
  --ink-primary:  #EDE6D6;
  --ink-secondary:#C9C2B2;
  --ink-muted:    #8B8A82;
  --ink-whisper:  #3A4150;
  --ember-core:   #D08059;
  --ember-deep:   #E2A46B;
  --ember-glow:   #E2A46B;
  color-scheme: dark;
}

*, *::before, *::after{ box-sizing: border-box; }
html{ scroll-behavior: smooth; scrollbar-gutter: stable; }
[hidden]{ display: none !important; }
#story, #main{ scroll-margin-top: calc(var(--header-height) + 1rem); }
@media (prefers-reduced-motion: reduce){
  html{ scroll-behavior: auto; }
  *, *::before, *::after{
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
body{
  margin: 0;
  background: var(--paper-base);
  color: var(--ink-primary);
  font-family: var(--font-reading);
  font-size: var(--text-body);
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
  transition: background var(--dur-slow) var(--ease-settle), color var(--dur-slow) var(--ease-settle);
  opacity: 0;
}
body.is-ready{ opacity: 1; transition: opacity 620ms var(--ease-settle); }
@media (prefers-reduced-motion: reduce){ body{ opacity: 1; } }

h1,h2{ font-family: var(--font-display); font-weight: 560; line-height: 1.12; margin: 0 0 var(--sp-3); letter-spacing: -0.01em; }
h1{ font-size: var(--text-h1); }
em{ font-style: italic; }
p{ margin: 0 0 var(--sp-3); }
a{ color: inherit; }
img, svg{ display:block; max-width:100%; }

.container{ max-width: 880px; margin: 0 auto; padding-inline: var(--sp-4); }
@media (max-width: 640px){ .container{ padding-inline: var(--sp-3); } }
.eyebrow{
  font-family: var(--font-reading); font-size: var(--text-label);
  letter-spacing: 0.16em; text-transform: uppercase; color: var(--ember-core);
  font-weight: 500; display: inline-flex; align-items: center; gap: var(--sp-1);
}
.visually-hidden{ position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }

a, button, input, summary{ outline: none; }
a:focus-visible, input:focus-visible, summary:focus-visible{
  outline: 2px solid var(--ember-core); outline-offset: 3px; border-radius: 2px;
}
.btn:focus-visible{ outline: 2px solid var(--ember-core); outline-offset: 3px; border-radius: var(--radius-soft); }
.theme-toggle:focus-visible, .candle-indicator:focus-visible{
  outline: 2px solid var(--ember-core); outline-offset: 3px; border-radius: 999px;
}
.nav-toggle:focus-visible{ outline: 2px solid var(--ember-core); outline-offset: 3px; border-radius: var(--radius-soft); }

.skip-link{
  position: absolute; left: var(--sp-2); top: -60px;
  background: var(--ink-primary); color: var(--paper-base);
  padding: var(--sp-2) var(--sp-3); border-radius: var(--radius-soft);
  z-index: 200; transition: top var(--dur-quiet) var(--ease-settle);
  font-size: var(--text-caption); letter-spacing: 0.04em;
}
.skip-link:focus{ top: var(--sp-2); }

.btn{
  display: inline-flex; align-items: center; gap: 0.5em;
  font-family: var(--font-reading); font-size: var(--text-body); font-weight: 500;
  padding: 0.85em 1.6em; border-radius: var(--radius-soft); border: 1px solid transparent;
  cursor: pointer; text-decoration: none;
  transition: background var(--dur-quiet) var(--ease-settle), color var(--dur-quiet) var(--ease-settle), border-color var(--dur-quiet) var(--ease-settle);
}
.btn-quiet{
  background: transparent; color: var(--ink-primary);
  border-bottom: 1px solid var(--ink-whisper); border-radius: 0; padding: 0.3em 0.1em;
}
.btn-quiet:hover{ border-color: var(--ember-core); color: var(--ember-core); }

/* ===== HEADER (not sticky here — the whole page is the reading state) ===== */
.site-header{
  border-bottom: 1px solid var(--ink-whisper);
  background: var(--paper-base);
}
.header-row{ display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding-block: var(--sp-2); }
.brand{
  display: flex; align-items: center; gap: 0.6rem; text-decoration: none; color: var(--ink-primary);
  font-family: var(--font-display); font-size: 1.25rem; font-weight: 560; letter-spacing: -0.01em;
}
.brand svg{ width: 24px; height: 24px; flex-shrink: 0; }
.desktop-nav{ display: flex; align-items: center; gap: var(--sp-4); }
.desktop-nav ul{ list-style: none; display: flex; gap: var(--sp-3); margin: 0; padding: 0; }
.desktop-nav a{
  text-decoration: none; font-size: var(--text-label); text-transform: uppercase;
  letter-spacing: 0.12em; color: var(--ink-secondary); position: relative; padding-bottom: 4px;
}
.desktop-nav a::after{ content:""; position: absolute; left:0; right:100%; bottom:0; height: 1px; background: var(--ember-core); transition: right var(--dur-quiet) var(--ease-settle); }
.desktop-nav a:hover{ color: var(--ink-primary); }
.desktop-nav a:hover::after{ right: 0; }

.candle-indicator{
  display: flex; align-items: center; gap: 0.55rem; font-size: var(--text-label);
  letter-spacing: 0.06em; color: var(--ink-secondary); padding: 0.35em 0.75em;
  border: 1px solid var(--ink-whisper); border-radius: 999px; white-space: nowrap;
}
.candle-indicator svg{ width: 15px; height: 15px; }
.candle-indicator .flame{ fill: var(--ink-whisper); transition: fill var(--dur-slow) var(--ease-settle); }
.candle-indicator.is-lit{ border-color: var(--ember-glow); color: var(--ember-core); }
.candle-indicator.is-lit .flame{ fill: var(--ember-core); }
.candle-indicator.is-lit .flame-flicker{ animation: flicker 2.6s ease-in-out infinite; transform-origin: 50% 85%; }
@keyframes flicker{ 0%,100%{ transform: scale(1); } 50%{ transform: scale(1.08) translateY(-0.4px); } }

.nav-toggle{
  display: none; background: none; border: 1px solid var(--ink-whisper); border-radius: var(--radius-soft);
  padding: 0.5em 0.7em; min-width: 44px; min-height: 44px; align-items: center; justify-content: center; cursor: pointer;
}
.nav-toggle svg{ width: 20px; height: 20px; }
.theme-toggle{
  background: none; border: 1px solid var(--ink-whisper); border-radius: 999px;
  width: 34px; height: 34px; min-width: 44px; min-height: 44px;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
  color: var(--ink-secondary); flex-shrink: 0;
}
.theme-toggle:hover{ border-color: var(--ember-core); color: var(--ember-core); }
.theme-toggle svg{ width: 16px; height: 16px; }
.theme-toggle .icon-sun{ display: none; }
html[data-theme="night"] .theme-toggle .icon-moon{ display: none; }
html[data-theme="night"] .theme-toggle .icon-sun{ display: block; }

.mobile-panel{
  position: fixed; inset: 0; background: var(--paper-base); z-index: 150;
  display: flex; flex-direction: column; padding: var(--sp-3) var(--sp-4) var(--sp-6);
  transform: translateY(-8px); opacity: 0; pointer-events: none;
  transition: opacity var(--dur-quiet) var(--ease-settle), transform var(--dur-quiet) var(--ease-settle);
}
.mobile-panel.is-open{ opacity: 1; transform: translateY(0); pointer-events: auto; }
.mobile-panel-top{ display:flex; align-items:center; justify-content: space-between; margin-bottom: var(--sp-6); }
.mobile-panel nav ul{ list-style: none; margin:0; padding:0; display:flex; flex-direction:column; gap: var(--sp-4); }
.mobile-panel nav a{ font-family: var(--font-display); font-weight: 440; font-size: clamp(1.5rem, 1.15rem + 4vw, 1.9rem); text-decoration:none; color: var(--ink-primary); }
.mobile-panel-bottom{ margin-top: var(--sp-6); display: flex; align-items: center; gap: var(--sp-3); }
body.panel-open{ overflow: hidden; }

/* ===== STORY ===== */
section{ padding-block: var(--sp-7); }
#story{ position: relative; }
#story::before{
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(ellipse 62% 48% at 50% 10%, color-mix(in srgb, var(--ember-glow) 16%, transparent) 0%, transparent 68%),
    radial-gradient(ellipse 120% 100% at 50% 50%, transparent 50%, color-mix(in srgb, var(--ink-primary) 4.5%, transparent) 100%);
}
#story > .container{ position: relative; z-index: 1; }

.reveal{ opacity: 0; transform: translateY(14px); transition: opacity 700ms var(--ease-settle), transform 700ms var(--ease-settle); }
.reveal.is-visible{ opacity: 1; transform: translateY(0); }
.resolve{ opacity: 0; filter: blur(14px); transform: scale(1.015); transition: opacity 1000ms var(--ease-settle), filter 1000ms var(--ease-settle), transform 1000ms var(--ease-settle); }
.resolve.is-visible{ opacity: 1; filter: blur(0); transform: scale(1); }
@media (prefers-reduced-motion: reduce){ .reveal, .resolve{ opacity:1; transform:none; filter:none; } }

.story-stamp{
  display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3);
}
.story-stamp .thread-dot{ width: 8px; height: 8px; border-radius: 50%; background: var(--thread); flex-shrink: 0; }
.story-stamp .meta{
  font-family: var(--font-voice); font-size: 0.78rem; letter-spacing: 0.03em; color: var(--ink-muted);
}

.story-card{ max-width: var(--measure); }
.story-card h1{ margin-top: var(--sp-2); margin-bottom: var(--sp-4); }
.story-body{ font-size: var(--text-body-lg); color: var(--ink-primary); }
.story-body p{ margin-bottom: var(--sp-3); }
.story-body em{ font-style: italic; }

.reading-thread{
  position: fixed; left: 0; top: 0; bottom: 0; width: 3px;
  background: var(--ink-whisper); opacity: 0.35; z-index: 90; pointer-events: none;
}
.reading-thread-fill{
  position: absolute; left: 0; top: 0; width: 100%; height: 0%;
  background: var(--thread); transition: height 60ms linear;
}
@media (prefers-reduced-motion: reduce){ .reading-thread-fill{ transition: none; } }
@media (max-width: 720px){ .reading-thread{ display: none; } }

.ending-mark{ width: 8px; height: 8px; border-radius: 50%; background: var(--thread); margin: var(--sp-5) 0; }

/* ===== JOURNEY BELONGING (Guided Discovery cross-link) ===== */
.story-journey .container{ max-width: 760px; }
.journey-belong{ display: inline-flex; align-items: center; gap: 0.7em; text-decoration: none; color: var(--ink-secondary);
  border: 1px solid var(--ink-whisper); border-radius: 999px; padding: 0.55em 1.1em;
  transition: border-color var(--dur-quiet) var(--ease-settle), color var(--dur-quiet) var(--ease-settle), transform var(--dur-quiet) var(--ease-settle); }
.journey-belong:hover{ border-color: var(--ember-core); transform: translateY(-1px); }
.journey-belong .jb-dot{ width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.journey-belong .jb-label{ font-size: var(--text-label); text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-muted); }
.journey-belong .jb-topic{ font-family: var(--font-display); font-weight: 500; color: var(--ink-primary); }

.marginalia{ margin-top: var(--sp-5); padding-top: var(--sp-4); border-top: 1px dashed var(--ink-whisper); }
.marginalia p.prompt{ font-size: var(--text-caption); color: var(--ink-secondary); margin-bottom: var(--sp-2); }
.marginalia-form{ display:flex; gap: var(--sp-2); flex-wrap: wrap; }
.marginalia-form input[type="text"]{
  flex: 1 1 260px; background: transparent; border: none; border-bottom: 1px solid var(--ink-whisper);
  padding: 0.6em 0.2em; font-family: var(--font-reading); font-size: var(--text-body); color: var(--ink-primary);
}
.marginalia-form input[type="text"]:focus{ border-color: var(--ember-core); }
.marginalia-notes{ margin-top: var(--sp-4); display:flex; flex-direction:column; gap: var(--sp-2); }
.marginalia-note{ font-family: var(--font-voice); font-size: 0.98rem; color: var(--ink-secondary); padding-left: var(--sp-3); border-left: 2px solid var(--thread); }

/* ===== KNOWLEDGE GRAPH: connections + related memories ===== */
.story-connections{ border-top: 1px solid var(--ink-whisper); background: var(--paper-raised); }
.story-connections .container, .related-memories .container{ max-width: 760px; }
.story-connections h2, .related-memories h2{ font-size: var(--text-h2); margin-bottom: var(--sp-4); }
.entity-groups{ display: grid; gap: var(--sp-4); }
.entity-group h3{ font-size: var(--text-label); text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-muted); font-weight: 500; margin: 0 0 var(--sp-2); }
.entity-chips{ display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.entity-chip{
  display: inline-flex; align-items: center; gap: 0.55em;
  font-size: var(--text-caption); text-decoration: none; color: var(--ink-primary);
  background: var(--paper-base); border: 1px solid var(--ink-whisper); border-radius: 999px;
  padding: 0.45em 0.9em;
  transition: border-color var(--dur-quiet) var(--ease-settle), transform var(--dur-quiet) var(--ease-settle), background var(--dur-quiet) var(--ease-settle);
}
.entity-chip:hover{ border-color: var(--ember-core); transform: translateY(-1px); }
.entity-chip .ec-dot{ width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

.related-memories{ border-top: 1px solid var(--ink-whisper); }
.related-grid{ display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--sp-2); }
@media (max-width: 640px){ .related-grid{ grid-template-columns: 1fr; } }
.related-card{
  display: flex; flex-direction: column; gap: 0.35rem;
  text-decoration: none; color: var(--ink-primary);
  background: var(--paper-raised); border: 1px solid var(--ink-whisper); border-radius: var(--radius-soft);
  padding: var(--sp-3);
  transition: transform var(--dur-quiet) var(--ease-settle), box-shadow var(--dur-quiet) var(--ease-settle), border-color var(--dur-quiet) var(--ease-settle);
}
.related-card:hover{ transform: translateY(-2px); box-shadow: 0 8px 24px -14px rgba(60,40,20,0.25); border-color: var(--ink-secondary); }
.related-card .rc-title{ font-family: var(--font-display); font-weight: 560; font-size: 1.1rem; }
.related-card .rc-via{ font-size: var(--text-caption); color: var(--ink-secondary); }
.related-card .rc-meta{ font-family: var(--font-voice); font-size: 0.7rem; letter-spacing: 0.03em; color: var(--ink-muted); }

/* ===== RETURN TO ARCHIVE ===== */
.return-invite{ border-top: 1px solid var(--ink-whisper); }
.return-invite .container{ max-width: 640px; text-align: center; }
.return-invite p{ color: var(--ink-secondary); margin-bottom: var(--sp-3); }

/* ===== FOOTER ===== */
footer{ border-top: 1px solid var(--ink-whisper); padding-block: var(--sp-6) var(--sp-5); }
.footer-grid{ display:flex; justify-content:space-between; gap: var(--sp-5); flex-wrap: wrap; margin-bottom: var(--sp-5); }
.footer-col h4{ font-family: var(--font-reading); font-size: var(--text-label); text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-muted); margin: 0 0 var(--sp-2); font-weight: 500; }
.footer-col ul{ list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap: 0.6rem; }
.footer-col a{ text-decoration:none; color: var(--ink-secondary); font-size: 0.95rem; }
.footer-col a:hover{ color: var(--ember-core); }
.footer-colophon{ font-size: var(--text-caption); color: var(--ink-muted); max-width: 60ch; }
.footer-bottom{
  display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap: var(--sp-2);
  padding-top: var(--sp-4); border-top: 1px solid var(--ink-whisper); font-size: var(--text-caption); color: var(--ink-muted);
}

@media (max-width: 720px){
  .desktop-nav{ display:none; }
  .nav-toggle{ display:inline-flex; align-items:center; justify-content:center; }
  section{ padding-block: var(--sp-6); }
  .footer-grid{ flex-direction:column; gap: var(--sp-4); }
}

/* =========================================================
   PHASE 11A — IMMERSIVE READER
   A cinematic, museum-grade reading experience woven from the
   memory's own data. Additive: layers over .story-body without
   touching the tracking hooks, ending-mark, bookmark or marginalia.
   ========================================================= */
#story{ padding-block: clamp(var(--sp-5), 6vw, var(--sp-8)); }
.story-card{ max-width: 44rem; margin-inline: auto; }

/* --- Masthead --- */
.story-masthead{ margin-bottom: clamp(var(--sp-4), 4vw, var(--sp-6)); }
.story-masthead .story-stamp{ margin-bottom: var(--sp-3); }
.story-masthead .meta{ text-transform: uppercase; letter-spacing: 0.14em; font-size: 0.72rem; }
.story-card h1{ font-size: clamp(2.3rem, 1.7rem + 2.6vw, 3.7rem); line-height: 1.06; letter-spacing: -0.018em;
  margin: var(--sp-2) 0 0; text-wrap: balance; }
.story-byline{ font-family: var(--font-voice); font-size: 0.8rem; letter-spacing: 0.02em; color: var(--ink-muted);
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.55em; margin-top: var(--sp-3); }
.story-byline .sm-dot{ opacity: 0.45; }
.story-byline .sm-by{ color: var(--ink-secondary); }

/* --- Reading rhythm --- */
.story-body{ font-size: clamp(1.18rem, 1.08rem + 0.4vw, 1.36rem); line-height: 1.85; color: var(--ink-primary);
  /* How far a full-bleed image may break past the text column — never more than
     the actual margin beside the 44rem story column, so it can never overflow
     the viewport at tablet widths. */
  --bleed: clamp(0px, calc((100vw - 44rem) / 2 - 1rem), 130px); }
.story-body::after{ content: ""; display: block; clear: both; }
.story-body > p{ margin: 0 0 1.4em; max-width: 62ch; }
.story-body > p > em{ font-style: italic; }
.lede-para{ }
@supports (initial-letter: 3) or (-webkit-initial-letter: 3){
  .lede-para::first-letter{ -webkit-initial-letter: 3; initial-letter: 3; color: var(--ember-core);
    font-family: var(--font-display); font-weight: 560; margin-right: 0.08em; }
}
@supports not ((initial-letter: 3) or (-webkit-initial-letter: 3)){
  .lede-para::first-letter{ float: left; font-family: var(--font-display); font-weight: 560;
    font-size: 3.4em; line-height: 0.72; padding: 0.04em 0.12em 0 0; color: var(--ember-core); }
}

/* --- Pull quote (the memory's own summary, given room) --- */
.mem-pullquote{ margin: clamp(var(--sp-5), 6vw, var(--sp-7)) auto; max-width: 32ch; text-align: center; clear: both; }
.mem-pullquote blockquote{ position: relative; margin: 0; font-family: var(--font-display); font-weight: 440; font-style: italic;
  font-size: clamp(1.55rem, 1.2rem + 1.7vw, 2.35rem); line-height: 1.26; color: var(--ink-primary); }
.mem-pullquote blockquote::before{ content: "\\201C"; display: block; font-size: 2.4em; line-height: 0.1; margin-bottom: 0.32em;
  color: var(--thread); opacity: 0.4; font-family: var(--font-display); }

/* --- Portrait pull (a face beside the prose) --- */
.mem-portrait{ float: right; width: clamp(180px, 33%, 240px); margin: 0.4em 0 var(--sp-3) var(--sp-4); }
.mem-portrait .mp-frame{ display: block; aspect-ratio: 4/5; padding: 8px; background: var(--paper-raised);
  border: 1px solid var(--ink-whisper); box-shadow: 0 2px 4px rgba(60,40,20,0.06), 0 22px 46px -26px rgba(60,40,20,0.42); }
.mem-portrait img{ width: 100%; height: 100%; object-fit: cover; display: block; }
.mem-portrait figcaption{ margin-top: 0.65rem; text-align: center; }
.mp-name{ display: block; font-family: var(--font-display); font-weight: 560; font-size: 0.98rem; }
.mp-role{ display: block; font-family: var(--font-voice); font-size: 0.66rem; letter-spacing: 0.03em; color: var(--ink-muted); margin-top: 0.15rem; }

/* --- Full-width memory photograph (landscape breaks out; portrait is a plate) --- */
.mem-photo{ clear: both; margin: clamp(var(--sp-5), 6vw, var(--sp-7)) 0;
  width: calc(100% + 2 * var(--bleed)); margin-inline: calc(-1 * var(--bleed)); }
.mem-photo.is-portrait{ width: min(100%, 460px); margin-inline: auto; }
.mem-photo .mph-frame{ overflow: hidden; border-radius: 2px; background: var(--paper-deep);
  box-shadow: 0 3px 8px rgba(60,40,20,0.10), 0 44px 90px -46px rgba(60,40,20,0.5); }
.mem-photo img{ width: 100%; height: auto; display: block; }
.mem-photo figcaption{ margin-top: 0.75rem; display: flex; justify-content: center; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; text-align: center; }
.mph-cap{ font-family: var(--font-reading); font-style: italic; font-size: 0.92rem; color: var(--ink-secondary); }
.mph-meta{ font-family: var(--font-voice); font-size: 0.66rem; letter-spacing: 0.04em; color: var(--ink-muted); }

/* --- Memory callouts (object / place / event, from the graph) --- */
.mem-callout{ clear: both; margin: clamp(var(--sp-4), 4vw, var(--sp-5)) 0; max-width: 46ch;
  padding: var(--sp-3) var(--sp-4); background: var(--paper-raised); border: 1px solid var(--ink-whisper);
  border-left: 3px solid var(--tab, var(--thread)); border-radius: var(--radius-soft); }
.mem-callout .mc-kind{ display: inline-flex; align-items: center; gap: 0.45em; font-family: var(--font-voice);
  font-size: 0.64rem; letter-spacing: 0.09em; text-transform: uppercase; color: var(--tab, var(--ember-core)); }
.mem-callout .mc-kind svg{ width: 15px; height: 15px; }
.mem-callout .mc-name{ display: inline-block; font-family: var(--font-display); font-weight: 560; font-size: 1.22rem;
  color: var(--ink-primary); text-decoration: none; margin-top: 0.25rem; }
.mem-callout .mc-name:hover{ color: var(--ember-core); }
.mem-callout .mc-detail{ font-size: 0.94rem; color: var(--ink-secondary); line-height: 1.5; margin: 0.35rem 0 0; }

/* --- Chapter pause --- */
.mem-pause{ display: flex; justify-content: center; gap: 0.85rem; margin: clamp(var(--sp-4), 5vw, var(--sp-6)) 0; clear: both; }
.mem-pause span{ width: 5px; height: 5px; border-radius: 50%; background: var(--ink-whisper); }
.mem-pause span:nth-child(2){ background: var(--thread); transform: translateY(-1px); }

/* --- Ending coda (bridges into exploration) --- */
.story-coda .container{ max-width: 40rem; text-align: center; padding-block: clamp(var(--sp-5), 6vw, var(--sp-7)); }
.coda-mark{ display: inline-flex; gap: 0.7rem; justify-content: center; margin-bottom: var(--sp-3); }
.coda-mark span{ width: 6px; height: 6px; border-radius: 50%; background: var(--thread); opacity: 0.55; }
.coda-mark span:nth-child(2){ opacity: 1; transform: translateY(-3px); }
.coda-line{ font-family: var(--font-display); font-size: clamp(1.3rem, 1.05rem + 1.1vw, 1.75rem); line-height: 1.3;
  color: var(--ink-primary); margin-bottom: var(--sp-2); text-wrap: balance; }
.coda-sub{ color: var(--ink-secondary); max-width: 44ch; margin-inline: auto; }

@media (max-width: 640px){
  .mem-portrait{ float: none; width: min(66%, 260px); margin: var(--sp-4) auto; }
  .mem-photo{ width: 100%; margin-inline: 0; }
  .story-body > p{ max-width: none; }
}

/* =========================================================
   PHASE 11A.5 — MASTERPIECE CRAFTSMANSHIP
   Refinement only. Elevates rhythm, choreography, photography
   and micro-interactions. Every rule has purpose; all motion is
   gated behind prefers-reduced-motion.
   ========================================================= */

/* Masthead: a small thread tick — a quiet "the story begins". */
.story-masthead{ position: relative; }
.story-masthead::after{ content: ""; display: block; width: 38px; height: 2px; border-radius: 2px;
  background: var(--thread); opacity: 0.85; margin-top: clamp(var(--sp-3), 3vw, var(--sp-4)); }
.story-byline .sm-when{ color: var(--ink-secondary); }

/* Reading rhythm: fewer orphans, no hyphenation, a hair more air, a subtly
   weightier opening paragraph. */
.story-body{ line-height: 1.88; hanging-punctuation: first last; }
.story-body > p{ text-wrap: pretty; hyphens: none; max-width: 63ch; }
.lede-para{ font-size: 1.05em; }

/* Photographic reveals — a gentle "developing" settle (never flashy). */
@media (prefers-reduced-motion: no-preference){
  .mem-photo, .mem-diptych, .mem-portrait{ transition: opacity 1000ms var(--ease-settle), transform 1000ms var(--ease-settle); }
  .mem-photo:not(.is-visible), .mem-diptych:not(.is-visible){ opacity: 0; transform: translateY(22px) scale(0.986); }
  .mem-portrait:not(.is-visible){ opacity: 0; transform: translateY(16px); }
  .mem-photo.is-visible, .mem-diptych.is-visible, .mem-portrait.is-visible{ opacity: 1; transform: none; }
  .mem-photo img, .mem-diptych img{ transition: filter 1300ms var(--ease-settle), transform 900ms var(--ease-settle); }
  .mem-photo:not(.is-visible) img, .mem-diptych:not(.is-visible) img{ filter: saturate(0.82) contrast(0.97); }
}

/* Portrait pull: alternating sides + a handcrafted frame lift on hover. */
.mem-portrait.pull-left{ float: left; margin: 0.4em var(--sp-4) var(--sp-3) 0; }
.mem-portrait .mp-frame{ transition: transform 550ms var(--ease-settle), box-shadow 550ms var(--ease-settle); }
.mem-portrait:hover .mp-frame{ transform: translateY(-3px); box-shadow: 0 4px 8px rgba(60,40,20,0.08), 0 30px 56px -24px rgba(60,40,20,0.5); }

/* Plate widths by orientation; a whisper of zoom on hover invites a closer look. */
.mem-photo.is-square{ width: min(100%, 560px); margin-inline: auto; }
.mem-photo .mph-frame img{ transform-origin: center; }
.mem-photo:hover .mph-frame img{ transform: scale(1.028); }

/* Diptych — two moments held side by side. */
.mem-diptych{ clear: both; margin: clamp(var(--sp-5), 6vw, var(--sp-7)) 0; display: grid; grid-template-columns: 1fr 1fr;
  gap: clamp(0.5rem, 1.6vw, 1.1rem); width: calc(100% + 2 * min(var(--bleed), 90px)); margin-inline: calc(-1 * min(var(--bleed), 90px)); }
.mem-diptych .dp-cell{ margin: 0; }
.mem-diptych .dp-frame{ display: block; aspect-ratio: 4/5; overflow: hidden; background: var(--paper-deep);
  box-shadow: 0 2px 6px rgba(60,40,20,0.08), 0 30px 60px -34px rgba(60,40,20,0.45); }
.mem-diptych img{ width: 100%; height: 100%; object-fit: cover; display: block; transform-origin: center; }
.mem-diptych .dp-frame:hover img{ transform: scale(1.03); }
.mem-diptych figcaption{ margin-top: 0.5rem; text-align: center; font-family: var(--font-voice);
  font-size: 0.66rem; letter-spacing: 0.03em; color: var(--ink-muted); }
@media (max-width: 640px){ .mem-diptych{ grid-template-columns: 1fr; width: 100%; margin-inline: 0; } }

/* Callout: quiet reveal, warmer hover. */
.mem-callout{ transition: box-shadow 400ms var(--ease-settle), border-left-color 400ms var(--ease-settle); }
.mem-callout:hover{ box-shadow: 0 18px 40px -30px rgba(60,40,20,0.4); }
.mem-callout .mc-name{ transition: color 320ms var(--ease-settle); }

/* Refined reading thread: thinner, with a soft glow at the growing tip. */
.reading-thread{ width: 2px; opacity: 0.22; }
.reading-thread-fill{ box-shadow: 0 6px 12px -2px color-mix(in srgb, var(--thread) 65%, transparent); }

/* Emotional pause: "— • —" rather than three plain dots. */
.mem-pause span{ align-self: center; }
.mem-pause span:nth-child(1){ width: 26px; height: 1px; border-radius: 0; background: linear-gradient(90deg, transparent, var(--ink-whisper)); }
.mem-pause span:nth-child(3){ width: 26px; height: 1px; border-radius: 0; background: linear-gradient(90deg, var(--ink-whisper), transparent); }
.mem-pause span:nth-child(2){ width: 5px; height: 5px; }

/* Coda ornament: a thread dot flanked by hairlines; more air below. */
.coda-mark{ align-items: center; }
.coda-mark i{ display: block; width: 30px; height: 1px; background: linear-gradient(90deg, transparent, var(--ink-whisper)); }
.coda-mark i:last-child{ background: linear-gradient(90deg, var(--ink-whisper), transparent); }
.coda-mark b{ display: block; width: 7px; height: 7px; border-radius: 50%; background: var(--thread); }
.story-coda .container{ padding-block: clamp(var(--sp-6), 8vw, var(--sp-8)); }

/* Section choreography: soften hard rules into centred hairlines so the acts
   flow into one another instead of snapping. */
.story-connections{ border-top: none; }
.related-memories, .return-invite{ border-top: none; position: relative; }
.related-memories::before, .return-invite::before{ content: ""; position: absolute; top: 0; left: 50%;
  transform: translateX(-50%); width: min(78%, 40rem); height: 1px;
  background: linear-gradient(90deg, transparent, var(--ink-whisper), transparent); }

@media (prefers-reduced-motion: reduce){
  .mem-photo, .mem-diptych, .mem-portrait, .mem-callout{ opacity: 1 !important; transform: none !important; }
  .mem-photo img, .mem-diptych img{ filter: none !important; }
  .mem-portrait:hover .mp-frame, .mem-photo:hover .mph-frame img, .mem-diptych .dp-frame:hover img{ transform: none; }
}

@media print{
  .site-header, .mobile-panel, .skip-link, .theme-toggle, .candle-indicator,
  .marginalia-form, .marginalia .prompt, .reading-thread, .return-invite{ display: none !important; }
  body{ background: #fff; color: #000; opacity: 1 !important; }
  a{ color: #000; text-decoration: underline; }
}
</style>
<link rel="stylesheet" href="../assets/experience.css">
</head>
<body>
<noscript><style>body{opacity:1 !important;}</style></noscript>

<a class="skip-link" href="#main">Skip to content</a>

<div class="reading-thread" aria-hidden="true"><div class="reading-thread-fill" id="reading-thread-fill"></div></div>

<header class="site-header">
  <div class="container header-row">
    <a class="brand" href="../index.html#top">
      <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 5c-2.4 4.6-4.6 6.9-4.6 10.3a4.6 4.6 0 0 0 9.2 0c0-3.4-2.2-5.7-4.6-10.3z" fill="var(--ember-core)"/><rect x="12.6" y="20" width="6.8" height="8" rx="1" fill="var(--ink-primary)"/></svg>
      Harlan's Legacy
    </a>
    <nav class="desktop-nav" aria-label="Primary">
      <ul>
        <li><a href="../index.html#hero">Start Here</a></li>
        <li><a href="../index.html#discover">Discover</a></li>
        <li><a href="../index.html#this-week">This Week</a></li>
        <li><a href="../index.html#archive">Archive</a></li>
        <li><a href="../family.html">Family</a></li>
        <li><a href="../index.html#about">About Harlan</a></li>
      </ul>
      <button class="theme-toggle" id="theme-toggle-desktop" type="button" aria-pressed="false" aria-label="Switch to night reading">
        <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>
        <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 3v2.4M12 18.6V21M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M3 12h2.4M18.6 12H21M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/></svg>
      </button>
      <span class="candle-indicator" id="candle-indicator-desktop" role="status">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path class="flame flame-flicker" d="M12 3c-1.6 3.4-3.4 5.1-3.4 7.6a3.4 3.4 0 0 0 6.8 0C15.4 8.1 13.6 6.4 12 3z"/></svg>
        <span id="candle-label-desktop">—</span>
      </span>
    </nav>
    <button class="nav-toggle" id="nav-toggle" type="button" aria-expanded="false" aria-controls="mobile-panel" aria-label="Open menu">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
    </button>
  </div>
</header>

<div class="mobile-panel" id="mobile-panel" role="dialog" aria-modal="true" aria-label="Site menu">
  <div class="mobile-panel-top">
    <span class="brand" style="font-size:1.1rem;">Harlan's Legacy</span>
    <button class="nav-toggle" id="nav-close" type="button" aria-label="Close menu">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  </div>
  <nav aria-label="Mobile">
    <ul>
      <li><a href="../index.html#hero">Start Here</a></li>
      <li><a href="../index.html#discover">Discover</a></li>
      <li><a href="../index.html#this-week">This Week</a></li>
      <li><a href="../index.html#archive">Archive</a></li>
      <li><a href="../family.html">Family</a></li>
      <li><a href="../index.html#about">About Harlan</a></li>
    </ul>
  </nav>
  <div class="mobile-panel-bottom">
    <button class="theme-toggle" id="theme-toggle-mobile" type="button" aria-pressed="false" aria-label="Switch to night reading">
      <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>
      <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 3v2.4M12 18.6V21M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M3 12h2.4M18.6 12H21M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/></svg>
    </button>
    <span class="candle-indicator" id="candle-indicator-mobile" role="status">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path class="flame flame-flicker" d="M12 3c-1.6 3.4-3.4 5.1-3.4 7.6a3.4 3.4 0 0 0 6.8 0C15.4 8.1 13.6 6.4 12 3z"/></svg>
      <span id="candle-label-mobile">—</span>
    </span>
  </div>
</div>

<main id="main">
  <section id="story">
    <div class="container">
      <div class="story-card reveal" id="hl-story" data-story-id="${s.id}" data-theme="${attr(s.theme)}" data-reading-time="${s.readingTime || 0}" data-url="${attr(s.url)}">
        <header class="story-masthead">
          <div class="story-stamp">
            <span class="thread-dot" aria-hidden="true"></span>
            <span class="meta">Story No. ${s.id} &middot; ${text(s.themeLabel)}</span>
            <button class="hl-bookmark" type="button" data-hl-save aria-pressed="false" aria-label="Save this memory" title="Save this memory" hidden>
              <svg class="hl-bm-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-3.5L6 21z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
              <span class="hl-bm-label">Save</span>
            </button>
          </div>

          <h1 class="resolve">${text(s.title)}</h1>

          <p class="story-byline">${mastheadMeta}</p>
        </header>

        <div class="story-body">
${composedBody}

          <div class="ending-mark" aria-hidden="true"></div>
        </div>

        <div class="marginalia" id="marginalia">
          <p class="prompt">Leave a line in the margin — what did this remind you of?</p>
          <form class="marginalia-form" id="marginalia-form">
            <label class="visually-hidden" for="marginalia-input">Your note</label>
            <input type="text" id="marginalia-input" maxlength="140" placeholder="This reminded me of…" required>
            <button class="btn btn-quiet" type="submit">Leave a note</button>
          </form>
          <div class="marginalia-notes" id="marginalia-notes" aria-live="polite"></div>
        </div>
      </div>
    </div>
  </section>
${codaHTML}
${journeyHTML}${connectionsHTML}${relatedHTML}
  <section class="read-next" id="hl-read-next" aria-label="Read next" hidden>
    <div class="container reveal">
      <p class="eyebrow">Where to go next</p>
      <h2 id="hl-rn-heading">Read next</h2>
      <div class="read-next-slot" id="hl-rn-slot"></div>
    </div>
  </section>
${exploreHTML}
  <section class="return-invite">
    <div class="container reveal">
      <p>There are ${moreCount} more of these, kept the same way this one was.</p>
      <a class="btn btn-quiet" href="../index.html#archive">← Back to the archive</a>
    </div>
  </section>
</main>

<footer>
  <div class="container">
    <div class="footer-grid">
      <div class="footer-col" style="max-width:36ch;">
        <h4>Harlan's Legacy</h4>
        <p class="footer-colophon">A weekly act of remembering, kept alive one Friday at a time. Written by his brother, Hal.</p>
      </div>
      <div class="footer-col">
        <h4>Explore</h4>
        <ul>
          <li><a href="../index.html#hero">Start Here</a></li>
          <li><a href="../index.html#discover">Discover</a></li>
          <li><a href="../index.html#this-week">This Week's Story</a></li>
          <li><a href="../index.html#archive">The Archive</a></li>
          <li><a href="../family.html">The Family</a></li>
          <li><a href="../index.html#book">The Book</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h4>Elsewhere</h4>
        <ul>
          <li><a href="https://www.facebook.com/halyes" target="_blank" rel="noopener noreferrer">Facebook — where it started</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span>&copy; <span id="year"></span> Harlan's Legacy</span>
      <span>Story No. ${s.id} of ${site.archiveTotal}</span>
    </div>
  </div>
</footer>

<script>
(function(){
  "use strict";
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  window.addEventListener("load", function(){ document.body.classList.add("is-ready"); });

  var revealEls = document.querySelectorAll(".reveal, .resolve");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealEls.forEach(function(el){ el.classList.add("is-visible"); });
  } else {
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (entry.isIntersecting) { entry.target.classList.add("is-visible"); io.unobserve(entry.target); }
      });
    }, { threshold: 0, rootMargin: "0px 0px -40px 0px" });
    revealEls.forEach(function(el){ io.observe(el); });
  }

  var themeToggles = document.querySelectorAll(".theme-toggle");
  var htmlEl = document.documentElement;
  function applyTheme(theme){
    htmlEl.setAttribute("data-theme", theme);
    themeToggles.forEach(function(btn){
      btn.setAttribute("aria-pressed", theme === "night" ? "true" : "false");
      btn.setAttribute("aria-label", theme === "night" ? "Switch to day reading" : "Switch to night reading");
    });
    try { window.localStorage.setItem("hl-theme", theme); } catch(e){}
  }
  (function initTheme(){
    var current = htmlEl.getAttribute("data-theme") === "night" ? "night" : "day";
    applyTheme(current);
  })();
  themeToggles.forEach(function(btn){
    btn.addEventListener("click", function(){
      applyTheme(htmlEl.getAttribute("data-theme") === "night" ? "day" : "night");
    });
  });

  function updateCandle(){
    var day = new Date().getDay();
    var isLit = (day === 5);
    var daysUntil = (5 - day + 7) % 7;
    var label = isLit ? "Lit today — a new story" : "New story in " + daysUntil + " day" + (daysUntil === 1 ? "" : "s");
    [
      { el: document.getElementById("candle-indicator-desktop"), lbl: document.getElementById("candle-label-desktop") },
      { el: document.getElementById("candle-indicator-mobile"), lbl: document.getElementById("candle-label-mobile") }
    ].forEach(function(pair){
      if (!pair.el) return;
      pair.el.classList.toggle("is-lit", isLit);
      pair.lbl.textContent = label;
      if (reduceMotion) { var f = pair.el.querySelector(".flame-flicker"); if (f) f.style.animation = "none"; }
    });
  }
  updateCandle();

  var navToggle = document.getElementById("nav-toggle");
  var navClose = document.getElementById("nav-close");
  var panel = document.getElementById("mobile-panel");
  var lastFocused = null;
  function openPanel(){
    lastFocused = document.activeElement;
    panel.classList.add("is-open");
    document.body.classList.add("panel-open");
    navToggle.setAttribute("aria-expanded", "true");
    var firstLink = panel.querySelector("a");
    if (firstLink) firstLink.focus();
    document.addEventListener("keydown", onPanelKeydown);
  }
  function closePanel(){
    panel.classList.remove("is-open");
    document.body.classList.remove("panel-open");
    navToggle.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onPanelKeydown);
    if (lastFocused) lastFocused.focus();
  }
  function onPanelKeydown(e){ if (e.key === "Escape") closePanel(); }
  navToggle.addEventListener("click", openPanel);
  navClose.addEventListener("click", closePanel);
  panel.querySelectorAll("a").forEach(function(a){ a.addEventListener("click", closePanel); });

  var storyBody = document.querySelector(".story-body");
  var threadFill = document.getElementById("reading-thread-fill");
  function updateThread(){
    if (!storyBody || !threadFill) return;
    var rect = storyBody.getBoundingClientRect();
    var vh = window.innerHeight;
    var total = rect.height + vh;
    var passed = vh - rect.top;
    var pct = Math.max(0, Math.min(1, passed / total));
    threadFill.style.height = (pct * 100) + "%";
  }
  window.addEventListener("scroll", updateThread, { passive: true });
  window.addEventListener("resize", updateThread);
  updateThread();

  var marginaliaForm = document.getElementById("marginalia-form");
  var marginaliaNotes = document.getElementById("marginalia-notes");
  marginaliaForm.addEventListener("submit", function(e){
    e.preventDefault();
    var input = document.getElementById("marginalia-input");
    var val = input.value.trim();
    if (!val) return;
    var note = document.createElement("p");
    note.className = "marginalia-note";
    note.textContent = "\\u201C" + val + "\\u201D";
    marginaliaNotes.appendChild(note);
    input.value = "";
    input.focus();
  });

  document.getElementById("year").textContent = new Date().getFullYear();
})();
</script>
<script src="../stories.js" defer></script>
<script src="../explore-data.js" defer></script>
<script src="../assets/experience.js" defer></script>
<script src="../assets/archive.js" defer></script>
<script src="../assets/explore.js" defer></script>
</body>
</html>
`;
}

function buildStoryPages(site, stories, graph, jByStory, journeys) {
  if (!fs.existsSync(STORY_DIR)) fs.mkdirSync(STORY_DIR, { recursive: true });
  const published = stories.filter(s => s.published);
  const wanted = new Set(published.map(s => `${s.id}-${s.slug}.html`));

  // Remove orphan story pages (unpublished / deleted / renamed).
  fs.readdirSync(STORY_DIR)
    .filter(f => /^\d+-.*\.html$/.test(f) && !wanted.has(f))
    .forEach(f => { fs.unlinkSync(path.join(STORY_DIR, f)); console.log(`  - removed orphan story/${f}`); });

  const written = [];
  published.forEach(s => {
    const file = path.join(STORY_DIR, `${s.id}-${s.slug}.html`);
    fs.writeFileSync(file, storyPageHTML(s, site, graph, (jByStory || {})[s.id], journeys));
    written.push(`story/${s.id}-${s.slug}.html`);
  });
  return written;
}

/* ---------- Search & Discovery index ----------
   One flat, searchable record per story + per family member + per place /
   object / event. Built only from data/stories.json + data/entities.json.
   Injected into index.html (so search needs no network request) and also
   written to search-index.json for reuse. */
function stripTags(s) { return String(s == null ? "" : s).replace(/<[^>]+>/g, ""); }

function buildSearchIndex(site, stories, entities, graph, journeys) {
  const records = [];

  // Memory journeys — a guided entry point, searchable like everything else.
  (journeys || []).forEach(j => records.push(journeysLib.journeyRecords([j])[0]));

  stories.forEach(s => {
    const kw = [
      s.title, s.summary, s.themeLabel, s.memoryDate, s.bookPart, s.dateLabel,
      "story", "no " + s.id, String(s.id),
      ...(s.people || []), ...(s.places || []), ...(s.objects || []),
      ...(s.events || []), ...(s.keywords || [])
    ].filter(Boolean).join(" ").toLowerCase();
    const sConn = (graph && graph.storyConnections[s.id]) || { total: 0 };
    records.push({
      type: "story",
      title: s.title,
      subtitle: s.published ? `No. ${s.id} · ${s.themeLabel}` : `Coming soon · ${s.themeLabel}`,
      url: s.published ? s.url : "#archive",
      badge: "Story",
      related: sConn.total || 0,
      keywords: kw
    });
  });

  const fam = ((entities.family && entities.family.people) || []).filter(p => !p.hidden);
  fam.forEach(p => {
    const kw = [
      p.name, p.fullName, p.role, p.lifeLabel, p.born, p.died,
      ...(p.bio || []).map(stripTags), "person", "family"
    ].filter(Boolean).join(" ").toLowerCase();
    const prev = graph && graph.entityById[p.id] ? exploreLib.entityPreview(graph.entityById[p.id], graph) : null;
    records.push({
      type: "person",
      title: p.name,
      subtitle: p.role,
      url: `family/${p.slug}.html`,
      badge: "Person",
      memories: prev ? prev.memories : 0,
      related: prev ? prev.related : 0,
      portrait: prev && prev.portrait ? prev.portrait.jpg : null,
      keywords: kw
    });
  });

  // Places / objects / events now have their own entity profile pages.
  graph.entities.filter(e => e.kind !== "person").forEach(e => {
    const conn = graph.entityConnections[e.id] || { storyCount: 0 };
    const kw = [e.name, e.detail, ...(e.aliases || []), e.kind]
      .filter(Boolean).join(" ").toLowerCase();
    const prev = exploreLib.entityPreview(e, graph);
    records.push({
      type: e.kind,
      title: e.name,
      subtitle: conn.storyCount ? `${conn.storyCount} ${conn.storyCount === 1 ? "story" : "stories"}` : (e.detail || ""),
      url: entityUrl(e),
      badge: KIND[e.kind].singular,
      memories: prev.memories,
      related: prev.related,
      keywords: kw
    });
  });

  // Public copy + inject into the homepage. Escape "<" so the JSON is safe
  // inside a <script> element and can never terminate it early.
  fs.writeFileSync(path.join(ROOT, "search-index.json"), JSON.stringify(records, null, 2) + "\n");
  const safe = JSON.stringify(records).replace(/</g, "\\u003c");
  const file = path.join(ROOT, "index.html");
  let html = fs.readFileSync(file, "utf8");
  html = injectRegion(html, "SEARCH_INDEX",
    `<script id="hl-search-index" type="application/json">${safe}</script>`);
  fs.writeFileSync(file, html);
  return records.length;
}

/* ---------- stories.js public mirror ---------- */
function buildStoriesJs(stories, graph, featured, site) {
  const records = stories.map(s => ({
    id: s.id, slug: s.slug, title: s.title,
    published: s.published, status: s.status,
    publishDate: s.publishedISO || s.dateLong, memoryDate: s.memoryDate,
    summary: s.summary, excerpt: s.lead || null,
    themes: [s.theme], people: s.people, places: s.places,
    objects: s.objects, events: s.events,
    bookPart: s.bookPart, echoStories: s.echoStories,
    readingTime: s.readingTime, keywords: s.keywords || [],
    url: s.url
  }));

  // --- Living Archive client data: the readable (published) archive only, plus
  //     graph-derived "what to read next" recommendations. This is what the
  //     client-side reading/continue/saved/stats layer (assets/archive.js) runs
  //     on. Recommendations are NEVER random — they come straight from the
  //     knowledge graph's related-memories ranking (shared people / places /
  //     objects / events), with a gentle boost for emotional continuity (same
  //     theme). Coming-soon stories are excluded so every link is real. */
  const published = stories.filter(s => s.published);
  const isPub = new Set(published.map(s => s.id));
  const themeLabels = {};
  Object.keys(site && site.themes ? site.themes : {}).forEach(k => {
    themeLabels[k] = site.themes[k].label || k;
  });
  const archStories = published.map(s => {
    const rel = graph && graph.relatedMemories[s.id] ? graph.relatedMemories[s.id] : [];
    const rec = rel
      .filter(r => r.story && isPub.has(r.story.id) && r.story.id !== s.id)
      .map(r => ({ id: r.story.id, score: r.shared + (r.story.theme === s.theme ? 0.5 : 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(r => r.id);
    return {
      id: s.id, slug: s.slug, title: s.title, url: s.url,
      theme: s.theme, themeLabel: s.themeLabel || themeLabels[s.theme] || s.theme,
      summary: s.summary || "", dateLabel: s.dateLabel || "",
      readingTime: s.readingTime || 0, rec
    };
  });
  const archive = {
    total: published.length,
    featured: featured ? featured.id : null,
    themes: themeLabels,
    stories: archStories
  };

  const banner = "/* Auto-generated from data/stories.json by build.js — do not edit by hand.\n" +
    "   The canonical source of truth is data/stories.json. */\n";
  const out = banner +
    "window.HL_STORIES = " + JSON.stringify(records, null, 2) + ";\n" +
    "window.HL_ARCHIVE = " + JSON.stringify(archive, null, 2) + ";\n";
  fs.writeFileSync(path.join(ROOT, "stories.js"), out);
  return "stories.js";
}

/* ---------- explore-data.js: compact graph previews for the hover / focus
   preview cards (assets/explore.js). Root-relative; loaded on every page. ---- */
function buildExploreData(graph) {
  const previews = exploreLib.exploreEntities(graph);
  const banner = "/* Auto-generated from the knowledge graph by build.js — do not edit by hand. */\n";
  const out = banner + "window.HL_GRAPH = { entities: " + JSON.stringify(previews) + " };\n";
  fs.writeFileSync(path.join(ROOT, "explore-data.js"), out);
  return "explore-data.js";
}

/* ---------- orchestrator ---------- */
function build() {
  const { site, stories, entities } = loadData();
  const featured = pickFeatured(stories);
  const graph = buildGraph(stories, entities);
  const journeys = journeysLib.buildJourneyData(site, stories, entities, graph);
  const jByStory = journeysLib.journeyByStory(journeys);
  const jByPerson = journeysLib.journeysByPerson(journeys);

  const idx = buildIndex(site, stories, featured, journeys, entities);
  const searchCount = buildSearchIndex(site, stories, entities, graph, journeys);
  const pages = buildStoryPages(site, stories, graph, jByStory, journeys);
  const js = buildStoriesJs(stories, graph, featured, site);
  buildExploreData(graph);
  const family = buildFamily(site, stories, entities, graph, jByPerson, journeys);
  const journeyPages = journeysLib.buildJourneyPages(journeys, site, graph);

  const summary = {
    featured: featured ? `${featured.id} — ${featured.title}` : "(none)",
    published: stories.filter(s => s.published).length,
    comingSoon: stories.filter(s => s.status === "coming-soon").length,
    total: stories.length,
    pages, index: path.basename(idx), storiesJs: js,
    familyTree: family.tree, familyProfiles: family.profiles,
    entityPages: family.entityPages || [],
    journeys: journeyPages,
    searchRecords: searchCount, graph: graph.stats
  };
  return summary;
}

module.exports = { build, loadData, pickFeatured, storyPageHTML };

/* Run directly: `node build.js` */
if (require.main === module) {
  console.log("Harlan's Legacy — building…");
  const s = build();
  console.log(`  This Week : ${s.featured}`);
  console.log(`  Published : ${s.published}   Coming soon: ${s.comingSoon}   Total: ${s.total}`);
  console.log(`  Story pages: ${s.pages.length}`);
  s.pages.forEach(p => console.log(`    · ${p}`));
  console.log(`  Family     : ${s.familyTree || "(none)"} + ${s.familyProfiles.length} profile(s)`);
  s.familyProfiles.forEach(p => console.log(`    · ${p}`));
  console.log(`  Entities   : ${s.entityPages.length} place/object/event page(s)`);
  s.entityPages.forEach(p => console.log(`    · ${p}`));
  console.log(`  Journeys   : ${s.journeys.length} memory journey page(s)`);
  s.journeys.forEach(p => console.log(`    · ${p}`));
  console.log(`  Search     : ${s.searchRecords} records indexed`);
  console.log(`  Graph      : ${s.graph.entities} entities · ${s.graph.edges} story↔entity edges`);
  console.log("  Done.");
}
