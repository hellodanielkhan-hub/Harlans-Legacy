/* =========================================================
   Harlan's Legacy — Guided Discovery / Memory Journeys
   Zero new dependencies. A journey is assembled entirely from
   the data layer: the TOPICS are the story themes that actually
   appear in data/stories.json (never hardcoded), and each
   journey gathers — through the Knowledge Graph (lib/graph.js) —
   the people, places, objects, events, photographs and the
   ordered sequence of memories that belong to that part of
   Harlan's life. Publish a new story with a theme and its
   journey grows automatically; add a new theme to site.json and
   a new journey appears. Nothing here is hand-maintained.
   ========================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const { pageShell, portrait, entityChips, primaryPhoto, renderLightbox, text, attr } = require("./family.js");
const { KIND, entityUrl } = require("./graph.js");
const exploreLib = require("./explore.js");

const { ROOT } = require("./paths.js");
const JOURNEY_DIR = path.join(ROOT, "journey");

function slugify(s) {
  return String(s).toLowerCase().replace(/['’&]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Sortable chronological key so the memories read as a walk, oldest first.
function dateKey(s) {
  if (s.publishedISO) { const d = Date.parse(s.publishedISO); if (!isNaN(d)) return d; }
  if (s.dateLong) {
    let d = Date.parse(s.dateLong); if (!isNaN(d)) return d;
    const m = s.dateLong.match(/([A-Za-z]+)\s+(\d{4})/);
    if (m) { d = Date.parse(m[1] + " 1, " + m[2]); if (!isNaN(d)) return d; }
  }
  return 0;
}

/* ---------- assemble journeys from data + graph ---------- */
function buildJourneyData(site, stories, entities, graph) {
  const themes = site.themes || {};
  const byTheme = {};
  stories.forEach(s => { (byTheme[s.theme] = byTheme[s.theme] || []).push(s); });

  // stable order = the order themes are declared in site.json
  const journeys = Object.keys(themes).filter(k => (byTheme[k] || []).length).map(key => {
    const t = themes[key];
    const ordered = byTheme[key].slice().sort((a, b) => dateKey(a) - dateKey(b) || a.id - b.id);

    // aggregate the graph's resolved entities across every memory in the topic
    const counts = { person: {}, place: {}, object: {}, event: {} };
    ordered.forEach(s => {
      const conn = graph.storyConnections[s.id];
      if (!conn) return;
      Object.keys(counts).forEach(kind => {
        (conn.groups[kind] || []).forEach(e => {
          counts[kind][e.id] = counts[kind][e.id] || { entity: e, n: 0 };
          counts[kind][e.id].n++;
        });
      });
    });
    const rank = obj => Object.keys(obj).map(id => obj[id])
      .sort((a, b) => b.n - a.n || a.entity.name.localeCompare(b.entity.name)).map(x => x.entity);

    const people = rank(counts.person), places = rank(counts.place),
      objects = rank(counts.object), events = rank(counts.event);
    const readingMin = ordered.reduce((n, s) => n + (s.readingTime || 2), 0);

    return {
      key, slug: slugify(t.topic || t.label),
      title: t.label, topic: t.topic || t.label, thread: t.thread || "#B8B4A8",
      description: t.description || "", intro: t.journeyIntro || "",
      stories: ordered, people, places, objects, events,
      published: ordered.filter(s => s.published).length, count: ordered.length,
      stats: { memories: ordered.length, people: people.length, places: places.length, objects: objects.length, events: events.length, readingMin },
      url: `journey/${slugify(t.topic || t.label)}.html`
    };
  });

  assignCovers(journeys);
  return journeys;
}

// Give every journey a distinct, appropriate cover: a fresh person's face where
// one is available (so Harlan's portrait never repeats across cards), otherwise
// a cinematic motif of the journey's defining place / object / event, otherwise
// a warm gradient art panel in the topic's thread colour.
function assignCovers(journeys) {
  const usedPerson = new Set();
  journeys.forEach(j => {
    const fresh = j.people.find(p => primaryPhoto(p) && !usedPerson.has(p.id));
    if (fresh) { usedPerson.add(fresh.id); j.cover = { kind: "person", person: fresh }; }
    else j.cover = null;
  });
  journeys.forEach(j => {
    if (j.cover) return;
    const ent = j.objects[0] || j.places[0] || j.events[0] || null;
    if (ent) j.cover = { kind: "motif", entity: ent, label: ent.name, glyph: (ent.monogram || ent.name.trim().charAt(0) || "").toUpperCase() };
    else j.cover = { kind: "art" };
  });
}

