/* PR #1 regression: the deferred-rebuild workflow (merged in 3a327d8) with the importer (lib/batch.js).
   Never touches production: no Supabase, no network beyond 127.0.0.1, random throwaway tokens.

     node pr1-regression.cjs <checkout> patched <plan.json> <out.json>

   <checkout> is a throwaway git worktree of 3a327d8 or later ("patched": the defer-rebuild change is
   in; "unpatched" reproduces the pre-PR baseline on a d13a77d worktree). Plan items carry photoMode
   from import.js plan(); stored photos are read back from the storage stub for the byte check. The real
   api/[...path].js runs in a local HTTP server in FILE mode (data/*.json of the worktree). Stubs:
   Supabase Storage (store.uploadObject writes to <checkout>/story-photos/<key>/<file>, where
   lib/hydrate.js puts originals before a Vercel build) and the Vercel deploy hook (a local counter).
   Fault injection wraps store.putStory / uploadObject / putStoryPhotos and the transport.
   Data: throwaway TEST copies of ready posts (ids 9101+, titles prefixed "TEST"). */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const [dir, mode, planFile, outFile] = process.argv.slice(2).map((v, i) => i === 1 ? v : path.resolve(v));
const PATCHED = mode === "patched";
const { runBatch, approvalFingerprint, uploadName, storedName } = require("../lib/batch.js");
const { Ledger } = require("../lib/ledger.js");

for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HL_DATA_DIR", "HARLAN_NARRATION_PUBLISH_GATE", "HARLAN_ENV_FILE"]) delete process.env[k];
const TOKEN = crypto.randomBytes(16).toString("hex"), MOD = crypto.randomBytes(16).toString("hex");
process.env.ADMIN_TOKEN = TOKEN;
process.env.HARLAN_MODERATORS = JSON.stringify({ [MOD]: { id: "mod1", name: "Test Moderator" } });

/* ---- stubs and fault injection ---- */
const store = require(path.join(dir, "lib", "store.js"));
if (store.USE_SUPABASE) throw new Error("must run in file mode");
const fault = { create: null, upload: null, gallery: null };
store.uploadObject = async (bucket, objPath, buf) => {
  if (fault.upload && fault.upload(objPath)) throw new Error("simulated storage failure");
  const d = path.join(dir, bucket, objPath); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.writeFileSync(d, buf);
};
store.removeObject = async (bucket, objPath) => { try { fs.unlinkSync(path.join(dir, bucket, objPath)); } catch (e) {} };
const realPutStory = store.putStory, realPutGalleries = store.putStoryPhotos;
const readStoredPhoto = async (id, item) => fs.readFileSync(path.join(dir, store.BUCKET_STORY, "story-" + id, item.file));
const run = o => runBatch(Object.assign({ readStoredPhoto }, o));
store.putStory = async rec => { if (fault.create && fault.create(rec)) throw new Error("simulated database failure"); return realPutStory(rec); };
store.putStoryPhotos = async m => { if (fault.gallery) fault.gallery(m); return realPutGalleries(m); };

