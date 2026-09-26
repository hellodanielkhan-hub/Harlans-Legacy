/* =========================================================================
   Harlan's Legacy — "Discover a Memory" living covers: curated photo pools

   Each homepage Discover card slowly reveals one family photograph after
   another (assets/discover-living.js). These pools are chosen by hand from
   the family photo archive (Supabase `photos`, the same manifest the family
   pages use) — real photographs only, no story artwork, no stock:

     funny   (Humor)              warm, lighter, personable moments
     grief   (Loss & Memory)      quieter, reflective photographs of the family
     shabbat (Faith & Traditions) family and occasion photographs — the archive
                                  holds no explicitly religious family photos,
                                  so this pool is family / tradition in spirit

   The first entry of a pool is what the card shows before any rotation (for
   Humor and Faith it is the card's existing cover). Pools are disjoint, so no
   photograph can appear on two cards at once. Entries are resolved against the
   live manifest at build time; a missing photo is simply skipped, and a card
   whose pool resolves to fewer than two photos keeps its static cover.
   ========================================================================= */
"use strict";

const POOLS = {
  funny: [
    { person: "harlan", id: "508556147-10228078061326150-5638579625169660949-n" },   // Harlan, 1970s portrait (current cover)
    { person: "hal", id: "487714021-10232812997965412-9218109837380083616-n" },      // Hal in Mardi Gras beads
    { person: "marvin", id: "508425718-10230733469254456-8304678049620777119-n" },   // Marvin at the fair, basket in hand
    { person: "harlan", id: "514971227-10228374019524920-4169024737502312036-n" },   // Harlan grinning under a hat
    { person: "harlan", id: "hal-and-harlan" },                                      // the brothers, grinning, step-and-repeat
    { person: "hal", id: "177680375-10222860887688875-639136943676799482-n" }       // Hal on the beach
  ],
  grief: [
    { person: "marvin", id: "marvin-and-zandra" },                                   // Marvin and Zandra's wedding
    { person: "zandra", id: "516523807-10228458963328462-2812137754455796728-n" },   // Zandra in the yard, 1960s
    { person: "marvin", id: "516607523-10228458948408089-8744987781729357311-n" },   // Marvin, a quiet portrait
    { person: "marvin", id: "marvin-and-zandra-2" },                                 // the two of them, faded print
    { person: "zandra", id: "504156313-10230533379732343-6280704363987193635-n" },   // Zandra by the house
    { person: "marvin", id: "504624772-10230533381332383-2679323943300035614-n" }    // the old house, a faded slide
  ],
  shabbat: [
    { person: "hal", id: "hal" },                                                    // Hal, formal portrait (current cover)
    { person: "harlan", id: "harlan-yaffe-with-mother-and", variant: "full", pos: [50, 30] }, // the family together (uncropped, so all three stay in frame)
    { person: "marvin", id: "marvin-j-yaffe-with-zandra-l" },                         // Marvin and Zandra, dressed for an outing
    { person: "zandra", id: "marvin-and-zandra" },                                    // Marvin and Zandra at a celebration
    { person: "hal", id: "hal-and-harlan" },                                          // the brothers in suits
    { person: "zandra", id: "zandra-l-yaffe-with-her-2-ki" }                          // Zandra with her two boys
  ]
};

// Match a pool entry against the manifest by exact id, or by id prefix (the
// manifest keeps slugs a little longer than the short names used above).
function resolvePool(key, peopleById) {
  const out = [], seen = new Set();
  for (const e of POOLS[key] || []) {
    const person = peopleById[e.person];
    const items = (person && person.photos && person.photos.items) || [];
    const it = items.find(x => x.id === e.id) || items.find(x => x.id.startsWith(e.id));
    if (!it || !it.portrait || !it.portrait.length) continue;
    // optional: the uncropped "full" derivative with its own position, for group photographs
    // whose face-centred square crop would leave someone out
    const full = e.variant === "full" && it.full && it.full.length;
    const k = e.person + "/" + it.id;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ person: e.person, it, kind: full ? "full" : "portrait", widths: full ? it.full : it.portrait, pos: (full && e.pos) || null });
  }
  return out;
}

module.exports = { POOLS, resolvePool };