// story id -> its journey (for cross-links on story pages)
function journeyByStory(journeys) {
  const map = {};
  journeys.forEach(j => j.stories.forEach(s => { map[s.id] = j; }));
  return map;
}
// person id -> journeys they appear in (for profile cross-links)
function journeysByPerson(journeys) {
  const map = {};
  journeys.forEach(j => j.people.forEach(p => { (map[p.id] = map[p.id] || []).push(j); }));
  return map;
}

/* ---------- shared render bits ---------- */
function personPhoto(person, prefix, sizes) {
  const it = primaryPhoto(person);
  if (!it) return "";
  const dir = `${prefix}assets/photos/${person.id}/`;
  const set = ext => it.portrait.map(w => `${dir}${it.id}.portrait.${w}.${ext} ${w}w`).join(", ");
  const largest = it.portrait[it.portrait.length - 1];
  const f = it.focus || { x: 50, y: 42 };
  // width/height reserve the square box (no layout shift); the per-photo focal
  // point keeps the face centred inside any non-square frame.
  return `<picture><source type="image/webp" srcset="${attr(set("webp"))}" sizes="${sizes}">` +
    `<img src="${attr(dir + it.id + ".portrait." + largest + ".jpg")}" srcset="${attr(set("jpg"))}" sizes="${sizes}" ` +
    `width="${largest}" height="${largest}" style="object-position:${f.x}% ${f.y}%" alt="" loading="lazy" decoding="async"></picture>`;
}

// Cover media: a fresh face (framed on the hero, filled on cards), a cinematic
// motif of a place/object/event, or a warm gradient art panel — see assignCovers.
function coverMedia(j, prefix, sizes) {
  const c = j.cover || { kind: "art" };
  if (c.kind === "person") return `<span class="jc jc-photo">${personPhoto(c.person, prefix, sizes)}</span>`;
  if (c.kind === "motif") return `<span class="jc jc-motif" style="--tab-color:var(--thread-${j.key})" aria-hidden="true"><span class="jc-ghost">${text(c.label || j.topic)}</span></span>`;
  return `<span class="jc jc-art" style="--tab-color:var(--thread-${j.key})" aria-hidden="true"><span class="jc-ghost">${text(j.topic)}</span></span>`;
}

// A lightbox gallery entry (full-size) built from a person's primary photograph.
function galleryEntry(person, prefix) {
  const it = primaryPhoto(person);
  if (!it || !it.full || !it.full.length) return null;
  const dir = `${prefix}assets/photos/${person.id}/`;
  return {
    webp: it.full.map(w => `${dir}${it.id}.full.${w}.webp ${w}w`).join(", "),
    jpg: it.full.map(w => `${dir}${it.id}.full.${w}.jpg ${w}w`).join(", "),
    src: `${dir}${it.id}.full.${it.full[it.full.length - 1]}.jpg`,
    caption: it.caption || person.name,
    year: it.year || "", location: it.location || "",
    alt: it.caption || `Photograph of ${person.name}`
  };
}

/* ---------- homepage "Discover a Memory" cinematic poster cards ---------- */
function renderDiscoverCards(journeys, prefix) {
  return journeys.map(j => {
    const people = j.people.slice(0, 3).map(p => text(p.name)).join(" &middot; ");
    return `        <a class="topic-card reveal pace-quick" data-theme="${j.key}" style="--tab-color:var(--thread-${j.key})" href="${prefix}${attr(j.url)}">
          <span class="topic-cover">${coverMedia(j, prefix, "(max-width:640px) 92vw, (max-width:960px) 44vw, 30vw")}<span class="topic-scrim"></span></span>
          <span class="topic-overlay">
            <span class="topic-kicker">${j.count} ${j.count === 1 ? "memory" : "memories"}</span>
            <span class="topic-title">${text(j.topic)}</span>
            <span class="topic-desc">${text(j.description)}</span>
            ${people ? `<span class="topic-people">${people}</span>` : ""}
            <span class="topic-cta">Begin the journey <span aria-hidden="true">&rarr;</span></span>
          </span>
        </a>`;
  }).join("\n");
}

