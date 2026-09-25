/* =========================================================================
   Harlan's Legacy — narration API routes (shared by server.js + api/[...path].js)

   Routes (all under /api):
     GET  /api/narration/:storyId            → combined status (§1, §15)
     POST /api/narration/:storyId/generate   → enqueue async job (§2) {mode?,force?}
     POST /api/narration/:storyId/approve     → approve a ready generation (§10) {generationId}
     GET  /api/narration/jobs/:jobId          → job status for polling (§2)

   Returns { status, body, kick?, rebuild? } or null when the path is not ours.
   `kick` tells a local caller to run the in-process worker pump; `rebuild` asks
   the caller to trigger a static rebuild (approval changes public availability).
   ========================================================================= */
"use strict";

const store = require("../store.js");
const service = require("./service.js");
const jobs = require("./jobs.js");
const assets = require("./assets.js");
const audit = require("./audit.js");
const registry = require("./providers/registry.js");
const { narrationText } = require("./text.js");

async function route(parts, method, body, actor) {
  if (parts[1] !== "narration") return null;
  body = body || {};
  actor = actor || { id: "unknown", name: "Unknown", via: "none" };
  const seg = parts[2] || null;

  // ---- whole-archive Narration Library (§7) ----
  if (!seg && method === "GET") return { status: 200, body: await service.library() };

  // ---- audit log (who did what) ----
  if (seg === "audit" && method === "GET") return { status: 200, body: { events: await audit.list({ limit: 500 }) } };

  // ---- ISOLATED STAGING BENCHMARK (spec §10) — never touches production narration.
  // enqueue/jobs/providers: moderator-authenticated like every other route.
  // complete/heartbeat: machine callbacks, authenticated by HMAC signature inside.
  if (seg === "staging") {
    // Benchmark-only surface: disabled unless explicitly enabled on a benchmark host.
    if (process.env.HARLAN_STAGING_ENABLED !== "1") return { status: 404, body: { error: "Not found" } };
    const staging = require("./staging.js");
    const sub = parts[3] || null;
    if (method === "GET" && sub === "providers") return { status: 200, body: { providers: registry.describe() } };
    if (method === "POST" && sub === "enqueue") {
      const t0 = Date.now();
      try {
        const job = await staging.enqueue({ caseId: body.caseId, providerId: body.providerId, runLabel: body.runLabel, fanOut: body.fanOut, actor });
        return { status: 202, body: { job, serverAcceptMs: Date.now() - t0 } };
      } catch (e) { return { status: e.code === "provider_not_configured" ? 409 : 400, body: { error: String(e.message || e), code: e.code || "error" } }; }
    }
    if (method === "GET" && sub === "health" && parts[4]) return await staging.providerHealth(parts[4]);
    if (method === "GET" && sub === "jobs" && parts[4]) { const j = await staging.get(parts[4]); return j ? { status: 200, body: j } : { status: 404, body: { error: "No staging job " + parts[4] } }; }
    if (method === "GET" && sub === "jobs") return { status: 200, body: { jobs: await staging.list(100) } };
    if (method === "POST" && sub === "complete") return await staging.complete(body);
    if (method === "POST" && sub === "heartbeat") return await staging.heartbeat(body);
    return { status: 404, body: { error: "Unknown staging route " + method + " " + (sub || "") } };
  }

  // ---- job dashboard / single job ----
  if (seg === "jobs" && method === "GET") {
    if (parts[3]) { const j = await jobs.get(parts[3]); return j ? { status: 200, body: service.publicJob(j) } : { status: 404, body: { error: "No job " + parts[3] } }; }
    const all = await jobs.all();
    return { status: 200, body: { counts: await jobs.counts(), jobs: Object.values(all).map(service.publicJob) } };
  }

  // ---- batch actions (§7) ----
  if (seg === "generate-missing" && method === "POST") { const r = await service.generateMissing({ includeDrafts: !!body.includeDrafts }); return { status: 202, body: r, kick: true }; }
  if (seg === "retry-failed" && method === "POST") { const r = await service.retryFailed(); return { status: 202, body: r, kick: true }; }
  if (seg === "cancel-queued" && method === "POST") { const n = await jobs.cancelQueued(body.storyId != null ? Number(body.storyId) : null); return { status: 200, body: { cancelled: n } }; }

  const id = /^\d+$/.test(seg || "") ? Number(seg) : null;
  if (id == null) return { status: 400, body: { error: "Story id required" } };
  const stories = await store.getStories();
  const story = stories.find(s => s.id === id);
  if (!story) return { status: 404, body: { error: "No story " + id } };
  const action = parts[3] || null;

  if (method === "GET" && !action) return { status: 200, body: await service.statusFor(story) };

  // publish-time contract check (§4/§5)
  if (method === "GET" && action === "publish-readiness") return { status: 200, body: await service.publishReadiness(story) };

  // narration treatment: review the (auto or overridden) emotional map, override, or revert (§4)
  if (method === "GET" && action === "treatment") return { status: 200, body: await service.getTreatment(story) };
  if (method === "PUT" && action === "treatment") {
    try { const t = await service.setTreatmentOverride(id, body.treatment || body); await audit.record({ action: "narration.treatment.override", storyId: id, actor, sourceRevision: t.sourceRevision }); return { status: 200, body: { ok: true, treatment: t } }; }
    catch (e) { return { status: 400, body: { error: String(e.message || e), code: e.code || "error" } }; }
  }
  if (method === "DELETE" && action === "treatment") { const t = await service.clearTreatmentOverride(id); return { status: 200, body: { ok: true, treatment: t } }; }

  // ----- Ready-generation PREVIEW (admin-only; NO publication, NO mutation) -----
  // Works in production (serverless + remote Supabase assets): info + a synthetic
  // manifest are JSON; asset requests 302-redirect to the finalized public object.
  // gen is a PATH segment (serverless doesn't pass query to this router).
  if (method === "GET" && (action === "preview" || action === "preview-asset")) {
    const rec = service.record(story);
    const versions = rec.versions || [];
    let gen = parts[4] || "";
    if (!/^gen_[0-9a-f]+$/.test(gen)) {
      const ready = versions.filter(v => v.status === "ready").sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1))[0];
      gen = (ready && ready.generationId) || rec.generationId || (versions[0] && versions[0].generationId) || "";
    }
    if (!gen) return { status: 404, body: { error: "No generation available to preview for story " + id } };
    const v = versions.find(x => x.generationId === gen) || {};
    const base = "/api/narration/" + id + "/preview-asset/" + gen + "/";

    if (action === "preview") {
      await audit.record({ action: "narration.preview", storyId: id, actor, generationId: gen });
      const paragraphs = [story.lead].concat(story.body || []).filter(Boolean);
      return { status: 200, body: {
        storyId: id, gen, title: story.title || "", series: "Mom & Dad Stories",
        base, label: "PREVIEW — NOT PUBLISHED", paragraphs,
        duration: v.duration || null, treatmentVersion: v.treatmentVersion || null,
        emotionalArc: v.emotionalArc || null, versionStatus: v.status || null
      } };
    }
    // preview-asset/<gen>/<file>
    const file = parts.slice(5).join("/");
    if (file === "listen.json") {
      const body = { audio: "narration.mp3", words: "narration.words.json", sentences: "narration.sentences.json",
        paragraphs: "narration.paragraphs.json", duration: v.duration || 0, voiceId: v.voiceId || "harlan-v1",
        label: "PREVIEW — NOT PUBLISHED" };
      if (await assets.exists(id, "g/" + gen + "/narration.zones.json")) body.zones = "narration.zones.json";
      return { status: 200, body };
    }
    const allow = ["narration.mp3", "narration.words.json", "narration.sentences.json", "narration.paragraphs.json", "narration.zones.json"];
    if (allow.indexOf(file) < 0) return { status: 404, body: { error: "not a preview asset" } };
    return { status: 302, redirect: assets.publicBase(id) + "/g/" + gen + "/" + file };  // → finalized public object (Supabase in prod)
  }

  if (method === "GET" && action === "audit") return { status: 200, body: { events: await audit.list({ storyId: id, limit: 200 }) } };

  if (method === "POST" && action === "generate") {
    const r = await service.requestGeneration(story, { mode: body.mode || "auto", force: !!body.force, actor });
    await audit.record({ action: "narration.generate.request", storyId: id, actor, generationId: r.job && r.job.id, sourceRevision: (r.job && r.job.sourceRevision) || (r.version && r.version.sourceRevision) || null });
    return { status: r.cached ? 200 : 202, body: r, kick: !r.cached };
  }

  if (method === "POST" && action === "approve") {
    try {
      const rec = await service.approve(id, body.generationId, { actor });
      await audit.record({ action: "narration.approve", storyId: id, actor, generationId: body.generationId, sourceRevision: rec.sourceRevision });
      return { status: 200, body: { ok: true, narration: rec }, rebuild: true };
    } catch (e) {
      return { status: 400, body: { error: String(e.message || e), code: e.code || "error" } };
    }
  }

  return { status: 404, body: { error: "Unknown narration route " + method + " /" + parts.slice(1).join("/") } };
}

module.exports = { route };
