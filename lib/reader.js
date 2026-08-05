/* =========================================================================
   Harlan's Legacy — Immersive Reader (Phase 11A · 11A.5 · 11A.75)

   Composes a memory into a cinematic reading experience from EXISTING data:
   the story record, the knowledge graph's resolved entities, the per-person
   photo galleries, AND each story's own editorial image gallery
   (data/story-photos.json — streets, newspapers, maps, objects…).

   Two modes, both data-driven:
     • AUTO (default) — weaves a varied, well-spaced set of photographs and
       memory callouts, drawing on story images first (the editor chose them
       for THIS memory) then family portraits, never repeating or colliding.
     • MANUAL — if the story record carries a `readerImages` plan, the editor's
       explicit choices win: exact image, layout, caption, placement, and which
       auto picks to disable. Manual always overrides auto.

   No new client JS: reveals ride the story page's existing IntersectionObserver.
   ========================================================================= */
"use strict";

const { KIND, entityUrl } = require("./graph.js");

function attr(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function text(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function html(s) { return String(s == null ? "" : s); }
function norm(s) { return String(s || "").toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }

function classify(it) {
  if (it.height > it.width * 1.05) return "portrait";
  if (it.width > it.height * 1.05) return "landscape";
  return "square";
}
function usable(it) { return it && ((it.portrait && it.portrait.length) || (it.full && it.full.length)); }

/* ---------- media pools ---------- */
// Family portraits — a face for pulls / diptychs.
function familyPool(persons) {
  const seen = {}, pool = [];
  (persons || []).forEach(p => {
    const ph = p && p.photos;
    if (!ph || Array.isArray(ph) || !ph.items || !ph.items.length) return;
    const items = ph.items.slice().sort((a, b) => (b.id === ph.primary ? 1 : 0) - (a.id === ph.primary ? 1 : 0));
    items.forEach(it => {
      if (seen[it.id] || !usable(it)) return; seen[it.id] = 1;
      pool.push({ source: "family", base: "assets/photos/" + p.id + "/", it, name: p.name, role: p.detail, orient: classify(it) });
    });
  });
  return pool;
}
// Editorial images the editor uploaded for this specific memory.
function storyPool(s) {
  const sp = s && s.storyPhotos;
  if (!sp || !sp.items || !sp.items.length) return [];
  const items = sp.items.slice().sort((a, b) => (b.id === sp.primary ? 1 : 0) - (a.id === sp.primary ? 1 : 0));
  return items.filter(usable).map(it => ({ source: "story", base: "assets/story-photos/story-" + s.id + "/", it, name: it.caption || "", role: "", orient: classify(it) }));
}
function cap(m) { return m.it.caption || m.name || ""; }
function metaOf(m) { return [m.it.year, m.it.location].filter(Boolean).join(" · "); }

/* ---------- image tags ---------- */
function srcset(base, id, kind, widths, ext) { return widths.map(w => `${base}${id}.${kind}.${w}.${ext} ${w}w`).join(", "); }
function coverImg(m, prefix, sizes) {
  const it = m.it, dir = prefix + m.base;
  const widths = (it.portrait && it.portrait.length) ? it.portrait : it.full;
  const kind = (it.portrait && it.portrait.length) ? "portrait" : "full";
  const largest = widths[widths.length - 1];
  const f = it.focus || { x: 50, y: 46 };
  return `<picture>
              <source type="image/webp" srcset="${srcset(dir, it.id, kind, widths, "webp")}" sizes="${sizes}">
              <img src="${dir}${it.id}.${kind}.${largest}.jpg" srcset="${srcset(dir, it.id, kind, widths, "jpg")}" sizes="${sizes}" width="${largest}" height="${largest}" style="object-position:${f.x}% ${f.y}%" alt="${attr(cap(m))}" loading="lazy" decoding="async">
            </picture>`;
}
function naturalImg(m, prefix, sizes) {
  const it = m.it, dir = prefix + m.base;
  const kind = (it.full && it.full.length) ? "full" : "portrait";
  const widths = kind === "full" ? it.full : it.portrait;
  const largest = widths[widths.length - 1];
  const w = it.width || largest, h = it.height || largest;
  return `<picture>
              <source type="image/webp" srcset="${srcset(dir, it.id, kind, widths, "webp")}" sizes="${sizes}">
              <img src="${dir}${it.id}.${kind}.${largest}.jpg" srcset="${srcset(dir, it.id, kind, widths, "jpg")}" sizes="${sizes}" width="${w}" height="${h}" alt="${attr(cap(m))}" loading="lazy" decoding="async">
            </picture>`;
}

/* ---------- figure layouts ---------- */
function portraitPull(m, prefix, side, capOverride) {
  const name = capOverride != null ? capOverride : m.name;
  return `          <figure class="mem-module mem-portrait pull-${side} reveal">
            <span class="mp-frame">${coverImg(m, prefix, "(max-width:640px) 60vw, 240px")}</span>
            ${(name || m.role) ? `<figcaption>${name ? `<span class="mp-name">${text(name)}</span>` : ""}${m.role ? `<span class="mp-role">${text(m.role)}</span>` : ""}</figcaption>` : ""}
          </figure>`;
}
function plate(m, prefix, capOverride, forceWide) {
  const cls = forceWide ? " is-wide" : (m.orient === "portrait" ? " is-portrait" : (m.orient === "landscape" ? " is-wide" : " is-square"));
  const c = capOverride != null ? capOverride : cap(m);
  const meta = metaOf(m);
  return `          <figure class="mem-module mem-photo${cls} reveal">
            <div class="mph-frame">${naturalImg(m, prefix, "(max-width:900px) 100vw, 860px")}</div>
            ${(c || meta) ? `<figcaption>${c ? `<span class="mph-cap">${text(c)}</span>` : ""}${meta ? `<span class="mph-meta">${text(meta)}</span>` : ""}</figcaption>` : ""}
          </figure>`;
}
function diptych(a, b, prefix) {
  const frame = m => `<figure class="dp-cell"><span class="dp-frame">${coverImg(m, prefix, "(max-width:640px) 92vw, 300px")}</span>${cap(m) ? `<figcaption>${text(cap(m))}</figcaption>` : ""}</figure>`;
  return `          <div class="mem-module mem-diptych reveal">
            ${frame(a)}
            ${frame(b)}
          </div>`;
}

/* ---------- callouts ---------- */
const KIND_ICON = {
  object: '<path d="M4 8l8-4 8 4-8 4-8-4z"/><path d="M4 8v8l8 4 8-4V8" fill="none"/>',
  place: '<path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2" fill="none"/>',
  event: '<circle cx="12" cy="12" r="8" fill="none"/><path d="M12 8v4l3 2" fill="none"/>'
};
const KIND_LABEL = { object: "Remembered object", place: "Where it happened", event: "A moment in time" };
function callout(e, prefix, kind) {
  const url = prefix + entityUrl(e);
  const icon = KIND_ICON[kind] || KIND_ICON.object;
  return `          <aside class="mem-module mem-callout reveal" data-kind="${kind}" style="--tab:${KIND[e.kind].color}">
            <span class="mc-kind"><svg viewBox="0 0 24 24" aria-hidden="true" stroke="currentColor" stroke-width="1.5" fill="currentColor">${icon}</svg>${text(KIND_LABEL[kind] || KIND[e.kind].singular)}</span>
            <a class="mc-name" href="${attr(url)}" data-entity-id="${attr(e.id)}" data-kind="${e.kind}">${text(e.name)}</a>
            ${e.detail ? `<p class="mc-detail">${text(e.detail)}</p>` : ""}
          </aside>`;
}
function pause() { return `          <div class="mem-module mem-pause reveal" aria-hidden="true"><span></span><span></span><span></span></div>`; }
function pullQuote(quote) { return `          <figure class="mem-module mem-pullquote reveal"><blockquote>${text(quote)}</blockquote></figure>`; }

/* ---------- masthead + coda ---------- */
function mastheadMeta(s) {
  const parts = [];
  if (s.memoryDate) parts.push(`<span class="sm-when">${text(s.memoryDate)}</span>`);
  parts.push(`<span class="sm-read">${s.readingTime || 2} min read</span>`);
  parts.push(`<span class="sm-by">Remembered by Hal</span>`);
  return parts.join('<span class="sm-dot" aria-hidden="true">·</span>');
}
function endingCoda(s, site) {
  const total = (site && site.archiveTotal) || "";
  return `
  <section class="story-coda" aria-label="End of memory">
    <div class="container reveal">
      <span class="coda-mark" aria-hidden="true"><i></i><b></b><i></i></span>
      <p class="coda-line">${total ? `One of ${text(total)} Fridays, kept the way this one was.` : "Kept the way every Friday is."}</p>
      <p class="coda-sub">The thread doesn't end here — it only turns. Follow where this memory leads.</p>
    </div>
  </section>`;
}

/* ---------- manual override plan ----------
   readerImages: [ { ref, layout, caption, after, enabled } ]
     ref     "story:<photoId>" | "family:<personId>" | "family:<personId>:<photoId>"
     layout  pull-left | pull-right | plate | wide  (optional — auto by orientation)
     caption optional caption override
     after   paragraph index to appear after (optional — evenly distributed)
     enabled default true; false removes an auto pick the editor turned off
*/
function resolveRef(ref, s, graph) {
  const parts = String(ref || "").split(":");
  if (parts[0] === "story") {
    const it = (s.storyPhotos && s.storyPhotos.items || []).find(x => x.id === parts[1]);
    return it && usable(it) ? { source: "story", base: "assets/story-photos/story-" + s.id + "/", it, name: it.caption || "", role: "", orient: classify(it) } : null;
  }
  if (parts[0] === "family") {
    const p = graph && graph.entityById[parts[1]];
    if (!p || !p.photos || !p.photos.items) return null;
    const it = parts[2] ? p.photos.items.find(x => x.id === parts[2]) : (p.photos.items.find(x => x.id === p.photos.primary) || p.photos.items[0]);
    return it && usable(it) ? { source: "family", base: "assets/photos/" + p.id + "/", it, name: p.name, role: p.detail, orient: classify(it) } : null;
  }
  return null;
}
function renderPlanned(entry, m, prefix) {
  const layout = entry.layout || (m.orient === "portrait" ? "pull-right" : (m.orient === "landscape" ? "wide" : "plate"));
  const capO = entry.caption != null ? entry.caption : null;
  if (layout === "pull-left" || layout === "pull-right") return portraitPull(m, prefix, layout === "pull-left" ? "left" : "right", capO);
  if (layout === "wide") return plate(m, prefix, capO, true);
  return plate(m, prefix, capO, false);
}

/* ---------- compose ---------- */
function composeBody(s, graph, prefix) {
  const paras = [s.lead].concat(s.body || []).filter(Boolean);
  const N = paras.length;
  if (!N) return "";
  const g = (graph && graph.storyConnections[s.id]) ? graph.storyConnections[s.id].groups : { person: [], place: [], object: [], event: [] };
  const persons = g.person || [], places = g.place || [], objects = g.object || [], events = g.event || [];

  const ins = {}, imgIdx = {};
  const idxOf = frac => Math.max(1, Math.min(N - 1, Math.round(N * frac)));
  const add = (i, h) => { if (!h) return; i = Math.max(0, Math.min(N, i)); (ins[i] = ins[i] || []).push(h); };
  const placeImage = (frac, h) => {
    if (!h) return; let i = idxOf(frac), guard = 0;
    while ((imgIdx[i] || imgIdx[i - 1] || imgIdx[i + 1]) && guard < N) { i = Math.min(N - 1, i + 1); guard++; }
    imgIdx[i] = 1; add(i, h);
  };

  // callouts (both modes)
  if (s.summary && N >= 2 && norm(s.summary) !== norm(paras[0])) add(1, pullQuote(s.summary));
  if (places[0]) add(Math.min(2, N - 1), callout(places[0], prefix, "place"));
  if (objects[0]) add(idxOf(0.5), callout(objects[0], prefix, "object"));
  if (events[0]) add(idxOf(0.9), callout(events[0], prefix, "event"));

  const manual = (s.readerImages || []).filter(e => e && e.ref);
  if (manual.length) {
    // MANUAL: the editor's explicit plan wins. Enabled entries only, in order,
    // placed at their `after` index or evenly distributed.
    const enabled = manual.filter(e => e.enabled !== false);
    enabled.forEach((entry, k) => {
      const m = resolveRef(entry.ref, s, graph);
      if (!m) return;
      const frac = (typeof entry.after === "number") ? (entry.after + 0.5) / N : (k + 1) / (enabled.length + 1);
      placeImage(frac, renderPlanned(entry, m, prefix));
    });
  } else {
    // AUTO: story images first (editor-chosen for this memory), then faces.
    const story = storyPool(s), family = familyPool(persons);
    const budget = N >= 9 ? 4 : N >= 6 ? 3 : N >= 3 ? 2 : N >= 2 ? 1 : 0;
    const usedIds = {}, usedPeople = {};
    const pxOf = m => { const f = (m.it.full && m.it.full.length) ? m.it.full : m.it.portrait; return f ? f[f.length - 1] : 0; };
    const takeFrom = (arr, pred) => { for (const m of arr) { if (usedIds[m.it.id]) continue; if (pred && !pred(m)) continue; usedIds[m.it.id] = 1; return m; } return null; };
    const take = pred => takeFrom(story, pred) || takeFrom(family, pred);
    const takeBest = pred => {
      let best = null; [story, family].forEach(arr => arr.forEach(m => { if (usedIds[m.it.id]) return; if (pred && !pred(m)) return; if (!best || pxOf(m) > pxOf(best)) best = m; }));
      if (best) usedIds[best.it.id] = 1; return best;
    };

    const imgs = [];
    // opening: a face beside the prose where one exists, else any image
    if (budget >= 1) { const m = takeFrom(family, x => x.orient === "portrait") || take(() => true); if (m) { usedPeople[m.source === "family" ? m.name : ""] = 1; imgs.push({ frac: 0.30, html: m.source === "family" && m.orient === "portrait" ? portraitPull(m, prefix, "right") : plate(m, prefix) }); } }
    if (budget >= 2) {
      const wide = takeBest(x => x.orient === "landscape");
      if (wide) imgs.push({ frac: 0.60, html: plate(wide, prefix) });
      else {
        const a = take(x => x.orient !== "landscape");
        const b = take(x => x.orient !== "landscape") ;
        if (a && b) imgs.push({ frac: 0.60, html: diptych(a, b, prefix) });
        else if (a) imgs.push({ frac: 0.60, html: plate(a, prefix) });
      }
    }
    if (budget >= 3) { const m = takeFrom(family, x => x.orient === "portrait") || take(x => x.orient !== "landscape") || take(() => true); if (m) imgs.push({ frac: 0.82, html: m.source === "family" && m.orient === "portrait" ? portraitPull(m, prefix, "left") : plate(m, prefix) }); }
    if (budget >= 4) { const m = takeBest(() => true); if (m) imgs.push({ frac: 0.91, html: plate(m, prefix) }); }

    imgs.forEach(im => placeImage(im.frac, im.html));
    if (N >= 9) { [0.44, 0.72].forEach(fr => { const i = idxOf(fr); if (!ins[i] && !imgIdx[i]) add(i, pause()); }); }
  }

  const out = [];
  for (let i = 0; i < N; i++) {
    (ins[i] || []).forEach(h => out.push(h));
    out.push(`          <p${i === 0 ? ' class="lede-para"' : ""}>${html(paras[i])}</p>`);
  }
  (ins[N] || []).forEach(h => out.push(h));
  return out.join("\n\n");
}

/* ---------- auto-plan preview (for the CMS to show/override) ---------- */
// Returns the image refs the AUTO composer would pick, so the editor can see
// and override them. Mirrors the auto selection above (family + story).
function autoPlan(s, graph) {
  const g = (graph && graph.storyConnections[s.id]) ? graph.storyConnections[s.id].groups : { person: [] };
  const persons = g.person || [];
  const paras = [s.lead].concat(s.body || []).filter(Boolean);
  const N = paras.length;
  const budget = N >= 9 ? 4 : N >= 6 ? 3 : N >= 3 ? 2 : N >= 2 ? 1 : 0;
  const story = storyPool(s), family = familyPool(persons);
  const used = {}, plan = [];
  const refOf = m => (m.source === "story" ? "story:" + m.it.id : "family:" + (m.base.split("/")[2]) + ":" + m.it.id);
  const takeFrom = (arr, pred) => { for (const m of arr) { if (used[m.it.id]) continue; if (pred && !pred(m)) continue; used[m.it.id] = 1; return m; } return null; };
  const take = pred => takeFrom(story, pred) || takeFrom(family, pred);
  if (budget >= 1) { const m = takeFrom(family, x => x.orient === "portrait") || take(() => true); if (m) plan.push({ ref: refOf(m), layout: m.source === "family" && m.orient === "portrait" ? "pull-right" : "plate", caption: m.name || m.it.caption || "", after: Math.round(N * 0.30), enabled: true }); }
  if (budget >= 2) { const m = takeFrom(story, x => x.orient === "landscape") || takeFrom(family, x => x.orient === "landscape") || take(() => true); if (m) plan.push({ ref: refOf(m), layout: m.orient === "landscape" ? "wide" : "plate", caption: m.it.caption || m.name || "", after: Math.round(N * 0.60), enabled: true }); }
  if (budget >= 3) { const m = takeFrom(family, x => x.orient === "portrait") || take(() => true); if (m) plan.push({ ref: refOf(m), layout: m.source === "family" && m.orient === "portrait" ? "pull-left" : "plate", caption: m.name || m.it.caption || "", after: Math.round(N * 0.82), enabled: true }); }
  if (budget >= 4) { const m = take(() => true); if (m) plan.push({ ref: refOf(m), layout: "plate", caption: m.it.caption || m.name || "", after: Math.round(N * 0.91), enabled: true }); }
  return plan;
}

module.exports = { composeBody, mastheadMeta, endingCoda, autoPlan };