/* ---------- the Memory Journey page ---------- */
const JOURNEY_CSS = `
/* shared cover media (hero, recommendations) */
.jc{ display:block; width:100%; height:100%; position:relative; }
.jc-photo img, .jc-photo picture{ width:100%; height:100%; object-fit:cover; object-position:50% 26%; display:block; }
.jc-motif, .jc-art{ background:
    radial-gradient(120% 90% at 28% 18%, color-mix(in srgb,var(--tab-color) 52%, transparent) 0%, transparent 58%),
    radial-gradient(130% 110% at 82% 92%, color-mix(in srgb,var(--tab-color) 34%, transparent) 0%, transparent 55%),
    linear-gradient(150deg, color-mix(in srgb,var(--tab-color) 20%, var(--paper-deep)) 0%, var(--paper-deep) 100%);
  display:flex; align-items:center; justify-content:center; overflow:hidden; }
.jc-ghost{ font-family:var(--font-display); font-weight:560; font-size:clamp(1.4rem,1rem+2vw,2.6rem); letter-spacing:0.02em;
  color:color-mix(in srgb, var(--tab-color) 60%, var(--ink-primary)); opacity:0.32; text-align:center; padding:0 1rem;
  text-transform:uppercase; line-height:1.05; }

/* ---- HERO: entering an exhibit ---- */
.journey-hero{ position:relative; overflow:hidden; padding-block:clamp(3rem,7vh,6rem) var(--sp-6); --jglow:20%; }
html[data-theme="night"] .journey-hero{ --jglow:32%; }
.journey-hero::before{ content:""; position:absolute; inset:0; z-index:0; pointer-events:none;
  background:radial-gradient(ellipse 72% 60% at 50% 0%, color-mix(in srgb, var(--jthread) var(--jglow), transparent) 0%, transparent 66%); }
.journey-hero > .container{ position:relative; z-index:1; max-width:900px; text-align:center; }
.jhero-cover{ width:min(440px, 82%); aspect-ratio:4 / 5; margin:0 auto var(--sp-5); position:relative;
  padding:clamp(8px,1.3vw,15px); background:var(--paper-raised); border:1px solid var(--ink-whisper); border-radius:6px;
  box-shadow:0 2px 6px rgba(40,26,14,0.16), 0 44px 88px -36px rgba(40,26,14,0.6); }
.jhero-cover .jc{ border-radius:3px; overflow:hidden; }
.jhero-cover .jc-photo img{ object-fit:cover; object-position:50% 24%; }
.journey-hero .eyebrow{ justify-content:center; }
.journey-hero h1{ font-size:clamp(2.6rem,1.9rem+3vw,4.6rem); line-height:1.02; letter-spacing:-0.02em; margin:var(--sp-2) 0 0; }
.jintro{ font-size:var(--text-body-lg); line-height:1.7; color:var(--ink-secondary); max-width:60ch; margin:var(--sp-4) auto 0; }

/* ---- STATS ---- */
.jstats{ display:flex; flex-wrap:wrap; justify-content:center; gap:0; margin-top:var(--sp-5);
  border:1px solid var(--ink-whisper); border-radius:999px; padding:0.3rem 0.6rem; background:var(--paper-raised); }
.jstat{ display:inline-flex; flex-direction:column; align-items:center; padding:0.5rem 1.15rem; position:relative; }
.jstat + .jstat::before{ content:""; position:absolute; left:0; top:22%; bottom:22%; width:1px; background:var(--ink-whisper); }
.jstat-n{ font-family:var(--font-display); font-weight:560; font-size:1.35rem; line-height:1; color:var(--ink-primary); }
.jstat-l{ font-family:var(--font-voice); font-size:0.62rem; letter-spacing:0.1em; text-transform:uppercase; color:var(--ink-muted); margin-top:0.3rem; }

/* ---- BODY sections ---- */
.journey-body{ max-width:860px; margin:0 auto; }
.journey-section{ margin-bottom:var(--sp-8); }
.journey-section > h2{ font-size:var(--text-h2); letter-spacing:-0.012em; margin-bottom:var(--sp-2); }
.journey-section > .jlead{ color:var(--ink-secondary); margin-bottom:var(--sp-5); max-width:62ch; line-height:1.7; }

/* ---- PEOPLE profile cards ---- */
.jpeople{ display:grid; grid-template-columns:repeat(auto-fit, minmax(238px, 1fr)); gap:var(--sp-3); }
.jpc{ display:flex; align-items:center; gap:var(--sp-3); padding:var(--sp-2) var(--sp-3); text-decoration:none; color:var(--ink-primary);
  background:var(--paper-raised); border:1px solid var(--ink-whisper); border-radius:var(--radius-soft);
  box-shadow:0 1px 2px rgba(60,40,20,0.05), 0 14px 32px -24px rgba(60,40,20,0.2);
  transition:transform 460ms var(--ease-settle), box-shadow 460ms var(--ease-settle), border-color 460ms var(--ease-settle); }
.jpc:hover{ transform:translateY(-4px); box-shadow:0 2px 5px rgba(60,40,20,0.08), 0 28px 54px -28px rgba(60,40,20,0.32); border-color:var(--ember-core); }
.jpc-photo{ width:74px; height:74px; border-radius:50%; overflow:hidden; flex-shrink:0; display:flex; align-items:center; justify-content:center;
  border:1px solid var(--ink-whisper); box-shadow:0 0 0 4px var(--paper-base), 0 0 0 5px color-mix(in srgb,var(--jthread) 40%, var(--ink-whisper));
  background:radial-gradient(circle at 50% 35%, color-mix(in srgb,var(--ember-glow) 26%, var(--paper-deep)) 0%, var(--paper-deep) 100%);
  color:var(--ember-deep); font-family:var(--font-display); font-weight:560; font-size:1.7rem; }
.jpc-photo img, .jpc-photo picture{ width:100%; height:100%; object-fit:cover; object-position:50% 22%; display:block; }
.jpc-txt{ display:flex; flex-direction:column; gap:0.15rem; min-width:0; }
.jpc-name{ font-family:var(--font-display); font-weight:560; font-size:1.18rem; line-height:1.1; }
.jpc-role{ font-size:0.85rem; color:var(--ink-secondary); line-height:1.35; }

/* ---- MEMORIES timeline cards ---- */
.memory-walk{ list-style:none; margin:0; padding:0; position:relative; }
.memory-walk::before{ content:""; position:absolute; left:16px; top:14px; bottom:14px; width:2px;
  background:linear-gradient(to bottom, transparent, color-mix(in srgb, var(--jthread) 62%, var(--ink-whisper)) 10%, color-mix(in srgb, var(--jthread) 62%, var(--ink-whisper)) 90%, transparent); }
.mw-step{ position:relative; padding:0 0 var(--sp-4) var(--sp-6); }
.mw-step:last-child{ padding-bottom:0; }
.mw-node{ position:absolute; left:9px; top:26px; width:16px; height:16px; border-radius:50%; z-index:1;
  background:var(--paper-base); border:2px solid var(--jthread); box-shadow:0 0 0 4px var(--paper-base); }
.mw-card{ background:var(--paper-raised); border:1px solid var(--ink-whisper); border-radius:var(--radius-soft);
  padding:var(--sp-4) var(--sp-4) var(--sp-3); position:relative; overflow:hidden;
  box-shadow:0 1px 2px rgba(60,40,20,0.05), 0 16px 36px -26px rgba(60,40,20,0.22);
  transition:transform 460ms var(--ease-settle), box-shadow 460ms var(--ease-settle), border-color 460ms var(--ease-settle); }
.mw-card::before{ content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--jthread); opacity:0.85; }
.mw-card:hover{ transform:translateY(-3px); box-shadow:0 2px 5px rgba(60,40,20,0.08), 0 30px 58px -30px rgba(60,40,20,0.3); border-color:var(--ink-secondary); }
.mw-when{ font-family:var(--font-voice); font-size:0.74rem; letter-spacing:0.06em; color:var(--jthread); display:block; margin-bottom:0.35rem; }
.mw-card h3{ font-size:clamp(1.3rem,1.1rem+0.6vw,1.6rem); line-height:1.15; margin:0 0 0.5rem; }
.mw-card p{ color:var(--ink-secondary); font-size:1.05rem; line-height:1.65; margin:0 0 var(--sp-2); }
.mw-read{ font-size:var(--text-caption); color:var(--ember-core); text-decoration:none; border-bottom:1px solid var(--ember-glow); padding-bottom:1px; }
.mw-read:hover{ color:var(--ember-deep); border-color:var(--ember-deep); }
.mw-soon{ font-family:var(--font-voice); font-size:0.72rem; letter-spacing:0.04em; text-transform:uppercase; color:var(--ink-muted); }

/* ---- PHOTOGRAPHS film-strip (wired to the lightbox) ---- */
.journey-filmstrip{ display:flex; gap:var(--sp-2); overflow-x:auto; padding:0.4rem 0 var(--sp-2); scroll-snap-type:x mandatory;
  scrollbar-width:thin; -webkit-overflow-scrolling:touch; }
.jfs-item{ flex:0 0 auto; width:172px; aspect-ratio:3 / 4; border:0; padding:0; margin:0; cursor:zoom-in; border-radius:var(--radius-soft);
  overflow:hidden; position:relative; scroll-snap-align:start; background:var(--paper-deep);
  box-shadow:0 1px 2px rgba(0,0,0,0.12), 0 18px 40px -24px rgba(40,26,14,0.4);
  transition:transform 460ms var(--ease-settle), box-shadow 460ms var(--ease-settle); }
.jfs-item img, .jfs-item picture{ width:100%; height:100%; object-fit:cover; object-position:50% 22%; display:block;
  transition:transform 900ms var(--ease-settle); }
.jfs-item::after{ content:""; position:absolute; inset:0; background:linear-gradient(to top, rgba(20,12,6,0.32), transparent 42%);
  opacity:0; transition:opacity 460ms var(--ease-settle); }
.jfs-item:hover{ transform:translateY(-4px); box-shadow:0 2px 6px rgba(0,0,0,0.16), 0 30px 60px -26px rgba(40,26,14,0.5); }
.jfs-item:hover img{ transform:scale(1.05); }
.jfs-item:hover::after{ opacity:1; }
.jfs-item:focus-visible{ outline:2px solid var(--ember-core); outline-offset:3px; }

/* ---- WANDER FURTHER recommendation cards ---- */
.journey-recs{ display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:var(--sp-3); }
.jrec{ display:flex; flex-direction:column; text-decoration:none; color:var(--ink-primary); border:1px solid var(--ink-whisper);
  border-radius:var(--radius-soft); overflow:hidden; background:var(--paper-raised);
  box-shadow:0 1px 2px rgba(60,40,20,0.05), 0 14px 32px -24px rgba(60,40,20,0.2);
  transition:transform 460ms var(--ease-settle), box-shadow 460ms var(--ease-settle), border-color 460ms var(--ease-settle); }
.jrec:hover{ transform:translateY(-5px); box-shadow:0 2px 5px rgba(60,40,20,0.08), 0 30px 58px -30px rgba(60,40,20,0.32); border-color:var(--ink-secondary); }
.jrec-cover{ display:block; position:relative; width:100%; aspect-ratio:3 / 2; overflow:hidden; }
.jrec-cover .jc-photo img{ object-position:50% 22%; transition:transform 900ms var(--ease-settle); }
.jrec:hover .jc-photo img{ transform:scale(1.05); }
.jrec-scrim{ position:absolute; inset:0; background:linear-gradient(to top, rgba(20,12,6,0.34), transparent 46%); }
.jrec-body{ display:flex; flex-direction:column; gap:0.3rem; padding:var(--sp-3); }
.jrec-kicker{ font-family:var(--font-voice); font-size:0.66rem; letter-spacing:0.08em; text-transform:uppercase; color:var(--ember-core); }
.jrec-title{ font-family:var(--font-display); font-weight:560; font-size:1.2rem; line-height:1.1; }
.jrec-desc{ font-size:0.9rem; color:var(--ink-secondary); line-height:1.5; }

.journey-return{ border-top:1px solid var(--ink-whisper); text-align:center; }
.journey-return .container{ max-width:640px; }

@media (max-width:640px){
  .journey-hero h1{ font-size:var(--text-h1); }
  .jhero-cover{ width:min(320px, 74%); }
  .jstats{ border-radius:var(--radius-soft); }
  .jpc-photo{ width:64px; height:64px; }
}
`;

