/* Zero-photo importer test against the merged Production code (3a327d8). Never touches production:
   no Supabase, no network beyond 127.0.0.1, random throwaway tokens.

     node zero-photo-workflow.cjs <checkout> <manifest.json> <snapshot.json> <out.json>

   <checkout> is a throwaway git worktree of 3a327d89 (unmodified). Its real api/[...path].js runs in a
   local HTTP server in FILE mode (data/*.json of the worktree). Stubs: Supabase Storage (writes under
   <checkout>/story-photos/) and the Vercel deploy hook (a local counter). Test items are planned from
   the local import manifest with the importer's own plan(), then given throwaway ids (9301+) and
   titles prefixed "TEST". Local photo files are only read; corrupted/missing cases use temp copies.
   Scenario H covers the hardening safeguards: protected ids, snapshot occupancy, deferred mode,
   read-back HTTP status, the stored record field by field, and credentials kept out of results. */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const [dir, manifestFile, snapshotFile, outFile] = process.argv.slice(2).map(v => path.resolve(v));
const { runBatch, approvalFingerprint, toBatchItem, uploadName, storedName, PROTECTED_IDS, IMPORT_SYSTEM } = require("../lib/batch.js");
const { Ledger } = require("../lib/ledger.js");
const { plan } = require("../import.js");

for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HL_DATA_DIR", "HARLAN_NARRATION_PUBLISH_GATE", "HARLAN_ENV_FILE", "HL_ADMIN_TOKEN"]) delete process.env[k];
const TOKEN = crypto.randomBytes(16).toString("hex");
process.env.ADMIN_TOKEN = TOKEN;

/* ---- stubs and fault injection ---- */
const store = require(path.join(dir, "lib", "store.js"));
if (store.USE_SUPABASE) throw new Error("must run in file mode");
const fault = { create: null, upload: null, corrupt: null, mutate: null };
store.uploadObject = async (bucket, objPath, buf) => {
  if (fault.upload && fault.upload(objPath)) throw new Error("simulated storage failure");
  if (fault.corrupt && fault.corrupt(objPath)) buf = Buffer.concat([buf, Buffer.from([0])]);   // storage keeps different bytes
  const d = path.join(dir, bucket, objPath); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.writeFileSync(d, buf);
};
store.removeObject = async (bucket, objPath) => { try { fs.unlinkSync(path.join(dir, bucket, objPath)); } catch (e) {} };
const realPutStory = store.putStory;
// Stored-photo digest: stands in for the planned admin-only verification endpoint (C1). It reads the stored
// original from the storage stub and answers like an API: { status, body: { file, sha256 } }.
let digestFault = null;
const storedPhotoDigest = async (id, item) => {
  if (digestFault) { const d = digestFault(id, item); if (d) return d; }
  const f = path.join(dir, store.BUCKET_STORY, "story-" + id, item.file);
  if (!fs.existsSync(f)) return { status: 404, body: { error: "no stored object" } };
  const b = fs.readFileSync(f);
  return { status: 200, body: { storyId: id, file: item.file, bytes: b.length, sha256: crypto.createHash("sha256").update(b).digest("hex") } };
};
// A fresh read-only snapshot taken through the API, as a Production run would take one.
const takeSnapshot = async () => { const r = await transport("GET", "/api/stories"); return { takenAt: new Date().toISOString(), source: "GET /api/stories (rehearsal API)", memories: r.body.map(s => ({ id: s.id, status: s.status, featured: !!s.featured, importSource: s.importSource || null })) }; };
const run = async o => runBatch(Object.assign({ storedPhotoDigest, snapshot: await takeSnapshot() }, o));
process.on("exit", () => { delete process.env.ADMIN_TOKEN; delete process.env.HL_ADMIN_TOKEN; });
store.putStory = async rec => { if (fault.create && fault.create(rec)) throw new Error("simulated database failure"); if (fault.mutate) rec = fault.mutate(rec) || rec; return realPutStory(rec); };

