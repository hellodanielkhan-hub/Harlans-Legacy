/* =========================================================================
   Harlan's Legacy — CMS AI layer (Phase 10)

   A clean, provider-based architecture for AI-assisted metadata. The CMS calls
   one method — HL_AI.generate(input) — and never cares which provider answers.
   Today the default provider derives suggestions locally with transparent
   heuristics (no network, no fabricated backend). Tomorrow, dropping in an
   OpenAI / Claude / Gemini call means implementing the SAME `generate(input)`
   contract in a new provider and selecting it with HL_AI.use("remote") — the
   editor UI does not change.

   Provider contract
   -----------------
     provider.name : string
     provider.generate(input) : Promise<Suggestions> | Suggestions

     input = {
       title, lead, body (string), dateISO, theme,
       entities  : { family:{people:[…]}, places:[…], objects:[…], events:[…] },
       stories   : [ full story records ],
       themes    : site.themes
     }

     Suggestions = {
       seoDescription, ogDescription, summary, readingTime,
       keywords[], searchTags[], people[], places[], objects[], events[],
       journey (theme key), relatedStories[{id,title,shared}],
       tone, timeline, connections[], _source, _note
     }

   Everything a provider returns is treated as a SUGGESTION the editor may apply
   or ignore — never silently written.
   ========================================================================= */