function renderStats(j) {
  const s = j.stats;
  const items = [
    [s.memories, s.memories === 1 ? "memory" : "memories"],
    [s.people, s.people === 1 ? "person" : "people"],
    [s.places, s.places === 1 ? "place" : "places"],
    [s.objects, s.objects === 1 ? "object" : "objects"],
    ["~" + s.readingMin, "min read"]
  ].filter(x => x[0] && !(typeof x[0] === "number" && x[0] === 0));
  return `      <div class="jstats reveal" role="list" aria-label="Journey at a glance">
${items.map(x => `        <span class="jstat" role="listitem"><span class="jstat-n">${text(x[0])}</span><span class="jstat-l">${text(x[1])}</span></span>`).join("\n")}
      </div>`;
}

function renderPeopleCards(j, prefix) {
  if (!j.people.length) return `<p class="jlead">The people in these memories will appear here as their stories are written.</p>`;
  return `      <div class="jpeople">
${j.people.map(p => {
    const pic = personPhoto(p, prefix, "74px");
    const media = pic ? pic : `<span aria-hidden="true">${text(p.monogram || p.name.charAt(0))}</span>`;
    return `        <a class="jpc" href="${prefix}${attr(entityUrl(p))}">
          <span class="jpc-photo">${media}</span>
          <span class="jpc-txt"><span class="jpc-name">${text(p.name)}</span>${p.detail ? `<span class="jpc-role">${text(p.detail)}</span>` : ""}</span>
        </a>`;
  }).join("\n")}
      </div>`;
}

