/* Harlan's Legacy — Admin Dashboard controller.
   Talks to the zero-dependency API in server.js. Every save/publish/delete
   writes data/stories.json server-side and triggers a full site rebuild,
   so the homepage, archive and story pages update immediately. */
(function () {
  "use strict";

  var THREADS = {
    funny: "var(--thread-funny)", momdad: "var(--thread-momdad)", toledo: "var(--thread-toledo)",
    shabbat: "var(--thread-shabbat)", grief: "var(--thread-grief)", ordinary: "var(--thread-ordinary)"
  };

  var state = { stories: [], site: null, selectedId: null, filter: "" };

  var $ = function (id) { return document.getElementById(id); };
  var listEl = $("story-list"), formEl = $("story-form"), emptyEl = $("empty-state");

  /* ---------- api ---------- */
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || (r.status + " " + r.statusText));
        return j;
      });
    });
  }

  /* ---------- toast + status ---------- */
  var toastTimer;
  function toast(msg, isErr) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = "toast"; }, 3200);
  }
  function status(msg) { $("status").textContent = msg || ""; }

  /* ---------- load ---------- */
  function loadAll() {
    return Promise.all([api("GET", "/api/stories"), api("GET", "/api/site")])
      .then(function (res) {
        state.stories = res[0];
        state.site = res[1];
        populateThemeSelect();
        renderList();
        renderStats();
      })
      .catch(function (e) { toast("Load failed: " + e.message, true); });
  }

  function populateThemeSelect() {
    var sel = $("f-theme");
    sel.innerHTML = "";
    Object.keys(state.site.themes).forEach(function (key) {
      var o = document.createElement("option");
      o.value = key; o.textContent = state.site.themes[key].label + " (" + key + ")";
      sel.appendChild(o);
    });
  }

  /* ---------- list ---------- */
  function renderStats() {
    var pub = state.stories.filter(function (s) { return s.status === "published"; }).length;
    var soon = state.stories.filter(function (s) { return s.status === "coming-soon"; }).length;
    var draft = state.stories.filter(function (s) { return s.status === "draft"; }).length;
    $("stats").innerHTML =
      '<span class="stat"><b>' + pub + '</b> published</span>' +
      '<span class="stat"><b>' + soon + '</b> coming soon</span>' +
      '<span class="stat"><b>' + draft + '</b> draft</span>' +
      '<span class="stat"><b>' + state.stories.length + '</b> total</span>';
  }

  function renderList() {
    var q = state.filter.toLowerCase();
    var items = state.stories.filter(function (s) {
      if (!q) return true;
      return (s.title + " " + s.theme + " " + s.id + " " + s.status).toLowerCase().indexOf(q) !== -1;
    });
    listEl.innerHTML = "";
    if (!items.length) {
      listEl.innerHTML = '<li class="subtle" style="color:var(--ink-muted);padding:0.5rem;">No matches.</li>';
      return;
    }
    items.forEach(function (s) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "story-item" + (s.id === state.selectedId ? " active" : "");
      btn.style.setProperty("--thread", THREADS[s.theme] || "var(--ink-whisper)");
      var pills = '<span class="pill ' + s.status + '">' + s.status.replace("-", " ") + '</span>';
      if (s.featured && s.status === "published") pills += ' <span class="pill featured">This week</span>';
      btn.innerHTML =
        '<span class="si-main"><span class="si-title">' + esc(s.title) + '</span>' +
        '<span class="si-meta">No. ' + s.id + ' · ' + (state.site.themes[s.theme] ? state.site.themes[s.theme].label : s.theme) + '</span></span>' +
        pills;
      btn.addEventListener("click", function () { select(s.id); });
      li.appendChild(btn);
      listEl.appendChild(li);
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ---------- select / new ---------- */
  function select(id) {
    var s = state.stories.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    state.selectedId = id;
    fill(s);
    renderList();
  }

  function newStory() {
    state.selectedId = null;
    var nextId = state.stories.reduce(function (m, s) { return Math.max(m, s.id); }, 0) + 1;
    fill({
      id: nextId, title: "", slug: "", status: "coming-soon", featured: false,
      theme: "ordinary", publishedISO: "", dateLong: "", dateLabel: "", memoryDate: "",
      summary: "", description: "", ogDescription: "", lead: "", body: [],
      people: [], places: [], objects: [], events: [], bookPart: "", keywords: [], echoStories: [], readingTime: ""
    }, true);
    renderList();
  }

  /* ---------- fill form ---------- */
  function fill(s, isNew) {
    emptyEl.hidden = true;
    formEl.hidden = false;
    $("form-title").textContent = isNew ? "New story" : "Editing: " + s.title;
    $("form-sub").textContent = isNew
      ? "A new record. Publishing it makes it live on the homepage."
      : "Story No. " + s.id + " — changes rebuild the site on save.";

    $("f-id").value = s.id;
    $("f-status").value = s.status || "coming-soon";
    $("f-theme").value = s.theme || "ordinary";
    $("f-title").value = s.title || "";
    $("f-slug").value = s.slug || "";
    $("f-featured").checked = !!s.featured;
    $("f-iso").value = s.publishedISO || "";
    $("f-datelong").value = s.dateLong || "";
    $("f-datelabel").value = s.dateLabel || "";
    $("f-memory").value = s.memoryDate || "";
    $("f-summary").value = s.summary || "";
    $("f-lead").value = s.lead || "";
    $("f-body").value = (s.body || []).join("\n\n");
    $("f-description").value = s.description || "";
    $("f-og").value = s.ogDescription || "";
    $("f-people").value = (s.people || []).join("\n");
    $("f-places").value = (s.places || []).join("\n");
    $("f-objects").value = (s.objects || []).join("\n");
    $("f-events").value = (s.events || []).join("\n");
    $("f-bookpart").value = s.bookPart || "";
    $("f-keywords").value = (s.keywords || []).join(", ");
    $("f-echoes").value = (s.echoStories || []).join(", ");
    $("f-reading").value = (s.readingTime === 0 || s.readingTime) ? s.readingTime : "";

    $("delete-btn").hidden = !!isNew;
    updateSlugPreview();
    updateOpenLink(s, isNew);
  }

  function updateSlugPreview() {
    var slug = $("f-slug").value.trim() || slugify($("f-title").value) || "…";
    $("slug-preview").textContent = "story/" + $("f-id").value + "-" + slug + ".html";
  }

  function updateOpenLink(s, isNew) {
    var link = $("open-story");
    if (!isNew && s.status === "published") {
      link.hidden = false;
      link.href = "/story/" + s.id + "-" + (s.slug || slugify(s.title)) + ".html";
    } else {
      link.hidden = true;
    }
  }

  function slugify(str) {
    return String(str || "").toLowerCase().trim()
      .replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  /* ---------- gather form -> record ---------- */
  function lines(id) {
    return $(id).value.split("\n").map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function collect() {
    var body = $("f-body").value.split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean);
    var echoes = $("f-echoes").value.split(",").map(function (x) { return parseInt(x.trim(), 10); }).filter(function (n) { return !isNaN(n); });
    var keywords = $("f-keywords").value.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    var reading = $("f-reading").value.trim();
    return {
      id: parseInt($("f-id").value, 10),
      title: $("f-title").value.trim(),
      slug: $("f-slug").value.trim(),
      status: $("f-status").value,
      featured: $("f-featured").checked,
      theme: $("f-theme").value,
      publishedISO: $("f-iso").value.trim() || null,
      dateLong: $("f-datelong").value.trim(),
      dateLabel: $("f-datelabel").value.trim(),
      memoryDate: $("f-memory").value.trim() || null,
      summary: $("f-summary").value.trim(),
      description: $("f-description").value.trim() || null,
      ogDescription: $("f-og").value.trim() || null,
      lead: $("f-lead").value.trim() || null,
      body: body,
      people: lines("f-people"), places: lines("f-places"),
      objects: lines("f-objects"), events: lines("f-events"),
      bookPart: $("f-bookpart").value.trim() || null,
      keywords: keywords,
      echoStories: echoes,
      readingTime: reading === "" ? null : parseInt(reading, 10)
    };
  }

  /* ---------- save / delete ---------- */
  function save(e) {
    e.preventDefault();
    var rec = collect();
    if (!rec.title) { toast("A title is required.", true); return; }
    if (rec.featured && rec.status !== "published") {
      toast("Only a published story can be This Week's Story.", true); return;
    }
    var exists = state.stories.some(function (s) { return s.id === rec.id; });
    var saveBtn = $("save-btn");
    saveBtn.disabled = true; saveBtn.textContent = "Saving…"; status("Rebuilding site…");

    var req = (state.selectedId != null && exists)
      ? api("PUT", "/api/stories/" + state.selectedId, rec)
      : api("POST", "/api/stories", rec);

    req.then(function (res) {
      var b = res.build || {};
      toast(exists ? "Saved & rebuilt." : "Created & rebuilt.");
      status(b.summary ? ("Live: This Week = " + b.summary.featured + " · " + b.summary.published + " published") : "Rebuilt.");
      state.selectedId = rec.id;
      return loadAll();
    }).then(function () {
      var s = state.stories.filter(function (x) { return x.id === rec.id; })[0];
      if (s) fill(s);
    }).catch(function (err) {
      toast("Save failed: " + err.message, true); status("");
    }).then(function () {
      saveBtn.disabled = false; saveBtn.textContent = "Save & rebuild";
    });
  }

  function del() {
    if (state.selectedId == null) return;
    var s = state.stories.filter(function (x) { return x.id === state.selectedId; })[0];
    if (!confirm("Delete “" + (s ? s.title : "this story") + "” (No. " + state.selectedId + ")? This also removes its story page. This cannot be undone.")) return;
    status("Deleting…");
    api("DELETE", "/api/stories/" + state.selectedId).then(function () {
      toast("Deleted & rebuilt.");
      state.selectedId = null;
      formEl.hidden = true; emptyEl.hidden = false;
      status("");
      return loadAll();
    }).catch(function (err) { toast("Delete failed: " + err.message, true); });
  }

  /* ---------- wire up ---------- */
  $("new-btn").addEventListener("click", newStory);
  $("delete-btn").addEventListener("click", del);
  formEl.addEventListener("submit", save);
  $("search").addEventListener("input", function () { state.filter = this.value; renderList(); });
  $("f-title").addEventListener("input", updateSlugPreview);
  $("f-slug").addEventListener("input", updateSlugPreview);
  $("f-id").addEventListener("input", updateSlugPreview);

  loadAll().then(function () { status(state.stories.length + " stories loaded."); });

  /* ====================== PHOTOS ====================== */
  var photoState = { photos: {}, names: {}, personId: null, loaded: false };

  function switchMode(mode) {
    var stories = mode === "stories";
    $("stories-layout").hidden = !stories;
    $("photos-layout").hidden = stories;
    $("mode-stories").classList.toggle("is-active", stories);
    $("mode-photos").classList.toggle("is-active", !stories);
    $("mode-stories").setAttribute("aria-selected", stories);
    $("mode-photos").setAttribute("aria-selected", !stories);
    if (!stories && !photoState.loaded) loadPhotos();
  }
  $("mode-stories").addEventListener("click", function () { switchMode("stories"); });
  $("mode-photos").addEventListener("click", function () { switchMode("photos"); });

  function loadPhotos() {
    return api("GET", "/api/photos").then(function (res) {
      photoState.photos = res.photos || {};
      photoState.names = res.names || {};
      photoState.loaded = true;
      renderPeople();
    }).catch(function (e) { toast("Photos load failed: " + e.message, true); });
  }

  function renderPeople() {
    var ul = $("people-list");
    ul.innerHTML = "";
    Object.keys(photoState.names).forEach(function (id) {
      var p = photoState.photos[id] || { items: [] };
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "story-item" + (id === photoState.personId ? " active" : "");
      btn.innerHTML = '<span class="si-main"><span class="si-title">' + esc(photoState.names[id]) +
        '</span><span class="si-meta">' + (p.items ? p.items.length : 0) + ' photo(s)</span></span>';
      btn.addEventListener("click", function () { selectPerson(id); });
      li.appendChild(btn); ul.appendChild(li);
    });
  }

  function selectPerson(id) {
    photoState.personId = id;
    $("photo-empty").hidden = true;
    $("photo-panel").hidden = false;
    $("photo-person-name").textContent = photoState.names[id] || id;
    renderPeople();
    renderPhotoGrid();
  }

  function person() { return photoState.photos[photoState.personId] || { primary: null, items: [] }; }

  function thumb(pid, it) {
    var w = (it.portrait && it.portrait[0]) || null;
    if (!w) return "";
    return "/assets/photos/" + pid + "/" + it.id + ".portrait." + w + ".jpg";
  }

  function renderPhotoGrid() {
    var pid = photoState.personId, p = person();
    var grid = $("photo-grid"); grid.innerHTML = "";
    if (!p.items.length) { grid.innerHTML = '<li class="subtle" style="color:var(--ink-muted)">No photographs yet — upload some above.</li>'; return; }
    p.items.forEach(function (it, idx) {
      var li = document.createElement("li");
      li.className = "photo-card" + (it.id === p.primary ? " is-primary" : "");
      var src = thumb(pid, it);
      li.innerHTML =
        (src ? '<img class="photo-thumb" src="' + esc(src) + '" alt="" loading="lazy">' : '<div class="photo-thumb"></div>') +
        '<div class="pc-body">' +
          '<label class="pc-primary"><input type="radio" name="primary" ' + (it.id === p.primary ? "checked" : "") + '> Primary' +
            (it.id === p.primary ? ' <span class="pc-badge">portrait</span>' : '') + '</label>' +
          '<input type="text" class="pc-cap" placeholder="Caption" value="' + esc(it.caption || "") + '">' +
          '<div class="pc-row"><input type="text" class="pc-year" placeholder="Year" value="' + esc(it.year || "") + '">' +
            '<input type="text" class="pc-loc" placeholder="Location" value="' + esc(it.location || "") + '"></div>' +
          '<input type="text" class="pc-src" placeholder="Photographer / source" value="' + esc(it.source || "") + '">' +
          '<div class="pc-actions">' +
            '<button type="button" class="pc-btn pc-up" ' + (idx === 0 ? "disabled" : "") + '>↑</button>' +
            '<button type="button" class="pc-btn pc-down" ' + (idx === p.items.length - 1 ? "disabled" : "") + '>↓</button>' +
            '<button type="button" class="pc-btn pc-del">Delete</button>' +
          '</div>' +
        '</div>';
      // wire events
      li.querySelector(".pc-primary input").addEventListener("change", function () { p.primary = it.id; renderPhotoGrid(); });
      li.querySelector(".pc-cap").addEventListener("input", function () { it.caption = this.value; });
      li.querySelector(".pc-year").addEventListener("input", function () { it.year = this.value || null; });
      li.querySelector(".pc-loc").addEventListener("input", function () { it.location = this.value || null; });
      li.querySelector(".pc-src").addEventListener("input", function () { it.source = this.value || null; });
      li.querySelector(".pc-up").addEventListener("click", function () { if (idx > 0) { p.items.splice(idx - 1, 0, p.items.splice(idx, 1)[0]); renderPhotoGrid(); } });
      li.querySelector(".pc-down").addEventListener("click", function () { if (idx < p.items.length - 1) { p.items.splice(idx + 1, 0, p.items.splice(idx, 1)[0]); renderPhotoGrid(); } });
      li.querySelector(".pc-del").addEventListener("click", function () { deletePhoto(it.id); });
      grid.appendChild(li);
    });
  }

  function savePhotos() {
    var pid = photoState.personId, p = person();
    var body = { primary: p.primary, items: p.items.map(function (it) {
      return { id: it.id, caption: it.caption || "", year: it.year || null, location: it.location || null, source: it.source || null, alt: it.alt || null };
    }) };
    var btn = $("photo-save"); btn.disabled = true; btn.textContent = "Saving…"; status("Rebuilding…");
    api("PUT", "/api/photos/" + encodeURIComponent(pid), body).then(function (res) {
      photoState.photos[pid] = res.person; toast("Saved & rebuilt."); status("Photos updated.");
      renderPeople(); renderPhotoGrid();
    }).catch(function (e) { toast("Save failed: " + e.message, true); })
      .then(function () { btn.disabled = false; btn.textContent = "Save & rebuild"; });
  }
  $("photo-save").addEventListener("click", savePhotos);

  function deletePhoto(photoId) {
    var pid = photoState.personId;
    if (!confirm("Delete this photograph and its optimized versions? This cannot be undone.")) return;
    status("Deleting…");
    api("DELETE", "/api/photos/" + encodeURIComponent(pid) + "/" + encodeURIComponent(photoId)).then(function (res) {
      photoState.photos[pid] = res.person; toast("Deleted & rebuilt."); renderPeople(); renderPhotoGrid();
    }).catch(function (e) { toast("Delete failed: " + e.message, true); });
  }

  $("photo-upload").addEventListener("change", function () {
    var pid = photoState.personId, files = Array.prototype.slice.call(this.files || []);
    if (!pid || !files.length) return;
    var prog = $("upload-progress"); prog.hidden = false;
    var done = 0, total = files.length;
    var input = this;
    function next(i) {
      if (i >= total) {
        prog.textContent = "Uploaded " + done + " of " + total + " — rebuilt.";
        input.value = "";
        return api("GET", "/api/photos").then(function (res) { photoState.photos = res.photos; photoState.names = res.names; renderPeople(); renderPhotoGrid(); });
      }
      prog.textContent = "Uploading " + (i + 1) + " of " + total + "…";
      var f = files[i], reader = new FileReader();
      reader.onload = function () {
        api("POST", "/api/photos/" + encodeURIComponent(pid), { filename: f.name, data: reader.result })
          .then(function () { done++; next(i + 1); })
          .catch(function (e) { toast("Upload failed: " + e.message, true); next(i + 1); });
      };
      reader.readAsDataURL(f);
    }
    next(0);
  });
})();
