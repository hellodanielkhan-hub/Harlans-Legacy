/* =========================================================================
   Harlan's Legacy — Living Archive (Phase 8)

   A small, self-contained reading-memory layer. No backend, no accounts:
   everything lives in localStorage and survives refresh. It powers, on the
   story pages: recording a view, marking a memory "read" once you reach the
   end, saving favourites, and an intelligent "Read next" (straight from the
   knowledge graph — never random). On the homepage: reading progress
   ("You've explored X of Y memories."), a Continue Reading card, Recently
   Viewed, Saved Memories, quiet reading statistics, an "I'm feeling
   nostalgic" random memory, and a tasteful completion message once every
   memory has been read.

   Progressive enhancement only: with JS off, or on a first-ever visit, the
   site is exactly as it was. Nothing here changes the architecture, the data
   model or any existing feature — it only reads window.HL_ARCHIVE (emitted by
   build.js from data/stories.json + the knowledge graph) and remembers where
   a reader has been.
   ========================================================================= */
(function () {
  "use strict";

  var ARCH = window.HL_ARCHIVE;
  if (!ARCH || !Array.isArray(ARCH.stories)) return; // nothing readable yet

  var KEY = "hl-archive";
  var SCHEMA = 1;
  var VIEW_CAP = 8;
  var DONE = 0.9; // fraction of a story read before it counts as "read"
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- metadata index ---------------------------------------------------- */
  var BY_ID = {};
  ARCH.stories.forEach(function (s) { BY_ID[s.id] = s; });
  var TOTAL = ARCH.total || ARCH.stories.length;
  function meta(id) { return BY_ID[id] || null; }

  /* ---- path helper (story pages live one level down in /story) ----------- */
  var PREFIX = /\/story\//.test(location.pathname) ? "../" : "";
  function href(url) { return url ? PREFIX + url : "#"; }

  /* ---- persistence ------------------------------------------------------- */
  function fresh() {
    return { v: SCHEMA, read: {}, viewed: [], saved: [], progress: {}, lastVisit: 0, prevVisit: 0 };
  }
  function load() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY));
      if (o && o.v === SCHEMA) {
        o.read = o.read || {}; o.viewed = o.viewed || []; o.saved = o.saved || [];
        o.progress = o.progress || {};
        return o;
      }
    } catch (e) {}
    return fresh();
  }
  var state = load();
  var saveTimer = null;
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }
  function persistSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () { saveTimer = null; persist(); }, 400);
  }

  /* ---- visit bookkeeping (snapshot the previous visit for display) ------- */
  (function trackVisit() {
    var now = Date.now();
    if (state.lastVisit) state.prevVisit = state.lastVisit;
    state.lastVisit = now;
    persist();
  })();

  /* ---- derived views ----------------------------------------------------- */
  function readIds() { return Object.keys(state.read).map(Number).filter(function (id) { return meta(id); }); }
  function readCount() { return readIds().length; }
  function minutesRead() {
    return readIds().reduce(function (n, id) { var m = meta(id); return n + (m ? (m.readingTime || 0) : 0); }, 0);
  }
  function favouriteCategory() {
    var counts = {};
    readIds().forEach(function (id) { var m = meta(id); if (m) counts[m.theme] = (counts[m.theme] || 0) + 1; });
    var best = null, bn = 0;
    Object.keys(counts).forEach(function (t) { if (counts[t] > bn) { bn = counts[t]; best = t; } });
    if (!best) return null;
    return ARCH.themes[best] || (meta(readIds()[0]) && best) || best;
  }
  function isSaved(id) { return state.saved.indexOf(id) !== -1; }

  /* Recommendations — always from the knowledge graph, never random.
     Prefer stories related to `fromId`; then related to what's been read;
     then any remaining unread memory. Read memories are skipped so "next"
     always moves you forward. */
  function recommend(fromId) {
    var out = [], seen = {};
    function consider(id) {
      id = Number(id);
      if (seen[id]) return;
      if (!meta(id)) return;
      if (id === fromId) return;
      if (state.read[id]) return;
      seen[id] = 1; out.push(id);
    }
    if (fromId && meta(fromId)) (meta(fromId).rec || []).forEach(consider);
    readIds().sort(function (a, b) { return (state.read[b] || 0) - (state.read[a] || 0); })
      .forEach(function (id) { (meta(id).rec || []).forEach(consider); });
    ARCH.stories.forEach(function (s) { consider(s.id); });
    return out;
  }

  /* Why a recommendation was made — shared graph entities, for a human line. */
  function sharedWith(aId, bId) {
    var a = meta(aId), b = meta(bId);
    if (!a || !b) return "";
    // We don't ship full entity lists to the client; lean on shared theme +
    // the fact the graph already ranked them as related.
    if (a.theme === b.theme) return "Continues " + (a.themeLabel || "the same thread").toLowerCase();
    return "A thread runs between them";
  }

  /* ---- tiny DOM helpers -------------------------------------------------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function relativeTime(ts) {
    if (!ts) return "";
    var d = Math.max(0, Date.now() - ts), min = 60000, hr = 3600000, day = 86400000;
    if (d < min) return "just now";
    if (d < hr) { var m = Math.round(d / min); return m + " minute" + (m === 1 ? "" : "s") + " ago"; }
    if (d < day) { var h = Math.round(d / hr); return h + " hour" + (h === 1 ? "" : "s") + " ago"; }
    var days = Math.round(d / day);
    if (days === 1) return "yesterday";
    if (days < 30) return days + " days ago";
    var mo = Math.round(days / 30);
    if (mo < 12) return mo + " month" + (mo === 1 ? "" : "s") + " ago";
    var y = Math.round(days / 365);
    return y + " year" + (y === 1 ? "" : "s") + " ago";
  }

  /* ---- announcements (screen-reader friendly, unobtrusive) --------------- */
  var announcer = null;
  function announce(msg) {
    if (!announcer) {
      announcer = el("div", "hl-toast");
      announcer.setAttribute("role", "status");
      announcer.setAttribute("aria-live", "polite");
      document.body.appendChild(announcer);
    }
    announcer.textContent = "";
    // defer so identical repeat messages are still announced by screen readers
    setTimeout(function () {
      announcer.textContent = msg;
      announcer.classList.add("is-shown");
      clearTimeout(announcer._t);
      announcer._t = setTimeout(function () { announcer.classList.remove("is-shown"); }, 2600);
    }, 30);
  }

  /* ---- mutations --------------------------------------------------------- */
  function recordView(id) {
    id = Number(id);
    if (!meta(id)) return;
    var i = state.viewed.indexOf(id);
    if (i !== -1) state.viewed.splice(i, 1);
    state.viewed.unshift(id);
    if (state.viewed.length > VIEW_CAP) state.viewed.length = VIEW_CAP;
    persist();
  }
  function markRead(id) {
    id = Number(id);
    if (!meta(id) || state.read[id]) return false;
    state.read[id] = Date.now();
    delete state.progress[id];
    persist();
    return true;
  }
  function setProgress(id, pct) {
    id = Number(id);
    if (!meta(id) || state.read[id]) return;
    if (pct >= DONE) { markRead(id); return; }
    state.progress[id] = Math.max(state.progress[id] || 0, pct);
    persistSoon();
  }
  function toggleSaved(id) {
    id = Number(id);
    var i = state.saved.indexOf(id);
    if (i === -1) { state.saved.unshift(id); persist(); return true; }
    state.saved.splice(i, 1); persist(); return false;
  }

  /* ---- a reusable memory card ------------------------------------------- */
  function memoryCard(id, opts) {
    opts = opts || {};
    var m = meta(id);
    var a = el("a", "hl-mem-card");
    a.href = href(m.url);
    a.setAttribute("data-theme", m.theme);
    a.style.setProperty("--tab-color", "var(--thread-" + m.theme + ", var(--thread))");
    if (opts.kicker) a.appendChild(el("span", "hl-mc-kicker", opts.kicker));
    a.appendChild(el("span", "hl-mc-title", m.title));
    if (opts.line) a.appendChild(el("span", "hl-mc-line", opts.line));
    else if (m.summary) a.appendChild(el("span", "hl-mc-line", m.summary));
    var foot = el("span", "hl-mc-foot");
    foot.appendChild(el("span", "hl-mc-theme", m.themeLabel));
    if (m.readingTime) foot.appendChild(el("span", "hl-mc-time", m.readingTime + " min read"));
    a.appendChild(foot);
    return a;
  }

  /* =======================================================================
     STORY PAGE
     ======================================================================= */
  function initStoryPage() {
    var card = document.getElementById("hl-story");
    if (!card) return false;
    var id = Number(card.getAttribute("data-story-id"));
    if (!meta(id) && !ARCH.stories.length) return true;

    recordView(id);

    /* -- Save / bookmark -- */
    var saveBtn = card.querySelector("[data-hl-save]");
    if (saveBtn) {
      saveBtn.hidden = false;
      var reflect = function () {
        var on = isSaved(id);
        saveBtn.setAttribute("aria-pressed", on ? "true" : "false");
        saveBtn.classList.toggle("is-saved", on);
        saveBtn.setAttribute("aria-label", on ? "Remove this memory from your saved memories" : "Save this memory");
        saveBtn.title = on ? "Saved — click to remove" : "Save this memory";
        var lbl = saveBtn.querySelector(".hl-bm-label");
        if (lbl) lbl.textContent = on ? "Saved" : "Save";
      };
      reflect();
      saveBtn.addEventListener("click", function () {
        var on = toggleSaved(id);
        reflect();
        announce(on ? "Saved to your memories" : "Removed from your memories");
      });
    }

    /* -- Reading progress + completion. Completion = the end of the memory has
          reached the viewport (its bottom scrolled into view). This works for
          any length and relies on scroll/resize events, so it is reliable
          everywhere. A short memory that already fits on screen counts as read
          once seen. An IntersectionObserver on the ending mark is layered on as
          an enhancement. -- */
    var body = document.querySelector(".story-body");
    if (body) {
      var complete = function () {
        if (markRead(id)) announce("You've finished this memory");
      };
      var tick = function () {
        if (state.read[id]) return;
        var rect = body.getBoundingClientRect();
        var vh = window.innerHeight || document.documentElement.clientHeight;
        var passed = vh - rect.top;
        setProgress(id, Math.max(0, Math.min(0.89, passed / (rect.height + vh))));
        if (rect.bottom <= vh + 4) complete();
      };
      var pending = false;
      var onScroll = function () {
        if (pending) return; pending = true;
        setTimeout(function () { pending = false; tick(); }, 150);
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll);
      setTimeout(tick, 500);

      var endMark = body.querySelector(".ending-mark");
      if (endMark && "IntersectionObserver" in window) {
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) { if (e.isIntersecting) complete(); });
        }, { threshold: 0 });
        io.observe(endMark);
      }
    }

    /* -- Read next (from the knowledge graph) -- */
    var rn = document.getElementById("hl-read-next");
    var slot = document.getElementById("hl-rn-slot");
    if (rn && slot) {
      var recs = recommend(id);
      if (recs.length) {
        var nid = recs[0];
        clear(slot);
        slot.appendChild(memoryCard(nid, { kicker: "Because you're reading this", line: sharedWith(id, nid) }));
        rn.hidden = false;
      }
    }
    return true;
  }

  /* =======================================================================
     HOMEPAGE
     ======================================================================= */
  var homeWired = false;
  function initHome() {
    var panel = document.getElementById("your-archive");
    var featuredCard = document.getElementById("this-week-card");
    if (!panel && !featuredCard) return false;
    wireFeatured(renderHome);
    renderHome();
    return true;
  }

  /* The homepage's "This Week" story is read inline. Treat opening it as a
     view, reaching its end as reading it, and offer the same Save control —
     so a reader who never leaves the homepage still builds a living archive. */
  function wireFeatured(onChange) {
    var fid = ARCH.featured;
    var card = document.getElementById("this-week-card");
    if (!fid || !meta(fid) || !card) return;

    var saveBtn = card.querySelector("[data-hl-save]");
    if (saveBtn) {
      saveBtn.hidden = false;
      var reflect = function () {
        var on = isSaved(fid);
        saveBtn.setAttribute("aria-pressed", on ? "true" : "false");
        saveBtn.classList.toggle("is-saved", on);
        saveBtn.setAttribute("aria-label", on ? "Remove this memory from your saved memories" : "Save this memory");
        saveBtn.title = on ? "Saved — click to remove" : "Save this memory";
        var lbl = saveBtn.querySelector(".hl-bm-label");
        if (lbl) lbl.textContent = on ? "Saved" : "Save";
      };
      reflect();
      saveBtn.addEventListener("click", function () {
        var on = toggleSaved(fid); reflect();
        announce(on ? "Saved to your memories" : "Removed from your memories");
        onChange();
      });
    }

    var details = card.querySelector("details.story-details");
    if (details) details.addEventListener("toggle", function () {
      if (details.open) { recordView(fid); onChange(); }
    });

    var endMark = card.querySelector(".ending-mark");
    if (endMark && "IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting && markRead(fid)) { announce("You've finished this memory"); onChange(); }
        });
      }, { threshold: 0.4 });
      io.observe(endMark);
    }
  }

  function renderHome() {
    var panel = document.getElementById("your-archive");
    if (!panel) return;

    var rc = readCount();
    var hasHistory = rc > 0 || state.viewed.length > 0 || state.saved.length > 0;
    if (!hasHistory) { panel.hidden = true; return; } // pristine first visit — untouched

    panel.hidden = false;

    /* -- Progress line + bar -- */
    var count = document.getElementById("hl-progress-count");
    var bar = document.getElementById("hl-progress-fill");
    var line = document.getElementById("hl-progress-line");
    var complete = rc >= TOTAL && TOTAL > 0;
    if (line) {
      if (complete) {
        line.textContent = "You've read every memory kept here so far.";
      } else {
        line.textContent = "You've explored " + rc + " of " + TOTAL + " " + (TOTAL === 1 ? "memory" : "memories") + ".";
      }
    }
    if (count) count.textContent = rc + " / " + TOTAL;
    if (bar) bar.style.width = (TOTAL ? Math.round((rc / TOTAL) * 100) : 0) + "%";
    var barTrack = document.getElementById("hl-progress-bar");
    if (barTrack) {
      barTrack.setAttribute("aria-valuenow", String(rc));
      barTrack.setAttribute("aria-valuemax", String(TOTAL));
      barTrack.setAttribute("aria-valuetext", rc + " of " + TOTAL + " memories read");
    }

    /* -- Completion message -- */
    var done = document.getElementById("hl-complete");
    if (done) done.hidden = !complete;

    /* -- Continue reading -- */
    var contWrap = document.getElementById("hl-continue");
    var contSlot = document.getElementById("hl-continue-slot");
    if (contWrap && contSlot) {
      // an in-progress memory, else the next recommended unread one
      var inProgress = Object.keys(state.progress).map(Number)
        .filter(function (pid) { return meta(pid) && !state.read[pid]; })
        .sort(function (a, b) { return state.viewed.indexOf(a) - state.viewed.indexOf(b); });
      clear(contSlot);
      if (inProgress.length) {
        contSlot.appendChild(memoryCard(inProgress[0], { kicker: "Pick up where you left off" }));
        contWrap.hidden = false;
      } else if (!complete) {
        var next = recommend(null);
        if (next.length) {
          contSlot.appendChild(memoryCard(next[0], { kicker: "Continue your visit" }));
          contWrap.hidden = false;
        } else { contWrap.hidden = true; }
      } else { contWrap.hidden = true; }
    }

    /* -- Recently viewed -- */
    fillRow("hl-recent", "hl-recent-row", state.viewed, null);

    /* -- Saved memories -- */
    fillSaved();

    /* -- Statistics -- */
    setText("hl-stat-read", String(rc));
    var mins = minutesRead();
    setText("hl-stat-minutes", mins ? String(mins) : "0");
    var fav = favouriteCategory();
    setText("hl-stat-fav", fav || "—");
    var lastVisit = state.prevVisit ? relativeTime(state.prevVisit) : "Welcome";
    setText("hl-stat-visit", lastVisit);

    /* -- Random memory: "I'm feeling nostalgic" (bind once) -- */
    var rand = document.getElementById("hl-random");
    if (rand) {
      rand.hidden = false;
      if (!homeWired) {
        rand.addEventListener("click", function () {
          var pool = ARCH.stories;
          if (!pool.length) return;
          var pick = pool[Math.floor(Math.random() * pool.length)];
          if (pick && pick.url) location.href = href(pick.url);
        });
      }
    }
    homeWired = true;
  }

  function setText(id, val) { var n = document.getElementById(id); if (n) n.textContent = val; }

  function fillRow(wrapId, rowId, ids, decorate) {
    var wrap = document.getElementById(wrapId);
    var row = document.getElementById(rowId);
    if (!wrap || !row) return;
    var list = ids.filter(function (id) { return meta(id); });
    if (!list.length) { wrap.hidden = true; return; }
    clear(row);
    list.forEach(function (id) {
      var c = memoryCard(id);
      if (decorate) decorate(c, id);
      row.appendChild(c);
    });
    wrap.hidden = false;
  }

  function fillSaved() {
    var wrap = document.getElementById("hl-saved");
    var row = document.getElementById("hl-saved-row");
    if (!wrap || !row) return;
    var list = state.saved.filter(function (id) { return meta(id); });
    if (!list.length) { wrap.hidden = true; return; }
    clear(row);
    list.forEach(function (id) {
      var item = el("div", "hl-saved-item");
      item.appendChild(memoryCard(id, { kicker: "Saved" }));
      var rm = el("button", "hl-unsave");
      rm.type = "button";
      rm.setAttribute("aria-label", "Remove " + meta(id).title + " from saved memories");
      rm.title = "Remove from saved";
      rm.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
      rm.addEventListener("click", function () {
        toggleSaved(id);
        announce("Removed from your memories");
        fillSaved();
      });
      item.appendChild(rm);
      row.appendChild(item);
    });
    wrap.hidden = false;
  }

  /* ---- boot -------------------------------------------------------------- */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else { boot(); }
  function boot() {
    try { initStoryPage() || initHome(); } catch (e) { /* never break the page */ }
  }
})();
