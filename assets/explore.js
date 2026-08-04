/* =========================================================================
   Harlan's Legacy — Universal Explore (Phase 9, client)

   Two quiet enhancements, both driven entirely by window.HL_GRAPH (emitted from
   the knowledge graph by build.js). No libraries, no network, no popups:

     1. Relationship preview — hovering OR keyboard-focusing any linked
        person / place / object / event (anything with [data-entity-id]) reveals
        a small archival preview card: portrait or monogram, a type badge, a
        short description, and how many memories it appears in.

     2. Inline entity preview — inside a story's prose, the first mention of each
        person / place / object / event this memory is connected to becomes a
        subtle link, so the same preview appears without ever leaving the page.

   Progressive enhancement: with JS off, or if the graph is missing, nothing
   changes. Fully keyboard accessible and reduced-motion aware.
   ========================================================================= */
(function () {
  "use strict";

  var GRAPH = window.HL_GRAPH;
  if (!GRAPH || !GRAPH.entities) return;
  var ENT = GRAPH.entities;

  // Story pages live in /story, profiles in /family, entities in /place|object|event,
  // journeys in /journey — all one level down. The homepage is at the root.
  var dir = location.pathname.replace(/\/[^\/]*$/, "");
  var PREFIX = (dir && dir !== "/" && dir !== "") ? "../" : "";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ---------------------------------------------------------------------
     1) The preview card — one reusable element, shown on hover / focus.
     --------------------------------------------------------------------- */
  var card = null, hideTimer = null, current = null;

  function ensureCard() {
    if (card) return card;
    card = document.createElement("div");
    card.className = "entity-hovercard";
    card.setAttribute("role", "tooltip");
    card.hidden = true;
    document.body.appendChild(card);
    // keep it open while the pointer is over the card itself
    card.addEventListener("mouseenter", function () { clearTimeout(hideTimer); });
    card.addEventListener("mouseleave", scheduleHide);
    return card;
  }

  function fill(p) {
    var media = p.portrait
      ? '<span class="hc-media"><img src="' + esc(PREFIX + p.portrait.jpg) + '" width="' + p.portrait.w +
        '" height="' + p.portrait.w + '" style="object-position:' + p.portrait.focus.x + '% ' + p.portrait.focus.y +
        '%" alt="" decoding="async"></span>'
      : '<span class="hc-media hc-mono" style="--tab-color:' + esc(p.color) + '" aria-hidden="true">' + esc(p.monogram) + '</span>';
    var bits = '<span class="hc-badge" style="--tab-color:' + esc(p.color) + '">' + esc(p.badge) + '</span>' +
      '<span class="hc-name">' + esc(p.name) + '</span>' +
      (p.desc ? '<span class="hc-desc">' + esc(p.desc) + '</span>' : '') +
      '<span class="hc-meta">' + p.memories + ' ' + (p.memories === 1 ? "memory" : "memories") +
      (p.related ? ' · ' + p.related + ' connected' : '') + '</span>';
    card.innerHTML = media + '<span class="hc-body">' + bits + '</span>';
  }

  function position(target) {
    var r = target.getBoundingClientRect();
    // measure off-screen first
    card.style.left = "-9999px"; card.style.top = "0px";
    card.hidden = false;
    var cw = card.offsetWidth, ch = card.offsetHeight;
    var vw = document.documentElement.clientWidth, gap = 10;
    var left = r.left + r.width / 2 - cw / 2;
    left = Math.max(8, Math.min(left, vw - cw - 8));
    var top = r.top - ch - gap;
    card.classList.remove("is-below");
    if (top < 8) { top = r.bottom + gap; card.classList.add("is-below"); }
    card.style.left = Math.round(left) + "px";
    card.style.top = Math.round(top) + "px";
  }

  function show(target) {
    var id = target.getAttribute("data-entity-id");
    var p = ENT[id];
    if (!p) return;
    clearTimeout(hideTimer);
    current = target;
    ensureCard();
    fill(p);
    position(target);
    // defer one tick so the fade-in transition runs (setTimeout, not rAF, so it
    // still fires if the tab is backgrounded)
    setTimeout(function () { if (current === target) card.classList.add("is-shown"); }, 16);
  }

  function hide() {
    current = null;
    if (!card) return;
    card.classList.remove("is-shown");
    hideTimer = setTimeout(function () { if (!current) card.hidden = true; }, 180);
  }
  function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 120); }

  // Delegated events so inline links created later are covered too.
  document.addEventListener("mouseover", function (e) {
    var t = e.target.closest && e.target.closest("[data-entity-id]");
    if (t) show(t);
  });
  document.addEventListener("mouseout", function (e) {
    var t = e.target.closest && e.target.closest("[data-entity-id]");
    if (t && !(e.relatedTarget && (t.contains(e.relatedTarget) || (card && card.contains(e.relatedTarget))))) scheduleHide();
  });
  document.addEventListener("focusin", function (e) {
    var t = e.target.closest && e.target.closest("[data-entity-id]");
    if (t) show(t); else if (card && !card.contains(e.target)) hide();
  });
  document.addEventListener("focusout", function (e) {
    var t = e.target.closest && e.target.closest("[data-entity-id]");
    if (t) scheduleHide();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); });
  window.addEventListener("scroll", function () { if (current) hide(); }, { passive: true });

  /* ---------------------------------------------------------------------
     2) Inline entity previews inside story prose.
     Only the entities THIS memory is connected to (already present on the
     page as chips) are linked, first mention only, capped, safely — we split
     text nodes, never touching existing markup.
     --------------------------------------------------------------------- */
  function linkStoryProse() {
    var body = document.querySelector(".story-body");
    if (!body) return;

    // entities connected to this memory = the chips already on the page
    var ids = [];
    document.querySelectorAll("[data-entity-id]").forEach(function (n) {
      var id = n.getAttribute("data-entity-id");
      if (id && ENT[id] && ids.indexOf(id) === -1) ids.push(id);
    });
    if (!ids.length) return;

    // build match candidates: {id, re} sorted by phrase length (longest first)
    var candidates = [];
    ids.forEach(function (id) {
      var p = ENT[id];
      var phrases = [p.name].concat(p.aliases || []);
      phrases.forEach(function (ph) {
        if (!ph) return;
        ph = String(ph).trim();
        if (ph.length < 3 || ph.indexOf("(") !== -1) return; // skip parenthetical descriptors
        candidates.push({ id: id, kind: p.kind, url: p.url, len: ph.length, phrase: ph });
      });
    });
    candidates.sort(function (a, b) { return b.len - a.len; });

    var usedIds = {}, MAX = 8, linked = 0;

    // Only paragraphs of the prose; skip anything already inside a link.
    var paras = body.querySelectorAll("p");
    for (var pi = 0; pi < paras.length && linked < MAX; pi++) {
      var para = paras[pi];
      for (var ci = 0; ci < candidates.length && linked < MAX; ci++) {
        var c = candidates[ci];
        if (usedIds[c.id]) continue;
        if (tryLinkInElement(para, c)) { usedIds[c.id] = 1; linked++; }
      }
    }
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function tryLinkInElement(root, c) {
    var re = new RegExp("(^|[^\\p{L}\\p{N}])(" + escapeRe(c.phrase) + ")(?![\\p{L}\\p{N}])", "iu");
    // walk text nodes not already inside an anchor
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var pn = node.parentNode;
        while (pn && pn !== root) {
          if (pn.nodeName === "A") return NodeFilter.FILTER_REJECT;
          pn = pn.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      var m = re.exec(node.nodeValue);
      if (!m) continue;
      var start = m.index + m[1].length;
      var end = start + m[2].length;
      var before = node.nodeValue.slice(0, start);
      var matchText = node.nodeValue.slice(start, end);
      var after = node.nodeValue.slice(end);

      var a = document.createElement("a");
      a.className = "entity-inline";
      a.setAttribute("data-entity-id", c.id);
      a.setAttribute("data-kind", c.kind);
      a.href = PREFIX + c.url;
      a.textContent = matchText;

      var frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(a);
      if (after) frag.appendChild(document.createTextNode(after));
      node.parentNode.replaceChild(frag, node);
      return true;
    }
    return false;
  }

  /* ---- boot ---- */
  function boot() {
    try { linkStoryProse(); } catch (e) { /* never break the page */ }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
