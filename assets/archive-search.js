/* =========================================================================
   Harlan's Legacy — archive search (archive.html)
   Moved verbatim from the homepage when search moved to the dedicated Archive
   page. Instant, grouped search over stories + people/places/objects/events;
   the index is the inline <script id="hl-search-index"> JSON written by build.js.
   ========================================================================= */
(function () {
  "use strict";
  (function initSearch(){
    var input = document.getElementById("hl-search-input");
    var panel = document.getElementById("search-panel");
    var clearBtn = document.getElementById("search-clear");
    var statusEl = document.getElementById("search-status");
    var field = input && input.closest(".search-field");
    var indexNode = document.getElementById("hl-search-index");
    if (!input || !panel || !indexNode) return;

    var INDEX = [];
    try { INDEX = JSON.parse(indexNode.textContent || "[]"); } catch(e){ INDEX = []; }

    var GROUPS = [
      { type: "journey", label: "Memory journeys", color: "var(--ember-core)" },
      { type: "story",  label: "Stories" },
      { type: "person", label: "People",  color: "var(--thread-momdad)" },
      { type: "place",  label: "Places",  color: "var(--thread-toledo)" },
      { type: "object", label: "Objects", color: "var(--thread-ordinary)" },
      { type: "event",  label: "Events",  color: "var(--thread-grief)" }
    ];
    var PER_GROUP = 6;
    var results = [];   // flat list of {rec} in render order
    var active = -1;

    function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
    function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

    function highlight(title, terms){
      var valid = terms.filter(Boolean).map(escRe);
      var t = title;
      if (valid.length){
        // Wrap matches in sentinels first, escape, then swap sentinels for <mark>,
        // so escaping can never break the inserted tags.
        t = t.replace(new RegExp("(" + valid.join("|") + ")", "ig"), "$1");
      }
      return esc(t).replace(//g, "<mark>").replace(//g, "</mark>");
    }

    function score(rec, q, terms){
      var title = rec.title.toLowerCase();
      if (title === q) return 100;
      if (title.indexOf(q) === 0) return 80;
      if (title.indexOf(q) !== -1) return 60;
      // all terms present in keywords
      var kw = rec.keywords;
      for (var i = 0; i < terms.length; i++){ if (kw.indexOf(terms[i]) === -1) return 0; }
      return 30;
    }

    function search(raw){
      var q = raw.trim().toLowerCase();
      if (!q){ close(); return; }
      var terms = q.split(/\s+/);
      var scored = [];
      INDEX.forEach(function(rec){
        var sc = score(rec, q, terms);
        if (sc > 0) scored.push({ rec: rec, sc: sc });
      });
      scored.sort(function(a,b){ return b.sc - a.sc || a.rec.title.localeCompare(b.rec.title); });
      render(scored, terms, q);
    }

    function render(scored, terms, q){
      results = [];
      var html = "";
      var total = 0;
      GROUPS.forEach(function(g){
        var rows = scored.filter(function(x){ return x.rec.type === g.type; }).slice(0, PER_GROUP);
        if (!rows.length) return;
        total += rows.length;
        var dot = g.color ? '<span class="dot" style="background:' + g.color + '"></span>' : '<span class="dot" style="background:var(--ember-core)"></span>';
        html += '<div class="search-group" role="presentation">';
        html += '<div class="search-group-title">' + dot + esc(g.label) + '</div>';
        var gc = g.color || 'var(--ember-core)';
        rows.forEach(function(x){
          var i = results.length;
          var rec = x.rec;
          results.push(rec);
          // Deep result: small portrait (or kind dot), title, meta + counts, type badge.
          var media = rec.portrait
            ? '<img class="sr-portrait" src="' + esc(rec.portrait) + '" width="36" height="36" alt="" loading="lazy" decoding="async">'
            : '<span class="sr-dot-media" style="background:' + gc + '"></span>';
          var counts = [];
          if (rec.memories) counts.push(rec.memories + (rec.memories === 1 ? ' memory' : ' memories'));
          if (rec.related) counts.push(rec.related + ' linked');
          var meta = (rec.subtitle || counts.length)
            ? '<span class="sr-meta">'
              + (rec.subtitle ? '<span class="sr-sub2">' + esc(rec.subtitle) + '</span>' : '')
              + (counts.length ? '<span class="sr-counts">' + esc(counts.join(' · ')) + '</span>' : '')
              + '</span>'
            : '';
          var badge = rec.badge ? '<span class="sr-badge" style="border-color:' + gc + '">' + esc(rec.badge) + '</span>' : '';
          html += '<a class="search-result deep" role="option" id="sr-' + i + '" tabindex="-1" href="' + esc(rec.url) + '">' +
                    media +
                    '<span class="sr-main"><span class="sr-title">' + highlight(rec.title, terms) + '</span>' + meta + '</span>' +
                    badge + '</a>';
        });
        html += '</div>';
      });
      if (!total){
        html = '<p class="search-empty">No matches for &ldquo;' + esc(q) + '&rdquo; yet.</p>';
      }
      panel.innerHTML = html;
      open();
      active = -1;
      statusEl.textContent = total ? (total + " result" + (total === 1 ? "" : "s") + " for " + q) : ("No results for " + q);
      // Clicking a result closes the panel (navigation happens via the href).
      panel.querySelectorAll(".search-result").forEach(function(a){
        a.addEventListener("mousedown", function(){ /* allow default navigation */ });
      });
    }

    function open(){ panel.hidden = false; if (field) field.setAttribute("aria-expanded", "true"); }
    function close(){
      panel.hidden = true; panel.innerHTML = ""; active = -1; results = [];
      if (field) field.setAttribute("aria-expanded", "false");
      input.setAttribute("aria-activedescendant", "");
    }

    function setActive(i){
      var nodes = panel.querySelectorAll(".search-result");
      if (!nodes.length) return;
      if (i < 0) i = nodes.length - 1;
      if (i >= nodes.length) i = 0;
      nodes.forEach(function(n){ n.classList.remove("is-active"); });
      active = i;
      var el = nodes[active];
      el.classList.add("is-active");
      el.scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", el.id);
    }

    input.addEventListener("input", function(){
      clearBtn.hidden = !input.value;
      search(input.value);
    });

    input.addEventListener("keydown", function(e){
      if (e.key === "ArrowDown"){ e.preventDefault(); if (panel.hidden) search(input.value); else setActive(active + 1); }
      else if (e.key === "ArrowUp"){ e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Enter"){
        if (active >= 0 && results[active]){ e.preventDefault(); window.location.href = results[active].url; }
      }
      else if (e.key === "Escape"){ if (!panel.hidden){ e.preventDefault(); close(); } else { input.value = ""; clearBtn.hidden = true; } }
    });

    clearBtn.addEventListener("click", function(){
      input.value = ""; clearBtn.hidden = true; close(); input.focus();
    });

    // Close when focus/click leaves the search widget.
    document.addEventListener("click", function(e){
      if (!e.target.closest(".archive-search")) close();
    });
    input.addEventListener("focus", function(){ if (input.value) search(input.value); });
  })();
})();
