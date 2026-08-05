/* =========================================================================
   Harlan's Legacy — Immersive Reader (Phase 11A · refined 11A.5)

   Composes a single memory into a cinematic, museum-grade reading experience,
   entirely from EXISTING data (the story record + the knowledge graph's
   resolved entities + the per-person photo galleries). Nothing is fabricated.

   11A.5 elevation — photographs become part of the storytelling, not decoration:
     - the whole gallery of each connected person is available, not just the
       primary portrait, so faces and moments vary through the narrative;
     - layouts alternate on purpose (portrait pull left / right, a landscape
       full-bleed OR a diptych, a centred plate) and never repeat back-to-back;
     - images are spaced so two never collide, and their count scales with the
       length of the read;
     - a story with no photographs still reads as a complete, well-paced piece.

   No new client JS: reveals ride the story page's existing IntersectionObserver
   (`.reveal`), so reduced-motion and performance are inherited.
   ========================================================================= */
"use strict";

const { KIND, entityUrl } = require("./graph.js");

function attr(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function text(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function html(s) { return String(s == null ? "" : s); } // prose already contains sanctioned inline <em>
function norm(s) { return String(s || "").toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }

/* ---------- media pool (every usable photo of the connected people) ---------- */
function classify(it) {
  if (it.height > it.width * 1.05) return "portrait";
  if (it.width > it.height * 1.05) return "landscape";
  return "square";
}
function mediaPool(persons) {
  const seen = {}, pool = [];
  (persons || []).forEach(p => {
    const ph = p && p.photos;
    if (!ph || Array.isArray(ph) || !ph.items || !ph.items.length) return;
    const items = ph.items.slice().sort((a, b) => (b.id === ph.primary ? 1 : 0) - (a.id === ph.primary ? 1 : 0));
    items.forEach(it => {
      if (seen[it.id]) return;
      if (!((it.portrait && it.portrait.length) || (it.full && it.full.length))) return;
      seen[it.id] = 1;
      pool.push({ pid: p.id, name: p.name, role: p.detail, it, orient: classify(it) });
    });
  });
  return pool;
}
function cap(m) { return m.it.caption || m.name; }
function metaOf(m) { return [m.it.year, m.it.location].filter(Boolean).join(" · "); }

/* ---------- image tags ---------- */
function srcset(dir, id, kind, widths, ext) { return widths.map(w => `${dir}${id}.${kind}.${w}.${ext} ${w}w`).join(", "); }

// Square-cropped cover image (portrait pulls, diptych) — uses portrait derivatives + focal point.
function coverImg(m, prefix, sizes) {
  const it = m.it, dir = `${prefix}assets/photos/${m.pid}/`;
  const widths = (it.portrait && it.portrait.length) ? it.portrait : it.full;
  const kind = (it.portrait && it.portrait.length) ? "portrait" : "full";
  const largest = widths[widths.length - 1];
  const f = it.focus || { x: 50, y: 42 };
  return `<picture>
              <source type="image/webp" srcset="${srcset(dir, it.id, kind, widths, "webp")}" sizes="${sizes}">
              <img src="${dir}${it.id}.${kind}.${largest}.jpg" srcset="${srcset(dir, it.id, kind, widths, "jpg")}" sizes="${sizes}" width="${largest}" height="${largest}" style="object-position:${f.x}% ${f.y}%" alt="${attr(cap(m))}" loading="lazy" decoding="async">
            </picture>`;
}
// Natural-ratio image (plate / full-bleed) — uses full derivatives, real dimensions (CLS-safe).
function naturalImg(m, prefix, sizes) {
  const it = m.it, dir = `${prefix}assets/photos/${m.pid}/`;
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
function portraitPull(m, prefix, side) {
  return `          <figure class="mem-module mem-portrait pull-${side} reveal">
            <span class="mp-frame">${coverImg(m, prefix, "(max-width:640px) 60vw, 240px")}</span>
            <figcaption><span class="mp-name">${text(m.name)}</span>${m.role ? `<span class="mp-role">${text(m.role)}</span>` : ""}</figcaption>
          </figure>`;
}
function plate(m, prefix) {
  const cls = m.orient === "portrait" ? " is-portrait" : (m.orient === "landscape" ? " is-wide" : " is-square");
  const meta = metaOf(m);
  return `          <figure class="mem-module mem-photo${cls} reveal">
            <div class="mph-frame">${naturalImg(m, prefix, "(max-width:900px) 100vw, 860px")}</div>
            <figcaption><span class="mph-cap">${text(cap(m))}</span>${meta ? `<span class="mph-meta">${text(meta)}</span>` : ""}</figcaption>
          </figure>`;
}
function diptych(a, b, prefix) {
  const frame = m => `<figure class="dp-cell"><span class="dp-frame">${coverImg(m, prefix, "(max-width:640px) 92vw, 300px")}</span><figcaption>${text(m.name)}</figcaption></figure>`;
  return `          <div class="mem-module mem-diptych reveal">
            ${frame(a)}
            ${frame(b)}
          </div>`;
}

/* ---------- callouts (from entities.json details) ---------- */
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

/* ---------- compose the woven body ---------- */
function composeBody(s, graph, prefix) {
  const paras = [s.lead].concat(s.body || []).filter(Boolean);
  const N = paras.length;
  if (!N) return "";
  const g = (graph && graph.storyConnections[s.id]) ? graph.storyConnections[s.id].groups : { person: [], place: [], object: [], event: [] };
  const persons = g.person || [], places = g.place || [], objects = g.object || [], events = g.event || [];
  const pool = mediaPool(persons);

  // how many photographs a read of this length can carry, gracefully
  const budget = N >= 9 ? 4 : N >= 6 ? 3 : N >= 3 ? 2 : N >= 2 ? 1 : 0;
  const usedIds = {}, usedPeople = {};
  const pxOf = m => { const f = (m.it.full && m.it.full.length) ? m.it.full : m.it.portrait; return f ? f[f.length - 1] : 0; };
  const take = pred => { for (const m of pool) { if (usedIds[m.it.id]) continue; if (pred && !pred(m)) continue; usedIds[m.it.id] = 1; return m; } return null; };
  // For full-bleed / plate slots, prefer the highest-resolution candidate so a
  // large image is never a soft upscale.
  const takeBest = pred => { let best = null; for (const m of pool) { if (usedIds[m.it.id]) continue; if (pred && !pred(m)) continue; if (!best || pxOf(m) > pxOf(best)) best = m; } if (best) usedIds[best.it.id] = 1; return best; };

  // Build a varied image programme (each entry gets placed with spacing later).
  const imgs = [];
  if (budget >= 1) { const m = take(x => x.orient === "portrait") || take(() => true); if (m) { usedPeople[m.pid] = 1; imgs.push({ frac: 0.30, html: portraitPull(m, prefix, "right") }); } }
  if (budget >= 2) {
    const wide = takeBest(x => x.orient === "landscape");
    if (wide) imgs.push({ frac: 0.60, html: plate(wide, prefix) });
    else {
      const a = take(x => x.orient !== "landscape");
      const b = take(x => x.orient !== "landscape" && (!a || x.pid !== a.pid)) || take(x => x.orient !== "landscape");
      if (a && b) imgs.push({ frac: 0.60, html: diptych(a, b, prefix) });
      else if (a) imgs.push({ frac: 0.60, html: plate(a, prefix) });
    }
  }
  if (budget >= 3) { const m = take(x => !usedPeople[x.pid] && x.orient === "portrait") || take(x => x.orient === "portrait") || take(() => true); if (m) { usedPeople[m.pid] = 1; imgs.push({ frac: 0.82, html: portraitPull(m, prefix, "left") }); } }
  if (budget >= 4) { const m = takeBest(() => true); if (m) imgs.push({ frac: 0.91, html: plate(m, prefix) }); }

  // placement — callouts may share a paragraph gap; images never sit adjacent.
  const ins = {}, imgIdx = {};
  const idxOf = frac => Math.max(1, Math.min(N - 1, Math.round(N * frac)));
  const add = (i, h) => { if (!h) return; i = Math.max(0, Math.min(N, i)); (ins[i] = ins[i] || []).push(h); };
  const placeImage = (frac, h) => {
    if (!h) return; let i = idxOf(frac), guard = 0;
    while ((imgIdx[i] || imgIdx[i - 1] || imgIdx[i + 1]) && guard < N) { i = Math.min(N - 1, i + 1); guard++; }
    imgIdx[i] = 1; add(i, h);
  };

  if (s.summary && N >= 2 && norm(s.summary) !== norm(paras[0])) add(1, pullQuote(s.summary));
  if (places[0]) add(Math.min(2, N - 1), callout(places[0], prefix, "place"));
  if (objects[0]) add(idxOf(0.5), callout(objects[0], prefix, "object"));
  if (events[0]) add(idxOf(0.9), callout(events[0], prefix, "event"));
  imgs.forEach(im => placeImage(im.frac, im.html));
  if (N >= 9) { [0.44, 0.72].forEach(fr => { const i = idxOf(fr); if (!ins[i] && !imgIdx[i]) add(i, pause()); }); }

  const out = [];
  for (let i = 0; i < N; i++) {
    (ins[i] || []).forEach(h => out.push(h));
    out.push(`          <p${i === 0 ? ' class="lede-para"' : ""}>${html(paras[i])}</p>`);
  }
  (ins[N] || []).forEach(h => out.push(h));
  return out.join("\n\n");
}

module.exports = { composeBody, mastheadMeta, endingCoda };
