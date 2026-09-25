/* =========================================================================
   Harlan's Legacy — Listening (Cinematic) PRODUCTION ENGINE

   CANONICAL ENGINE ID: harlan-listen-cinematic
   Lineage: the evolved implementation of the approved feature that originated in
   listen-cinematic-experience-v2.html — master state machine, singleton
   fixed-slot .leaf + .dest handoff (corrected page-turn from
   listen-page-engine-proof.html), paint-only spatial ink-front writing, one
   .cur spoken-word focus, physical cover opening, audio.currentTime as the sole
   reading clock, story-specific ducked soundscape, ending/exit, pause/resume,
   Escape, responsive. See LISTENING_SOURCE_OF_TRUTH.md.

   Parameterized & reusable: reads the story's narrated paragraphs from the
   reader markup ([data-narrate]) and the approved narration manifest
   (data-listen → listen.json). No hardcoded story/ paths/ PARAS. Mounted in a
   Shadow DOM so it cannot touch the normal reader. Narration audio/timings are
   lazy-loaded only when Listening is activated.
   ========================================================================= */
(function () {
  "use strict";

  // ---- machine-readable production identity (build guard asserts this) ----
  var ENGINE_ID = "harlan-listen-cinematic";
  var ENGINE_VERSION = "2.0.0";
  var ENGINE_LINEAGE = "listen-cinematic-experience-v2";
  window.HL_LISTEN_ENGINE = { id: ENGINE_ID, version: ENGINE_VERSION, lineage: ENGINE_LINEAGE };

  var THIS_SCRIPT = document.currentScript;
  var card = document.querySelector(".story-card[data-listen]") || document.querySelector("[data-listen]");
  if (!card) return;                                   // story not eligible → normal reader, untouched
  var BASE = card.getAttribute("data-listen").replace(/\/?$/, "/");
  var STORY_ID = card.getAttribute("data-story-id") || "";
  var DEBUG = /[?&]hldebug/.test(location.search);
  var cssHref = THIS_SCRIPT && THIS_SCRIPT.src ? THIS_SCRIPT.src.replace(/listen-cinematic\.js.*$/, "listen-cinematic.css") : "../assets/listen-cinematic.css";
  var ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];

  // narrated paragraphs come from the reader markup (lead + body), never inline
  var origParas = [].slice.call(document.querySelectorAll("[data-narrate]"));
  if (!origParas.length) return;
  var PARAS = origParas.map(function (p) { return p.textContent.replace(/\s+/g, " ").trim(); }).filter(Boolean);

  // cover identity from the page (fallbacks keep it generic)
  var idn = document.querySelector(".cover-identity");
  var TITLE = ((idn && idn.querySelector("h1") ? idn.querySelector("h1").textContent : (document.title || "").split("—")[0]) || "The memory").trim();
  var SERIES = ((idn && idn.querySelector(".cover-eyebrow") ? idn.querySelector(".cover-eyebrow").textContent : "Mom & Dad Stories") || "").trim();

  ensureFonts();

  var MAN = null, DUR = 0;
  // tiny manifest fetch on load (for the CTA duration + gating); audio/timings are lazy
  // The CTA stays disabled until the manifest is in, so a tap always starts the
  // experience inside its own user gesture (and never lands on a dead button).
  fetch(BASE + "listen.json").then(function (r) { return r.ok ? r.json() : null; })
    .then(function (m) { if (!m || !m.words) { dropCta(); return; } MAN = m; DUR = m.duration || 0; if (durEl) durEl.textContent = DUR ? " · " + fmt(DUR) : ""; cta.disabled = false; })
    .catch(dropCta);
  function dropCta() { if (cta.parentNode) cta.parentNode.removeChild(cta); }

  /* ---------------- the light-DOM CTA ---------------- */
  var cta = document.createElement("button");
  cta.className = "hl-listen"; cta.type = "button"; cta.disabled = true; cta.setAttribute("aria-label", "Listen to this memory — enter the listening experience");
  cta.innerHTML = '<span class="hl-glyph" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" fill="currentColor"/></svg></span><span class="hl-label">Listen to this memory</span><span class="hl-dur"></span>';
  (idn || card).appendChild(cta);
  var durEl = cta.querySelector(".hl-dur");
  cta.addEventListener("click", launch);

  /* ---------------- lazy-loaded narration data ---------------- */
  var TIMINGS = null, ZONESDATA = null;
  function ensureData(cb) {
    var afterMan = function () {
      if (TIMINGS) { cb(true); return; }
      var w = fetch(BASE + MAN.words, { priority: "high" }).then(function (r) { return r.json(); });
      var z = MAN.zones ? fetch(BASE + MAN.zones, { priority: "high" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }) : Promise.resolve(null);
      Promise.all([w, z]).then(function (a) { TIMINGS = a[0].words || a[0]; ZONESDATA = a[1]; if (TIMINGS && TIMINGS.length) { DUR = DUR || TIMINGS[TIMINGS.length - 1].end; cb(true); } else cb(false); }).catch(function () { cb(false); });
    };
    if (MAN) return afterMan();
    fetch(BASE + "listen.json").then(function (r) { return r.ok ? r.json() : null; }).then(function (m) { if (!m || !m.words) return cb(false); MAN = m; DUR = m.duration || 0; afterMan(); }).catch(function () { cb(false); });
  }

  /* ---------------- engine state ---------------- */
  var host = null, root = null, scene = null, book, cover, leaf, dest, leafText, destText, leafFoot, destFoot,
      turnshadow, edgelight, bend, leafPool, pen, dbg, measurePtx, bar, playBtn, closeBtn, atmosBtn;
  var audio = null, scapeCtl = null;
  var PAGES = [], current = 0, STATE = 'IDLE', TURN = 'SETTLED', TEXT = 'UNWRITTEN';
  var WORDS = [], curWordEl = null, penHideT = 0, anims = [], bookFloat = null, raf = null, seqToken = 0;
  var TURN_DUR = 1.15, TURN_LEAD = 1.32, destIdx = -1, destLive = false, open = false;
  var reduceMotion = matchMedia("(prefers-reduced-motion:reduce)").matches;

  function launch() {
    if (open) return; open = true; cta.setAttribute("aria-expanded", "true"); cta.classList.add("is-busy");
    if (MAN) proceed(); else fetch(BASE + "listen.json").then(function (r) { return r.ok ? r.json() : null; }).then(function (m) { if (!m || !m.words) { bail(); return; } MAN = m; DUR = m.duration || 0; proceed(); }).catch(bail);
  }
  function bail() { open = false; cta.classList.remove("is-busy"); }
  var launchTok = 0;
  function proceed() {
    var tok = ++launchTok;
    // Respond on the tap itself: the dark room opens now and the book arrives once its
    // timings are in. (Waiting for the timing files first left the page unchanged for
    // seconds on a phone, while those small files competed with the MP3 stream.)
    buildStage();
    // Request the small timing/zone files BEFORE the audio stream starts.
    ensureData(function (ok) { setTimeout(function () {                        // after audio + soundscape below exist
      if (tok !== launchTok) return;                                        // closed or relaunched meanwhile
      if (!ok) { closeOverlay(); return; }                                   // graceful: back to the reader
      if (ZONESDATA && scapeCtl) scapeCtl.setZones(ZONESDATA);
      // pagination must measure the FULLY-STYLED stage with REAL fonts loaded, or it
      // over-paginates (0-height / fallback-font measurement). Gate on both.
      var go = function () { if (tok === launchTok) whenStyled(beginSequence); };
      if (document.fonts && document.fonts.ready) { var did = false; var run = function () { if (!did) { did = true; go(); } }; document.fonts.ready.then(run); setTimeout(run, 900); }
      else go();
    }, 0); });
    // Establish audio + the AudioContext SYNCHRONOUSLY inside the click gesture, so
    // later playback (which happens ~2s later at OPEN_SETTLE→READING) is permitted.
    if (!audio) { audio = new Audio(); audio.preload = "auto"; audio.addEventListener("error", function () { if (open) closeOverlay(); }); audio.addEventListener("ended", function () { if (STATE === "READING") endReading(); }); }
    try { audio.muted = true; audio.src = BASE + MAN.audio; var up = audio.play(); if (up && up.then) up.then(function () { audio.pause(); audio.currentTime = 0; audio.muted = false; }).catch(function () { audio.muted = false; }); else audio.muted = false; } catch (e) { audio.muted = false; }
    try { if (window.HLSoundscape && !scapeCtl) scapeCtl = window.HLSoundscape.create({ soundscape: (MAN.soundscape || (MAN.zones ? "blue-chair" : "default")), isPaused: function () { return !audio || audio.paused; } }); if (scapeCtl) { scapeCtl.resume(); scapeCtl.silence(); } } catch (e) {}
  }

  /* ---------------- build the Shadow-DOM stage ---------------- */
  function stageHTML() {
    return '<link rel="stylesheet" href="' + cssHref + '">' +
      '<div class="lc-scene' + (DEBUG ? ' debug' : '') + '" id="lcScene">' +
      '<div class="dbg" id="dbg"></div>' +
      '<div class="scene" id="sceneInner">' +
      '<div class="atmos" aria-hidden="true"><div class="base"></div><div class="warmpool"></div><div class="coolpool"></div><div class="expo"></div><div class="grain"></div><div class="vig"></div></div>' +
      '<div class="book" id="book"><div class="contact" aria-hidden="true"></div><div class="block" aria-hidden="true"></div>' +
      '<div class="surface" id="dest"><div class="vignette"></div><div class="pool"></div><div class="edgedark"></div><div class="pagetext"><div class="story-text" id="destText"></div></div><div class="foot" id="destFoot"></div></div>' +
      '<div id="turnshadow" aria-hidden="true"></div>' +
      '<div id="leaf"><div class="face back"><div class="ubib"></div></div><div class="face front surface"><div class="vignette"></div><div class="pool" id="leafPool"></div><div class="edgedark"></div><div class="pagetext"><div class="story-text" id="leafText"></div></div><div class="foot" id="leafFoot"></div><div class="pen" id="pen"></div></div><div class="edgelight" id="edgelight"></div><div class="bend" id="bend"></div></div>' +
      '<div class="cover" id="cover"><div class="thickedge" aria-hidden="true"></div><div class="cface inner" aria-hidden="true"><div class="lt"></div></div>' +
      '<div class="cface front"><div class="cloth"></div><div class="rake"></div><div class="bloom"></div><div class="falloff"></div><div class="keyline"></div>' +
      '<div class="plate"><div class="masthead">Harlan’s Legacy</div><div class="drule"></div><div class="titlewrap"><div class="kicker">from the collected memories</div>' +
      '<div class="title" id="lcTitle"></div><div class="teller">as kept by Hal</div>' +
      '<div class="series"><span id="lcSeries"></span><span class="dot"></span><span id="lcNo"></span></div></div></div><div class="colophon" aria-hidden="true"></div></div>' +
      '<div class="foreedge" aria-hidden="true"></div></div>' +
      '<div class="spine" aria-hidden="true"></div></div>' +
      '</div>' +
      '<div class="lc-bar" id="bar" role="group" aria-label="Memory player">' +
      '<button class="lc-btn" id="playBtn" type="button" aria-label="Pause narration"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor"/><rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor"/></svg></button>' +
      '<button class="lc-btn" id="closeBtn" type="button" aria-label="Close listening and return to reading"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>' +
      '</div>' +
      '<div class="lc-attrib" id="attrib">' + esc(MAN && MAN.label ? MAN.label : "Narrated by the voice of Harlan’s Legacy") + ' — a generated narration, not an original recording.</div>' +
      '</div>';
  }
  function buildStage() {
    host = document.createElement("div"); host.setAttribute("role", "dialog"); host.setAttribute("aria-label", "Listening — " + TITLE);
    root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    root.innerHTML = stageHTML();
    document.body.appendChild(host);
    scene = root.getElementById("lcScene");
    book = root.getElementById("book"); cover = root.getElementById("cover"); leaf = root.getElementById("leaf"); dest = root.getElementById("dest");
    leafText = root.getElementById("leafText"); destText = root.getElementById("destText"); leafFoot = root.getElementById("leafFoot"); destFoot = root.getElementById("destFoot");
    turnshadow = root.getElementById("turnshadow"); edgelight = root.getElementById("edgelight"); bend = root.getElementById("bend");
    leafPool = root.getElementById("leafPool"); pen = root.getElementById("pen"); dbg = root.getElementById("dbg"); bar = root.getElementById("bar");
    playBtn = root.getElementById("playBtn"); closeBtn = root.getElementById("closeBtn"); measurePtx = leaf.querySelector(".pagetext");
    root.getElementById("lcTitle").textContent = TITLE;
    root.getElementById("lcSeries").textContent = SERIES || "Mom & Dad Stories";
    root.getElementById("lcNo").textContent = STORY_ID ? ("No. " + STORY_ID) : "";
    // audio + soundscape were established during the click gesture (see proceed());
    // here we only wire the in-stage controls.
    // controls
    playBtn.addEventListener("click", playPause);
    closeBtn.addEventListener("click", closeOverlay);
    document.addEventListener("keydown", onKey);
    if (DEBUG) window.__lcDbg = function () { return audio ? { state: STATE, at: +audio.currentTime.toFixed(2), paused: audio.paused, muted: audio.muted, rs: audio.readyState, err: audio.error && audio.error.code, srcTail: (audio.src || "").slice(-40) } : { state: STATE, audio: null }; };
    // reveal overlay (fade the black room in), lock the reader scroll
    scrollY = window.scrollY || 0; document.documentElement.classList.add("hl-noscroll");
    void host.offsetHeight; host.classList.add("lc-visible");
  }

  // Run cb only once the shadow stylesheet has actually applied (so layout is real).
  function whenStyled(cb) {
    var link = root && root.querySelector('link[rel="stylesheet"]');
    var did = false, run = function () { if (did) return; did = true; setTimeout(cb, 30); };   // small settle so layout flushes
    if (!link || link.sheet) { run(); return; }
    link.addEventListener("load", run); link.addEventListener("error", run); setTimeout(run, 1500);
  }

  /* ---------------- pages (timing-driven, inline .w spans, drop cap) ---------------- */
  function paraCounts() { return PARAS.map(function (p) { return (p.match(/\S+/g) || []).filter(function (t) { return /[A-Za-z0-9]/.test(t); }).length; }); }
  function buildPages() {
    var counts = paraCounts(), breakAt = {}, acc = 0; counts.forEach(function (c, i) { if (i > 0) breakAt[acc] = 1; acc += c; });
    var SENTS = [], s = []; for (var i = 0; i < TIMINGS.length; i++) { s.push(i); if (/[.!?][")”’]?$/.test(TIMINGS[i].w)) { SENTS.push({ words: s, paraStart: !!breakAt[s[0]] }); s = []; } } if (s.length) SENTS.push({ words: s, paraStart: !!breakAt[s[0]] });
    PAGES = []; var TARGET = 0.66, PARA_FILL = 0.44, si = 0, guard = 0;
    while (si < SENTS.length && guard++ < 3000) {
      var lead = (PAGES.length === 0); leafText.className = 'story-text' + (lead ? ' lead' : ''); leafText.innerHTML = ''; measurePtx.style.display = 'block';
      var cs = getComputedStyle(measurePtx), avail = measurePtx.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      if (DEBUG && PAGES.length === 0) window.__pag0 = { avail: avail, clientH: measurePtx.clientHeight, fs: getComputedStyle(leafText).fontSize };
      function fill() { return leafText.offsetHeight / Math.max(avail, 1); }
      var curP = document.createElement('p'); leafText.appendChild(curP); var words = [], added = 0;
      while (si < SENTS.length) {
        var sent = SENTS[si];
        if (sent.paraStart && added > 0) { if (fill() >= PARA_FILL) break; curP = document.createElement('p'); leafText.appendChild(curP); }
        var mark = []; sent.words.forEach(function (wi) { if (curP.childNodes.length) curP.appendChild(document.createTextNode(' ')); var sp = document.createElement('span'); sp.className = 'w'; sp.textContent = TIMINGS[wi].w; curP.appendChild(sp); mark.push(sp); });
        if (fill() > TARGET && added > 0) { mark.forEach(function (sp) { var pv = sp.previousSibling; if (pv && pv.nodeType === 3) curP.removeChild(pv); curP.removeChild(sp); }); if (!curP.childNodes.length) leafText.removeChild(curP); break; }
        sent.words.forEach(function (wi) { words.push(TIMINGS[wi]); }); added++; si++;
      }
      measurePtx.style.display = ''; PAGES.push({ html: leafText.innerHTML, lead: lead, words: words, firstStart: (words[0] ? words[0].start : 0), lastEnd: (words.length ? words[words.length - 1].end : 0) });
    }
    leafText.className = 'story-text'; leafText.innerHTML = ''; current = 0;
  }
  function bindWords(textEl, footEl, idx) {
    var pg = PAGES[idx]; textEl.className = 'story-text' + (pg.lead ? ' lead' : ''); textEl.innerHTML = pg.html;
    var spans = [].slice.call(textEl.querySelectorAll('.w')); if (pg.lead && spans[0]) spans[0].classList.add('drop');
    for (var i = 0; i < spans.length; i++) { var tm = pg.words[i]; spans[i].__s = tm ? tm.start : 0; spans[i].__e = tm ? tm.end : 0; }
    footEl.textContent = TITLE + ' · ' + (ROMAN[idx] || (idx + 1)); return spans;
  }
  function prepareLeaf(idx) { WORDS = bindWords(leafText, leafFoot, idx); setFocus(null); TEXT = 'UNWRITTEN'; }
  function clearSurface(textEl, footEl) { textEl.className = 'story-text'; textEl.innerHTML = ''; footEl.textContent = ''; }
  function setFocus(el) { if (curWordEl === el) return; if (curWordEl) curWordEl.classList.remove('cur'); curWordEl = el; if (el) el.classList.add('cur'); }

  // writing driver — the ONLY thing that changes ink visibility (paint-only; layout never changes)
  function driveWriting(t) {
    var found = null, started = false, allDone = (WORDS.length > 0);
    for (var i = 0; i < WORDS.length; i++) {
      var el = WORDS[i], st = el.__s, en = el.__e, drop = el.classList.contains('drop');
      if (t >= en) { if (!el.classList.contains('written')) el.classList.add('written'); if (!drop) { el.style.webkitMaskPosition = ''; el.style.maskPosition = ''; } el.style.opacity = ''; started = true; }
      else if (t >= st) { var p = (t - st) / Math.max(en - st, 0.001); if (p < 0) p = 0; if (p > 1) p = 1; el.classList.remove('written'); if (drop) { el.style.opacity = p; } else { var pos = (100 - p * 100) + '% 0'; el.style.webkitMaskPosition = pos; el.style.maskPosition = pos; } found = el; movePen(el, p); started = true; allDone = false; }
      else { el.classList.remove('written'); if (drop) { el.style.opacity = '0'; } else { el.style.webkitMaskPosition = '100% 0'; el.style.maskPosition = '100% 0'; } allDone = false; }
    }
    setFocus(found); TEXT = allDone ? 'WRITTEN' : (started ? 'WRITING' : 'UNWRITTEN');
    if (penHideT && performance.now() > penHideT) { pen.style.opacity = '0'; penHideT = 0; }
  }
  function driveWritingOn(textEl, idx, t) {
    var spans = textEl.querySelectorAll('.w'); for (var i = 0; i < spans.length; i++) {
      var el = spans[i], st = el.__s, en = el.__e, drop = el.classList.contains('drop');
      if (t >= en) { el.classList.add('written'); if (!drop) { el.style.webkitMaskPosition = ''; el.style.maskPosition = ''; } el.style.opacity = ''; }
      else if (t >= st) { var p = (t - st) / Math.max(en - st, 0.001); if (p < 0) p = 0; if (p > 1) p = 1; if (drop) { el.style.opacity = p; } else { var pos = (100 - p * 100) + '% 0'; el.style.webkitMaskPosition = pos; el.style.maskPosition = pos; } }
      else { if (drop) { el.style.opacity = '0'; } else { el.style.webkitMaskPosition = '100% 0'; el.style.maskPosition = '100% 0'; } }
    }
  }
  function movePen(el, p) { var r = el.getBoundingClientRect(), fr = leaf.getBoundingClientRect(); if (!r.width) return; pen.style.left = (r.left - fr.left + r.width * p) + 'px'; pen.style.top = (r.top - fr.top + r.height * 0.16) + 'px'; pen.style.opacity = '.5'; penHideT = performance.now() + 260; }

  /* ---------------- master clock = narration audio (advances only in READING/TURNING) ---------------- */
  function writingAllowed() { return STATE === 'READING' || STATE === 'TURNING'; }
  function turnAllowed() { return STATE === 'READING'; }
  function narrationSpeaking(t) { if (!TIMINGS) return false; for (var i = 0; i < TIMINGS.length; i++) { if (t >= TIMINGS[i].start - 0.03 && t <= TIMINGS[i].end + 0.14) return true; if (TIMINGS[i].start > t + 0.5) break; } return false; }
  // The reading loop is driven by BOTH rAF (smooth while visible) and a setInterval
  // co-driver (keeps writing/turns advancing if the tab is backgrounded — rAF pauses
  // when hidden, audio does not). tick() is idempotent (it derives everything from
  // audio.currentTime), so double-driving is harmless.
  var iv = null;
  function tick() {
    var t = audio ? (audio.currentTime || 0) : 0;
    if (writingAllowed()) driveWriting(t);
    if (destLive) driveWritingOn(destText, destIdx, t);
    if (turnAllowed() && TURN === 'SETTLED' && current < PAGES.length - 1) {
      var cur = PAGES[current], nxt = PAGES[current + 1];
      var startAt = Math.max(cur.lastEnd, (nxt.firstStart || cur.lastEnd) - TURN_LEAD);
      if (t >= startAt) turnForward();
    }
    if (STATE === 'READING' && current === PAGES.length - 1) { var lw = PAGES[current].words, le2 = lw.length ? lw[lw.length - 1].end : 0; if ((audio && audio.ended) || (le2 > 0 && t >= le2 + 1.4)) endReading(); }
    if (scapeCtl && (STATE === 'READING' || STATE === 'TURNING')) scapeCtl.frame(t, DUR, narrationSpeaking(t));
    dbgUpd();
  }
  function loop() { tick(); raf = requestAnimationFrame(loop); }
  function startFrame() { if (!raf) raf = requestAnimationFrame(loop); if (!iv) iv = setInterval(tick, 33); }

  /* ---------------- singleton page turn (corrected: fixed-slot leaf + dest handoff) ---------------- */
  function turnForward() {
    if (STATE !== 'READING' || TURN !== 'SETTLED' || current >= PAGES.length - 1) return;
    STATE = 'TURNING'; TURN = 'TURNING'; scene.classList.add('turning'); var np = current + 1, t = audio.currentTime || 0, D = Math.round(TURN_DUR * 1000);
    bindWords(destText, destFoot, np); destIdx = np; destLive = true; driveWritingOn(destText, np, t);
    dest.querySelector('.pool').style.opacity = '.62'; dest.style.visibility = 'visible'; void dest.offsetHeight; dbgUpd();
    var a = A(leaf, [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(-5deg)', offset: .13 }, { transform: 'rotateY(-38deg)', offset: .33 }, { transform: 'rotateY(-96deg)', offset: .56 }, { transform: 'rotateY(-151deg)', offset: .81 }, { transform: 'rotateY(-180deg)' }], D, { easing: 'cubic-bezier(.5,.02,.2,1)' });
    A(edgelight, [{ opacity: 0, offset: 0 }, { opacity: 0, offset: .12 }, { opacity: .92, offset: .36 }, { opacity: .5, offset: .56 }, { opacity: 0, offset: .72 }], D, { easing: 'ease-in-out' });
    A(bend, [{ opacity: 0, offset: 0 }, { opacity: .85, offset: .34 }, { opacity: .9, offset: .56 }, { opacity: 0, offset: .82 }], D, { easing: 'ease-in-out' });
    A(turnshadow, [{ opacity: 0, offset: 0 }, { opacity: .9, offset: .5 }, { opacity: 0, offset: .9 }], D, { easing: 'ease-in-out' });
    var finished = false, done = function () {
      if (finished) return; finished = true; destLive = false;
      WORDS = bindWords(leafText, leafFoot, np); driveWriting(audio.currentTime || 0); leafPool.style.opacity = '.62';
      try { a && a.cancel(); } catch (e) {} leaf.style.transform = 'rotateY(0deg)'; edgelight.style.opacity = '0'; bend.style.opacity = '0'; turnshadow.style.opacity = '0';
      void leaf.offsetHeight; clearSurface(destText, destFoot); dest.style.visibility = 'hidden';
      current = np; TURN = 'SETTLED'; STATE = 'READING'; scene.classList.remove('turning'); dbgUpd();
    };
    if (a) { a.onfinish = done; } else done();
    setTimeout(done, D + 70);
  }

  /* ---------------- MASTER STATE MACHINE ----------------
     IDLE → ENTERING → CLOSED_BOOK → OPENING → OPEN_SETTLE → READING → (TURNING → READING)* → ENDING → EXIT */
  function step(tok, ms, fn) { setTimeout(function () { if (tok === seqToken && open) fn(); }, ms); }
  function setClosed() { scene.classList.remove('opened'); cover.style.transform = 'rotateY(0deg)'; leafPool.style.opacity = '0'; cover.querySelector('.inner .lt').style.opacity = '0'; cover.querySelector('.foreedge').style.opacity = '1'; }
  function beginSequence() {
    var tok = ++seqToken; cancelAll();
    buildPages();
    current = 0; TURN = 'SETTLED'; leaf.style.transform = 'rotateY(0deg)'; book.style.opacity = ''; book.style.filter = '';
    clearSurface(destText, destFoot); dest.style.visibility = 'hidden'; prepareLeaf(0); setClosed();     // page 1 typeset + UNWRITTEN under the closed cover
    STATE = 'ENTERING'; scene.classList.add('arriving'); startFrame(); dbgUpd();
    var RM = reduceMotion;
    A(book, [{ opacity: 0, transform: 'translateY(16px) scale(.965)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }], RM ? 300 : 700, { delay: RM ? 120 : 500, easing: 'cubic-bezier(.16,.82,.28,1)' });
    step(tok, RM ? 500 : 1200, function () { STATE = 'CLOSED_BOOK'; dbgUpd(); });               // closed cover established (visible)
    step(tok, RM ? 800 : 1600, function () { openCover(tok); });                                 // intentional hold, then open
  }
  function openCover(tok) {
    STATE = 'OPENING'; scene.classList.remove('arriving'); dbgUpd();
    var RM = reduceMotion, OPEN = RM ? 800 : 1800;
    A(cover, [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(1.8deg)', offset: .05 }, { transform: 'rotateY(-3deg)', offset: .12 }, { transform: 'rotateY(-26deg)', offset: .32 }, { transform: 'rotateY(-80deg)', offset: .55 }, { transform: 'rotateY(-128deg)', offset: .77 }, { transform: 'rotateY(-156deg)', offset: .92 }, { transform: 'rotateY(-162deg)' }], OPEN, { easing: 'cubic-bezier(.36,.02,.16,1)' });
    var fe = cover.querySelector('.foreedge'); if (fe) A(fe, [{ opacity: 1 }, { opacity: 0, offset: .28 }, { opacity: 0 }], OPEN);
    A(cover.querySelector('.inner .lt'), [{ opacity: 0 }, { opacity: 0, offset: .5 }, { opacity: .55, offset: .88 }, { opacity: .42 }], OPEN, { easing: 'ease' });
    A(leafPool, [{ opacity: 0 }, { opacity: 0, offset: .5 }, { opacity: .62, offset: .9 }], OPEN, { easing: 'ease' });
    A(book, [{ transform: 'scale(1.028)' }, { transform: 'scale(1.028)', offset: .28 }, { transform: 'scale(1)' }], OPEN, { easing: 'cubic-bezier(.4,.02,.2,1)' });
    step(tok, OPEN, function () {
      STATE = 'OPEN_SETTLE'; scene.classList.add('opened'); leafPool.style.opacity = '.62'; dbgUpd();     // page revealed; still no narration/writing
      step(tok, RM ? 160 : 320, function () { enterReading(tok); });
    });
  }
  function enterReading(tok) {
    STATE = 'READING'; scene.classList.add('reading'); startFloat();
    try { audio.currentTime = 0; } catch (e) {} var p = audio.play(); if (p && p.catch) p.catch(function () {}); setPlayIcon(true);
    if (scapeCtl) scapeCtl.resume();
    dbgUpd();     // ← the ONLY place narration/writing/focus/soundscape can start
  }
  function endReading() {
    if (STATE !== 'READING') return; var tok = ++seqToken; STATE = 'ENDING'; scene.classList.add('ended'); if (scapeCtl) scapeCtl.silence(); dbgUpd();
    A(book, [{ opacity: 1 }, { opacity: .42 }], reduceMotion ? 700 : 2200, { easing: 'ease' });
    var wp = root.querySelector('.atmos .warmpool'); if (wp) { wp.style.transition = 'opacity 2.2s ease'; wp.style.opacity = '.16'; }
    step(tok, reduceMotion ? 900 : 2300, function () { STATE = 'EXIT'; closeOverlay(); });
  }
  function startFloat() { if (bookFloat) { try { bookFloat.cancel(); } catch (e) {} } bookFloat = A(book, [{ transform: 'translate3d(0,0,0) scale(1)' }, { transform: 'translate3d(0,-.5%,0) scale(1.006)', offset: .5 }, { transform: 'translate3d(0,0,0) scale(1)' }], 26000, { easing: 'ease-in-out', iterations: Infinity }); }

  /* ---------------- controls / teardown ---------------- */
  function setPlayIcon(playing) { if (!playBtn) return; playBtn.setAttribute("aria-label", playing ? "Pause narration" : "Play narration"); playBtn.innerHTML = playing ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor"/><rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" fill="currentColor"/></svg>'; }
  function playPause() {
    if (STATE !== 'READING' && STATE !== 'TURNING') return;
    if (audio.paused) { var p = audio.play(); if (p && p.catch) p.catch(function () {}); if (scapeCtl) scapeCtl.resume(); setPlayIcon(true); }
    else { audio.pause(); if (scapeCtl) scapeCtl.silence(); setPlayIcon(false); }
  }
  function onKey(e) {
    if (!open) return; var tag = (e.target && e.target.tagName || "").toLowerCase(); if (tag === "input" || tag === "textarea") return;
    if (e.key === "Escape") { e.preventDefault(); closeOverlay(); }
    else if (e.code === "Space" || (e.key || "").toLowerCase() === "k") { e.preventDefault(); playPause(); }
  }
  var scrollY = 0;
  function closeOverlay() {
    if (!open) return;
    launchTok++; seqToken++; cancelAll(); if (bookFloat) { try { bookFloat.cancel(); } catch (e) {} }
    try { if (audio) audio.pause(); } catch (e) {}
    if (scapeCtl) { try { scapeCtl.silence(); } catch (e) {} }
    document.removeEventListener("keydown", onKey);
    if (host) host.classList.remove("lc-visible");
    var fade = reduceMotion ? 160 : 500;
    setTimeout(function () {
      if (scapeCtl) { try { scapeCtl.teardown(); } catch (e) {} scapeCtl = null; }
      if (host && host.parentNode) host.parentNode.removeChild(host);
      host = root = scene = audio = null; if (raf) { cancelAnimationFrame(raf); raf = null; } if (iv) { clearInterval(iv); iv = null; }
      PAGES = []; WORDS = []; current = 0; STATE = 'IDLE'; TURN = 'SETTLED'; destLive = false;
      document.documentElement.classList.remove("hl-noscroll"); window.scrollTo(0, scrollY);
      cta.setAttribute("aria-expanded", "false"); cta.classList.remove("is-busy"); open = false;
    }, fade + 40);
  }

  /* ---------------- helpers ---------------- */
  function A(el, kf, dur, o) { o = o || {}; if (!el || !el.animate) return null; try { var a = el.animate(kf, { duration: dur, easing: o.easing || 'ease', fill: o.fill || 'forwards', delay: o.delay || 0, iterations: o.iterations || 1 }); anims.push(a); return a; } catch (e) { return null; } }
  function cancelAll() { anims.forEach(function (a) { try { a.cancel(); } catch (e) {} }); anims = []; }
  function fmt(s) { s = Math.round(s || 0); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function ensureFonts() { if (document.getElementById("lc-fonts")) return; var l = document.createElement("link"); l.id = "lc-fonts"; l.rel = "stylesheet"; l.href = "https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Cormorant+Garamond:ital,wght@0,500;0,600;1,400&family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600&display=swap"; document.head.appendChild(l); }
  function dbgUpd() {
    if (!DEBUG || !dbg) return; var t = audio ? (audio.currentTime || 0) : 0;
    var pre = (STATE === 'IDLE' || STATE === 'ENTERING' || STATE === 'CLOSED_BOOK' || STATE === 'OPENING' || STATE === 'OPEN_SETTLE');
    var written = root ? root.querySelectorAll('.w.written').length : 0, hl = root ? root.querySelectorAll('.w.cur').length : 0;
    var clean = !pre || (written === 0 && hl === 0 && (!audio || audio.paused || audio.currentTime === 0));
    dbg.innerHTML = 'LISTEN_CINEMATIC (' + ENGINE_ID + ')\nSTATE           <b>' + STATE + '</b>\nTURN_STATE      <b>' + TURN + '</b>\nPAGE            <b>' + (current + 1) + ' / ' + PAGES.length + '</b>\nAUDIO_TIME      <b>' + t.toFixed(2) + '</b>\nACTIVE_LEAVES   <b class="' + ((root ? root.querySelectorAll('#leaf').length : 0) <= 1 ? 'ok' : 'warn') + '">' + (root ? root.querySelectorAll('#leaf').length : 0) + '</b>\nHIGHLIGHTS      <b class="' + (hl <= 1 ? 'ok' : 'warn') + '">' + hl + '</b>\nWRITING_ALLOWED <b>' + (writingAllowed() ? 'yes' : 'no') + '</b>\nOPENING_CLEAN   <b class="' + (clean ? 'ok' : 'warn') + '">' + (clean ? 'ok' : 'VIOLATION') + '</b>';
  }
})();