(function () {
  "use strict";

  var STOP = ("the a an and or but of to in on at for with from by as is was were be been being " +
    "it its it's he she they them his her their our your my we you i me this that these those there here " +
    "so if then than too very just not no yes do did does had have has will would could should can " +
    "about into over under out up down off again once more most some any all each every other one two " +
    "which who whom whose what when where why how because while during before after above below between").split(" ");
  var STOPSET = {}; STOP.forEach(function (w) { STOPSET[w] = 1; });

  function tokens(s) {
    return String(s || "").toLowerCase().replace(/<[^>]+>/g, " ")
      .replace(/[^a-z0-9'’\s-]/g, " ").split(/\s+/).filter(Boolean);
  }
  function sentences(s) {
    return String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
      .split(/(?<=[.!?])\s+/).filter(Boolean);
  }
  function clip(s, n) {
    s = String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (s.length <= n) return s;
    var cut = s.slice(0, n);
    var sp = cut.lastIndexOf(" ");
    return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, "") + "…";
  }
  function uniq(arr) { var seen = {}, out = []; arr.forEach(function (x) { var k = String(x).toLowerCase(); if (x && !seen[k]) { seen[k] = 1; out.push(x); } }); return out; }
  function titleCase(s) { return String(s || "").replace(/\b\w/g, function (m) { return m.toUpperCase(); }); }

  // Map a theme + emotional cues in the prose to a short "tone" line.
  var THEME_TONE = {
    funny: "Warm and comic — a story told to make the room laugh.",
    momdad: "Tender and domestic — the gravity of home and parents.",
    toledo: "Nostalgic and boyish — the wide-open feeling of early days.",
    shabbat: "Quiet and devotional — ritual kept, imperfectly, on purpose.",
    grief: "Aching and reflective — what remains after someone is gone.",
    ordinary: "Gentle and observational — the small things that held a life."
  };
  function toneFor(theme, text) {
    var t = text.toLowerCase();
    if (/\b(laugh|funny|joke|ridiculous|absurd)\b/.test(t)) return "Warm and comic — built around a laugh.";
    if (/\b(died|death|funeral|grief|gone|passed|mourn)\b/.test(t)) return "Aching and reflective — shaped by loss.";
    if (/\b(candle|shabbat|prayer|blessing|sabbath)\b/.test(t)) return "Quiet and devotional — a ritual kept.";
    return THEME_TONE[theme] || "Reflective and warm — an ordinary moment, kept.";
  }

  /* -------- entity resolution (mirrors the graph's alias matching) -------- */
  function collectEntities(entities) {
    var list = [];
    ((entities.family && entities.family.people) || []).forEach(function (p) {
      if (p.hidden) return;
      list.push({ kind: "person", name: p.name, aliases: [p.name, p.fullName].concat(p.aliases || []).filter(Boolean) });
    });
    [["place", entities.places], ["object", entities.objects], ["event", entities.events]].forEach(function (pair) {
      (pair[1] || []).forEach(function (e) {
        list.push({ kind: pair[0], name: e.name, aliases: [e.name].concat(e.aliases || []).filter(Boolean) });
      });
    });
    return list;
  }
  function matchEntities(text, entities) {
    var low = " " + text.toLowerCase().replace(/\s+/g, " ") + " ";
    var out = { person: [], place: [], object: [], event: [] };
    collectEntities(entities).forEach(function (e) {
      var hit = e.aliases.some(function (a) {
        a = String(a).toLowerCase().replace(/\([^)]*\)/g, "").trim();
        if (a.length < 3) return false;
        return low.indexOf(" " + a + " ") !== -1 || low.indexOf(" " + a + ",") !== -1 ||
          low.indexOf(" " + a + ".") !== -1 || low.indexOf(a) !== -1 && a.length > 5;
      });
      if (hit) out[e.kind].push(e.name);
    });
    Object.keys(out).forEach(function (k) { out[k] = uniq(out[k]); });
    return out;
  }

  /* -------- keyword extraction -------- */
  function keywords(text, extra) {
    var freq = {};
    tokens(text).forEach(function (w) {
      if (w.length < 4 || STOPSET[w] || /^\d+$/.test(w)) return;
      freq[w] = (freq[w] || 0) + 1;
    });
    var top = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a] || a.localeCompare(b); }).slice(0, 8);
    return uniq(top.concat(extra || [])).slice(0, 12);
  }

  /* -------- related stories by shared referenced entities -------- */
  function relatedStories(matched, stories, selfId) {
    var mine = {};
    ["people", "places", "objects", "events"].forEach(function (f) {
      (matched[f === "people" ? "person" : f === "places" ? "place" : f === "objects" ? "object" : "event"] || [])
        .forEach(function (n) { mine[n.toLowerCase()] = 1; });
    });
    var scored = stories.filter(function (s) { return s.id !== selfId; }).map(function (s) {
      var shared = 0;
      ["people", "places", "objects", "events"].forEach(function (f) {
        (s[f] || []).forEach(function (n) { if (mine[String(n).toLowerCase()]) shared++; });
      });
      return { id: s.id, title: s.title, shared: shared };
    }).filter(function (x) { return x.shared > 0; });
    scored.sort(function (a, b) { return b.shared - a.shared || a.id - b.id; });
    return scored.slice(0, 5);
  }

  /* -------- suggest a journey/theme from prose vs theme descriptions -------- */
  function suggestTheme(text, themes, fallback) {
    if (!themes) return fallback;
    var words = tokens(text); var freq = {}; words.forEach(function (w) { freq[w] = (freq[w] || 0) + 1; });
    var best = fallback, bestScore = -1;
    Object.keys(themes).forEach(function (key) {
      var t = themes[key];
      var bag = tokens((t.label || "") + " " + (t.topic || "") + " " + (t.description || "") + " " + key);
      var score = 0; bag.forEach(function (w) { if (freq[w]) score += freq[w]; });
      if (score > bestScore) { bestScore = score; best = key; }
    });
    return bestScore > 0 ? best : fallback;
  }

  /* ---------------- the local (no-API) heuristic provider ---------------- */
  var localProvider = {
    name: "Local heuristics (no API key needed)",
    generate: function (input) {
      var body = String(input.body || "");
      var lead = String(input.lead || "");
      var title = String(input.title || "");
      var full = [title, lead, body].filter(Boolean).join(" \n ");
      var wordCount = tokens(full).length;
      var sents = sentences(lead + " " + body);
      var matched = matchEntities([title, lead, body].join(" \n "), input.entities || {});
      var kw = keywords(full, [].concat(matched.person, matched.place, matched.object, matched.event));
      var year = (input.dateISO || "").slice(0, 4);

      return {
        _source: localProvider.name,
        _note: "Heuristic suggestions from your title, prose, date and the existing archive — review before applying.",
        summary: clip(sents[0] || title, 120),
        seoDescription: clip(sents.slice(0, 2).join(" ") || lead || body, 155),
        ogDescription: clip(sents[0] || lead || body, 110),
        readingTime: Math.max(1, Math.round(wordCount / 200)),
        keywords: kw,
        searchTags: uniq(kw.concat([input.themes && input.themes[input.theme] ? input.themes[input.theme].label : input.theme]).filter(Boolean)),
        people: matched.person,
        places: matched.place,
        objects: matched.object,
        events: matched.event,
        journey: suggestTheme(full, input.themes, input.theme),
        relatedStories: relatedStories(matched, input.stories || [], input.selfId),
        tone: toneFor(input.theme, full),
        timeline: year ? ("Sits around " + year + " in the family timeline.") : "Add a date to place this on the timeline.",
        connections: relatedStories(matched, input.stories || [], input.selfId).map(function (r) {
          return "Shares people/places with No. " + r.id + " — " + r.title;
        })
      };
    }
  };

  /* ---------------- remote provider stub (future real API) ----------------
     Implements the SAME contract by POSTing to /api/ai/generate. Enable with
     HL_AI.use("remote") once server.js is wired to a real model + API key. */
  var remoteProvider = {
    name: "Remote AI (/api/ai/generate)",
    generate: function (input) {
      return fetch("/api/ai/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.ok) throw new Error((j && (j.reason || j.error)) || "AI provider not configured");
        return j.suggestions;
      });
    }
  };

  window.HL_AI = {
    version: 1,
    providers: { local: localProvider, remote: remoteProvider },
    active: "local",
    use: function (name) { if (this.providers[name]) this.active = name; return this; },
    currentName: function () { return this.providers[this.active].name; },
    generate: function (input) {
      try { return Promise.resolve(this.providers[this.active].generate(input)); }
      catch (e) { return Promise.reject(e); }
    }
  };
})();