function renderMemoryCards(j) {
  return `      <ol class="memory-walk">
${j.stories.map(s => {
    const when = s.dateLong || s.dateLabel || "";
    const link = s.published && s.url
      ? `<a class="mw-read" href="../${attr(s.url)}">Read this memory &rarr;</a>`
      : `<span class="mw-soon">Coming soon</span>`;
    return `        <li class="mw-step reveal pace-quick">
          <span class="mw-node" aria-hidden="true"></span>
          <div class="mw-card">
            ${when ? `<span class="mw-when">${text(when)}</span>` : ""}
            <h3>${text(s.title)}</h3>
            ${s.summary ? `<p>${text(s.summary)}</p>` : ""}
            ${link}
          </div>
        </li>`;
  }).join("\n")}
      </ol>`;
}

function renderJourney(j, site, graph, allJourneys) {
  const heroCover = `<figure class="jhero-cover reveal" style="--jthread:${j.thread}">${coverMedia(j, "../", "(max-width:640px) 74vw, 440px")}</figure>`;

  const placesThings = [].concat(
    j.places.map(e => ({ entity: e })), j.objects.map(e => ({ entity: e })), j.events.map(e => ({ entity: e }))
  );
  const worldHtml = placesThings.length ? entityChips(placesThings, "../") : "";

  // photographs → film-strip wired to the shared lightbox
  const galPeople = j.people.filter(p => primaryPhoto(p));
  const gallery = galPeople.map(p => galleryEntry(p, "../")).filter(Boolean);
  const filmstrip = gallery.length ? `      <div class="journey-filmstrip">
${galPeople.map((p, i) => `        <button class="jfs-item" type="button" data-lb-open="${i}" aria-haspopup="dialog" aria-controls="hl-lightbox" aria-label="Open photograph of ${attr(p.name)}">${personPhoto(p, "../", "172px")}</button>`).join("\n")}
      </div>` : "";
  const lightboxHtml = gallery.length ? renderLightbox(gallery) : "";

  // wander further → rich recommendation cards
  const others = allJourneys.filter(o => o.slug !== j.slug);
  const recsHtml = others.map(o => `        <a class="jrec" href="../${attr(o.url)}">
          <span class="jrec-cover">${coverMedia(o, "../", "260px")}<span class="jrec-scrim"></span></span>
          <span class="jrec-body">
            <span class="jrec-kicker">${o.count} ${o.count === 1 ? "memory" : "memories"}</span>
            <span class="jrec-title">${text(o.topic)}</span>
            <span class="jrec-desc">${text(o.description)}</span>
          </span>
        </a>`).join("\n");

  const jsonld = JSON.stringify({
    "@context": "https://schema.org", "@type": "CollectionPage",
    name: `${j.topic} — a memory journey`, description: j.description,
    url: `${site.domain}/${j.url}`
  }, null, 2);

  const main = `  <section class="journey-hero" id="top" style="--jthread:${j.thread}">
    <div class="container">
      ${heroCover}
      <p class="eyebrow reveal">A Memory Journey</p>
      <h1 class="resolve">${text(j.topic)}</h1>
      <p class="jintro reveal">${text(j.intro || j.description)}</p>
${renderStats(j)}
    </div>
  </section>

  <section>
    <div class="container journey-body" style="--jthread:${j.thread}">
      <div class="journey-section reveal">
        <h2>Who you'll meet</h2>
${renderPeopleCards(j, "../")}
      </div>

      ${worldHtml ? `<div class="journey-section reveal">
        <h2>Places &amp; things</h2>
        <p class="jlead">The world these memories move through — each one opens onto everywhere else it appears.</p>
${worldHtml}
      </div>` : ""}

      <div class="journey-section reveal">
        <h2>The memories</h2>
        <p class="jlead">In the order they happened — walk them slowly.</p>
${renderMemoryCards(j)}
      </div>

      ${filmstrip ? `<div class="journey-section reveal">
        <h2>Photographs</h2>
        <p class="jlead">Faces from these memories. Open one to step into the full gallery.</p>
${filmstrip}
      </div>` : ""}

      ${recsHtml ? `<div class="journey-section reveal">
        <h2>Wander further</h2>
        <div class="journey-recs">
${recsHtml}
        </div>
      </div>` : ""}
    </div>
  </section>
${exploreLib.renderContinueExploring({ type: "journey", journey: j, selfKey: "j:" + j.slug }, graph, allJourneys, "../")}
  <section class="journey-return">
    <div class="container reveal">
      <a class="btn btn-quiet" href="../index.html#discover">&larr; All memory journeys</a>
    </div>
  </section>
${lightboxHtml}`;

  return pageShell({
    depth: 1,
    active: "discover",
    title: `${j.topic} — Harlan's Legacy`,
    description: (j.description || `A guided journey through ${j.topic} in Harlan's Legacy`).slice(0, 180),
    canonical: `${site.domain}/${j.url}`,
    jsonld,
    footerNote: "Every journey grows as new Fridays are written.",
    css: JOURNEY_CSS,
    main
  });
}