const hooks = []; let hookFailNext = 0;
const hookServer = http.createServer((req, res) => { if (req.method === "POST") { hooks.push(Date.now()); if (hookFailNext > 0) { hookFailNext--; res.statusCode = 500; } } res.end("ok"); });
const handler = require(path.join(dir, "api", "[...path].js"));
const apiServer = http.createServer((req, res) => handler(req, res));
let base;
const calls = [];   // every request the importer sends: [method, path]
async function transport(method, p, body, headers, opts) {
  calls.push([method, p]);
  const tok = opts && "token" in opts ? opts.token : TOKEN;
  const h = Object.assign({ "content-type": "application/json" }, tok ? { "x-admin-token": tok } : {}, headers || {});
  const r = await fetch(base + p, { method, headers: h, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const counted = async fn => { const b = hooks.length, c = calls.length; const r = await fn(); return { r, builds: hooks.length - b, calls: calls.slice(c) }; };
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const readStories = () => JSON.parse(fs.readFileSync(path.join(dir, "data", "stories.json"), "utf8"));
const readGalleries = () => { const f = path.join(dir, "data", "story-photos.json"); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {}; };
const pageFor = id => fs.readdirSync(path.join(dir, "story")).find(n => n.startsWith(id + "-") && n.endsWith(".html"));
const uploadsTo = (cs, id) => cs.filter(([m, p]) => m === "POST" && p === "/api/story-photos/" + id).length;
function vercelBuild() {   // package.json build:vercel (hydrate is a no-op in file mode)
  for (const s of ["lib/hydrate.js", "lib/photos.js", "build.js", "lib/collect-public.js"]) execFileSync(process.execPath, [s], { cwd: dir, stdio: "pipe", env: Object.assign({}, process.env, { ADMIN_TOKEN: "", HARLAN_MODERATORS: "" }), maxBuffer: 64e6 });
}

/* ---- test items from the real local manifest ---- */
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const snapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
const TEXT_ONLY = ["P009", "P010", "P012", "P014", "P028", "P031"];   // images on disk, excluded by editorial decision
const NONE = ["P007", "P021", "P041", "P054"];                          // no photos on Facebook (batch 1)
const ONE = ["P022", "P045", "P078", "P081"], MULTI = ["P084", "P287", "P286", "P284"];
const wanted = new Set([...TEXT_ONLY, ...NONE, ...ONE, ...MULTI]);
const entries = manifest.entries.filter(e => wanted.has(e.postId)).map(e => TEXT_ONLY.includes(e.postId) ? Object.assign({}, e, { excludeImages: true }) : e);
const planned = plan({ entries }, snapshot, { assumeApproved: true }).items;
const byPost = Object.fromEntries(planned.map(x => [x.postId, x]));
let nextId = 9301;
const asTest = postId => { const x = toBatchItem(byPost[postId]); x.record = Object.assign({}, x.record, { id: nextId++, title: "TEST " + nextId + " - " + x.record.title, status: "draft", featured: false }); return x; };
const approve = items => Object.fromEntries(items.map(it => [it.postId, approvalFingerprint(it)]));
const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-nophoto-ledger-"));
const newLedger = name => new Ledger(path.join(ledgerDir, name + ".jsonl"));

const report = { commit: execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim(), apiWorkingTreeDiff: execFileSync("git", ["-C", dir, "diff", "--stat"]).toString().trim() || "(none: API code exactly as 3a327d8)", started: new Date().toISOString(), scenarios: {}, checks: [] };
const check = (scenario, name, ok, detail) => { report.checks.push({ scenario, name, ok: !!ok, detail: detail == null ? "" : String(detail) }); if (!ok) console.error("FAIL [" + scenario + "] " + name + " " + (detail || "")); };
const S = (k, v) => { report.scenarios[k] = v; };
const verifyStored = (items) => {
  const St = readStories(), Gl = readGalleries(); const bad = [];
  for (const s of items) {
    const st = St.find(x => x.id === s.record.id);
    if (!(st && st.status === "draft" && !st.featured && st.title === s.record.title && st.lead === s.record.lead && JSON.stringify(st.body) === JSON.stringify(s.record.body) && st.importSource && st.importSource.postId === s.postId)) bad.push(s.postId + " record");
    const g = Gl["story-" + s.record.id] || { primary: null, items: [] };
    if (g.items.length !== s.images.length) bad.push(s.postId + " count " + g.items.length + "/" + s.images.length);
    s.images.forEach((im, i) => { const it = g.items[i], f = it && path.join(dir, "story-photos", "story-" + s.record.id, it.file); if (!(it && it.file === storedName(uploadName(im.file)) && fs.existsSync(f) && sha(f) === im.sha256)) bad.push(s.postId + "#" + im.order); });
    if (s.images.length ? g.primary !== (g.items[0] && g.items[0].id) : g.primary != null) bad.push(s.postId + " primary");
    if (!s.images.length && fs.existsSync(path.join(dir, "story-photos", "story-" + s.record.id))) bad.push(s.postId + " has a photo folder");
  }
  return bad;
};

async function main() {
  await new Promise(r => hookServer.listen(0, "127.0.0.1", r));
  await new Promise(r => apiServer.listen(0, "127.0.0.1", r));
  process.env.VERCEL_DEPLOY_HOOK_URL = "http://127.0.0.1:" + hookServer.address().port + "/hook";
  base = "http://127.0.0.1:" + apiServer.address().port;
  // A stand-in for pilot Draft No. 404 (an import Draft of P003), so adoption of a protected id can be attempted.
  await transport("POST", "/api/stories", Object.assign({}, byPost[NONE[0]].record, { id: 404, title: "PILOT STAND-IN", importSource: { system: IMPORT_SYSTEM, postId: "P003", facebookUrl: null, facebookTimeChicago: null } }), { "x-defer-rebuild": "1" });
  const before = readStories(), galleriesBefore = JSON.stringify(readGalleries());
  const notReady = planned.filter(x => x.readiness !== "READY");
  check("setup", "every sampled post plans as READY (text-only, none, one-photo, multi-photo)", !notReady.length, notReady.map(x => x.postId + ":" + x.readiness + " " + x.reasons.join(";")).join(" | "));
  check("setup", "text-only posts plan with their images excluded and no upload requests", TEXT_ONLY.every(id => byPost[id].photoMode === "none" && !byPost[id].images.length && byPost[id].imagesExcluded > 0 && !byPost[id].requests.some(q => q.path.startsWith("/api/story-photos/") && q.method === "POST")), TEXT_ONLY.map(id => id + ":" + byPost[id].imagesExcluded).join(" "));

  /* ===== 1-5, 8: a mixed batch (2 no-photo, 2 text-only, 2 one-photo, 2 multi-photo) ===== */
  const A = [NONE[0], TEXT_ONLY[0], ONE[0], MULTI[0], NONE[1], TEXT_ONLY[1], ONE[1], MULTI[1]].map(asTest);
  const la = newLedger("A");
  const photosA = A.reduce((n, x) => n + x.images.length, 0);
  const rA = await counted(() => run({ items: A, transport, ledger: la, defer: true, batchId: "A", approved: approve(A) }));
  const zeroA = A.filter(x => !x.images.length);
  S("A_mixed", { posts: A.map(x => x.postId + "(" + x.photoMode + ", " + x.images.length + ")"), writes: rA.r.writes, builds: rA.builds, finalBuild: rA.r.finalBuild, stopped: rA.r.stopped });
  check("1", "every Draft saved and verified, including the 4 zero-photo Drafts", !rA.r.stopped && rA.r.posts.every(p => p.result === "verified") && rA.r.posts.length === 8, JSON.stringify(rA.r.stopped));
  check("1", "the zero-photo Drafts are stored as non-featured Drafts with the approved text", zeroA.every(x => { const s = readStories().find(y => y.id === x.record.id); return s && s.status === "draft" && !s.featured && s.lead === x.record.lead; }));
  check("2", "no photo-upload request for any zero-photo post", zeroA.every(x => uploadsTo(rA.calls, x.record.id) === 0), zeroA.map(x => x.postId + ":" + uploadsTo(rA.calls, x.record.id)).join(" "));
  check("2", "writes = 8 creates + " + photosA + " uploads (zero-photo posts add only their create)", rA.r.writes === 8 + photosA, rA.r.writes);
  check("3", "gallery verification accepted the empty galleries (primary null, no items)", zeroA.every(x => rA.r.posts.find(p => p.postId === x.postId).photos === 0) && zeroA.every(x => { const g = readGalleries()["story-" + x.record.id]; return !g || (!g.items.length && g.primary == null); }));
  check("4", "one-photo posts: uploaded once, photo 1 is Primary, byte-identical", A.filter(x => x.images.length === 1).every(x => uploadsTo(rA.calls, x.record.id) === 1) && !verifyStored(A.filter(x => x.images.length === 1)).length, verifyStored(A.filter(x => x.images.length === 1)).join(","));
  check("5", "multi-photo posts: Facebook order preserved, photo 1 Primary, every file byte-identical", !verifyStored(A.filter(x => x.images.length > 1)).length, verifyStored(A.filter(x => x.images.length > 1)).join(","));
  check("1-5", "every stored record and gallery matches the approved item exactly", !verifyStored(A).length, verifyStored(A).join(","));
  const ev = la.read(); const lastVerified = ev.map(e => e.step).lastIndexOf("verified"), builtAt = ev.findIndex(e => e.step === "batch-built");
  check("8", "exactly one build, sent only after every post (and gallery) verified, recorded in the ledger", rA.builds === 1 && rA.r.finalBuild.sent && builtAt > lastVerified && ev.filter(e => e.step === "verified").length === 8, JSON.stringify({ builds: rA.builds, builtAt, lastVerified }));
  check("8", "every Draft write answered 'deferred' (no per-write build)", rA.r.rebuilds.deferred === rA.r.writes && rA.r.rebuilds.triggered === 0, JSON.stringify(rA.r.rebuilds));

  // the closing build works with zero-photo Drafts in the data; the Drafts stay off the public site
  vercelBuild();
  const pubText = ["stories.js", "search-index.json", "explore-data.js", "archive.html", "index.html"].map(f => { const p = path.join(dir, "public", f); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; }).join(" ");
  check("8", "the build runs with zero-photo Drafts present and none of the Drafts reaches the public site", A.every(x => !pageFor(x.record.id) && !pubText.includes(x.record.title)));
  const St = readStories();
  fs.writeFileSync(path.join(dir, "data", "stories.json"), JSON.stringify(St.map(x => A.some(a => a.record.id === x.id) ? Object.assign({}, x, { status: "published" }) : x), null, 2) + "\n");
  vercelBuild();
  check("1", "publish-readiness (throwaway data only): zero-photo memories render a page without any photo", zeroA.every(x => { const f = pageFor(x.record.id); return f && !fs.readFileSync(path.join(dir, "story", f), "utf8").includes("story-" + x.record.id + "/"); }), zeroA.map(x => x.postId + ":" + pageFor(x.record.id)).join(" "));
  fs.writeFileSync(path.join(dir, "data", "stories.json"), JSON.stringify(St, null, 2) + "\n");

  const rA2 = await counted(() => run({ items: A, transport, ledger: la, defer: true, batchId: "A", approved: approve(A) }));
  check("6", "re-running the finished batch: all already verified, 0 writes, no second build", rA2.r.writes === 0 && rA2.builds === 0 && rA2.r.posts.every(p => p.result === "already verified"), JSON.stringify(rA2.r.finalBuild));

  /* ===== 3 (negative): a zero-photo Draft that somehow holds a photo is refused ===== */
  const Z = [asTest(NONE[2])], lz = newLedger("Z");
  await transport("POST", "/api/stories", Object.assign({}, Z[0].record, { importSource: undefined }), { "x-defer-rebuild": "1" });   // a different memory already holds this id
  await transport("POST", "/api/story-photos/" + Z[0].record.id, { filename: "stray.jpg", data: "data:image/jpeg;base64," + fs.readFileSync(byPost[ONE[0]].images[0].file).toString("base64") }, { "x-defer-rebuild": "1" });
  const rZ = await counted(() => run({ items: Z, transport, ledger: lz, defer: true, batchId: "Z", approved: approve(Z) }));
  check("3", "a Draft approved without photos whose id is not this post's Draft is refused in preflight (occupied in the snapshot; no adoption, no writes, no build)", rZ.r.stopped && rZ.r.stopped.step === "preflight" && /occupied in the snapshot/.test(rZ.r.stopped.error) && rZ.r.writes === 0 && rZ.builds === 0, JSON.stringify(rZ.r.stopped));
  // the same, but it IS this post's own Draft (importSource matches) with a stray photo: gallery check stops it
  const Z2 = [asTest(NONE[3])], lz2 = newLedger("Z2");
  await transport("POST", "/api/stories", Z2[0].record, { "x-defer-rebuild": "1" });
  await transport("POST", "/api/story-photos/" + Z2[0].record.id, { filename: "stray.jpg", data: "data:image/jpeg;base64," + fs.readFileSync(byPost[ONE[0]].images[0].file).toString("base64") }, { "x-defer-rebuild": "1" });
  const rZ2 = await counted(() => run({ items: Z2, transport, ledger: lz2, defer: true, batchId: "Z2", approved: approve(Z2) }));
  check("3", "own zero-photo Draft that already holds a photo: stops at the gallery check, nothing uploaded, no build", rZ2.r.stopped && rZ2.r.stopped.step === "gallery check" && /approved without photos/.test(rZ2.r.stopped.error) && rZ2.r.writes === 0 && rZ2.builds === 0, JSON.stringify(rZ2.r.stopped));
  // a photo appears between the gallery check and the read-back (an editor uploading at that moment): verify stops it
  const Z3 = [asTest(TEXT_ONLY[2])], lz3 = newLedger("Z3");
  let injected = false;
  const racy = async (m, p, b, h) => { const r = await transport(m, p, b, h); if (!injected && m === "GET" && p === "/api/story-photos/" + Z3[0].record.id) { injected = true; await transport("POST", p, { filename: "editor.jpg", data: "data:image/jpeg;base64," + fs.readFileSync(byPost[ONE[0]].images[0].file).toString("base64") }); } return r; };
  const rZ3 = await counted(() => run({ items: Z3, transport: racy, ledger: lz3, defer: true, batchId: "Z3", approved: approve(Z3) }));
  check("3", "a photo that appears on a zero-photo Draft before read-back fails verification; no closing build", rZ3.r.stopped && rZ3.r.stopped.step === "verify" && /photos\/order differ/.test(rZ3.r.stopped.error) && !rZ3.r.finalBuild.sent && !lz3.batchBuilt("Z3"), JSON.stringify(rZ3.r.stopped));
  S("3_negative", { otherDraft: rZ.r.stopped, ownDraftWithStrayPhoto: rZ2.r.stopped, photoAppearsBeforeReadBack: rZ3.r.stopped });

  /* ===== 6: interruptions on zero-photo and multi-photo posts, then resume ===== */
  const B = [TEXT_ONLY[3], MULTI[2], NONE[2] === Z[0].postId ? TEXT_ONLY[4] : NONE[2], ONE[2]].map(asTest), lb = newLedger("B");
  fault.create = r => r.id === B[0].record.id;                                                     // zero-photo create fails
  const B1 = await counted(() => run({ items: B, transport, ledger: lb, defer: true, batchId: "B", approved: approve(B) }));
  fault.create = null;
  check("6", "create failure on a zero-photo post: batch stops at once, no build", B1.r.stopped && B1.r.stopped.postId === B[0].postId && B1.r.stopped.step === "create" && B1.builds === 0, JSON.stringify(B1.r.stopped));
  let seen = 0; fault.upload = p => p.startsWith("story-" + B[1].record.id + "/") && ++seen === 3;        // multi-photo: photo 3 fails
  const B2 = await counted(() => run({ items: B, transport, ledger: lb, defer: true, batchId: "B", approved: approve(B) }));
  fault.upload = null;
  check("6", "resume, then an upload failure at photo 3 of a multi-photo post: stops, no build", B2.r.stopped && B2.r.stopped.postId === B[1].postId && B2.r.stopped.step === "photo 3" && B2.builds === 0, JSON.stringify(B2.r.stopped));
  let drop = (m, p) => m === "POST" && p === "/api/stories" ; let dropped = 0;
  const lossy = async (m, p, b, h) => { const r = await transport(m, p, b, h); if (drop && drop(m, p) && b && b.id === B[2].record.id) { drop = null; dropped++; throw new Error("connection reset (response lost)"); } return r; };
  const B3 = await counted(() => run({ items: B, transport: lossy, ledger: lb, defer: true, batchId: "B", approved: approve(B) }));
  check("6", "resume continues photo 3 onward; then the create answer of a zero-photo post is lost: stops, no build", dropped === 1 && B3.r.stopped && B3.r.stopped.postId === B[2].postId && B3.builds === 0 && B3.r.posts.find(p => p.postId === B[1].postId).photosUploaded === B[1].images.length - 2, JSON.stringify({ s: B3.r.stopped, p: B3.r.posts }));
  const B4 = await counted(() => run({ items: B, transport, ledger: lb, defer: true, batchId: "B", approved: approve(B) }));
  check("6", "final resume adopts the zero-photo post's own Draft and completes with exactly 1 build", !B4.r.stopped && B4.builds === 1 && lb.read().some(e => e.step === "created" && e.adopted && e.postId === B[2].postId), JSON.stringify(B4.r.stopped));
  check("6", "after 3 interruptions: every story id exists once, every photo once in order, zero-photo posts never uploaded", B.every(b => readStories().filter(s => s.id === b.record.id).length === 1) && !verifyStored(B).length && [B[0], B[2]].every(x => uploadsTo(calls, x.record.id) === 0), verifyStored(B).join(","));
  S("6_resume", { createFailure: B1.r.stopped, uploadFailure: B2.r.stopped, lostCreateAnswer: B3.r.stopped, final: B4.r.posts.map(p => p.postId + ":" + p.result + (p.photosUploaded != null ? " (" + p.photosUploaded + " uploaded)" : "")), builds: [B1.builds, B2.builds, B3.builds, B4.builds] });

  /* ===== 7: missing or failed photos stop the batch safely ===== */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hl-nophoto-img-"));
  const copyImgs = it => Object.assign({}, it, { images: it.images.map(im => { const f = path.join(tmp, it.postId + "-" + path.basename(im.file)); fs.copyFileSync(im.file, f); return Object.assign({}, im, { file: f }); }) });
  const C = [asTest(TEXT_ONLY[5]), copyImgs(asTest(ONE[3])), copyImgs(asTest(MULTI[3]))];
  const approvedC = approve(C);
  fs.unlinkSync(C[2].images[1].file);
  const C1 = await counted(() => run({ items: C, transport, ledger: newLedger("C1"), defer: true, batchId: "C1", approved: approvedC }));
  check("7", "a photo file missing on disk stops the whole batch before any write (the zero-photo post is not created either)", C1.r.stopped && C1.r.stopped.step === "preflight" && /photo 2 missing on disk/.test(C1.r.stopped.error) && C1.r.writes === 0 && C1.builds === 0 && !readStories().some(s => C.some(c => c.record.id === s.id)), JSON.stringify(C1.r.stopped));
  fs.copyFileSync(byPost[MULTI[3]].images[1].file, C[2].images[1].file);
  fs.appendFileSync(C[1].images[0].file, Buffer.from([0]));
  const C2 = await counted(() => run({ items: C, transport, ledger: newLedger("C2"), defer: true, batchId: "C2", approved: approvedC }));
  check("7", "a photo changed on disk after approval stops the batch before any write", C2.r.stopped && /changed on disk/.test(C2.r.stopped.error) && C2.r.writes === 0 && C2.builds === 0, JSON.stringify(C2.r.stopped));
  const lostPhotos = Object.assign({}, asTest(ONE[3]), { images: [] });
  const C3 = await counted(() => run({ items: [lostPhotos], transport, ledger: newLedger("C3"), defer: true, batchId: "C3", approved: approve([lostPhotos]) }));
  check("7", "a photo post whose photo list came through empty (and is not approved as photoMode 'none') stops before any write", C3.r.stopped && /approved with photos but none listed/.test(C3.r.stopped.error) && C3.r.writes === 0 && C3.builds === 0, JSON.stringify(C3.r.stopped));
  const undecided = Object.assign({}, asTest(NONE[0]), { photoMode: undefined });
  const C4 = await counted(() => run({ items: [undecided], transport, ledger: newLedger("C4"), defer: true, batchId: "C4", approved: approve([undecided]) }));
  check("7", "an empty photo list without a declared photoMode stops before any write", C4.r.stopped && /photoMode missing/.test(C4.r.stopped.error) && C4.r.writes === 0, JSON.stringify(C4.r.stopped));
  const undeclared = Object.assign({}, asTest(ONE[3]), { photoMode: undefined });
  const C4b = await counted(() => run({ items: [undeclared], transport, ledger: newLedger("C4b"), defer: true, batchId: "C4b", approved: approve([undeclared]) }));
  check("1,7", "a photo post that does not declare photoMode fails closed before any write", C4b.r.stopped && /photoMode missing/.test(C4b.r.stopped.error) && C4b.r.writes === 0 && C4b.builds === 0, JSON.stringify(C4b.r.stopped));
  const invalid = Object.assign({}, asTest(NONE[1]), { photoMode: "None" });
  const C4c = await counted(() => run({ items: [invalid], transport, ledger: newLedger("C4c"), defer: true, batchId: "C4c", approved: approve([invalid]) }));
  check("1,7", "an invalid photoMode (\"None\") fails closed before any write", C4c.r.stopped && /invalid photoMode "None"/.test(C4c.r.stopped.error) && C4c.r.writes === 0, JSON.stringify(C4c.r.stopped));
  const noReader = [asTest(ONE[3])];
  const C4dSnap = await takeSnapshot();
  const C4d = await counted(() => runBatch({ items: noReader, transport, ledger: newLedger("C4d"), defer: true, batchId: "C4d", approved: approve(noReader), snapshot: C4dSnap }));
  check("7", "a batch with photos but no way to read back stored bytes fails closed before any write", C4d.r.stopped && /no storedPhotoDigest/.test(C4d.r.stopped.error) && C4d.r.writes === 0, JSON.stringify(C4d.r.stopped));
  const Cx = [asTest(TEXT_ONLY[5]), asTest(MULTI[3])];
  const corruptKey = "story-" + Cx[1].record.id + "/" + storedName(uploadName(Cx[1].images[1].file));
  fault.corrupt = p => p === corruptKey;
  const C7 = await counted(() => run({ items: Cx, transport, ledger: newLedger("C7"), defer: true, batchId: "C7", approved: approve(Cx) }));
  fault.corrupt = null;
  check("7", "stored bytes that differ from the approved file (photo 2) fail verification; no build", C7.r.stopped && C7.r.stopped.step === "verify" && /photo 2 stored bytes differ/.test(C7.r.stopped.error) && C7.builds === 0 && !C7.r.finalBuild.sent, JSON.stringify(C7.r.stopped));
  const switched = Object.assign({}, asTest(ONE[3]), { photoMode: "none", images: [] });
  const C5 = await counted(() => run({ items: [switched], transport, ledger: newLedger("C5"), defer: true, batchId: "C5", approved: approve([asTest(ONE[3])]) }));
  check("7", "a photo post quietly switched to 'no photos' after approval fails the approval fingerprint", C5.r.stopped && /does not match its approved manifest entry/.test(C5.r.stopped.error) && C5.r.writes === 0, JSON.stringify(C5.r.stopped));
  const C6items = [asTest(TEXT_ONLY[5]), asTest(ONE[3])];
  fault.upload = p => p.startsWith("story-" + C6items[1].record.id + "/");
  const C6 = await counted(() => run({ items: C6items, transport, ledger: newLedger("C6"), defer: true, batchId: "C6", approved: approve(C6items) }));
  fault.upload = null;
  const gC6 = (await transport("GET", "/api/story-photos/" + C6items[1].record.id)).body;
  check("7", "a failed photo upload (storage error) stops the batch, leaves no gallery entry, sends no build", C6.r.stopped && C6.r.stopped.step === "photo 1" && !gC6.items.length && C6.builds === 0 && !C6.r.finalBuild.sent, JSON.stringify(C6.r.stopped));
  S("7_photo_failures", { missingFile: C1.r.stopped, changedFile: C2.r.stopped, emptyListForPhotoPost: C3.r.stopped, undeclaredEmpty: C4.r.stopped, undeclaredWithPhotos: C4b.r.stopped, invalidMode: C4c.r.stopped, noStoredReader: C4d.r.stopped, storedBytesDiffer: C7.r.stopped, switchedAfterApproval: C5.r.stopped, uploadFails: C6.r.stopped });

  /* ===== 8: the closing build request itself fails ===== */
  const G = [asTest(TEXT_ONLY[4] === B[2].postId ? NONE[1] : TEXT_ONLY[4])], lg = newLedger("G");
  hookFailNext = 1;
  const G1 = await counted(() => run({ items: G, transport, ledger: lg, defer: true, batchId: "G", approved: approve(G) }));
  const builtAfterG1 = lg.batchBuilt("G");
  const G2 = await counted(() => run({ items: G, transport, ledger: lg, defer: true, batchId: "G", approved: approve(G) }));
  check("8", "a failed closing build is reported and not recorded; the re-run sends it once with no writes", G1.r.stopped && G1.r.stopped.step === "final build" && !builtAfterG1 && G2.r.writes === 0 && G2.builds === 1 && lg.batchBuilt("G"), JSON.stringify({ g1: G1.r.stopped, w: G2.r.writes, b: G2.builds }));
  check("8", "no stopped batch in this test ever sent a build (Z3's one build is the simulated editor's own upload)", [rZ, rZ2, B1, B2, B3, C1, C2, C3, C4, C4b, C4c, C4d, C5, C6, C7].every(x => x.builds === 0) && !rZ3.r.finalBuild.sent);

  /* ===== H: hardening - protected ids, occupancy, deferred mode, read-back status, stored fields, credentials ===== */
  const H = { "x-defer-rebuild": "1" };
  const touches = (cs, id) => cs.filter(([, p]) => p === "/api/stories/" + id || p === "/api/story-photos/" + id).length;
  const protectedState = () => JSON.stringify(readStories().filter(s => PROTECTED_IDS.includes(s.id))) + JSON.stringify(Object.entries(readGalleries()).filter(([k]) => PROTECTED_IDS.includes(Number(k.replace("story-", "")))));
  const protectedBefore = protectedState();
  const hp = [];
  for (const id of [303, 304, 305, 388, 396, 403, 404]) {
    for (const postId of [ONE[0], NONE[0]]) {
      const x = asTest(postId); x.record.id = id;
      const r = await counted(() => run({ items: [x], transport, ledger: newLedger("H" + id + postId), defer: true, batchId: "H" + id + postId, approved: approve([x]) }));
      hp.push({ id, postId, stopped: r.r.stopped && r.r.stopped.step, ok: !!(r.r.stopped && r.r.stopped.step === "preflight" && /protected existing memory/.test(r.r.stopped.error) && r.r.writes === 0 && r.builds === 0 && touches(r.calls, id) === 0) });
    }
  }
  check("C3", "every protected id (303, 304, 305, 388, 396, 403, 404) is refused before any request, for a photo post and a zero-photo post", hp.every(x => x.ok), JSON.stringify(hp.filter(x => !x.ok)));
  // adopt / attach photos to the No. 404 stand-in: an item claiming to be P003's import Draft, with photos
  const pilot = asTest(ONE[1]); pilot.postId = "P003"; pilot.record.id = 404; pilot.record.importSource = Object.assign({}, pilot.record.importSource, { postId: "P003" });
  const rp = await counted(() => run({ items: [pilot], transport, ledger: newLedger("Hpilot"), defer: true, batchId: "Hpilot", approved: approve([pilot]) }));
  check("C3", "adopting No. 404 as 'this post's own import Draft' and attaching photos to it is refused before any request", rp.r.stopped && rp.r.stopped.step === "preflight" && /protected existing memory/.test(rp.r.stopped.error) && rp.r.writes === 0 && touches(rp.calls, 404) === 0, JSON.stringify(rp.r.stopped));
  // an edited ledger that claims a protected id as created and verified changes nothing
  const forged = asTest(NONE[1]); forged.record.id = 403;
  const lf403 = newLedger("Hforged"); lf403.append({ batchId: "Hforged", postId: forged.postId, step: "created", storyId: 403 }); lf403.append({ batchId: "Hforged", postId: forged.postId, step: "verified", storyId: 403 });
  const rf = await counted(() => run({ items: [forged], transport, ledger: lf403, defer: true, batchId: "Hforged", approved: approve([forged]) }));
  check("C3", "a ledger edited to claim No. 403 as created and verified does not let the batch use or skip it", rf.r.stopped && /protected existing memory/.test(rf.r.stopped.error) && rf.r.writes === 0 && rf.builds === 0, JSON.stringify(rf.r.stopped));
  // ids occupied in the fresh snapshot by memories that are not this post's own import Draft
  const plain = (id, extra) => Object.assign({}, byPost[ONE[0]].record, { id, title: "TEST " + id }, extra || {});
  await transport("POST", "/api/stories", Object.assign(plain(9450, { status: "published" }), { importSource: undefined }), H);
  await transport("POST", "/api/stories", Object.assign(plain(9451), { importSource: undefined }), H);
  await transport("POST", "/api/stories", plain(9452, { importSource: { system: IMPORT_SYSTEM, postId: "P999", facebookUrl: null, facebookTimeChicago: null } }), H);
  await transport("POST", "/api/story-photos/9450", { filename: "existing.jpg", data: "data:image/jpeg;base64," + fs.readFileSync(byPost[ONE[0]].images[0].file).toString("base64") }, H);
  const occ = [];
  for (const [id, what] of [[9450, "a published memory with a photo"], [9451, "an editor's Draft"], [9452, "another post's import Draft"], [304, "existing No. 304 with photos"]]) {
    const x = asTest(ONE[2]); x.record.id = id;
    const g0 = JSON.stringify(readGalleries()["story-" + id] || null), s0 = JSON.stringify(readStories().find(s => s.id === id));
    const r = await counted(() => run({ items: [x], transport, ledger: newLedger("Hocc" + id), defer: true, batchId: "Hocc" + id, approved: approve([x]) }));
    occ.push({ id, what, ok: !!(r.r.stopped && r.r.stopped.step === "preflight" && /occupied|protected/.test(r.r.stopped.error) && r.r.writes === 0 && r.builds === 0 && touches(r.calls, id) === 0 && g0 === JSON.stringify(readGalleries()["story-" + id] || null) && s0 === JSON.stringify(readStories().find(s => s.id === id))) });
  }
  check("C3", "ids occupied in the fresh snapshot (published, editor Draft, another post's import Draft, No. 304) are refused; nothing about them changes", occ.every(x => x.ok), JSON.stringify(occ.filter(x => !x.ok)));
  const dup409 = await counted(() => transport("POST", "/api/stories", plain(9450), H));
  check("C3", "the API-side guard is intact: creating an existing id answers 409, no build", dup409.r.status === 409 && dup409.builds === 0, dup409.r.status);
  const snapless = [asTest(NONE[2])];
  const rs1 = await counted(() => runBatch({ items: snapless, transport, ledger: newLedger("Hs1"), defer: true, batchId: "Hs1", approved: approve(snapless), storedPhotoDigest }));
  const rs2 = await counted(() => runBatch({ items: snapless, transport, ledger: newLedger("Hs2"), defer: true, batchId: "Hs2", approved: approve(snapless), storedPhotoDigest, snapshot: { takenAt: new Date(Date.now() - 7 * 3600e3).toISOString(), memories: [] } }));
  check("C3", "no snapshot, or a stale one (7 h), stops the batch before any request", rs1.r.stopped && /no fresh read-only snapshot/.test(rs1.r.stopped.error) && rs2.r.stopped && /not fresh/.test(rs2.r.stopped.error) && rs1.calls.length === 0 && rs2.calls.length === 0, JSON.stringify([rs1.r.stopped, rs2.r.stopped]));
  const smuggle = Object.assign(asTest(NONE[2]), { protectedIds: [], snapshot: { memories: [] } });
  const rsm = await counted(() => run({ items: [smuggle], transport, ledger: newLedger("Hsm"), defer: true, batchId: "Hsm", approved: {} }));
  check("C3", "a payload cannot carry its own protected-id list or snapshot (unknown fields are refused)", rsm.r.stopped && /unknown item field "protectedIds"/.test(rsm.r.stopped.error) && /unknown item field "snapshot"/.test(rsm.r.stopped.error) && rsm.r.writes === 0, JSON.stringify(rsm.r.stopped));
  check("C3", "protected memories and their galleries are byte-identical after every attempt", protectedState() === protectedBefore);

  // deferred mode is required
  const dm = [];
  for (const defer of [undefined, false]) {
    const x = [asTest(NONE[3])];
    const r = await counted(() => run(Object.assign({ items: x, transport, ledger: newLedger("Hd" + defer), batchId: "Hd" + defer, approved: approve(x) }, defer === undefined ? {} : { defer })));
    dm.push({ defer: String(defer), ok: !!(r.r.stopped && /deferred rebuild mode is required/.test(r.r.stopped.error) && r.r.writes === 0 && r.builds === 0 && !r.r.finalBuild.sent && r.calls.every(([m, p]) => m === "GET" && p === "/api/stories")) });
  }
  check("C4", "missing defer and defer:false both stop before any write; no build", dm.every(x => x.ok), JSON.stringify(dm));
  const okDefer = [asTest(NONE[3])];
  const rdo = await counted(() => run({ items: okDefer, transport, ledger: newLedger("Hdok"), defer: true, batchId: "Hdok", approved: approve(okDefer) }));
  check("C4", "the same post with defer:true completes with exactly one final build", !rdo.r.stopped && rdo.builds === 1 && rdo.r.finalBuild.sent, JSON.stringify(rdo.r.stopped));

  // read-back HTTP status and the stored record, field by field
  const rb = [];
  // opts: { digest(id,item), mutate(rec), transport }; each is undone after the run.
  const readBack = async (label, items, make, expect) => {
    const o = make(items[0].record.id, items);
    digestFault = o.digest || null; fault.mutate = o.mutate || null;
    const r = await counted(() => run({ items, transport: o.transport || transport, ledger: newLedger("Hrb" + label), defer: true, batchId: "Hrb" + label, approved: approve(items) }));
    digestFault = null; fault.mutate = null;
    rb.push({ label, error: r.r.stopped && r.r.stopped.error, ok: !!(r.r.stopped && r.r.stopped.step === "verify" && expect.test(r.r.stopped.error) && r.builds === 0 && !r.r.finalBuild.sent) });
  };
  const failNth = (p, n, status) => { let k = 0; return async (m, q, b, h) => (m === "GET" && q === p && ++k === n) ? { status, body: { error: "unavailable" } } : transport(m, q, b, h); };
  await readBack("digest500", [asTest(ONE[3])], id0 => ({ digest: id => id === id0 ? { status: 500, body: { error: "storage unavailable" } } : null }), /stored-bytes read-back answered HTTP 500/);
  await readBack("digest404", [asTest(ONE[3])], id0 => ({ digest: id => id === id0 ? { status: 404, body: {} } : null }), /stored-bytes read-back answered HTTP 404/);
  await readBack("digestOtherFile", [asTest(ONE[3])], (id0, items) => ({ digest: id => id === id0 ? { status: 200, body: { file: "other.jpg", sha256: items[0].images[0].sha256 } } : null }), /read-back is for another file/);
  await readBack("gallery503", [asTest(NONE[0])], id0 => ({ transport: failNth("/api/story-photos/" + id0, 2, 503) }), /gallery read-back answered HTTP 503/);
  await readBack("story500", [asTest(NONE[1])], id0 => ({ transport: failNth("/api/stories/" + id0, 2, 500) }), /story read-back answered HTTP 500/);
  await readBack("summaryTampered", [asTest(NONE[2])], id0 => ({ mutate: rec => rec.id === id0 ? Object.assign({}, rec, { summary: "changed in storage" }) : rec }), /summary differs/);
  await readBack("slugTampered", [asTest(NONE[3])], id0 => ({ mutate: rec => rec.id === id0 ? Object.assign({}, rec, { slug: "something-else" }) : rec }), /slug differs/);
  check("PART4", "read-back: non-200 photo digest, gallery or story answers, a digest for another file, and stored fields that differ all stop the batch; no build", rb.every(x => x.ok), JSON.stringify(rb.filter(x => !x.ok)));

  // the complete record is approved: a field changed after approval, or an unknown field, stops in preflight
  const ch = asTest(NONE[3]); const chApproved = approve([ch]); ch.record.summary = "edited after approval";
  const rch = await counted(() => run({ items: [ch], transport, ledger: newLedger("Hch"), defer: true, batchId: "Hch", approved: chApproved }));
  const uk = asTest(NONE[3]); uk.record.notAField = 1;
  const ruk = await counted(() => run({ items: [uk], transport, ledger: newLedger("Huk"), defer: true, batchId: "Huk", approved: {} }));
  check("C2", "a summary edited after approval, and an unknown record field, both stop before any write", rch.r.stopped && /does not match its approved manifest entry/.test(rch.r.stopped.error) && ruk.r.stopped && /unknown record field "notAField"/.test(ruk.r.stopped.error) && rch.r.writes === 0 && ruk.r.writes === 0, JSON.stringify([rch.r.stopped, ruk.r.stopped]));

  // credentials never reach the ledger or the result, even when a server error echoes one
  const sec = [asTest(NONE[0])], lsec = newLedger("Hsec");
  const echo = async (m, q, b, h) => (m === "POST" && q === "/api/stories") ? { status: 500, body: { error: "rejected token " + TOKEN + " x-admin-token: " + TOKEN } } : transport(m, q, b, h);
  const rsec = await counted(() => run({ items: sec, transport: echo, ledger: lsec, defer: true, batchId: "Hsec", approved: approve(sec), secrets: [TOKEN] }));
  check("PART4", "a server error that echoes the admin token never reaches the ledger or the result", rsec.r.stopped && !JSON.stringify(rsec.r).includes(TOKEN) && !fs.readFileSync(path.join(ledgerDir, "Hsec.jsonl"), "utf8").includes(TOKEN), JSON.stringify(rsec.r.stopped));
  S("H_hardening", { protectedIds: hp, occupied: occ, deferred: dm, readBack: rb });

  /* ===== 9: ordinary Admin saves and published-memory rebuilds (merged 3a327d8 behaviour) ===== */
  const D = { "x-defer-rebuild": "1" };
  const sample = byPost[ONE[0]];
  const img = n => ({ filename: "editor" + n + ".jpg", data: "data:image/jpeg;base64," + fs.readFileSync(sample.images[0].file).toString("base64") });
  const rec = (id, extra) => Object.assign({}, sample.record, { id, title: "TEST " + id, importSource: undefined }, extra || {});
  const cases = [
    ["Editorial Workspace: create Draft (no header)", () => transport("POST", "/api/stories", rec(9401)), 1, 201],
    ["Editorial Workspace: edit Draft", () => transport("PUT", "/api/stories/9401", rec(9401, { title: "TEST 9401 edited" })), 1, 200],
    ["Editorial Workspace: upload photo to Draft", () => transport("POST", "/api/story-photos/9401", img(1)), 1, 201],
    ["Editorial Workspace: reorder Draft gallery", () => transport("PUT", "/api/story-photos/9401", { items: [] }), 1, 200],
    ["Editorial Workspace: delete Draft", () => transport("DELETE", "/api/stories/9401"), 1, 200],
    ["create PUBLISHED, even with the defer header", () => transport("POST", "/api/stories", rec(9411, { status: "published" }), D), 1, 201],
    ["edit published, with header", () => transport("PUT", "/api/stories/9411", rec(9411, { status: "published", title: "TEST 9411 e" }), D), 1, 200],
    ["upload photo to published, with header", () => transport("POST", "/api/story-photos/9411", img(2), D), 1, 201],
    ["edit published, no header", () => transport("PUT", "/api/stories/9411", rec(9411, { status: "published", title: "TEST 9411 e2" })), 1, 200],
    ["publish a Draft, with header", async () => { await transport("POST", "/api/stories", rec(9412), D); return transport("PUT", "/api/stories/9412", rec(9412, { status: "published" }), D); }, 1, 200],
    ["un-publish (published -> Draft), with header", () => transport("PUT", "/api/stories/9411", rec(9411), D), 1, 200],
    ["no token (refused)", () => transport("POST", "/api/stories", rec(9421), D, { token: "" }), 0, 401],
    ["Coming Soon -> Draft, with header (it leaves the site, so it rebuilds)", () => transport("PUT", "/api/stories/9431", rec(9431), D), 1, 200],
    ["edit Coming Soon, with header", () => transport("PUT", "/api/stories/9432", rec(9432, { status: "coming-soon", title: "TEST 9432 e" }), D), 1, 200],
    ["upload photo to Coming Soon, with header", () => transport("POST", "/api/story-photos/9432", img(3), D), 1, 201],
    ["Draft -> Coming Soon, with header", () => transport("PUT", "/api/stories/9433", rec(9433, { status: "coming-soon" }), D), 1, 200]
  ];
  // Coming Soon set-up happens before the counted cases (its own saves rebuild, as they always have).
  await transport("POST", "/api/stories", rec(9431, { status: "coming-soon" }));
  await transport("POST", "/api/stories", rec(9432, { status: "coming-soon" }));
  await transport("POST", "/api/stories", rec(9433), D);
  const rows = [];
  for (const [name, fn, eb, es] of cases) { const c = await counted(fn); rows.push({ name, status: c.r.status, builds: c.builds }); check("9", name + " -> " + eb + " build(s), HTTP " + es, c.builds === eb && c.r.status === es, c.r.status + " / " + c.builds); }
  S("9_admin_saves", rows);

  /* ===== existing memories untouched ===== */
  const after = readStories();
  check("existing", "every memory that existed before the test is byte-identical", JSON.stringify(after.filter(s => s.id < 9000)) === JSON.stringify(before));
  const gAfter = readGalleries();
  check("existing", "every pre-existing gallery is unchanged", JSON.stringify(Object.fromEntries(Object.entries(gAfter).filter(([k]) => !/^story-9[34]\d\d$/.test(k)))) === galleriesBefore);
  check("existing", "no imported memory was published or featured by the importer", after.filter(s => s.importSource && s.id >= 9300 && s.id < 9400).every(s => s.status === "draft" && !s.featured));
  return finish();
}

function finish() {
  report.finished = new Date().toISOString();
  report.passed = report.checks.length > 0 && report.checks.every(c => c.ok);
  report.totalProductionBuildsCounted = hooks.length;
  fs.writeFileSync(outFile, JSON.stringify(report, null, 1));
  console.log((report.passed ? "PASS" : "FAIL") + ": " + report.checks.filter(c => c.ok).length + "/" + report.checks.length + " checks");
  hookServer.close(); apiServer.close();
  process.exitCode = report.passed ? 0 : 1;
}
main().catch(e => { console.error(e); report.error = String(e.stack || e); finish(); process.exitCode = 1; });
