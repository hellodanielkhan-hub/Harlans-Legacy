/* =========================================================
   Harlan's Legacy — Experience enhancements (Phase 3)
   Craftsmanship only, progressive, defer-loaded on every page.
   If this file does not run, the site behaves exactly as before:
   the candle video still autoplays via its HTML attributes, and
   its poster/still image still covers the load-failure case.
   ========================================================= */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- View Transitions: opt into richer styling where supported ---- */
  if (document.startViewTransition) {
    document.documentElement.classList.add("hl-vt");
  }

  /* ---- Natural image fade-in ----
     Only images still loading are faded (already-cached ones never blink).
     Lightbox slides are handled separately. Off under reduced motion. */
  document.documentElement.classList.add("hl-enh");
  if (!reduceMotion) {
    Array.prototype.forEach.call(
      document.querySelectorAll(".portrait img, .card-catalogue img, .story-body img, .jc-photo img, .jfs-item img, .jpc-photo img, .lb-slide img"),
      function (img) {
        if (img.closest(".lb-slide")) return;                 // lightbox has its own reveal
        if (img.complete && img.naturalWidth > 0) return;     // already shown — no blink
        img.classList.add("hl-fade");
        var done = function () { img.classList.add("is-in"); };
        img.addEventListener("load", done);
        img.addEventListener("error", done);
        if (img.decode) img.decode().then(done).catch(function () {});
      }
    );
  }

  /* ---- About exhibit: rotating framed portraits (homepage only) ----
     A slow, cinematic cross-dissolve through the family's faces. It never
     competes with reading (long dwell, gentle fade), pauses when the tab is
     hidden, and holds a single portrait under prefers-reduced-motion. */
  (function initAboutPortraits() {
    var fig = document.getElementById("about-portrait");
    if (!fig) return;
    var slides = Array.prototype.slice.call(fig.querySelectorAll(".ap-slide"));
    if (!slides.length) return;
    var caption = document.getElementById("ap-caption");
    var idx = slides.findIndex(function (s) { return s.classList.contains("is-visible"); });
    if (idx < 0) { idx = 0; slides[0].classList.add("is-visible"); }

    function setCaption(s) {
      if (!caption) return;
      var name = s.getAttribute("data-name") || "";
      var role = s.getAttribute("data-role") || "";
      caption.innerHTML = '<span class="ap-name">' + name.replace(/[&<>]/g, "") + "</span>" +
        (role ? " &middot; " + role.replace(/[&<>]/g, "") : "");
    }
    setCaption(slides[idx]);

    if (reduceMotion || slides.length < 2) return;
    var ROTATE = 6500, timer = null;
    function tick() {
      var prev = slides[idx];
      idx = (idx + 1) % slides.length;
      var next = slides[idx];
      next.classList.add("is-visible");
      prev.classList.remove("is-visible");
      setCaption(next);
    }
    function schedule() { window.clearTimeout(timer); if (!document.hidden) timer = window.setTimeout(function () { tick(); schedule(); }, ROTATE); }
    document.addEventListener("visibilitychange", function () { if (document.hidden) window.clearTimeout(timer); else schedule(); });
    schedule();
  })();

  /* ---- Hero candle cinemagraph ----
     Real muted/looping candle video with graceful fallbacks:
       • video cannot load  → poster + still image beneath show
       • reduced motion      → video paused on its first frame (still)
       • scrolled off-screen → video paused to save CPU / battery
     The <video> is decorative (aria-hidden); the Friday status lives
     in the caption, which stays available to assistive tech. */
  var video = document.getElementById("hero-candle-video");
  if (video) {
    var figure = video.closest(".hero-candle");
    var failed = false;
    function markFailed() {
      if (failed) return;
      failed = true;
      if (figure) figure.classList.add("is-video-failed");
    }
    video.addEventListener("error", markFailed, true);
    Array.prototype.forEach.call(video.querySelectorAll("source"), function (s) {
      s.addEventListener("error", function () {
        // Failed only once every source has given up.
        if (video.networkState === video.NETWORK_NO_SOURCE) markFailed();
      });
    });
    // Catch the "no playable source" case that fires no media error.
    window.setTimeout(function () {
      if (video.networkState === video.NETWORK_NO_SOURCE || video.readyState === 0) markFailed();
    }, 2500);

    if (reduceMotion) {
      // Honour the preference: hold the still frame, never animate.
      video.removeAttribute("autoplay");
      try { video.pause(); } catch (e) {}
    } else {
      var tryPlay = function () { var p = video.play(); if (p && p.catch) p.catch(function () {}); };
      // Pause when the candle is off-screen; resume when it returns.
      if ("IntersectionObserver" in window) {
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            if (failed) return;
            if (en.isIntersecting) tryPlay(); else { try { video.pause(); } catch (e) {} }
          });
        }, { threshold: 0.12 });
        io.observe(video);
      } else {
        tryPlay();
      }
      // Re-hold when the tab is hidden (battery-friendly).
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) { try { video.pause(); } catch (e) {} }
        else if (!failed) tryPlay();
      });
    }
  }

  /* ---- Family photo lightbox ----
     Premium, dependency-free gallery. Smooth crossfade only, manual
     prev/next, optional 25s autoplay (paused while interacting), caption +
     approximate year + location, chronological order (the data order),
     zoom + pan, full keyboard support, Escape to close, lazy image loading.
     Inert unless the page injected #hl-lightbox + #hl-gallery. */
  (function initLightbox() {
    var lb = document.getElementById("hl-lightbox");
    var dataEl = document.getElementById("hl-gallery");
    if (!lb || !dataEl) return;
    var items = [];
    try { items = JSON.parse(dataEl.textContent || "[]"); } catch (e) {}
    if (!items.length) return;

    var frame = document.getElementById("lb-frame");
    var elCap = document.getElementById("lb-caption");
    var elYear = document.getElementById("lb-year");
    var elLoc = document.getElementById("lb-loc");
    var elCount = document.getElementById("lb-count");
    var btnPlay = lb.querySelector(".lb-play");
    var btnZoom = lb.querySelector(".lb-zoom");

    var idx = 0, lastFocus = null, playing = false, timer = null, hovering = false;
    var zoom = false, pan = { x: 0, y: 0 }, dragging = false, sx = 0, sy = 0;
    var FADE = reduceMotion ? 0 : 720;      // matches the CSS crossfade
    var INTERVAL = 5000;                    // autoplay cadence

    function escAttr(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

    function makeSlide(item) {
      var wrap = document.createElement("div");
      wrap.className = "lb-slide";
      wrap.innerHTML = '<picture><source type="image/webp" srcset="' + escAttr(item.webp) + '" sizes="(max-width:800px) 94vw, 80vw">' +
        '<img src="' + escAttr(item.src) + '" srcset="' + escAttr(item.jpg) + '" sizes="(max-width:800px) 94vw, 80vw" ' +
        'alt="' + escAttr(item.alt) + '" decoding="async"></picture>';
      return wrap;
    }
    var cache = {};
    function preload(item) { if (item && !cache[item.src]) { var i = new Image(); i.src = item.src; cache[item.src] = i; } }

    function show(n) {
      n = (n % items.length + items.length) % items.length;
      idx = n;
      var item = items[n];
      var slide = makeSlide(item);
      var img = slide.querySelector("img");
      frame.appendChild(slide);

      // meta updates immediately so navigation feels instant
      elCap.textContent = item.caption || "";
      elYear.textContent = item.year ? ("c. " + item.year) : "";
      elLoc.textContent = item.location || "";
      elCount.textContent = (n + 1) + " of " + items.length;
      resetZoom();

      // Reveal (crossfade) only once the image is decoded — no white flash;
      // the outgoing print stays until the incoming one is ready.
      function reveal() {
        if (slide._shown) return; slide._shown = true;
        void slide.offsetWidth;
        slide.classList.add("is-visible");
        Array.prototype.slice.call(frame.querySelectorAll(".lb-slide")).forEach(function (s) {
          if (s === slide) return;
          s.classList.remove("is-visible");
          var rm = function () { if (s.parentNode) s.parentNode.removeChild(s); };
          if (FADE) window.setTimeout(rm, FADE + 80); else rm();
        });
      }
      if (img.decode) { img.decode().then(reveal).catch(reveal); }
      else if (img.complete) { reveal(); }
      else { img.addEventListener("load", reveal); img.addEventListener("error", reveal); }
      window.setTimeout(reveal, 1400);        // safety net

      preload(items[(n + 1) % items.length]);
      preload(items[(n - 1 + items.length) % items.length]);
      preload(items[(n + 2) % items.length]);
    }
    function next() { show(idx + 1); bump(); }
    function prev() { show(idx - 1); bump(); }

    function open(start, trigEl) {
      lastFocus = trigEl || document.activeElement;
      idx = (typeof start === "number" && start >= 0) ? start : 0;
      frame.innerHTML = "";
      lb.hidden = false;
      document.body.classList.add("lb-open");
      show(idx);
      var c = lb.querySelector(".lb-close"); if (c) c.focus();
      document.addEventListener("keydown", onKey, true);
    }
    function close() {
      stop();
      lb.hidden = true;
      document.body.classList.remove("lb-open");
      document.removeEventListener("keydown", onKey, true);
      frame.innerHTML = "";
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    /* autoplay — optional, 5s, loops forever, paused while interacting */
    function schedule() { window.clearTimeout(timer); if (playing && !hovering && !dragging && !document.hidden) timer = window.setTimeout(function () { show(idx + 1); schedule(); }, INTERVAL); }
    function bump() { if (playing) schedule(); }        // reset the clock on manual nav
    function start() { playing = true; btnPlay.classList.add("is-playing"); btnPlay.setAttribute("aria-pressed", "true"); btnPlay.setAttribute("aria-label", "Pause slideshow"); schedule(); }
    function stop() { playing = false; btnPlay.classList.remove("is-playing"); btnPlay.setAttribute("aria-pressed", "false"); btnPlay.setAttribute("aria-label", "Play slideshow"); window.clearTimeout(timer); }
    function toggle() { playing ? stop() : start(); }

    lb.addEventListener("pointerenter", function () { hovering = true; window.clearTimeout(timer); });
    lb.addEventListener("pointerleave", function () { hovering = false; dragging = false; if (playing) schedule(); });
    document.addEventListener("visibilitychange", function () { if (document.hidden) window.clearTimeout(timer); else if (playing) schedule(); });

    /* zoom + pan */
    function applyPan() {
      var img = frame.querySelector(".lb-slide.is-visible img");
      if (img) img.style.transform = zoom ? ("scale(2.1) translate(" + pan.x + "px," + pan.y + "px)") : "";
    }
    function resetZoom() { zoom = false; pan = { x: 0, y: 0 }; frame.classList.remove("is-zoomed"); if (btnZoom) btnZoom.setAttribute("aria-pressed", "false"); applyPan(); }
    function toggleZoom() { zoom = !zoom; pan = { x: 0, y: 0 }; frame.classList.toggle("is-zoomed", zoom); if (btnZoom) btnZoom.setAttribute("aria-pressed", zoom ? "true" : "false"); applyPan(); }

    var lastSwipe = 0;
    frame.addEventListener("click", function () { if (Date.now() - lastSwipe < 400) return; toggleZoom(); });
    frame.addEventListener("pointerdown", function (e) { if (!zoom) return; dragging = true; sx = e.clientX; sy = e.clientY; });

    /* horizontal swipe navigation (mobile), when not zoomed */
    var stage = lb.querySelector(".lb-stage"), tsx = 0, tsy = 0, swiping = false;
    stage.addEventListener("pointerdown", function (e) { if (zoom) return; tsx = e.clientX; tsy = e.clientY; swiping = true; });
    stage.addEventListener("pointerup", function (e) {
      if (!swiping) return; swiping = false;
      var dx = e.clientX - tsx, dy = e.clientY - tsy;
      if (Math.abs(dx) > 48 && Math.abs(dy) < 48) { lastSwipe = Date.now(); (dx < 0 ? next : prev)(); }
    });
    window.addEventListener("pointermove", function (e) { if (!dragging) return; pan.x += (e.clientX - sx) / 2.1; pan.y += (e.clientY - sy) / 2.1; sx = e.clientX; sy = e.clientY; applyPan(); });
    window.addEventListener("pointerup", function () { if (dragging) { dragging = false; if (playing && !hovering) schedule(); } });

    /* controls */
    lb.querySelector(".lb-next").addEventListener("click", function (e) { e.stopPropagation(); next(); });
    lb.querySelector(".lb-prev").addEventListener("click", function (e) { e.stopPropagation(); prev(); });
    lb.querySelector(".lb-close").addEventListener("click", close);
    if (btnPlay) btnPlay.addEventListener("click", function (e) { e.stopPropagation(); toggle(); });
    if (btnZoom) btnZoom.addEventListener("click", function (e) { e.stopPropagation(); toggleZoom(); });
    Array.prototype.forEach.call(lb.querySelectorAll("[data-lb-close]"), function (el) { el.addEventListener("click", close); });

    function onKey(e) {
      if (lb.hidden) return;
      switch (e.key) {
        case "Escape": e.preventDefault(); close(); break;
        case "ArrowRight": e.preventDefault(); next(); break;
        case "ArrowLeft": e.preventDefault(); prev(); break;
        case "Home": e.preventDefault(); show(0); bump(); break;
        case "End": e.preventDefault(); show(items.length - 1); bump(); break;
        case " ": case "Spacebar": e.preventDefault(); toggle(); break;
        case "z": case "Z": case "+": case "=": e.preventDefault(); toggleZoom(); break;
        case "Tab": trapFocus(e); break;
      }
    }
    function trapFocus(e) {
      var f = Array.prototype.filter.call(lb.querySelectorAll("button"), function (b) { return b.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    Array.prototype.forEach.call(document.querySelectorAll("[data-lb-open]"), function (t) {
      t.addEventListener("click", function (e) { e.preventDefault(); open(parseInt(t.getAttribute("data-lb-open"), 10) || 0, t); });
    });
  })();
})();
