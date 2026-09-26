/* =========================================================================
   Harlan's Legacy — "Discover a Memory": living covers (homepage only)

   Each Discover card quietly reveals another family photograph every few
   seconds, like prints changing on an exhibition wall — not a carousel: no
   controls, no sliding, no zoom, just a slow crossfade between two stacked
   frames behind the card's existing scrim and type.

     • one shared clock: each card changes every INTERVAL, the cards STAGGER
       apart, so the section never flashes all at once
     • a card never shows the photograph it already shows, nor one another
       card is showing (the curated pools are also disjoint)
     • only the NEXT photograph of each card is fetched and decoded, and only
       once the section approaches the viewport; a frame is never shown
       before it has decoded, so a card is never blank
     • paused when the section is off screen or the tab is hidden
     • prefers-reduced-motion: nothing runs — the first photograph stays

   Sequence data comes from build.js (lib/journeys.js livingCover), as
   data-living on each .jc-living cover. Progressive enhancement only.
   ========================================================================= */
(function () {
  "use strict";
  var covers = Array.prototype.slice.call(document.querySelectorAll(".jc-living[data-living]"));
  if (!covers.length || !("IntersectionObserver" in window)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var conn = navigator.connection;                       // Data Saver / 2G: keep the first photograph
  if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ""))) return;

  var INTERVAL = 3600;   // each card changes about every 3.6 s
  var FADE = 650;        // crossfade length (CSS transition on .jl-frame)
  var FIRST = 2400;      // the first change waits for the section to settle in view

  var cards = covers.map(function (el) {
    var seq = []; try { seq = JSON.parse(el.getAttribute("data-living")) || []; } catch (e) {}
    var on = el.querySelector(".jl-frame");
    var img = on && on.querySelector("img");
    if (on) on.style.zIndex = "1";
    return { el: el, seq: seq, idx: 0, on: on, off: null, next: -1, ready: false, z: 1, sizes: img ? img.getAttribute("sizes") : "" };
  }).filter(function (c) { return c.on && c.seq.length > 1; });
  if (!cards.length) return;
  var STAGGER = Math.round(INTERVAL / cards.length);   // 1.2 s apart for three cards

  function stem(c, i) { return c.seq[i].d; }
  function srcset(p, ext) { return p.w.map(function (w) { return p.d + "." + (p.k || "portrait") + "." + w + "." + ext + " " + w + "w"; }).join(", "); }
  function showing() { return cards.map(function (c) { return stem(c, c.idx); }); }

  // next photograph in the card's own order: never the one it shows, never one another card shows
  function pickNext(c) {
    var busy = showing();
    for (var s = 1; s < c.seq.length; s++) {
      var i = (c.idx + s) % c.seq.length;
      if (busy.indexOf(stem(c, i)) < 0) return i;
    }
    return -1;
  }

  function makeFrame(c) {
    var pic = document.createElement("picture");
    pic.className = "jl-frame";
    var src = document.createElement("source"); src.type = "image/webp"; src.setAttribute("sizes", c.sizes);
    var img = document.createElement("img"); img.alt = ""; img.decoding = "async"; img.setAttribute("sizes", c.sizes);
    pic.appendChild(src); pic.appendChild(img);
    c.el.appendChild(pic);
    return pic;
  }

  // fetch + decode only the next photograph (into the hidden frame)
  function prepare(c) {
    var i = pickNext(c);
    if (i < 0 || (i === c.next && (c.ready || c.loading))) return;
    if (!c.off) c.off = makeFrame(c);
    var p = c.seq[i], img = c.off.querySelector("img"), source = c.off.querySelector("source");
    c.next = i; c.ready = false; c.loading = true;
    img.removeAttribute("loading");
    img.style.objectPosition = p.f[0] + "% " + p.f[1] + "%";
    source.setAttribute("srcset", srcset(p, "webp"));
    img.setAttribute("srcset", srcset(p, "jpg"));
    img.src = p.d + "." + (p.k || "portrait") + "." + p.w[p.w.length - 1] + ".jpg";
    var settle = function (ok) { if (c.next !== i) return; c.loading = false; c.ready = ok; if (!ok) c.next = -1; };
    if (img.decode) img.decode().then(function () { settle(true); }, function () { settle(false); });
    else img.onload = function () { settle(true); };
  }

  function advance(c) {
    if (!c.ready || c.next < 0 || showing().indexOf(stem(c, c.next)) >= 0) { prepare(c); return; }   // never cut to an unready frame
    // the new print fades in ON TOP of the old one (which stays fully opaque
    // beneath), so the card never dims mid-fade; the old one is hidden after
    var incoming = c.off, outgoing = c.on;
    incoming.style.zIndex = String(++c.z);
    incoming.classList.add("is-on");
    c.on = incoming; c.off = outgoing; c.idx = c.next; c.next = -1; c.ready = false;
    setTimeout(function () { outgoing.classList.remove("is-on"); prepare(c); }, FADE + 60);   // then quietly fetch the one after
  }

  /* ---- one shared, staggered clock; runs only while the section is on screen ---- */
  var turn = 0, timer = null, lead = null, inView = false, primed = false;
  function tick() { advance(cards[turn % cards.length]); turn++; }
  function start() {
    if (timer || lead || !inView || document.hidden) return;
    lead = setTimeout(function () { lead = null; tick(); timer = setInterval(tick, STAGGER); }, primed ? STAGGER : FIRST);
    primed = true;
  }
  function stop() { clearTimeout(lead); lead = null; clearInterval(timer); timer = null; }

  var section = cards[0].el.closest(".discover-grid") || cards[0].el;
  // as the section approaches: fetch each card's next photograph (one image per card)
  new IntersectionObserver(function (entries) {
    if (entries.some(function (e) { return e.isIntersecting; })) cards.forEach(prepare);
  }, { rootMargin: "400px 0px" }).observe(section);
  // while it is actually on screen: rotate; otherwise pause
  new IntersectionObserver(function (entries) {
    inView = entries.some(function (e) { return e.isIntersecting; });
    if (inView) start(); else stop();
  }, { threshold: 0.12 }).observe(section);
  document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else start(); });
})();