const hooks = []; let hookFailNext = 0;
const hookServer = http.createServer((req, res) => { if (req.method === "POST") { hooks.push(Date.now()); if (hookFailNext > 0) { hookFailNext--; res.statusCode = 500; } } res.end("ok"); });
const handler = require(path.join(dir, "api", "[...path].js"));
const apiServer = http.createServer((req, res) => handler(req, res));
let base;
async function transport(method, p, body, headers, opts) {
  const tok = opts && "token" in opts ? opts.token : TOKEN;
  const h = Object.assign({ "content-type": "application/json" }, tok ? { "x-admin-token": tok } : {}, headers || {});
  const r = await fetch(base + p, { method, headers: h, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const counted = async fn => { const b = hooks.length; const r = await fn(); return { r, builds: hooks.length - b }; };
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const readStories = () => JSON.parse(fs.readFileSync(path.join(dir, "data", "stories.json"), "utf8"));
const readGalleries = () => JSON.parse(fs.readFileSync(path.join(dir, "data", "story-photos.json"), "utf8"));
const pageFor = id => fs.readdirSync(path.join(dir, "story")).find(n => n.startsWith(id + "-") && n.endsWith(".html"));
function vercelBuild() {   // package.json build:vercel (hydrate is a no-op in file mode)
  const t = Date.now();
  for (const s of ["lib/hydrate.js", "lib/photos.js", "build.js", "lib/collect-public.js"]) execFileSync(process.execPath, [s], { cwd: dir, stdio: "pipe", env: Object.assign({}, process.env, { ADMIN_TOKEN: "", HARLAN_MODERATORS: "" }), maxBuffer: 64e6 });
  return Math.round((Date.now() - t) / 100) / 10;
}

/* ---- sample ---- */
const plan = JSON.parse(fs.readFileSync(planFile, "utf8")).items.filter(x => x.readiness === "READY_PENDING_APPROVAL" && x.images.length >= 2);
function pick(n) {
  const must = ["P289", "P386"].map(id => plan.find(x => x.postId === id)).filter(Boolean);
  const rest = plan.filter(x => !must.includes(x));
  const step = rest.length / (n - must.length);
  return must.concat(Array.from({ length: n - must.length }, (_, i) => rest[Math.floor(i * step)])).sort((a, b) => a.publishedISO.localeCompare(b.publishedISO));
}
const asTest = (x, id) => ({ postId: x.postId, photoMode: x.photoMode, images: x.images, record: Object.assign({}, x.record, { id, title: "TEST " + id + " - " + x.record.title, status: "draft", featured: false }) });
const approve = items => Object.fromEntries(items.map(it => [it.postId, approvalFingerprint(it)]));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-pr1-ledger-"));
const newLedger = name => new Ledger(path.join(ledgerDir, name + ".jsonl"));

const report = { mode, commit: execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim(), workingTreeDiff: execFileSync("git", ["-C", dir, "diff", "--stat"]).toString().trim(), started: new Date().toISOString(), scenarios: {}, checks: [] };
const check = (scenario, name, ok, detail) => { report.checks.push({ scenario, name, ok: !!ok, detail: detail == null ? "" : String(detail) }); if (!ok) console.error("FAIL [" + scenario + "] " + name + " " + (detail || "")); };
const S = (k, v) => { report.scenarios[k] = v; };

async function main() {
  await new Promise(r => hookServer.listen(0, "127.0.0.1", r));
  await new Promise(r => apiServer.listen(0, "127.0.0.1", r));
  process.env.VERCEL_DEPLOY_HOOK_URL = "http://127.0.0.1:" + hookServer.address().port + "/hook";
  base = "http://127.0.0.1:" + apiServer.address().port;
  const before = readStories();
  const featuredBefore = before.filter(s => s.featured).map(s => s.id);
  const sample = pick(25).map((x, i) => asTest(x, 9101 + i));
  const photos = sample.reduce((a, s) => a + s.images.length, 0);
  const others = plan.filter(x => !sample.some(s => s.postId === x.postId));
  let o = 0; const take = (n, id0) => others.slice(o, o += n).map((x, i) => asTest(x, id0 + i));

  /* ===== 1, 2, 12: a fully successful 25-post batch ===== */
  const A = await counted(() => run({ items: sample, transport, ledger: newLedger("A"), defer: PATCHED, batchId: "A", approved: approve(sample) }));
  const a = A.r;
  S("A_success", { posts: 25, photos, writes: a.writes, responses: a.rebuilds, productionBuilds: A.builds, finalBuild: a.finalBuild, stopped: a.stopped });
  check("12", "all 25 posts verified (status, featured, title, text, date, category, photo order, Primary)", a.posts.filter(p => p.result === "verified").length === 25 && !a.stopped, JSON.stringify(a.stopped));
  check("1,2", "writes = 25 creates + " + photos + " photo uploads", a.writes === 25 + photos, a.writes);
  if (PATCHED) {
    check("1", "every Draft create answered 'deferred'", a.rebuilds.deferred === a.writes, JSON.stringify(a.rebuilds));
    check("2", "every Draft photo upload answered 'deferred' (no per-photo build)", a.rebuilds.triggered === 0, JSON.stringify(a.rebuilds));
    check("12", "exactly ONE production build, sent after the whole batch verified, recorded in the ledger", A.builds === 1 && a.finalBuild.sent && a.finalBuild.rebuild === "triggered" && newLedger("A").batchBuilt("A"), A.builds);
  } else {
    check("baseline", "today's code: one production build per write", A.builds === a.writes && a.rebuilds.triggered === a.writes, A.builds + " builds / " + a.writes + " writes");
  }
  const St = readStories(), Gl = readGalleries();
  let recOk = 0, imgOk = 0, bad = [];
  for (const s of sample) {
    const st = St.find(x => x.id === s.record.id);
    if (st && st.status === "draft" && !st.featured && st.title === s.record.title && st.lead === s.record.lead && JSON.stringify(st.body) === JSON.stringify(s.record.body) && st.importSource && st.importSource.postId === s.postId) recOk++;
    const g = Gl["story-" + s.record.id] || { items: [] };
    s.images.forEach((im, i) => { const it = g.items[i], f = it && path.join(dir, "story-photos", "story-" + s.record.id, it.file); if (it && fs.existsSync(f) && sha(f) === im.sha256) imgOk++; else bad.push(s.postId + "#" + im.order); });
    if (g.items.length !== s.images.length || !(g.items[0] && g.primary === g.items[0].id)) bad.push(s.postId + " count/primary");
  }
  check("12", "build input holds all 25 records exactly as approved", recOk === 25, recOk + "/25");
  check("12", "build input holds every photo once, in order, byte-identical (SHA-256); Primary = photo 1", imgOk === photos && !bad.length, imgOk + "/" + photos + " " + bad.join(","));
  const secs = vercelBuild();
  const G2 = readGalleries();
  let deriv = 0;
  for (const s of sample) for (const it of G2["story-" + s.record.id].items) { const d = path.join(dir, "assets", "story-photos", "story-" + s.record.id); if (fs.existsSync(d) && fs.readdirSync(d).some(f => f.startsWith(it.id + "."))) deriv++; }
  const pubText = ["stories.js", "search-index.json", "explore-data.js", "archive.html", "index.html"].map(f => { const p = path.join(dir, "public", f); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; }).join(" ");
  const leak = sample.filter(s => pageFor(s.record.id) || pubText.includes(s.record.title));
  check("12", "the final build processed every imported photo (responsive derivatives)", deriv === photos, deriv + "/" + photos);
  check("12", "the Drafts are not on the public site after the build", leak.length === 0, leak.map(s => s.record.id).join(","));
  fs.writeFileSync(path.join(dir, "data", "stories.json"), JSON.stringify(St.map(x => x.id >= 9101 && x.id <= 9125 ? Object.assign({}, x, { status: "published" }) : x), null, 2) + "\n");
  vercelBuild();
  let pages = 0, onPage = 0;
  for (const s of sample) { const f = pageFor(s.record.id); if (!f) continue; pages++; const html = fs.readFileSync(path.join(dir, "story", f), "utf8"); G2["story-" + s.record.id].items.forEach(it => { if (html.includes(it.id)) onPage++; }); }
  check("12", "publish-readiness (throwaway data only): all 25 render with every photo", pages === 25 && onPage === photos, pages + " pages, " + onPage + "/" + photos);
  fs.writeFileSync(path.join(dir, "data", "stories.json"), JSON.stringify(St, null, 2) + "\n");
  S("A_build", { seconds: secs, derivatives: deriv + "/" + photos, publishReadiness: pages + " pages, " + onPage + "/" + photos + " photos" });

  /* ===== 11: repeating a finished batch ===== */
  const A2 = await counted(() => run({ items: sample, transport, ledger: newLedger("A"), defer: PATCHED, batchId: "A", approved: approve(sample) }));
  check("11", "re-running the finished batch: 25 already verified, 0 writes, " + (PATCHED ? "build not sent again" : "no build"), A2.r.writes === 0 && A2.builds === 0 && A2.r.posts.every(p => p.result === "already verified"), JSON.stringify({ writes: A2.r.writes, builds: A2.builds, fb: A2.r.finalBuild }));
  const dupe = await counted(() => transport("POST", "/api/stories", sample[0].record, { "x-defer-rebuild": "1" }));
  check("11", "a repeated create of an existing id is refused (409), no duplicate, no build", dupe.r.status === 409 && dupe.builds === 0 && readStories().filter(s => s.id === sample[0].record.id).length === 1, dupe.r.status);
  S("A_repeat", { writes: A2.r.writes, builds: A2.builds, finalBuild: A2.r.finalBuild, repeatedCreate: dupe.r.status });

  if (!PATCHED) return finish();
  const D = { "x-defer-rebuild": "1" };
  const img = n => ({ filename: "editor" + n + ".jpg", data: "data:image/jpeg;base64," + fs.readFileSync(sample[0].images[0].file).toString("base64") });
  const rec = (id, extra) => Object.assign({}, sample[0].record, { id, title: "TEST " + id, importSource: undefined }, extra || {});
  async function cases(scn, list) {
    const rows = [];
    for (const [name, fn, expectBuilds, expectStatus] of list) {
      const c = await counted(fn);
      rows.push({ name, status: c.r.status, rebuild: c.r.body && (c.r.body.build ? c.r.body.build.rebuild : c.r.body.rebuild || c.r.body.error), builds: c.builds, expected: expectBuilds });
      check(scn, name + " -> " + expectBuilds + " build(s)" + (expectStatus ? ", HTTP " + expectStatus : ""), c.builds === expectBuilds && (!expectStatus || c.r.status === expectStatus), c.r.status + " / " + c.builds);
    }
    return rows;
  }

  /* ===== 3: Editorial Workspace saves (no header) ===== */
  S("3_editor", await cases("3", [
    ["create Draft", () => transport("POST", "/api/stories", rec(9201)), 1, 201],
    ["edit Draft", () => transport("PUT", "/api/stories/9201", rec(9201, { title: "TEST 9201 edited" })), 1, 200],
    ["upload photo to Draft", () => transport("POST", "/api/story-photos/9201", img(1)), 1, 201],
    ["reorder / caption Draft gallery", () => transport("PUT", "/api/story-photos/9201", { items: [] }), 1, 200],
    ["delete Draft", () => transport("DELETE", "/api/stories/9201"), 1, 200]
  ]));

  /* ===== 4: published memories always rebuild ===== */
  S("4_published", await cases("4", [
    ["create PUBLISHED with header", () => transport("POST", "/api/stories", rec(9211, { status: "published" }), D), 1, 201],
    ["edit published, with header", () => transport("PUT", "/api/stories/9211", rec(9211, { status: "published", title: "TEST 9211 e" }), D), 1, 200],
    ["upload photo to published, with header", () => transport("POST", "/api/story-photos/9211", img(2), D), 1, 201],
    ["reorder published gallery, with header", () => transport("PUT", "/api/story-photos/9211", { items: [] }, D), 1, 200],
    ["edit published, no header (Editorial Workspace)", () => transport("PUT", "/api/stories/9211", rec(9211, { status: "published", title: "TEST 9211 e2" })), 1, 200],
    ["publish a Draft (Draft -> published), with header", async () => { await transport("POST", "/api/stories", rec(9212), D); return transport("PUT", "/api/stories/9212", rec(9212, { status: "published" }), D); }, 1, 200],
    ["un-publish (published -> Draft), with header", () => transport("PUT", "/api/stories/9211", rec(9211), D), 1, 200]
  ]));

  /* ===== 5: coming-soon (public) ===== */
  await transport("POST", "/api/stories", rec(9221, { status: "coming-soon" }));
  await transport("POST", "/api/stories", rec(9222, { status: "coming-soon" }));
  await transport("POST", "/api/stories", rec(9223), D);
  S("5_coming_soon", await cases("5", [
    ["coming-soon -> Draft, with header", () => transport("PUT", "/api/stories/9221", rec(9221), D), 1, 200],
    ["edit coming-soon (stays coming-soon), with header", () => transport("PUT", "/api/stories/9222", rec(9222, { status: "coming-soon", title: "TEST 9222 e" }), D), 1, 200],
    ["upload photo to coming-soon, with header", () => transport("POST", "/api/story-photos/9222", img(3), D), 1, 201],
    ["Draft -> coming-soon, with header", () => transport("PUT", "/api/stories/9223", rec(9223, { status: "coming-soon" }), D), 1, 200]
  ]));

  /* ===== 6: invalid or missing headers / credentials ===== */
  S("6_headers", await cases("6", [
    ["header 'true'", () => transport("POST", "/api/stories", rec(9231), { "x-defer-rebuild": "true" }), 1, 201],
    ["header '0'", () => transport("POST", "/api/stories", rec(9232), { "x-defer-rebuild": "0" }), 1, 201],
    ["header '2'", () => transport("POST", "/api/stories", rec(9233), { "x-defer-rebuild": "2" }), 1, 201],
    ["header 'yes'", () => transport("POST", "/api/stories", rec(9234), { "x-defer-rebuild": "yes" }), 1, 201],
    ["misspelt header name 'x-defer-rebuilds: 1'", () => transport("POST", "/api/stories", rec(9235), { "x-defer-rebuilds": "1" }), 1, 201],
    ["no header", () => transport("POST", "/api/stories", rec(9236)), 1, 201],
    ["no token + header (refused, nothing saved)", async () => { const r = await transport("POST", "/api/stories", rec(9237), D, { token: "" }); const g = await transport("GET", "/api/stories/9237"); return { status: r.status === 401 && g.status === 404 ? 401 : 0, body: r.body }; }, 0, 401],
    ["wrong token + header (refused)", () => transport("POST", "/api/stories", rec(9238), D, { token: "not-the-token" }), 0, 401],
    ["moderator token + header on a Draft (allowed: moderators can already save Drafts)", () => transport("POST", "/api/stories", rec(9239), D, { token: MOD }), 0, 201],
    ["header name in capitals 'X-Defer-Rebuild: 1' (HTTP names are case-insensitive)", () => transport("POST", "/api/stories", rec(9240), { "X-Defer-Rebuild": "1" }), 0, 201]
  ]));

  /* ===== 7 + 10: failure during memory creation, then resume ===== */
  const B = take(5, 9131), lb = newLedger("B");
  fault.create = r => r.id === B[2].record.id;
  const B1 = await counted(() => run({ items: B, transport, ledger: lb, defer: true, batchId: "B", approved: approve(B) }));
  fault.create = null;
  S("7_create_failure", { first: { stopped: B1.r.stopped, verified: B1.r.posts.length, builds: B1.builds, finalBuild: B1.r.finalBuild } });
  check("7", "batch stops at the failed create (3rd post) and reports it", B1.r.stopped && B1.r.stopped.postId === B[2].postId && B1.r.stopped.step === "create" && B1.r.posts.length === 2, JSON.stringify(B1.r.stopped));
  check("7", "no build after the failed batch", B1.builds === 0 && !B1.r.finalBuild.sent, B1.builds);
  check("7", "nothing saved for the failed post; posts 4-5 untouched; posts 1-2 stay Drafts", (await transport("GET", "/api/stories/" + B[2].record.id)).status === 404 && (await transport("GET", "/api/stories/" + B[3].record.id)).status === 404 && readStories().filter(s => [B[0], B[1]].some(b => b.record.id === s.id)).every(s => s.status === "draft"));
  check("7", "ledger: 2 verified, an error line for the failed post, no batch-built", (() => { const st = lb.state(); return st[B[0].postId].verified && st[B[1].postId].verified && !st[B[2].postId].storyId && st[B[2].postId].lastError && !lb.batchBuilt("B"); })());
  const B2 = await counted(() => run({ items: B, transport, ledger: lb, defer: true, batchId: "B", approved: approve(B) }));
  report.scenarios["7_create_failure"].resume = { posts: B2.r.posts.map(p => p.postId + ":" + p.result), builds: B2.builds, finalBuild: B2.r.finalBuild };
  check("10", "resume after create failure: 2 already verified, 3 completed, exactly 1 build", !B2.r.stopped && B2.r.posts.filter(p => p.result === "already verified").length === 2 && B2.r.posts.filter(p => p.result === "verified").length === 3 && B2.builds === 1 && lb.batchBuilt("B"), JSON.stringify({ s: B2.r.stopped, b: B2.builds }));
  check("11", "resume after create failure: each story id exists exactly once", B.every(b => readStories().filter(s => s.id === b.record.id).length === 1));

  /* ===== 8 + 10: failure during photo upload, then resume ===== */
  const C = take(5, 9141), lc = newLedger("C");
  let seen = 0; fault.upload = p => p.startsWith("story-" + C[2].record.id + "/") && ++seen === 2;
  const C1 = await counted(() => run({ items: C, transport, ledger: lc, defer: true, batchId: "C", approved: approve(C) }));
  fault.upload = null;
  const gC = (await transport("GET", "/api/story-photos/" + C[2].record.id)).body;
  S("8_upload_failure", { first: { stopped: C1.r.stopped, builds: C1.builds, galleryOfFailedPost: gC.items.length + "/" + C[2].images.length, finalBuild: C1.r.finalBuild } });
  check("8", "batch stops at the failed upload (3rd post, photo 2)", C1.r.stopped && C1.r.stopped.postId === C[2].postId && C1.r.stopped.step === "photo 2", JSON.stringify(C1.r.stopped));
  check("8", "no build after the failed batch", C1.builds === 0 && !C1.r.finalBuild.sent, C1.builds);
  check("8", "the failed upload left no gallery entry (photo 1 kept, photo 2 absent)", gC.items.length === 1, gC.items.length);
  // A build from elsewhere (say an editor's save) while batches B... and C are incomplete: the partial Drafts stay off the site.
  vercelBuild();
  const partialLeak = C.concat(B).filter(x => pageFor(x.record.id));
  check("8", "partial batch: its Drafts stay unpublished and off the site even if another build runs", partialLeak.length === 0 && readStories().filter(s => C.some(c => c.record.id === s.id)).every(s => s.status === "draft"), partialLeak.length);
  const C2 = await counted(() => run({ items: C, transport, ledger: lc, defer: true, batchId: "C", approved: approve(C) }));
  const gC2 = (await transport("GET", "/api/story-photos/" + C[2].record.id)).body;
  const wantC = C[2].images.map(im => storedName(uploadName(im.file)));
  report.scenarios["8_upload_failure"].resume = { posts: C2.r.posts.map(p => p.postId + ":" + p.result + (p.photosUploaded != null ? " (" + p.photosUploaded + " uploaded)" : "")), builds: C2.builds, galleryOfFailedPost: gC2.items.length + "/" + C[2].images.length };
  check("10", "resume after upload failure: continues at photo 2, exactly 1 build", !C2.r.stopped && C2.r.posts.find(p => p.postId === C[2].postId).photosUploaded === C[2].images.length - 1 && C2.builds === 1, JSON.stringify(C2.r.posts));
  check("11", "resume after upload failure: every photo once, in order, no duplicate", JSON.stringify(gC2.items.map(x => x.file)) === JSON.stringify(wantC), gC2.items.map(x => x.file).join(","));

  /* ===== 9 + 10: gallery verification failures ===== */
  const Dd = take(3, 9151), ld = newLedger("D");
  const keyD = "story-" + Dd[1].record.id;
  fault.gallery = m => { const g = m[keyD]; if (g && g.items.length === Dd[1].images.length) { g.items.reverse(); fault.gallery = null; } };
  const D1 = await counted(() => run({ items: Dd, transport, ledger: ld, defer: true, batchId: "D", approved: approve(Dd) }));
  fault.gallery = null;
  S("9_gallery_order", { first: { stopped: D1.r.stopped, builds: D1.builds } });
  check("9", "wrong photo order detected at verification: batch stops, no build", D1.r.stopped && D1.r.stopped.step === "verify" && /order/.test(D1.r.stopped.error) && D1.builds === 0, JSON.stringify(D1.r.stopped));
  const D2 = await counted(() => run({ items: Dd, transport, ledger: ld, defer: true, batchId: "D", approved: approve(Dd) }));
  check("9", "re-running while the order is still wrong: stops before uploading anything, no build", D2.r.stopped && D2.r.stopped.step === "gallery check" && D2.r.writes === 0 && D2.builds === 0, JSON.stringify(D2.r.stopped));
  const gd = (await transport("GET", "/api/story-photos/" + Dd[1].record.id)).body;
  const repair = await counted(() => transport("PUT", "/api/story-photos/" + Dd[1].record.id, { primary: null, items: gd.items.slice().reverse().map(x => ({ id: x.id })) }));
  const D3 = await counted(() => run({ items: Dd, transport, ledger: ld, defer: true, batchId: "D", approved: approve(Dd) }));
  report.scenarios["9_gallery_order"].afterOwnerRepair = { repairBuilds: repair.builds, resume: D3.r.posts.map(p => p.postId + ":" + p.result), builds: D3.builds };
  check("10", "after the owner repairs the order in the Editorial Workspace, the resume verifies and sends exactly 1 build", !D3.r.stopped && D3.builds === 1, JSON.stringify(D3.r.stopped));

  const Dp = take(2, 9156), lp = newLedger("Dp");
  const keyP = "story-" + Dp[0].record.id;
  fault.gallery = m => { const g = m[keyP]; if (g && g.items.length === Dp[0].images.length) { g.primary = g.items[1].id; fault.gallery = null; } };
  const P1 = await counted(() => run({ items: Dp, transport, ledger: lp, defer: true, batchId: "Dp", approved: approve(Dp) }));
  fault.gallery = null;
  check("9", "wrong Primary detected at verification: batch stops, no build", P1.r.stopped && /Primary/.test(P1.r.stopped.error) && P1.builds === 0, JSON.stringify(P1.r.stopped));
  const gp = (await transport("GET", "/api/story-photos/" + Dp[0].record.id)).body;
  await transport("PUT", "/api/story-photos/" + Dp[0].record.id, { primary: gp.items[0].id, items: gp.items.map(x => ({ id: x.id })) });
  const P2 = await counted(() => run({ items: Dp, transport, ledger: lp, defer: true, batchId: "Dp", approved: approve(Dp) }));
  check("10", "after the Primary is repaired, the resume completes with exactly 1 build", !P2.r.stopped && P2.builds === 1, P2.builds);
  S("9_gallery_primary", { first: P1.r.stopped, resumeBuilds: P2.builds });

  /* ===== approved-manifest mismatch (stop before any write) ===== */
  const E = take(3, 9161);
  const approvedE = approve(E);
  const E_changed = E.map((x, i) => i === 1 ? Object.assign({}, x, { record: Object.assign({}, x.record, { title: x.record.title + " (changed after approval)" }) }) : x);
  const E1 = await counted(() => run({ items: E_changed, transport, ledger: newLedger("E"), defer: true, batchId: "E", approved: approvedE }));
  check("manifest", "a post that differs from its approved manifest stops the whole batch before any write", E1.r.stopped && E1.r.stopped.step === "preflight" && E1.r.writes === 0 && E1.builds === 0 && E.every(x => !readStories().some(s => s.id === x.record.id)), JSON.stringify(E1.r.stopped));
  const tmpImg = fs.mkdtempSync(path.join(os.tmpdir(), "hl-pr1-img-"));
  const E2items = E.map(x => Object.assign({}, x, { images: x.images.map(im => { const f = path.join(tmpImg, x.postId + "-" + path.basename(im.file)); fs.copyFileSync(im.file, f); return Object.assign({}, im, { file: f }); }) }));
  const approvedE2 = approve(E2items);
  fs.appendFileSync(E2items[2].images[0].file, Buffer.from([0]));
  const E2 = await counted(() => run({ items: E2items, transport, ledger: newLedger("E2"), defer: true, batchId: "E2", approved: approvedE2 }));
  check("manifest", "a local photo changed on disk after approval stops the batch before any write", E2.r.stopped && /changed on disk/.test(E2.r.stopped.error) && E2.r.writes === 0 && E2.builds === 0, JSON.stringify(E2.r.stopped));
  const E3 = await counted(() => run({ items: E.slice(0, 1), transport, ledger: newLedger("E3"), defer: true, batchId: "E3", approved: {} }));
  check("manifest", "a post that is not approved stops the batch before any write", E3.r.stopped && /not in the approved manifest/.test(E3.r.stopped.error) && E3.r.writes === 0 && E3.builds === 0, JSON.stringify(E3.r.stopped));
  S("manifest_mismatch", { changedTitle: E1.r.stopped, changedPhoto: E2.r.stopped, notApproved: E3.r.stopped });

  /* ===== 11: answers lost in transit (request done, response never arrives) ===== */
  const F = take(2, 9171), lf = newLedger("F");
  let drop = (m, p) => m === "POST" && p === "/api/stories";
  const lossy = async (m, p, b, h) => { const r = await transport(m, p, b, h); if (drop && drop(m, p, b)) { drop = null; throw new Error("connection reset (response lost)"); } return r; };
  const F1 = await counted(() => run({ items: F, transport: lossy, ledger: lf, defer: true, batchId: "F", approved: approve(F) }));
  drop = (m, p) => m === "POST" && p === "/api/story-photos/" + F[1].record.id;
  const F2 = await counted(() => run({ items: F, transport: lossy, ledger: lf, defer: true, batchId: "F", approved: approve(F) }));
  drop = null;
  const F3 = await counted(() => run({ items: F, transport, ledger: lf, defer: true, batchId: "F", approved: approve(F) }));
  const gF = (await transport("GET", "/api/story-photos/" + F[1].record.id)).body;
  S("11_lost_answers", { createAnswerLost: { stopped: F1.r.stopped, builds: F1.builds }, uploadAnswerLost: { stopped: F2.r.stopped, builds: F2.builds }, resume: { posts: F3.r.posts.map(p => p.postId + ":" + p.result + (p.photosUploaded != null ? " (" + p.photosUploaded + " uploaded)" : "")), builds: F3.builds } });
  check("11", "create answer lost: batch stops, no build; resume adopts that post's own Draft instead of creating another", F1.r.stopped && F1.builds === 0 && F2.builds === 0 && lf.read().some(e => e.step === "created" && e.adopted), JSON.stringify(F1.r.stopped));
  check("11", "upload answer lost: resume does not upload that photo again (each photo exactly once, in order)", JSON.stringify(gF.items.map(x => x.file)) === JSON.stringify(F[1].images.map(im => storedName(uploadName(im.file)))), gF.items.map(x => x.file).join(","));
  check("10", "after both interruptions the batch completes with exactly 1 build", !F3.r.stopped && F3.builds === 1 && F.every(x => readStories().filter(s => s.id === x.record.id).length === 1), F3.builds);

  /* ===== 12: the closing build request itself fails ===== */
  const Gx = take(2, 9181), lg = newLedger("G");
  hookFailNext = 1;
  const G1 = await counted(() => run({ items: Gx, transport, ledger: lg, defer: true, batchId: "G", approved: approve(Gx) }));
  const builtAfterG1 = lg.batchBuilt("G");
  const G2r = await counted(() => run({ items: Gx, transport, ledger: lg, defer: true, batchId: "G", approved: approve(Gx) }));
  const G3 = await counted(() => run({ items: Gx, transport, ledger: lg, defer: true, batchId: "G", approved: approve(Gx) }));
  S("12_build_request_fails", { first: { stopped: G1.r.stopped, finalBuild: G1.r.finalBuild }, retry: { writes: G2r.r.writes, finalBuild: G2r.r.finalBuild, builds: G2r.builds }, again: { builds: G3.builds, finalBuild: G3.r.finalBuild } });
  check("12", "a failed build request is reported, not recorded as built", G1.r.stopped && G1.r.stopped.step === "final build" && !builtAfterG1, JSON.stringify(G1.r.stopped));
  check("12", "re-run: no writes, sends the one build, records it; a further re-run sends nothing", G2r.r.writes === 0 && G2r.builds === 1 && lg.batchBuilt("G") && G3.builds === 0, JSON.stringify({ w: G2r.r.writes, b: G2r.builds, b3: G3.builds }));

  /* ===== existing memories and editor behaviour ===== */
  const after = readStories();
  check("existing", "every memory that existed before the test is byte-identical", JSON.stringify(after.filter(s => s.id < 9000)) === JSON.stringify(before));
  check("existing", "the featured memory is unchanged", JSON.stringify(after.filter(s => s.featured).map(s => s.id)) === JSON.stringify(featuredBefore), JSON.stringify(featuredBefore));
  check("existing", "no imported memory was published or featured by the importer", after.filter(s => s.importSource && s.id >= 9100 && s.id < 9200).every(s => s.status === "draft" && !s.featured));
  return finish();
}

function finish() {
  report.finished = new Date().toISOString();
  report.passed = report.checks.length > 0 && report.checks.every(c => c.ok);
  report.totalProductionBuildsCounted = hooks.length;
  fs.writeFileSync(outFile, JSON.stringify(report, null, 1));
  console.log((report.passed ? "PASS" : "FAIL") + " " + mode + ": " + report.checks.filter(c => c.ok).length + "/" + report.checks.length + " checks");
  hookServer.close(); apiServer.close();
  process.exitCode = report.passed ? 0 : 1;
}
main().catch(e => { console.error(e); report.error = String(e.stack || e); finish(); process.exitCode = 1; });
