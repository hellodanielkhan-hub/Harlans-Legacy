/* =========================================================
   Harlan's Legacy — Knowledge Graph resolver
   Zero dependencies. Builds, purely from stories.json +
   entities.json, the full bidirectional graph:
     - every entity → every story it appears in
     - every story → every entity it contains
     - automatic backlinks (both directions)
     - "Related Memories" (stories sharing entities)
     - related entities (entities that co-occur in stories)
   No relationship is hand-maintained: story references
   (people/places/objects/events strings) are resolved
   against each entity's name / aliases, unioned with any
   seed story ids on the entity. Add a reference in either
   file and the edge appears on the next build.
   ========================================================= */
"use strict";

// kind → display + where its profile pages live + accent color.
// Concrete hex (not CSS vars) so entity-chip dots colour correctly on every
// generated page — story/family/entity pages define only a single --thread.
const KIND = {
  person: { label: "People",  singular: "Person", dir: "family", color: "#A8735A" }, // clay-warm
  place:  { label: "Places",  singular: "Place",  dir: "place",  color: "#6B7A8C" }, // slate-soft
  object: { label: "Objects", singular: "Object", dir: "object", color: "#5F8A82" }, // harbor-quiet
  event:  { label: "Events",  singular: "Event",  dir: "event",  color: "#B99189" }  // dust-rose
};
const STORY_FIELD = { person: "people", place: "places", object: "objects", event: "events" };

function norm(s) { return String(s == null ? "" : s).trim().toLowerCase(); }

// site-root-relative URL to an entity's profile page.
function entityUrl(ent) { return `${KIND[ent.kind].dir}/${ent.slug}.html`; }

function collectEntities(entities) {
  const list = [];
  // `hidden` people stay in the data (so they can be re-enabled later) but are
  // excluded from the graph entirely — search, related entities, resolution.
  const people = ((entities.family && entities.family.people) || []).filter(p => !p.hidden);
  people.forEach(p => list.push({
    kind: "person", id: p.id, slug: p.slug, name: p.name, fullName: p.fullName,
    detail: p.role, monogram: p.monogram, photos: p.photos, bio: p.bio,
    lifeLabel: p.lifeLabel, born: p.born, died: p.died,
    relationships: p.relationships, timeline: p.timeline,
    aliases: p.aliases || [], seedStories: p.storyIds || [], source: p
  }));
  [["place", entities.places], ["object", entities.objects], ["event", entities.events]]
    .forEach(([kind, arr]) => (arr || []).forEach(n => list.push({
      kind, id: n.id, slug: n.slug, name: n.name, detail: n.detail,
      monogram: (n.name || "?").trim().charAt(0).toUpperCase(),
      photos: [], aliases: n.aliases || [], seedStories: n.stories || [], source: n
    })));
  return list;
}

function buildGraph(stories, entities) {
  const ents = collectEntities(entities);
  const entityById = {};
  ents.forEach(e => { entityById[e.id] = e; });

  // alias/name lookup → entity (first definition wins)
  const lookup = {};
  ents.forEach(e => {
    [e.name, e.fullName, ...(e.aliases || [])].filter(Boolean).forEach(a => {
      const k = norm(a);
      if (k && !(k in lookup)) lookup[k] = e;
    });
  });

  const storyById = {};
  stories.forEach(s => { storyById[s.id] = s; });

  // edges
  const entStoryIds = {};   // entityId → Set(storyId)
  const storyEntIds = {};   // storyId  → Set(entityId)
  const storyUnmatched = {};// storyId  → { person:[str], place:[str], ... }
  ents.forEach(e => { entStoryIds[e.id] = new Set(); });
  stories.forEach(s => { storyEntIds[s.id] = new Set(); storyUnmatched[s.id] = { person: [], place: [], object: [], event: [] }; });

  function link(entId, storyId) {
    if (!entStoryIds[entId] || storyById[storyId] === undefined) return;
    entStoryIds[entId].add(storyId);
    storyEntIds[storyId].add(entId);
  }

  // 1) resolve each story's reference strings against entity aliases
  stories.forEach(s => {
    Object.keys(STORY_FIELD).forEach(kind => {
      const arr = s[STORY_FIELD[kind]] || [];
      arr.forEach(str => {
        const hit = lookup[norm(str)];
        if (hit && hit.kind === kind) link(hit.id, s.id);
        else if (hit) link(hit.id, s.id);        // aliased across kinds — still a real edge
        else storyUnmatched[s.id][kind].push(str);
      });
    });
  });

  // 2) union with entity-side seed story ids (robust to a missing string ref)
  ents.forEach(e => (e.seedStories || []).forEach(id => link(e.id, id)));

  // --- derived views -------------------------------------------------------
  // story → grouped entity records (matched) + leftover unmatched strings
  const storyConnections = {};
  stories.forEach(s => {
    const groups = { person: [], place: [], object: [], event: [] };
    [...storyEntIds[s.id]].forEach(eid => {
      const e = entityById[eid]; if (e) groups[e.kind].push(e);
    });
    Object.keys(groups).forEach(k => groups[k].sort((a, b) => a.name.localeCompare(b.name)));
    storyConnections[s.id] = { groups, unmatched: storyUnmatched[s.id],
      total: Object.values(groups).reduce((n, a) => n + a.length, 0) };
  });

  // entity → connected stories (records) + related entities (co-occurring)
  const entityConnections = {};
  ents.forEach(e => {
    const storyIds = [...entStoryIds[e.id]];
    const connectedStories = storyIds.map(id => storyById[id]).filter(Boolean)
      .sort((a, b) => Number(a.published) - Number(b.published) || a.id - b.id)
      .reverse();
    // related entities: those sharing at least one story, ranked by shared count
    const shared = {};
    storyIds.forEach(sid => [...storyEntIds[sid]].forEach(other => {
      if (other === e.id) return;
      shared[other] = (shared[other] || 0) + 1;
    }));
    const relatedEntities = Object.keys(shared)
      .map(id => ({ entity: entityById[id], shared: shared[id] }))
      .filter(x => x.entity)
      .sort((a, b) => b.shared - a.shared || a.entity.name.localeCompare(b.entity.name));
    entityConnections[e.id] = { stories: connectedStories, related: relatedEntities, storyCount: storyIds.length };
  });

  // story → Related Memories (other stories sharing entities), ranked
  const relatedMemories = {};
  stories.forEach(s => {
    const mine = storyEntIds[s.id];
    const scored = stories.filter(o => o.id !== s.id).map(o => {
      const via = [...storyEntIds[o.id]].filter(id => mine.has(id));
      return { story: o, shared: via.length, via: via.map(id => entityById[id]).filter(Boolean) };
    }).filter(x => x.shared > 0)
      .sort((a, b) => b.shared - a.shared
        || Number(b.story.published) - Number(a.story.published)
        || a.story.title.localeCompare(b.story.title));
    relatedMemories[s.id] = scored;
  });

  return {
    KIND, entityUrl,
    entities: ents, entityById,
    storyConnections, entityConnections, relatedMemories,
    stats: {
      entities: ents.length,
      edges: stories.reduce((n, s) => n + storyEntIds[s.id].size, 0),
      byKind: ents.reduce((m, e) => (m[e.kind] = (m[e.kind] || 0) + 1, m), {})
    }
  };
}

module.exports = { buildGraph, KIND, entityUrl };
