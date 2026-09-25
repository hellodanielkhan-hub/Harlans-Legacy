/* =========================================================================
   Harlan's Legacy — Admin: Voice Narration panel (§1, §9, §10, §11, §12, §15)

   Self-contained. Talks to /api/narration/* and renders the reusable workflow
   for whichever story is open in the editor:

     Not generated → [Generate Voice Narration]
     Generating…   → truthful stages (Queued / Generating / Aligning / Finalizing)
     Ready         → [▶ Preview] [Regenerate] [Approve]
     Approved      → ✓ Approved  [▶ Preview] [Regenerate]
     Outdated      → ⚠ story text changed  [Regenerate]
     Failed        → message  [Retry]

   No engine secret here — this only calls the server API. Reuses the admin's
   token + toast + button styles so it fits the CMS, not a separate dashboard.
   ========================================================================= */
(function () {
  "use strict";
  function token() { try { return sessionStorage.getItem("hl-admin-token") || ""; } catch (e) { return ""; } }
  function el(id) { return document.getElementById(id); }
  function toast(msg, kind) { var t = el("toast"); if (!t) return; t.textContent = msg; t.className = "toast show" + (kind ? " " + kind : ""); setTimeout(function () { t.className = "toast"; }, 3400); }
  function api(method, path, body) {
    var h = { "Content-Type": "application/json" }; var tok = token(); if (tok) h["x-admin-token"] = tok;
    return fetch(path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; }); });
  }
  function fmtDur(s) { s = Math.round(s || 0); var m = Math.floor(s / 60); return m + ":" + String(s % 60).padStart(2, "0"); }
  function fmtDate(iso) { if (!iso) return "—"; try { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch (e) { return iso; } }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  var state = { id: null, poll: null };

  function stop() { if (state.poll) { clearInterval(state.poll); state.poll = null; } }
  function hide() { stop(); var p = el("narration-panel"); if (p) p.hidden = true; state.id = null; }
  function show(id, story) {
    var p = el("narration-panel"); if (!p) return;
    p.hidden = false; state.id = id; stop();
    el("narr-body").innerHTML = '<p class="upload-note">Loading narration status…</p>';
    refresh();
  }

  function refresh() {
    if (state.id == null) return;
    api("GET", "/api/narration/" + state.id).then(render).catch(function (e) {
      el("narr-body").innerHTML = '<p class="upload-note">Save the memory first to manage its narration.</p>';
    });
  }

  function btn(label, cls, act) {
    var b = document.createElement("button"); b.type = "button"; b.className = "btn " + (cls || "btn-soft"); b.textContent = label; b.addEventListener("click", act); return b;
  }

  // Publish availability, mirroring the server publish contract (approved+fresh only).
  var PUBMAP = {
    approved: { ok: true, label: "Publish" },
    none: { label: "Publish unavailable — Generate Voice Narration" },
    processing: { label: "Publish unavailable — Narration is being generated" },
    ready: { label: "Publish unavailable — Approve Narration" },
    outdated: { label: "Publish unavailable — Regenerate Narration" },
    failed: { label: "Publish unavailable — Retry Narration" },
    superseded: { label: "Publish unavailable — Regenerate Narration" }
  };
  function publishBanner(state) {
    var m = PUBMAP[state] || PUBMAP.none;
    var d = document.createElement("div"); d.className = "narr-pub " + (m.ok ? "ok" : "blocked");
    d.innerHTML = (m.ok ? "✓ " : "⛔ ") + esc(m.label);
    return d;
  }

  function render(st) {
    var body = el("narr-body"); body.innerHTML = "";
    body.appendChild(publishBanner(st.state));
    var note = el("narr-note");
    var meta = document.createElement("div"); meta.className = "narr-meta";
    var voice = (st.voiceId || "harlan") + " · v" + (st.voiceVersion || "1");

    // ---- processing (a job is active) ----
    if (st.state === "processing" && st.job) {
      note.textContent = "Generating — you can keep working; this runs in the background.";
      body.appendChild(row("Voice", voice));
      body.appendChild(stageBar(st.job));
      startPolling(st.job.id);
      return;
    }

    // ---- failed ----
    if (st.state === "failed" || (st.job && st.job.status === "failed")) {
      var err = (st.job && st.job.error) || {};
      note.textContent = "Generation failed.";
      body.appendChild(warn("⚠ " + (err.message || "Generation failed.")));
      var actions = document.createElement("div"); actions.className = "narr-actions";
      actions.appendChild(btn("Retry", "btn-soft", function () { generate(true); }));
      body.appendChild(actions);
      return;
    }

    var appr = st.approved;
    var ready = (st.readyVersions || [])[0];

    // ---- approved ----
    if (st.state === "approved" && appr) {
      note.textContent = "Approved — enabled for Listening Mode and published with the story.";
      body.appendChild(row("Status", '<span class="narr-ok">✓ Approved · fresh</span>'));
      body.appendChild(row("Voice", voice));
      body.appendChild(row("Generation", appr.generationId ? esc(appr.generationId) : "—"));
      body.appendChild(row("Duration", fmtDur(appr.duration)));
      body.appendChild(integrityLine(appr.integrity));
      body.appendChild(row("Generated", fmtDate(appr.generatedAt)));
      body.appendChild(row("Approved", fmtDate(appr.approvedAt)));
      body.appendChild(preview(appr.audioUrl));
      var a1 = document.createElement("div"); a1.className = "narr-actions";
      a1.appendChild(btn("Regenerate", "btn-ghost", function () { generate(true); }));
      body.appendChild(a1);
      return;
    }

    // ---- outdated (approved but story text/voice changed) ----
    if (st.state === "outdated") {
      note.textContent = "The story text changed after this narration was approved.";
      body.appendChild(warn("⚠ Outdated — the approved narration no longer matches the current story text. Regenerate to refresh."));
      body.appendChild(row("Voice", voice));
      if (appr) body.appendChild(preview(appr.audioUrl));
      var a2 = document.createElement("div"); a2.className = "narr-actions";
      a2.appendChild(btn("Regenerate narration", "btn-soft", function () { generate(true); }));
      body.appendChild(a2);
      return;
    }

    // ---- ready (generated, awaiting approval) ----
    if (st.state === "ready" && ready) {
      note.textContent = "Generated — preview, then approve to publish to Listening Mode.";
      body.appendChild(row("Status", "Ready for review"));
      body.appendChild(row("Voice", voice));
      body.appendChild(row("Duration", fmtDur(ready.duration)));
      body.appendChild(integrityLine(ready.integrity));
      body.appendChild(preview(ready.audioUrl));
      var a3 = document.createElement("div"); a3.className = "narr-actions";
      a3.appendChild(btn("Approve narration", "btn-soft", function () { approve(ready.generationId); }));
      a3.appendChild(btn("Regenerate", "btn-ghost", function () { generate(true); }));
      body.appendChild(a3);
      return;
    }

    // ---- none ----
    note.textContent = "The spoken memory for Listening Mode — generated from this story's text.";
    if (!st.hasText) { body.appendChild(warn("Add the story's lead and body text first — there is nothing to narrate yet.")); return; }
    body.appendChild(row("Status", "Not generated"));
    body.appendChild(row("Voice", voice));
    var a4 = document.createElement("div"); a4.className = "narr-actions";
    a4.appendChild(btn("Generate voice narration", "btn-soft", function () { generate(false); }));
    body.appendChild(a4);
  }

  function stageLabel(job) {
    var map = { queued: "Queued", generating: "Generating voice", aligning: "Creating timings", finalizing: "Finalizing", ready: "Ready" };
    return map[job.status] || job.stage || job.status;
  }
  // A truthful multi-stage progress indicator — reflects the real backend lifecycle,
  // never a fabricated percentage (§2/§12). The current stage pulses; earlier stages
  // are marked done; later stages wait.
  var STAGES = [["queued", "Queued"], ["generating", "Generating"], ["aligning", "Aligning"], ["finalizing", "Finalizing"], ["ready", "Ready"]];
  function stageBar(job) {
    var cur = STAGES.map(function (s) { return s[0]; }).indexOf(job.status);
    if (cur < 0) cur = 0;
    var wrap = document.createElement("div"); wrap.className = "narr-stages";
    wrap.innerHTML = STAGES.map(function (s, i) {
      var cls = i < cur ? "done" : (i === cur ? "active" : "wait");
      return '<div class="narr-stage ' + cls + '"><span class="narr-sdot"></span><span class="narr-slabel">' + s[1] + '</span></div>';
    }).join('<span class="narr-sline"></span>');
    return wrap;
  }
  function row(k, vHtml) { var d = document.createElement("div"); d.className = "narr-row"; d.innerHTML = '<span class="narr-k">' + esc(k) + '</span><span class="narr-v">' + vHtml + '</span>'; return d; }
  function warn(msg) { var d = document.createElement("div"); d.className = "narr-warn"; d.textContent = msg; return d; }
  function integrityLine(ig) {
    if (!ig) return row("Integrity", "—");
    var ok = ig.ok ? '<span class="narr-ok">✓ ' + ig.matchedWords + "/" + ig.sourceWords + " words aligned</span>"
      : '<span class="narr-bad">✗ ' + ig.missingCount + " missing, " + ig.duplicateCount + " extra</span>";
    return row("Integrity", ok);
  }
  function preview(url) {
    var wrap = document.createElement("div"); wrap.className = "narr-preview";
    var audio = document.createElement("audio"); audio.controls = true; audio.preload = "none"; audio.style.width = "100%";
    audio.src = url; wrap.appendChild(audio); return wrap;
  }

  function generate(force) {
    if (state.id == null) return;
    el("narr-body").innerHTML = '<p class="upload-note">' + (force ? "Regenerating…" : "Starting generation…") + '</p>';
    api("POST", "/api/narration/" + state.id + "/generate", { force: !!force }).then(function (r) {
      if (r.cached) { toast("Existing approved narration reused.", "ok"); refresh(); return; }
      toast("Generation queued.", "ok");
      if (r.job) startPolling(r.job.id); else refresh();
    }).catch(function (e) { toast("Generate failed: " + e.message, "err"); refresh(); });
  }

  function startPolling(jobId) {
    stop();
    var tick = function () {
      api("GET", "/api/narration/jobs/" + jobId).then(function (j) {
        if (j.status === "ready" || j.status === "failed" || j.status === "cancelled") { stop(); refresh(); return; }
        var old = el("narr-body").querySelector(".narr-stages");
        if (old) old.parentNode.replaceChild(stageBar(j), old); else refresh();
      }).catch(function () { /* keep polling */ });
    };
    tick(); state.poll = setInterval(tick, 1500);
  }

  function approve(generationId) {
    if (state.id == null) return;
    api("POST", "/api/narration/" + state.id + "/approve", { generationId: generationId }).then(function () {
      toast("Narration approved & site rebuilt.", "ok"); refresh();
    }).catch(function (e) { toast("Approve failed: " + e.message, "err"); });
  }

  window.HLNarration = { show: show, hide: hide, refresh: refresh };
})();