/* ---------- write journey pages (with orphan cleanup) ---------- */
function buildJourneyPages(journeys, site, graph) {
  if (!fs.existsSync(JOURNEY_DIR)) fs.mkdirSync(JOURNEY_DIR, { recursive: true });
  const wanted = new Set(journeys.map(j => `${j.slug}.html`));
  fs.readdirSync(JOURNEY_DIR)
    .filter(f => f.endsWith(".html") && !wanted.has(f))
    .forEach(f => { fs.unlinkSync(path.join(JOURNEY_DIR, f)); console.log(`  - removed orphan journey/${f}`); });

  const written = [];
  journeys.forEach(j => {
    fs.writeFileSync(path.join(JOURNEY_DIR, `${j.slug}.html`), renderJourney(j, site, graph, journeys));
    written.push(j.url);
  });
  return written;
}

/* ---------- search records ---------- */
function journeyRecords(journeys) {
  return journeys.map(j => ({
    type: "journey",
    title: j.topic,
    subtitle: `${j.count} ${j.count === 1 ? "memory" : "memories"} · a journey`,
    url: j.url,
    badge: "Journey",
    memories: j.count,
    keywords: [j.topic, j.title, j.description, j.intro, "journey", "discover",
      ...j.people.map(p => p.name)].filter(Boolean).join(" ").toLowerCase()
  }));
}

module.exports = {
  buildJourneyData, renderDiscoverCards, buildJourneyPages, journeyRecords,
  journeyByStory, journeysByPerson
};
