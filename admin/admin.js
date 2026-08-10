/* =========================================================================
   Harlan's Legacy — Editorial Workspace controller (Phase 10)

   Talks to the same zero-dependency API in server.js (no schema change): every
   save/publish/delete writes data/stories.json and triggers a full rebuild, so
   the public site updates immediately. The editor asks for only the essentials
   (title, date, journey, story, publish state); everything else is auto-derived
   or AI-assisted, and the full story schema is still round-tripped on save.
   ========================================================================= */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var THREADS = { funny: "var(--thread-funny,#8f9a80)", momdad: "#A8735A", toledo: "#6B7A8C", shabbat: "#B8964F", grief: "#B99189", ordinary: "#5F8A82" };

  var state = { stories: [], site: null, entities: null, selectedId: null, filter: "", status: "coming-soon", dirty: false, isNew: false, saving: false, creating: null, lastSuggestions: null, readerPlan: [], readerManual: false, storyGallery: { primary: null, items: [] } };

  /* ---------------- api ----------------
     Sends the admin token (production auth) when one is stored. On 401 it
     clears the token and prompts again, so an expired/wrong token is recoverable
     without a blank screen. */
  function adminToken() { try { return sessionStorage.getItem("hl-admin-token") || ""; } catch (e) { return ""; } }
  function setAdminToken(t) { try { if (t) sessionStorage.setItem("hl-admin-token", t); else sessionStorage.removeItem("hl-admin-token"); } catch (e) {} }
  function promptToken(msg) {
    var t = window.prompt(msg || "Enter the admin token to manage this archive:", "");
    if (t != null) setAdminToken(t.trim());
    return adminToken();
  }
  function api(method, path, body) {
    var headers = { "Content-Type": "application/json" };
    var tok = adminToken(); if (tok) headers["x-admin-token"] = tok;
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.status === 401) { var e = new Error(j.error || "Unauthorized"); e.status = 401; throw e; }
          if (!r.ok) throw new Error(j.error || (r.status + " " + r.statusText));
          return j;
        });
      });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }
  function slugify(str) { return String(str || "").toLowerCase().trim().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }

  /* ---------------- toast + status ---------------- */
  var toastTimer;
  function toast(msg, kind) { var t = $("toast"); t.textContent = msg; t.className = "toast show" + (kind ? " " + kind : ""); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = "toast"; }, 3400); }
  function status(msg) { $("status").textContent = msg || ""; }

  /* ---------------- theme (dark default, light optional) ---------------- */
  (function initMode() {
    var toggle = $("mode-toggle");
    function reflect() { var light = document.documentElement.getAttribute("data-mode") === "light"; toggle.querySelector(".ic-moon").hidden = light; toggle.querySelector(".ic-sun").hidden = !light; }
    reflect();
    toggle.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-mode") === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-mode", next);
      try { localStorage.setItem("hl-admin-mode", next); } catch (e) {}
      reflect();
    });
  })();

  /* ---------------- load ---------------- */
  function loadError(msg) {
    var el = $("story-list");
    if (el) el.innerHTML = '<li class="list-empty" style="color:var(--danger);line-height:1.5;">' + esc(msg) + '<br><br><button class="btn btn-ghost" id="retry-load" type="button">Retry</button></li>';
    var btn = $("retry-load"); if (btn) btn.addEventListener("click", function () { status("Reconnecting…"); loadAll(); });
    status("Could not reach the archive.");
  }
  function loadAll(retried) {
    return Promise.all([api("GET", "/api/stories"), api("GET", "/api/site"), api("GET", "/api/entities")]).then(function (res) {
      state.stories = res[0]; state.site = res[1]; state.entities = res[2];
      populateThemeSelect(); renderStats(); renderList();
    }).catch(function (e) {
      if (e.status === 401 && !retried) { promptToken("This archive is protected. Enter the admin token:"); return loadAll(true); }
      // A real production failure — show a clear message, never a silent "0 memories".
      loadError(e.status === 401
        ? "Unauthorized — the admin token is missing or incorrect."
        : "Could not load the archive from the server: " + e.message + ". Check that the API and Supabase are reachable.");
      toast("Load failed: " + e.message, "err");
    });
  }
  function populateThemeSelect() {
    var sel = $("f-theme"); sel.innerHTML = "";
    Object.keys(state.site.themes).forEach(function (key) { var o = document.createElement("option"); o.value = key; o.textContent = state.site.themes[key].label; sel.appendChild(o); });
  }

  /* ---------------- list + stats ---------------- */
  function renderStats() {
    var pub = 0, soon = 0, draft = 0;
    state.stories.forEach(function (s) { if (s.status === "published") pub++; else if (s.status === "draft") draft++; else soon++; });
    $("stats").innerHTML = '<span class="stat"><b>' + pub + '</b> live</span><span class="stat"><b>' + soon + '</b> soon</span><span class="stat"><b>' + draft + '</b> draft</span><span class="stat"><b>' + state.stories.length + '</b> total</span>';
  }
  function renderList() {
    var q = state.filter.toLowerCase(), listEl = $("story-list");
    var items = state.stories.filter(function (s) { return !q || (s.title + " " + s.theme + " " + s.id + " " + s.status).toLowerCase().indexOf(q) !== -1; });
    listEl.innerHTML = "";
    if (!items.length) { listEl.innerHTML = '<li class="list-empty">No memories match “' + esc(state.filter) + '”.</li>'; return; }
    items.sort(function (a, b) { return (b.publishedISO || "").localeCompare(a.publishedISO || "") || b.id - a.id; });
    items.forEach(function (s) {
      var li = document.createElement("li");
      var b = document.createElement("button"); b.type = "button";
      b.className = "item" + (s.id === state.selectedId ? " active" : "");
      b.style.setProperty("--thread", THREADS[s.theme] || "var(--line)");
      var label = state.site.themes[s.theme] ? state.site.themes[s.theme].label : s.theme;
      var pill = '<span class="pill ' + s.status + '">' + s.status.replace("-", " ") + '</span>';
      if (s.featured && s.status === "published") pill = '<span class="pill featured">This week</span>' + pill;
      b.innerHTML = '<span class="im"><span class="it">' + esc(s.title || "Untitled") + '</span><span class="is">No. ' + s.id + ' · ' + esc(label) + '</span></span>' + pill;
      b.addEventListener("click", function () { attemptSelect(s.id); });
      li.appendChild(b); listEl.appendChild(li);
    });
  }

  /* ---------------- unsaved-changes guard (Save draft / Discard / Cancel) ---------------- */
  function currentDraftKey() { return state.isNew ? "new" : state.selectedId; }
  function discardCurrent() { clearDraft(currentDraftKey()); state.dirty = false; }
  // Run `proceed` after resolving any unsaved changes. Never blocks creating a
  // separate memory: Save-as-draft persists this one, Discard drops only its
  // local draft, Cancel aborts.
  function unsavedGuard(proceed) {
    if (!state.dirty) { proceed(); return; }
    showChoice("Unsaved changes", "This memory has changes you haven't saved yet.", [
      { label: "Save as draft", kind: "btn-primary", act: function () { setStatus("draft"); save(false, proceed); } },
      { label: "Discard", kind: "btn-danger", act: function () { discardCurrent(); proceed(); } },
      { label: "Cancel", kind: "btn-ghost", act: null }
    ]);
  }

  /* ---------------- select / new ---------------- */
  function attemptSelect(id) { unsavedGuard(function () { select(id); }); }
  function select(id) { var s = state.stories.filter(function (x) { return x.id === id; })[0]; if (!s) return; state.selectedId = id; state.isNew = false; fill(s); renderList(); restoreDraft(id); }
  function newStory() { unsavedGuard(freshStory); }
  // Always a completely fresh editor — never restores an old in-progress draft.
  function freshStory() {
    clearDraft("new");
    state.selectedId = null; state.isNew = true; state.dirty = false;
    var nextId = state.stories.reduce(function (m, s) { return Math.max(m, s.id); }, 0) + 1;
    fill({ id: nextId, title: "", slug: "", status: "draft", featured: false, theme: "ordinary", publishedISO: "", dateLong: "", dateLabel: "", memoryDate: "", summary: "", description: "", ogDescription: "", lead: "", body: [], people: [], places: [], objects: [], events: [], bookPart: "", keywords: [], echoStories: [], readingTime: "" }, true);
    renderList(); $("f-title").focus();
  }

  /* Lightweight modal for a 3-way choice (built once). */
  function showChoice(title, msg, buttons) {
    var ov = $("hl-modal");
    if (!ov) {
      ov = document.createElement("div"); ov.id = "hl-modal"; ov.className = "hl-modal-overlay"; ov.hidden = true;
      ov.innerHTML = '<div class="hl-modal" role="dialog" aria-modal="true" aria-labelledby="hl-modal-title"><h3 id="hl-modal-title"></h3><p id="hl-modal-msg"></p><div class="hl-modal-actions" id="hl-modal-actions"></div></div>';
      document.body.appendChild(ov);
      ov.addEventListener("mousedown", function (e) { if (e.target === ov) closeModal(); });
    }
    $("hl-modal-title").textContent = title; $("hl-modal-msg").textContent = msg;
    var acts = $("hl-modal-actions"); acts.innerHTML = "";
    buttons.forEach(function (b) {
      var el = document.createElement("button"); el.type = "button"; el.className = "btn " + (b.kind || "btn-ghost"); el.textContent = b.label;
      el.addEventListener("click", function () { closeModal(); if (b.act) b.act(); });
      acts.appendChild(el);
    });
    ov.hidden = false;
    ov._key = function (e) { if (e.key === "Escape") closeModal(); };
    document.addEventListener("keydown", ov._key);
    var first = acts.querySelector("button"); if (first) first.focus();
  }
  function closeModal() { var ov = $("hl-modal"); if (!ov) return; ov.hidden = true; if (ov._key) document.removeEventListener("keydown", ov._key); }

  /* ---------------- fill form ---------------- */
  function isoToDateInput(iso) { return /^\d{4}-\d{2}-\d{2}/.test(iso || "") ? String(iso).slice(0, 10) : ""; }
  function fill(s, isNew) {
    $("empty-state").hidden = true; $("editor").hidden = false;
    $("editor-eyebrow").textContent = isNew ? "New memory" : "Editing Story No. " + s.id;
    $("form-title").textContent = s.title || "Untitled";
    $("f-title").value = s.title || "";
    $("f-slug").value = s.slug || "";
    $("f-id").value = s.id;
    $("f-theme").value = s.theme || "ordinary";
    $("f-date").value = isoToDateInput(s.publishedISO);
    $("f-featured").checked = !!s.featured;
    // body textarea = lead + body paragraphs
    var paras = (s.lead ? [s.lead] : []).concat(s.body || []);
    $("f-body").value = paras.join("\n\n");
    $("f-summary").value = s.summary || "";
    $("f-description").value = s.description || "";
    $("f-og").value = s.ogDescription || "";
    $("f-memory").value = s.memoryDate || "";
    $("f-people").value = (s.people || []).join("\n");
    $("f-places").value = (s.places || []).join("\n");
    $("f-objects").value = (s.objects || []).join("\n");
    $("f-events").value = (s.events || []).join("\n");
    $("f-bookpart").value = s.bookPart || "";
    $("f-keywords").value = (s.keywords || []).join(", ");
    $("f-echoes").value = (s.echoStories || []).join(", ");
    $("f-reading").value = (s.readingTime === 0 || s.readingTime) ? s.readingTime : "";
    setStatus(s.status || "draft");
    $("delete-btn").hidden = !!isNew;
    $("ai-suggestions").innerHTML = ""; $("ai-apply-all").hidden = true; state.lastSuggestions = null;
    state.dirty = false;
    // reader images: manual plan if the story carries one, else automatic
    state.readerPlan = Array.isArray(s.readerImages) ? s.readerImages.slice() : [];
    state.readerManual = state.readerPlan.length > 0;
    state.storyGallery = { primary: null, items: [] };
    renderReaderPlan();
    if (!isNew) loadStoryImages(s.id); else renderStoryGrid();
    updateDerived(); updateSaveState(false, isNew ? "New — not yet saved" : (s.status === "published" ? "Published & live" : titleCase(s.status || "draft")));
    updateOpenLink(s, isNew);
  }
  function titleCase(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1).replace("-", " "); }

  function setStatus(v) {
    state.status = v;
    Array.prototype.forEach.call($("pubseg").children, function (b) { var on = b.getAttribute("data-v") === v; b.classList.toggle("on", on); });
    if (v !== "published") $("f-featured").checked = false;
  }

  /* ---------------- derived (slug, reading time, preview) ---------------- */
  function bodyParas() { return $("f-body").value.split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean); }
  function wordCount() { return $("f-body").value.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length; }
  function computedReading() { return Math.max(1, Math.round(wordCount() / 200)); }

  function updateDerived() {
    var slug = $("f-slug").value.trim() || slugify($("f-title").value) || "…";
    $("slug-preview").textContent = "story/" + $("f-id").value + "-" + slug + ".html";
    var rt = $("f-reading").value.trim(); $("rt-min").textContent = rt === "" ? computedReading() : rt;
    $("form-title").textContent = $("f-title").value.trim() || "Untitled";
    renderPreview(); renderSeo();
  }

  function allowEm(s) { return esc(s).replace(/&lt;(\/?)(em|i)&gt;/g, "<$1em>"); }
  function renderPreview() {
    var title = $("f-title").value.trim(), paras = bodyParas();
    var themeLabel = state.site && state.site.themes[$("f-theme").value] ? state.site.themes[$("f-theme").value].label : "";
    var iso = $("f-date").value, dateLong = iso ? longDate(iso) : ($("f-memory").value.trim() || "");
    var host = $("pv-story");
    if (!title && !paras.length) { host.innerHTML = '<p class="pv-empty">Start writing — the memory appears here as readers will see it.</p>'; return; }
    var html = '<p class="stamp">Story No. ' + esc($("f-id").value) + (themeLabel ? ' · ' + esc(themeLabel) : "") + '</p>' +
      '<h1>' + (esc(title) || "Untitled") + '</h1>' +
      (dateLong ? '<p class="pv-date">' + esc(dateLong) + '</p>' : "") +
      '<div class="pv-prose">' + paras.map(function (p) { return "<p>" + allowEm(p) + "</p>"; }).join("") + '</div>';
    host.innerHTML = html;
  }
  function renderSeo() {
    var title = $("f-title").value.trim() || "Untitled";
    var slug = $("f-slug").value.trim() || slugify(title);
    var desc = $("f-description").value.trim() || $("f-summary").value.trim() || (bodyParas()[0] || "").replace(/<[^>]+>/g, "").slice(0, 155);
    var og = $("f-og").value.trim() || desc;
    $("seo-url").textContent = "harlanslegacy.com › story › " + (slug || "…");
    $("seo-title").textContent = title + " — Harlan's Legacy";
    $("seo-desc").textContent = desc || "The SEO description appears here…";
    $("og-title").textContent = title;
    $("og-desc").textContent = og || "Social share description…";
    var tl = (title + " — Harlan's Legacy").length, dl = desc.length;
    $("seo-metric").innerHTML =
      '<span class="m' + (tl > 60 ? " warn" : "") + '">title ' + tl + '/60</span>' +
      '<span class="m' + (dl > 160 || (dl && dl < 70) ? " warn" : "") + '">description ' + dl + '/160</span>' +
      '<span class="m">' + computedReading() + ' min read</span>';
  }
  function longDate(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); if (!m) return ""; return MONTHS[+m[2] - 1] + " " + (+m[3]) + ", " + m[1]; }
  function labelDate(iso) { var m = /^(\d{4})-(\d{2})/.exec(iso); if (!m) return ""; return MON[+m[2] - 1] + " " + m[1]; }

  function updateOpenLink(s, isNew) {
    var link = $("open-story");
    if (!isNew && s.status === "published") { link.hidden = false; link.href = "/story/" + s.id + "-" + (s.slug || slugify(s.title)) + ".html"; }
    else link.hidden = true;
  }

  /* ---------------- collect -> record ---------------- */
  function lines(id) { return $(id).value.split("\n").map(function (x) { return x.trim(); }).filter(Boolean); }
  function collect() {
    var paras = bodyParas();
    var lead = paras.length ? paras[0] : null;
    var body = paras.slice(1);
    var iso = $("f-date").value || null;
    var echoes = $("f-echoes").value.split(",").map(function (x) { return parseInt(x.trim(), 10); }).filter(function (n) { return !isNaN(n); });
    var keywords = $("f-keywords").value.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    var reading = $("f-reading").value.trim();
    return {
      id: parseInt($("f-id").value, 10),
      title: $("f-title").value.trim(),
      slug: $("f-slug").value.trim(),
      status: state.status,
      featured: $("f-featured").checked,
      theme: $("f-theme").value,
      publishedISO: iso,
      dateLong: iso ? longDate(iso) : "",
      dateLabel: iso ? labelDate(iso) : "",
      memoryDate: $("f-memory").value.trim() || null,
      summary: $("f-summary").value.trim(),
      description: $("f-description").value.trim() || null,
      ogDescription: $("f-og").value.trim() || null,
      lead: lead, body: body,
      people: lines("f-people"), places: lines("f-places"), objects: lines("f-objects"), events: lines("f-events"),
      bookPart: $("f-bookpart").value.trim() || null,
      keywords: keywords, echoStories: echoes,
      readingTime: reading === "" ? computedReading() : parseInt(reading, 10),
      readerImages: state.readerManual ? state.readerPlan : []
    };
  }

  /* ---------------- validation ---------------- */
  function validate(rec) {
    var errs = [];
    $("wrap-title").classList.remove("field-invalid"); $("err-title").hidden = true;
    if (!rec.title) { errs.push("A title is needed."); $("wrap-title").classList.add("field-invalid"); $("err-title").hidden = false; }
    if (rec.featured && rec.status !== "published") errs.push("Only a published memory can be This Week's featured story.");
    if (rec.status === "published" && !rec.publishedISO) errs.push("A published memory needs a story date.");
    return errs;
  }

  /* ---------------- save / delete ---------------- */
  function save(publish, done) {
    if (state.saving) return;                       // guard: double-clicking Save/Publish never double-writes
    if (publish) setStatus("published");
    var rec = collect();
    var errs = validate(rec);
    if (errs.length) { toast(errs[0], "err"); updateSaveState(true, "Unsaved changes"); return; }
    // Update when we already hold a persistent id (incl. an auto-created draft);
    // create otherwise. This does NOT depend on the local list being in sync, so
    // a save immediately after a draft is created still PUTs (never a duplicate POST).
    var isUpdate = (!state.isNew && state.selectedId != null);
    state.saving = true;
    [$("save-btn"), $("save-btn-2")].forEach(function (b) { b.disabled = true; });
    updateSaveState(true, "Saving…"); status("Saving to the archive…");
    var req = isUpdate ? api("PUT", "/api/stories/" + state.selectedId, rec) : api("POST", "/api/stories", rec);
    var ok = false, savedId = rec.id;
    req.then(function (res) {
      var saved = res.story || rec; savedId = saved.id;
      var b = res.build || {};
      toast(isUpdate ? "Saved & rebuilt." : "Created & rebuilt.", "ok");
      status(b.summary ? ("Live · This week = " + b.summary.featured + " · " + b.summary.published + " published") : "Saved.");
      state.selectedId = savedId; state.isNew = false; clearDraft(savedId); clearDraft("new"); state.dirty = false; ok = true;
      return loadAll();
    }).then(function () {
      if (!ok) return;
      var s = state.stories.filter(function (x) { return x.id === savedId; })[0];
      if (s && !done) fill(s);
      updateSaveState(false, "Saved · " + clock());
    })
      .catch(function (err) {
        // Never destroy the user's work: the form is untouched on failure and we say so plainly.
        toast("Save failed: " + err.message, "err");
        status("Save failed — your changes are still here.");
        updateSaveState(true, "Save failed — your changes are still here");
      })
      .then(function () { state.saving = false; [$("save-btn"), $("save-btn-2")].forEach(function (b) { b.disabled = false; }); if (ok && done) done(); });
  }
  function del() {
    if (state.selectedId == null || state.isNew) return;
    var s = state.stories.filter(function (x) { return x.id === state.selectedId; })[0];
    if (!confirm("Delete “" + (s ? s.title : "this memory") + "” (No. " + state.selectedId + ")? This removes its story page too. This cannot be undone.")) return;
    status("Deleting…");
    api("DELETE", "/api/stories/" + state.selectedId).then(function () {
      toast("Deleted & rebuilt.", "ok"); clearDraft(state.selectedId); state.selectedId = null; state.dirty = false;
      $("editor").hidden = true; $("empty-state").hidden = false; status("");
      return loadAll();
    }).catch(function (err) { toast("Delete failed: " + err.message, "err"); });
  }

  /* ---------------- autosave (local drafts) ---------------- */
  var draftTimer;
  function draftKey(id) { return "hl-admin-draft:" + id; }
  function markDirty() {
    state.dirty = true; updateDerived();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      try { localStorage.setItem(draftKey(state.isNew ? "new" : state.selectedId), JSON.stringify(collect())); } catch (e) {}
      updateSaveState(true, "Autosaved locally · " + clock());
    }, 700);
  }
  function restoreDraft(id) {
    var raw; try { raw = localStorage.getItem(draftKey(id)); } catch (e) { raw = null; }
    if (!raw) return;
    try {
      var d = JSON.parse(raw); applyRecord(d); state.dirty = true;
      updateSaveState(true, "Unsaved local draft restored · " + clock());
    } catch (e) {}
  }
  function applyRecord(d) {
    $("f-title").value = d.title || ""; $("f-slug").value = d.slug || ""; $("f-theme").value = d.theme || "ordinary";
    $("f-date").value = isoToDateInput(d.publishedISO); $("f-featured").checked = !!d.featured;
    $("f-body").value = (d.lead ? [d.lead] : []).concat(d.body || []).join("\n\n");
    $("f-summary").value = d.summary || ""; $("f-description").value = d.description || ""; $("f-og").value = d.ogDescription || "";
    $("f-memory").value = d.memoryDate || ""; $("f-people").value = (d.people || []).join("\n"); $("f-places").value = (d.places || []).join("\n");
    $("f-objects").value = (d.objects || []).join("\n"); $("f-events").value = (d.events || []).join("\n");
    $("f-bookpart").value = d.bookPart || ""; $("f-keywords").value = (d.keywords || []).join(", "); $("f-echoes").value = (d.echoStories || []).join(", ");
    $("f-reading").value = (d.readingTime === 0 || d.readingTime) ? d.readingTime : "";
    setStatus(d.status || "draft"); updateDerived();
  }
  function clearDraft(id) { try { localStorage.removeItem(draftKey(id)); } catch (e) {} }
  function clock() { var d = new Date(); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
  function updateSaveState(dirty, text) { var el = $("save-state"); el.className = "save-state" + (dirty ? " dirty" : " saved"); $("save-text").textContent = text || (dirty ? "Unsaved changes" : "Saved"); }

  /* ---------------- AI assisted metadata ---------------- */
  function runAI() {
    if (!window.HL_AI) { toast("AI layer not loaded.", "err"); return; }
    $("ai-provider").textContent = "via " + window.HL_AI.currentName();
    var btn = $("ai-generate"); btn.disabled = true; btn.textContent = "Reading the memory…";
    var input = {
      title: $("f-title").value.trim(), lead: bodyParas()[0] || "", body: bodyParas().join("\n\n"),
      dateISO: $("f-date").value, theme: $("f-theme").value, selfId: parseInt($("f-id").value, 10),
      entities: state.entities || {}, stories: state.stories, themes: state.site.themes
    };
    window.HL_AI.generate(input).then(function (sug) { state.lastSuggestions = sug; renderSuggestions(sug); })
      .catch(function (e) { toast("Generate failed: " + e.message, "err"); })
      .then(function () { btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/></svg> Regenerate'; });
  }
  var SUGGEST_FIELDS = [
    { key: "summary", label: "Summary", apply: function (v) { $("f-summary").value = v; } },
    { key: "seoDescription", label: "SEO description", apply: function (v) { $("f-description").value = v; } },
    { key: "ogDescription", label: "Social / OG", apply: function (v) { $("f-og").value = v; } },
    { key: "readingTime", label: "Reading time", fmt: function (v) { return v + " min"; }, apply: function (v) { $("f-reading").value = v; } },
    { key: "journey", label: "Journey", fmt: function (v) { return state.site.themes[v] ? state.site.themes[v].label : v; }, apply: function (v) { $("f-theme").value = v; } },
    { key: "tone", label: "Emotional tone", apply: null },
    { key: "timeline", label: "Timeline placement", apply: null },
    { key: "people", label: "People", list: true, apply: function (v) { $("f-people").value = v.join("\n"); } },
    { key: "places", label: "Places", list: true, apply: function (v) { $("f-places").value = v.join("\n"); } },
    { key: "objects", label: "Objects", list: true, apply: function (v) { $("f-objects").value = v.join("\n"); } },
    { key: "events", label: "Events", list: true, apply: function (v) { $("f-events").value = v.join("\n"); } },
    { key: "keywords", label: "Search keywords", list: true, apply: function (v) { $("f-keywords").value = v.join(", "); } },
    { key: "searchTags", label: "Search tags", list: true, apply: null },
    { key: "relatedStories", label: "Related stories", related: true, apply: function (v) { $("f-echoes").value = v.map(function (r) { return r.id; }).join(", "); } },
    { key: "connections", label: "Internal connections", list: true, apply: null }
  ];
  function renderSuggestions(sug) {
    var host = $("ai-suggestions"); host.innerHTML = "";
    SUGGEST_FIELDS.forEach(function (f, i) {
      var v = sug[f.key]; if (v == null || (Array.isArray(v) && !v.length) || v === "") return;
      var disp;
      if (f.related) disp = v.map(function (r) { return '<span class="chip">No. ' + r.id + " · " + esc(r.title) + " (" + r.shared + "×)</span>"; }).join("");
      else if (f.list) disp = v.map(function (x) { return '<span class="chip">' + esc(x) + "</span>"; }).join("");
      else disp = esc(f.fmt ? f.fmt(v) : v);
      var row = document.createElement("div"); row.className = "sugg";
      row.innerHTML = '<div class="sg-body"><div class="sg-label">' + esc(f.label) + '</div><div class="sg-val">' + disp + '</div></div>' +
        (f.apply ? '<button class="mini-btn" type="button" data-i="' + i + '">Apply</button>' : '');
      if (f.apply) row.querySelector(".mini-btn").addEventListener("click", function () {
        f.apply(v); this.textContent = "Applied ✓"; this.classList.add("applied"); markDirty();
      });
      host.appendChild(row);
    });
    $("ai-apply-all").hidden = false;
    if (sug._note) { var n = document.createElement("p"); n.className = "hint"; n.style.marginTop = "0.6rem"; n.textContent = sug._note; host.appendChild(n); }
  }
  function applyAll() {
    if (!state.lastSuggestions) return;
    SUGGEST_FIELDS.forEach(function (f) { if (!f.apply) return; var v = state.lastSuggestions[f.key]; if (v == null || (Array.isArray(v) && !v.length) || v === "") return; f.apply(v); });
    Array.prototype.forEach.call(document.querySelectorAll("#ai-suggestions .mini-btn"), function (b) { b.textContent = "Applied ✓"; b.classList.add("applied"); });
    markDirty(); toast("Applied all suggestions.", "ok");
  }

  /* ---------------- preview tabs ---------------- */
  function showPreview(which) {
    var story = which === "story";
    $("pv-story-card").hidden = !story; $("pv-seo-card").hidden = story;
    $("pv-tab-story").classList.toggle("on", story); $("pv-tab-seo").classList.toggle("on", !story);
    $("pv-tab-story").setAttribute("aria-selected", story); $("pv-tab-seo").setAttribute("aria-selected", !story);
  }

  /* ---------------- wire memories ---------------- */
  $("new-btn").addEventListener("click", newStory);
  $("empty-new").addEventListener("click", newStory);
  $("delete-btn").addEventListener("click", del);
  $("story-form").addEventListener("submit", function (e) { e.preventDefault(); save(false); });
  $("search").addEventListener("input", function () { state.filter = this.value; renderList(); });
  $("ai-generate").addEventListener("click", runAI);
  $("ai-apply-all").addEventListener("click", applyAll);
  $("pv-tab-story").addEventListener("click", function () { showPreview("story"); });
  $("pv-tab-seo").addEventListener("click", function () { showPreview("seo"); });
  Array.prototype.forEach.call($("pubseg").children, function (b) { b.addEventListener("click", function () { setStatus(b.getAttribute("data-v")); markDirty(); }); });
  ["f-title", "f-slug", "f-id", "f-theme", "f-date", "f-featured", "f-body", "f-summary", "f-description", "f-og", "f-memory", "f-people", "f-places", "f-objects", "f-events", "f-bookpart", "f-keywords", "f-echoes", "f-reading"].forEach(function (id) {
    var el = $(id); if (el) el.addEventListener("input", markDirty);
  });
  $("goto-photos").addEventListener("click", function () { switchMode("photos"); });
  $("goto-photos").addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchMode("photos"); } });

  /* keyboard shortcuts */
  document.addEventListener("keydown", function (e) {
    var mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (!$("editor").hidden) save(false); }
    else if (mod && e.key === "Enter") { e.preventDefault(); if (!$("editor").hidden) save(true); }
    else if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); switchMode("stories"); $("search").focus(); }
    else if (mod && e.key.toLowerCase() === "g") { e.preventDefault(); if (!$("editor").hidden) runAI(); }
    else if (e.key === "Escape") { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }
  });
  window.addEventListener("beforeunload", function (e) { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } });

  /* ---------------- workspace switch ---------------- */
  function switchMode(mode) {
    var stories = mode === "stories";
    $("view-stories").hidden = !stories; $("view-photos").hidden = stories;
    $("mode-stories").classList.toggle("is-active", stories); $("mode-photos").classList.toggle("is-active", !stories);
    $("mode-stories").setAttribute("aria-selected", stories); $("mode-photos").setAttribute("aria-selected", !stories);
    if (!stories && !photoState.loaded) loadPhotos();
  }
  $("mode-stories").addEventListener("click", function () { switchMode("stories"); });
  $("mode-photos").addEventListener("click", function () { switchMode("photos"); });

  loadAll().then(function () { status(state.stories.length + " memories loaded."); });

  /* ====================== PHOTOGRAPHS ====================== */
  var photoState = { photos: {}, names: {}, personId: null, loaded: false, dragFrom: null };
  function loadPhotos() {
    return api("GET", "/api/photos").then(function (res) { photoState.photos = res.photos || {}; photoState.names = res.names || {}; photoState.loaded = true; renderPeople(); }).catch(function (e) { toast("Photos load failed: " + e.message, "err"); });
  }
  function renderPeople() {
    var ul = $("people-list"); ul.innerHTML = "";
    Object.keys(photoState.names).forEach(function (id) {
      var p = photoState.photos[id] || { items: [] };
      var li = document.createElement("li");
      var b = document.createElement("button"); b.type = "button"; b.className = "item" + (id === photoState.personId ? " active" : "");
      b.innerHTML = '<span class="im"><span class="it">' + esc(photoState.names[id]) + '</span><span class="is">' + (p.items ? p.items.length : 0) + ' photograph(s)</span></span>';
      b.addEventListener("click", function () { selectPerson(id); });
      li.appendChild(b); ul.appendChild(li);
    });
  }
  function selectPerson(id) { photoState.personId = id; $("photo-empty").hidden = true; $("photo-panel").hidden = false; $("photo-person-name").textContent = photoState.names[id] || id; renderPeople(); renderPhotoGrid(); }
  function person() { return photoState.photos[photoState.personId] || { primary: null, items: [] }; }
  function thumb(pid, it) { var w = (it.portrait && it.portrait[0]) || null; if (w) return "/assets/photos/" + pid + "/" + it.id + ".portrait." + w + ".jpg"; return it.url || ""; }

  function renderPhotoGrid() {
    var pid = photoState.personId, p = person(), grid = $("photo-grid"); grid.innerHTML = "";
    if (!p.items.length) { grid.innerHTML = '<li class="list-empty">No photographs yet — drop some above.</li>'; return; }
    p.items.forEach(function (it, idx) {
      var li = document.createElement("li"); li.className = "photo-card" + (it.id === p.primary ? " is-primary" : ""); li.setAttribute("draggable", "true"); li.dataset.idx = idx;
      var src = thumb(pid, it);
      li.innerHTML = (src ? '<img class="photo-thumb" src="' + escAttr(src) + '" alt="" loading="lazy">' : '<div class="photo-thumb"></div>') +
        '<div class="pc-body">' +
        '<label class="pc-primary"><input type="radio" name="primary" ' + (it.id === p.primary ? "checked" : "") + '> Primary portrait' + (it.id === p.primary ? ' <span class="pc-badge">shown</span>' : '') + '</label>' +
        '<input type="text" class="pc-cap" placeholder="Caption" value="' + escAttr(it.caption || "") + '">' +
        '<div class="pc-two"><input type="text" class="pc-year" placeholder="Year" value="' + escAttr(it.year || "") + '"><input type="text" class="pc-loc" placeholder="Location" value="' + escAttr(it.location || "") + '"></div>' +
        '<input type="text" class="pc-src" placeholder="Photographer / source" value="' + escAttr(it.source || "") + '">' +
        '<div class="pc-actions"><button type="button" class="mini-btn pc-up" ' + (idx === 0 ? "disabled" : "") + '>↑ Up</button><button type="button" class="mini-btn pc-down" ' + (idx === p.items.length - 1 ? "disabled" : "") + '>↓ Down</button><button type="button" class="mini-btn del">Delete</button></div>' +
        '</div>';
      li.querySelector(".pc-primary input").addEventListener("change", function () { p.primary = it.id; renderPhotoGrid(); });
      li.querySelector(".pc-cap").addEventListener("input", function () { it.caption = this.value; });
      li.querySelector(".pc-year").addEventListener("input", function () { it.year = this.value || null; });
      li.querySelector(".pc-loc").addEventListener("input", function () { it.location = this.value || null; });
      li.querySelector(".pc-src").addEventListener("input", function () { it.source = this.value || null; });
      li.querySelector(".pc-up").addEventListener("click", function () { move(idx, idx - 1); });
      li.querySelector(".pc-down").addEventListener("click", function () { move(idx, idx + 1); });
      li.querySelector(".del").addEventListener("click", function () { deletePhoto(it.id); });
      // drag reorder
      li.addEventListener("dragstart", function (e) { photoState.dragFrom = idx; e.dataTransfer.effectAllowed = "move"; });
      li.addEventListener("dragover", function (e) { e.preventDefault(); li.classList.add("drag-over"); });
      li.addEventListener("dragleave", function () { li.classList.remove("drag-over"); });
      li.addEventListener("drop", function (e) { e.preventDefault(); li.classList.remove("drag-over"); if (photoState.dragFrom != null) move(photoState.dragFrom, idx); photoState.dragFrom = null; });
      grid.appendChild(li);
    });
  }
  function move(from, to) { var p = person(); if (to < 0 || to >= p.items.length || from === to) return; p.items.splice(to, 0, p.items.splice(from, 1)[0]); renderPhotoGrid(); }

  function savePhotos() {
    var pid = photoState.personId, p = person();
    var body = { primary: p.primary, items: p.items.map(function (it) { return { id: it.id, caption: it.caption || "", year: it.year || null, location: it.location || null, source: it.source || null, alt: it.alt || null }; }) };
    var btn = $("photo-save"); btn.disabled = true; status("Rebuilding…");
    api("PUT", "/api/photos/" + encodeURIComponent(pid), body).then(function (res) { photoState.photos[pid] = res.person; toast("Saved & rebuilt.", "ok"); status("Photographs updated."); renderPeople(); renderPhotoGrid(); })
      .catch(function (e) { toast("Save failed: " + e.message, "err"); }).then(function () { btn.disabled = false; });
  }
  $("photo-save").addEventListener("click", savePhotos);

  function deletePhoto(photoId) {
    if (!confirm("Delete this photograph and its optimized versions? This cannot be undone.")) return;
    status("Deleting…");
    api("DELETE", "/api/photos/" + encodeURIComponent(photoState.personId) + "/" + encodeURIComponent(photoId))
      .then(function (res) { photoState.photos[photoState.personId] = res.person; toast("Deleted & rebuilt.", "ok"); renderPeople(); renderPhotoGrid(); })
      .catch(function (e) { toast("Delete failed: " + e.message, "err"); });
  }

  function uploadFiles(files) {
    var pid = photoState.personId; files = Array.prototype.slice.call(files || []).filter(function (f) { return /image\/(jpeg|png)/.test(f.type); });
    if (!pid || !files.length) return;
    var prog = $("upload-progress"); prog.hidden = false; var done = 0, total = files.length;
    function next(i) {
      if (i >= total) { prog.textContent = "Uploaded " + done + " of " + total + " — rebuilt."; return api("GET", "/api/photos").then(function (res) { photoState.photos = res.photos; photoState.names = res.names; renderPeople(); renderPhotoGrid(); }); }
      prog.textContent = "Uploading " + (i + 1) + " of " + total + "…";
      var reader = new FileReader();
      reader.onload = function () { api("POST", "/api/photos/" + encodeURIComponent(pid), { filename: files[i].name, data: reader.result }).then(function () { done++; next(i + 1); }).catch(function (e) { toast("Upload failed: " + e.message, "err"); next(i + 1); }); };
      reader.readAsDataURL(files[i]);
    }
    next(0);
  }
  $("photo-upload").addEventListener("change", function () { uploadFiles(this.files); this.value = ""; });
  var dz = $("photo-drop");
  dz.addEventListener("click", function () { if (photoState.personId) $("photo-upload").click(); else toast("Choose a person first.", "err"); });
  dz.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); dz.click(); } });
  ["dragenter", "dragover"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("drag"); }); });
  ["dragleave", "drop"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("drag"); }); });
  dz.addEventListener("drop", function (e) { if (!photoState.personId) { toast("Choose a person first.", "err"); return; } uploadFiles(e.dataTransfer.files); });

  /* ====================== STORY IMAGES + READER PLACEMENT ====================== */
  function siThumb(it) { var w = (it.portrait && it.portrait[0]); if (w) return "/assets/story-photos/" + storyKeyOf() + "/" + it.id + ".portrait." + w + ".jpg"; if (it.full && it.full[0]) return "/assets/story-photos/" + storyKeyOf() + "/" + it.id + ".full." + it.full[0] + ".jpg"; return it.url || ""; }
  function storyKeyOf() { return "story-" + state.selectedId; }
  function loadStoryImages(id) {
    if (id == null) { state.storyGallery = { primary: null, items: [] }; renderStoryGrid(); return; }
    api("GET", "/api/story-photos/" + id).then(function (g) { state.storyGallery = g || { primary: null, items: [] }; renderStoryGrid(); renderReaderPlan(); }).catch(function () { state.storyGallery = { primary: null, items: [] }; renderStoryGrid(); });
  }
  var siSaveTimer;
  function putStoryImages() {
    if (state.selectedId == null) return;
    clearTimeout(siSaveTimer);
    siSaveTimer = setTimeout(function () {
      var g = state.storyGallery;
      var body = { primary: g.primary, items: g.items.map(function (it) { return { id: it.id, caption: it.caption || "", year: it.year || null, location: it.location || null, source: it.source || null, alt: it.alt || null, focus: it.focus || null }; }) };
      status("Rebuilding…");
      api("PUT", "/api/story-photos/" + state.selectedId, body).then(function (r) { state.storyGallery = r.gallery; status("Images updated."); }).catch(function (e) { toast("Image save failed: " + e.message, "err"); });
    }, 500);
  }
  function renderStoryGrid() {
    var grid = $("si-grid"); if (!grid) return; grid.innerHTML = "";
    var g = state.storyGallery;
    if (!g.items.length) { grid.innerHTML = '<li class="list-empty">No editorial images yet — drop some above. A draft is created automatically so nothing is lost.</li>'; return; }
    g.items.forEach(function (it, idx) {
      var li = document.createElement("li"); li.className = "photo-card" + (it.id === g.primary ? " is-primary" : "");
      var src = siThumb(it); var f = it.focus || { x: 50, y: 50 };
      li.innerHTML = '<div class="si-focus">' + (src ? '<img class="photo-thumb focusable" src="' + escAttr(src) + '" alt="" loading="lazy" style="object-position:' + f.x + '% ' + f.y + '%">' : '<div class="photo-thumb"></div>') + '<span class="focus-dot" style="left:' + f.x + '%;top:' + f.y + '%"></span></div>' +
        '<div class="pc-body">' +
        '<label class="pc-primary"><input type="radio" name="si-primary" ' + (it.id === g.primary ? "checked" : "") + '> Primary' + (it.id === g.primary ? ' <span class="pc-badge">shown</span>' : '') + '</label>' +
        '<input type="text" class="pc-cap" placeholder="Caption" value="' + escAttr(it.caption || "") + '">' +
        '<div class="pc-two"><input type="text" class="pc-year" placeholder="Year" value="' + escAttr(it.year || "") + '"><input type="text" class="pc-loc" placeholder="Location" value="' + escAttr(it.location || "") + '"></div>' +
        '<div class="pc-actions"><button type="button" class="mini-btn si-up" ' + (idx === 0 ? "disabled" : "") + '>↑</button><button type="button" class="mini-btn si-down" ' + (idx === g.items.length - 1 ? "disabled" : "") + '>↓</button><button type="button" class="mini-btn del">Delete</button></div>' +
        '<p class="hint" style="margin:0;">Click image to set focal point (cropping).</p>' +
        '</div>';
      li.querySelector(".pc-primary input").addEventListener("change", function () { g.primary = it.id; renderStoryGrid(); putStoryImages(); });
      li.querySelector(".pc-cap").addEventListener("input", function () { it.caption = this.value; putStoryImages(); });
      li.querySelector(".pc-year").addEventListener("input", function () { it.year = this.value || null; putStoryImages(); });
      li.querySelector(".pc-loc").addEventListener("input", function () { it.location = this.value || null; putStoryImages(); });
      li.querySelector(".si-up").addEventListener("click", function () { if (idx > 0) { g.items.splice(idx - 1, 0, g.items.splice(idx, 1)[0]); renderStoryGrid(); putStoryImages(); } });
      li.querySelector(".si-down").addEventListener("click", function () { if (idx < g.items.length - 1) { g.items.splice(idx + 1, 0, g.items.splice(idx, 1)[0]); renderStoryGrid(); putStoryImages(); } });
      li.querySelector(".del").addEventListener("click", function () { deleteStoryImage(it.id); });
      var img = li.querySelector(".focusable");
      if (img) img.addEventListener("click", function (e) { var r = img.getBoundingClientRect(); it.focus = { x: Math.round((e.clientX - r.left) / r.width * 100), y: Math.round((e.clientY - r.top) / r.height * 100) }; renderStoryGrid(); putStoryImages(); });
      grid.appendChild(li);
    });
  }
  function deleteStoryImage(pid) {
    if (!confirm("Delete this image and its optimized versions? This cannot be undone.")) return;
    status("Deleting…");
    api("DELETE", "/api/story-photos/" + state.selectedId + "/" + encodeURIComponent(pid)).then(function (r) { state.storyGallery = r.gallery; toast("Deleted & rebuilt.", "ok"); renderStoryGrid(); renderReaderPlan(); }).catch(function (e) { toast("Delete failed: " + e.message, "err"); });
  }
  /* Guarantee the open memory has a persistent id, creating a DRAFT on the fly
     when it is still new — so the editor never forces a manual "save first"
     before images (or any id-addressed action). Auto-drafts are never published.
     Concurrent callers fold into one in-flight creation. Resolves with the id. */
  function ensureStoryId() {
    if (state.selectedId != null && !state.isNew) return Promise.resolve(state.selectedId);
    if (state.creating) return state.creating;
    var rec = collect(); rec.status = "draft"; rec.featured = false;
    state.creating = api("POST", "/api/stories", rec).then(function (res) {
      var created = res.story || rec;
      state.selectedId = created.id; state.isNew = false; state.status = "draft"; setStatus("draft");
      clearDraft("new");
      $("f-id").value = created.id;
      $("editor-eyebrow").textContent = "Editing Story No. " + created.id;
      $("delete-btn").hidden = false;
      updateOpenLink(created, false);
      updateSaveState(false, "Draft saved · " + clock());
      state.creating = null;
      toast("Draft started — add images and keep writing.", "ok");
      return loadAll().then(function () { renderList(); return created.id; });
    }, function (err) { state.creating = null; throw err; });
    return state.creating;
  }
  function uploadStoryFiles(files) {
    files = Array.prototype.slice.call(files || []).filter(function (f) { return /image\/(jpeg|png)/.test(f.type); });
    if (!files.length) return;
    ensureStoryId().then(function () {
      var prog = $("si-progress"); prog.hidden = false; var done = 0, failed = 0, total = files.length;
      function next(i) {
        if (i >= total) { prog.textContent = failed ? ("Uploaded " + done + " of " + total + " · " + failed + " failed.") : ("Uploaded " + done + " of " + total + "."); return loadStoryImages(state.selectedId); }
        prog.textContent = "Uploading " + (i + 1) + " of " + total + "…";
        var reader = new FileReader();
        reader.onload = function () { api("POST", "/api/story-photos/" + state.selectedId, { filename: files[i].name, data: reader.result }).then(function () { done++; next(i + 1); }).catch(function (e) { failed++; toast("Upload failed (" + files[i].name + "): " + e.message, "err"); next(i + 1); }); };
        reader.onerror = function () { failed++; toast("Could not read " + files[i].name, "err"); next(i + 1); };
        reader.readAsDataURL(files[i]);
      }
      next(0);
    }).catch(function (e) { toast("Couldn't start a draft for the images: " + e.message, "err"); });
  }
  var siInput = $("si-upload"), siDrop = $("si-drop");
  if (siInput) siInput.addEventListener("change", function () { uploadStoryFiles(this.files); this.value = ""; });
  if (siDrop) {
    siDrop.addEventListener("click", function () { siInput.click(); });
    siDrop.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); siDrop.click(); } });
    ["dragenter", "dragover"].forEach(function (ev) { siDrop.addEventListener(ev, function (e) { e.preventDefault(); siDrop.classList.add("drag"); }); });
    ["dragleave", "drop"].forEach(function (ev) { siDrop.addEventListener(ev, function (e) { e.preventDefault(); siDrop.classList.remove("drag"); }); });
    siDrop.addEventListener("drop", function (e) { uploadStoryFiles(e.dataTransfer.files); });
  }

  /* ---- reader placement plan ---- */
  function ensurePhotos(cb) { if (photoState.loaded) { if (cb) cb(); } else { loadPhotos().then(function () { if (cb) cb(); }); } }
  function availableRefs() {
    var opts = [];
    (state.storyGallery.items || []).forEach(function (it) { opts.push({ ref: "story:" + it.id, label: "Image · " + (it.caption || it.id).slice(0, 28) }); });
    // Family portraits come from the photo manifest (people who actually have photos).
    Object.keys(photoState.names || {}).forEach(function (id) {
      var p = photoState.photos[id];
      if (p && p.items && p.items.length) opts.push({ ref: "family:" + id, label: "Portrait · " + photoState.names[id] });
    });
    return opts;
  }
  var LAYOUTS = [["", "Auto layout"], ["pull-right", "Portrait — right"], ["pull-left", "Portrait — left"], ["plate", "Plate (centred)"], ["wide", "Full-width"]];
  function renderReaderPlan() {
    var list = $("rp-list"); if (!list) return;
    $("rp-mode").textContent = state.readerManual ? "Manual — your placement wins" : "Automatic";
    $("rp-reset").hidden = !state.readerManual;
    list.innerHTML = "";
    if (!state.readerManual) { list.innerHTML = '<p class="rp-empty">Images are placed automatically. Load the automatic picks to fine-tune, or add your own.</p>'; return; }
    if (!photoState.loaded) { ensurePhotos(renderReaderPlan); }
    if (!state.readerPlan.length) { list.innerHTML = '<p class="rp-empty">No images placed. Add one, or reset to automatic.</p>'; }
    var refs = availableRefs();
    state.readerPlan.forEach(function (entry, i) {
      var row = document.createElement("div"); row.className = "rp-row" + (entry.enabled === false ? " off" : "");
      var refOpts = refs.map(function (o) { return '<option value="' + escAttr(o.ref) + '"' + (o.ref === entry.ref ? " selected" : "") + '>' + esc(o.label) + '</option>'; }).join("");
      if (entry.ref && !refs.some(function (o) { return o.ref === entry.ref; })) refOpts = '<option value="' + escAttr(entry.ref) + '" selected>' + esc(entry.ref) + '</option>' + refOpts;
      var layOpts = LAYOUTS.map(function (l) { return '<option value="' + l[0] + '"' + ((entry.layout || "") === l[0] ? " selected" : "") + '>' + l[1] + '</option>'; }).join("");
      row.innerHTML = '<label class="rp-en check"><input type="checkbox" ' + (entry.enabled !== false ? "checked" : "") + '></label>' +
        '<select class="rp-ref">' + refOpts + '</select>' +
        '<select class="rp-layout">' + layOpts + '</select>' +
        '<input class="rp-cap" type="text" placeholder="Caption" value="' + escAttr(entry.caption || "") + '">' +
        '<input class="rp-after" type="number" min="1" placeholder="after ¶" value="' + (entry.after != null ? (entry.after + 1) : "") + '">' +
        '<span class="rp-tools"><button type="button" class="mini-btn rp-up" ' + (i === 0 ? "disabled" : "") + '>↑</button><button type="button" class="mini-btn rp-down" ' + (i === state.readerPlan.length - 1 ? "disabled" : "") + '>↓</button><button type="button" class="mini-btn del rp-del">✕</button></span>';
      row.querySelector(".rp-en input").addEventListener("change", function () { entry.enabled = this.checked; renderReaderPlan(); planDirty(); });
      row.querySelector(".rp-ref").addEventListener("change", function () { entry.ref = this.value; planDirty(); });
      row.querySelector(".rp-layout").addEventListener("change", function () { entry.layout = this.value; planDirty(); });
      row.querySelector(".rp-cap").addEventListener("input", function () { entry.caption = this.value; planDirty(); });
      row.querySelector(".rp-after").addEventListener("input", function () { var v = parseInt(this.value, 10); entry.after = isNaN(v) ? undefined : Math.max(0, v - 1); planDirty(); });
      row.querySelector(".rp-up").addEventListener("click", function () { if (i > 0) { state.readerPlan.splice(i - 1, 0, state.readerPlan.splice(i, 1)[0]); renderReaderPlan(); planDirty(); } });
      row.querySelector(".rp-down").addEventListener("click", function () { if (i < state.readerPlan.length - 1) { state.readerPlan.splice(i + 1, 0, state.readerPlan.splice(i, 1)[0]); renderReaderPlan(); planDirty(); } });
      row.querySelector(".rp-del").addEventListener("click", function () { state.readerPlan.splice(i, 1); renderReaderPlan(); planDirty(); });
      list.appendChild(row);
    });
  }
  function planDirty() { markDirty(); }
  $("rp-auto").addEventListener("click", function () {
    if (state.selectedId == null) { toast("Save the memory first to compute its automatic picks.", "err"); return; }
    api("GET", "/api/reader-plan/" + state.selectedId).then(function (r) { state.readerPlan = (r.plan || []).slice(); state.readerManual = true; renderReaderPlan(); markDirty(); toast("Loaded automatic picks — tweak away.", "ok"); }).catch(function (e) { toast("Could not load picks: " + e.message, "err"); });
  });
  $("rp-add").addEventListener("click", function () { var refs = availableRefs(); state.readerManual = true; state.readerPlan.push({ ref: refs[0] ? refs[0].ref : "", layout: "", caption: "", enabled: true }); renderReaderPlan(); markDirty(); });
  $("rp-reset").addEventListener("click", function () { state.readerManual = false; state.readerPlan = []; renderReaderPlan(); markDirty(); toast("Reset to automatic placement.", "ok"); });
})();
