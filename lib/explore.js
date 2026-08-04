/* =========================================================================
   Harlan's Legacy — Universal Explore (Phase 9)

   One shared source for cross-collection discovery, so no page reinvents it:
     - entityPreview / exploreEntities : compact graph previews emitted to the
       client (portrait, short description, related-memory count) that power the
       hover / focus preview cards in assets/explore.js.
     - continueDeck / renderContinueExploring : the calm "Continue exploring"
       section rendered at the foot of every page (story, profile, place /
       object / event, journey). It always draws a DIVERSE, cross-collection
       deck straight from the knowledge graph — a story leads to an object leads
       to a person leads to a journey — never hardcoded, never random.

   Depends only on lib/graph.js (KIND + entityUrl), so there is no import cycle
   with family.js / journeys.js, which call into here.
   ========================================================================= */
"use strict";

const { KIND, entityUrl } = require("./graph.js");

function attr(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function text(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/* Smallest primary portrait for an entity (people only) — same photo data the
   rest of the site derives from. Returns a root-relative jpg + focal point, or
   null. Kept tiny and local to avoid a require cycle with family.js. */
function portraitData(e) {
  const ph = e && e.photos;
  if (!ph || Array.isArray(ph) || !ph.items || !ph.items.length) return null;
  const it = ph.items.find(x => x.id === ph.primary) || ph.items[0];
  if (!it || !it.portrait || !it.portrait.length) return null;
  const w = it.portrait[0]; // smallest derivative — previews are small
  return {
    jpg: `assets/photos/${e.id}/${it.id}.portrait.${w}.jpg`,
    webp: `assets/photos/${e.id}/${it.id}.portrait.${w}.webp`,
    w, focus: it.focus || { x: 50, y: 42 }
  };
}

/* A compact preview record for a single entity, resolved from the graph. */
function entityPreview(e, graph) {
  const conn = (graph.entityConnections && graph.entityConnections[e.id]) || { stories: [], related: [], storyCount: 0 };
  return {
    id: e.id, kind: e.kind, name: e.name,
    url: entityUrl(e),
    badge: KIND[e.kind].singular,
    color: KIND[e.kind].color,
    desc: e.detail || "",
    monogram: e.monogram || (e.name || "?").trim().charAt(0).toUpperCase(),
    memories: conn.storyCount || 0,
    related: (conn.related || []).length,
    aliases: (e.aliases || []).slice(0, 6),
    portrait: portraitData(e)
  };
}

/* All entity previews, keyed by id — emitted to the client as window.HL_GRAPH. */
function exploreEntities(graph) {
  const out = {};
  (graph.entities || []).forEach(e => { out[e.id] = entityPreview(e, graph); });
  return out;
}

/* --------------------------------------------------------------------------
   Continue Exploring deck — a diverse, deduped, self-excluding set of up to six
   destinations spanning as many collections as possible, drawn from the graph.
   -------------------------------------------------------------------------- */
function continueDeck(ctx, graph, journeys) {
  const pools = { story: [], person: [], place: [], object: [], event: [], journey: [] };
  const seen = new Set();
  if (ctx.selfKey) seen.add(ctx.selfKey);
  journeys = journeys || [];

  function pushEntity(e) {
    if (!e || !pools[e.kind]) return;
    const key = "e:" + e.id;
    if (seen.has(key)) return; seen.add(key);
    pools[e.kind].push({ t: "entity", e });
  }
  function pushStory(s) {
    if (!s || !s.published || !s.url) return;
    const key = "s:" + s.id;
    if (seen.has(key)) return; seen.add(key);
    pools.story.push({ t: "story", s });
  }
  function pushJourney(j) {
    if (!j) return;
    const key = "j:" + j.slug;
    if (seen.has(key)) return; seen.add(key);
    pools.journey.push({ t: "journey", j });
  }
  const journeysWith = pred => journeys.filter(pred);

  if (ctx.type === "story") {
    const s = ctx.story;
    (graph.relatedMemories[s.id] || []).forEach(r => pushStory(r.story));
    const conn = graph.storyConnections[s.id] || { groups: {} };
    ["person", "place", "object", "event"].forEach(k => (conn.groups[k] || []).forEach(pushEntity));
    journeysWith(j => j.stories.some(x => x.id === s.id)).forEach(pushJourney);
  } else if (ctx.type === "person" || ctx.type === "entity") {
    const e = ctx.entity;
    const conn = graph.entityConnections[e.id] || { stories: [], related: [] };
    (conn.stories || []).forEach(pushStory);
    (conn.related || []).forEach(r => pushEntity(r.entity));
    journeysWith(j =>
      j.people.some(x => x.id === e.id) ||
      j.places.some(x => x.id === e.id) ||
      j.objects.some(x => x.id === e.id) ||
      j.events.some(x => x.id === e.id)
    ).forEach(pushJourney);
  } else if (ctx.type === "journey") {
    const j0 = ctx.journey;
    journeysWith(j => j.slug !== j0.slug).forEach(pushJourney);
    (j0.stories || []).forEach(pushStory);
    (j0.people || []).forEach(pushEntity);
    (j0.places || []).forEach(pushEntity);
    (j0.objects || []).forEach(pushEntity);
    (j0.events || []).forEach(pushEntity);
  }

  // Round-robin across collections so the deck always crosses sections.
  const order = ["story", "person", "place", "object", "event", "journey"];
  const deck = [];
  let progress = true;
  while (deck.length < 6 && progress) {
    progress = false;
    for (const k of order) {
      if (pools[k].length) { deck.push(pools[k].shift()); progress = true; if (deck.length >= 6) break; }
    }
  }
  return deck;
}

function entityMedia(e, prefix) {
  const pd = portraitData(e);
  if (pd) {
    return `<span class="xc-media"><picture>` +
      `<source type="image/webp" srcset="${attr(prefix + pd.webp)}"></source>` +
      `<img src="${attr(prefix + pd.jpg)}" width="${pd.w}" height="${pd.w}" ` +
      `style="object-position:${pd.focus.x}% ${pd.focus.y}%" alt="" loading="lazy" decoding="async"></picture></span>`;
  }
  return `<span class="xc-media xc-media-mono" data-monogram aria-hidden="true" style="--tab-color:${KIND[e.kind].color}">${text(e.monogram || (e.name || "?").trim().charAt(0))}</span>`;
}

function card(item, prefix) {
  if (item.t === "story") {
    const s = item.s;
    return `        <a class="explore-card ec-story" href="${attr(prefix + s.url)}" style="--tab-color:${s.threadHex || "var(--thread)"}">
          <span class="xc-body">
            <span class="xc-badge">Story</span>
            <span class="xc-title">${text(s.title)}</span>
            ${s.summary ? `<span class="xc-desc">${text(s.summary)}</span>` : ""}
            <span class="xc-meta">Story No. ${s.id}</span>
          </span>
        </a>`;
  }
  if (item.t === "journey") {
    const j = item.j;
    return `        <a class="explore-card ec-journey" href="${attr(prefix + j.url)}" style="--tab-color:${j.thread}">
          <span class="xc-body">
            <span class="xc-badge">Journey</span>
            <span class="xc-title">${text(j.topic)}</span>
            ${j.description ? `<span class="xc-desc">${text(j.description)}</span>` : ""}
            <span class="xc-meta">${j.count} ${j.count === 1 ? "memory" : "memories"}</span>
          </span>
        </a>`;
  }
  const e = item.e;
  const conn = graphMemoryCount(e);
  return `        <a class="explore-card ec-entity" data-entity-id="${attr(e.id)}" data-kind="${e.kind}" href="${attr(prefix + entityUrl(e))}" style="--tab-color:${KIND[e.kind].color}">
          ${entityMedia(e, prefix)}
          <span class="xc-body">
            <span class="xc-badge">${text(KIND[e.kind].singular)}</span>
            <span class="xc-title">${text(e.name)}</span>
            ${e.detail ? `<span class="xc-desc">${text(e.detail)}</span>` : ""}
            ${conn != null ? `<span class="xc-meta">${conn} ${conn === 1 ? "memory" : "memories"}</span>` : ""}
          </span>
        </a>`;
}
// memory count attached to the entity by the caller (see renderContinueExploring)
function graphMemoryCount(e) { return (e && e._memories != null) ? e._memories : null; }

const SUBTITLES = {
  story: "Where this memory reaches across the archive.",
  person: "Where their thread leads next.",
  entity: "Other threads that run through here.",
  journey: "More ways to walk the archive."
};

function renderContinueExploring(ctx, graph, journeys, prefix) {
  const deck = continueDeck(ctx, graph, journeys);
  if (!deck.length) return "";
  // annotate entity cards with their memory count from the graph
  deck.forEach(item => {
    if (item.t === "entity") {
      const c = graph.entityConnections[item.e.id];
      item.e._memories = c ? (c.storyCount || 0) : 0;
    }
  });
  const cards = deck.map(item => card(item, prefix)).join("\n");
  const sub = SUBTITLES[ctx.type] || SUBTITLES.story;
  return `
  <section class="continue-exploring" aria-label="Continue exploring">
    <div class="container reveal">
      <p class="eyebrow">Follow a thread</p>
      <h2>Continue exploring</h2>
      <p class="ce-sub">${text(sub)}</p>
      <div class="explore-grid">
${cards}
      </div>
    </div>
  </section>`;
}

module.exports = { entityPreview, exploreEntities, continueDeck, renderContinueExploring };
