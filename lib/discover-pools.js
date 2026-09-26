/* =========================================================================
   Harlan's Legacy — curated family photograph pools (homepage + theme pages)

   Chosen by hand from the family photo archive (Supabase `photos`, the same
   manifest the family pages use) — real photographs only, no story artwork,
   no stock — and resolved against the live manifest at build time.

   POOLS  one per Discover card / theme (assets/discover-living.js rotates them):
     funny   (Humor)              warm, lighter, personable moments
     grief   (Loss & Memory)      quieter, reflective photographs of the family
     shabbat (Faith & Traditions) family and occasion photographs — the archive
                                  holds no explicitly religious family photos,
                                  so this pool is family / tradition in spirit
     The FIRST photograph of a pool is both the card's opening frame and the
     theme page's cover (lib/journeys.js assignCovers); `cover` picks a
     different derivative for the larger theme-page hero only.

   ABOUT  one dignified portrait per family member for "About Harlan"
          (assets/experience.js rotates it; the caption names each person).

   All pools are disjoint, so the About exhibit and the three Discover cards
   can never show the same photograph at the same time. A missing photo is
   skipped; a Discover card whose pool resolves to fewer than two photographs
   keeps its static cover.
   ========================================================================= */
"use strict";

const POOLS = {
  funny: [
    { person: "harlan", id: "508556147-10228078061326150-5638579625169660949-n" },   // Harlan, 1970s portrait (cover)
    { person: "hal", id: "487714021-10232812997965412-9218109837380083616-n" },      // Hal in Mardi Gras beads
    { person: "marvin", id: "508425718-10230733469254456-8304678049620777119-n" },   // Marvin at the fair, basket in hand
    { person: "harlan", id: "514971227-10228374019524920-4169024737502312036-n" },   // Harlan grinning under a hat
    { person: "harlan", id: "hal-and-harlan" },                                      // the brothers, grinning, step-and-repeat
    { person: "hal", id: "177680375-10222860887688875-639136943676799482-n" }       // Hal on the beach
  ],
  grief: [
    { person: "marvin", id: "marvin-and-zandra", cover: "best" },                    // Marvin and Zandra's wedding (cover)
    { person: "zandra", id: "516523807-10228458963328462-2812137754455796728-n" },   // Zandra in the yard, 1960s
    { person: "zandra", id: "516533150-10228458963368463-8391854088951359797-n" },   // Zandra and a friend in the garden
    { person: "marvin", id: "marvin-and-zandra-2" },                                 // the two of them, faded print
    { person: "zandra", id: "504156313-10230533379732343-6280704363987193635-n" },   // Zandra by the house
    { person: "marvin", id: "504624772-10230533381332383-2679323943300035614-n" }    // the old house, a faded slide
  ],
  shabbat: [
    { person: "hal", id: "hal" },                                                    // Hal, formal portrait (cover)
    { person: "harlan", id: "harlan-yaffe-with-mother-and", variant: "full", pos: [50, 30] }, // the family together (uncropped, so all three stay in frame)
    { person: "marvin", id: "marvin-j-yaffe-with-zandra-l" },                         // Marvin and Zandra, dressed for an outing
    { person: "zandra", id: "marvin-and-zandra" },                                    // Marvin and Zandra at a celebration
    { person: "hal", id: "hal-and-harlan" },                                          // the brothers in suits
    { person: "zandra", id: "zandra-l-yaffe-with-her-2-ki" }                          // Zandra with her two boys
  ]
};

const ABOUT = [
  { person: "marvin", id: "516607523-10228458948408089-8744987781729357311-n", variant: "best" },   // Marvin, a quiet portrait
  { person: "zandra", id: "464922816-10225644168720356-7727881483837371960-n", variant: "best" },   // Zandra, black-and-white portrait
  { person: "harlan", id: "516640506-10228432046535559-8885468322076332904-n", variant: "best" },   // Harlan, smiling
  { person: "hal", id: "517626788-10234663381063833-869554853570533631-n", variant: "best" }        // Hal, in a suit at dinner
];

// Match an entry against the manifest by exact id, or by id prefix (the manifest
// keeps some slugs a little longer than the names used above).
// variant "full": the uncropped derivative with its own position, for group
//   photographs whose face-centred square crop would leave someone out.
// variant "best": for small originals whose square crop tops out below 528px,
//   the uncropped derivative when it is larger (so a portrait is not
//   upscaled); a large original keeps its face-centred crop (and its weight).
function resolveEntries(entries, peopleById) {
  const out = [], seen = new Set();
  for (const e of entries || []) {
    const person = peopleById[e.person];
    const items = (person && person.photos && person.photos.items) || [];
    const it = items.find(x => x.id === e.id) || items.find(x => x.id.startsWith(e.id));
    if (!it || !it.portrait || !it.portrait.length) continue;
    const hasFull = it.full && it.full.length;
    const maxPortrait = Math.max(...it.portrait);
    const full = !!hasFull && (e.variant === "full" || (e.variant === "best" && maxPortrait < 528 && Math.max(...it.full) > maxPortrait));
    const k = e.person + "/" + it.id;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ person: e.person, it, kind: full ? "full" : "portrait", widths: full ? it.full : it.portrait, pos: (full && e.pos) || null });
  }
  return out;
}
const resolvePool = (key, peopleById) => resolveEntries(POOLS[key], peopleById);
const resolveAbout = peopleById => resolveEntries(ABOUT, peopleById);
// the theme page's cover: the pool's first photograph, in its `cover` variant
function resolveCover(key, peopleById) {
  const first = (POOLS[key] || [])[0];
  return first ? resolveEntries([Object.assign({}, first, { variant: first.cover || first.variant })], peopleById)[0] || null : null;
}

module.exports = { POOLS, ABOUT, resolvePool, resolveAbout, resolveCover };
