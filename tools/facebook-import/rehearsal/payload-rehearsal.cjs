/* Rehearses an import-ready batch payload, unchanged, against a throwaway worktree of 3a327d8 in FILE
   mode (local HTTP server, stubbed storage and deploy hook, random token). Never touches production.
     node payload-rehearsal.cjs <checkout> <batch-NN-import-payload.json> <out.json> */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const [dir, payloadFile, outFile] = process.argv.slice(2).map(v => path.resolve(v));
const { runBatch, uploadName, storedName } = require("../lib/batch.js");
const { Ledger } = require("../lib/ledger.js");
for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HL_DATA_DIR", "HARLAN_NARRATION_PUBLISH_GATE", "HARLAN_ENV_FILE", "HL_ADMIN_TOKEN"]) delete process.env[k];
const TOKEN = crypto.randomBytes(16).toString("hex");
process.env.ADMIN_TOKEN = TOKEN;
process.on("exit", () => { delete process.env.ADMIN_TOKEN; delete process.env.HL_ADMIN_TOKEN; });
const store = require(path.join(dir, "lib", "store.js"));
if (store.USE_SUPABASE) throw new Error("must run in file mode");
store.uploadObject = async (bucket, objPath, buf) => { const d = path.join(dir, bucket, objPath); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.writeFileSync(d, buf); };
const hooks = [];
const hookServer = http.createServer((req, res) => { if (req.method === "POST") hooks.push(Date.now()); res.end("ok"); });
const handler = require(path.join(dir, "api", "[...path].js"));
const apiServer = http.createServer((req, res) => handler(req, res));
let base; const calls = [];
async function transport(method, p, body, headers) {
  calls.push([method, p]);
  const r = await fetch(base + p, { method, headers: Object.assign({ "content-type": "application/json", "x-admin-token": TOKEN }, headers || {}), body: method === "GET" ? undefined : JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail == null ? "" : String(detail) }); if (!ok) console.error("FAIL " + name + " " + (detail || "")); };

(async () => {
  await new Promise(r => hookServer.listen(0, "127.0.0.1", r));
  await new Promise(r => apiServer.listen(0, "127.0.0.1", r));
  process.env.VERCEL_DEPLOY_HOOK_URL = "http://127.0.0.1:" + hookServer.address().port + "/hook";
  base = "http://127.0.0.1:" + apiServer.address().port;
  const P = JSON.parse(fs.readFileSync(payloadFile, "utf8"));
  const before = JSON.parse(fs.readFileSync(path.join(dir, "data", "stories.json"), "utf8"));
  const clash = P.items.filter(it => before.some(s => s.id === it.record.id));
  check("the payload's provisional ids are free in the rehearsal data", !clash.length, clash.map(c => c.record.id).join(","));
  const ledger = new Ledger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hl-rehearsal-")), "ledger.jsonl"));
  const storedPhotoDigest = async (id, item) => { const f = path.join(dir, store.BUCKET_STORY, "story-" + id, item.file); if (!fs.existsSync(f)) return { status: 404, body: {} }; const b = fs.readFileSync(f); return { status: 200, body: { storyId: id, file: item.file, bytes: b.length, sha256: sha(f) } }; };
  const snap = await transport("GET", "/api/stories");
  const snapshot = { takenAt: new Date().toISOString(), source: "GET /api/stories (rehearsal API)", memories: snap.body.map(s => ({ id: s.id, status: s.status, featured: !!s.featured, importSource: s.importSource || null })) };
  const r = await runBatch({ items: P.items, transport, ledger, storedPhotoDigest, snapshot, defer: true, batchId: "batch-" + P.batch + "-rehearsal", approved: P.approvedFingerprints });
  check("all " + P.items.length + " posts created and verified, in the approved order", !r.stopped && r.posts.map(p => p.postId).join(" ") === P.items.map(i => i.postId).join(" ") && r.posts.every(p => p.result === "verified"), JSON.stringify(r.stopped));
  check("writes = " + P.items.length + " creates + " + P.counts.photos + " photo uploads", r.writes === P.items.length + P.counts.photos, r.writes);
  check("exactly one build, after every post verified", hooks.length === 1 && r.finalBuild.sent && ledger.batchBuilt("batch-" + P.batch + "-rehearsal"), hooks.length);
  const St = JSON.parse(fs.readFileSync(path.join(dir, "data", "stories.json"), "utf8"));
  const Gf = path.join(dir, "data", "story-photos.json"), Gl = fs.existsSync(Gf) ? JSON.parse(fs.readFileSync(Gf, "utf8")) : {};
  const rows = [];
  for (const it of P.items) {
    const s = St.find(x => x.id === it.record.id), g = Gl["story-" + it.record.id] || { primary: null, items: [] };
    const files = g.items.map(x => x.file), want = it.images.map(im => storedName(uploadName(im.file)));
    const bytesOk = it.images.every((im, i) => g.items[i] && sha(path.join(dir, "story-photos", "story-" + it.record.id, g.items[i].file)) === im.sha256);
    const ups = calls.filter(([m, p]) => m === "POST" && p === "/api/story-photos/" + it.record.id).length;
    const ok = s && s.status === "draft" && !s.featured && s.title === it.record.title && s.lead === it.record.lead && JSON.stringify(s.body) === JSON.stringify(it.record.body) && s.importSource.postId === it.postId
      && JSON.stringify(files) === JSON.stringify(want) && bytesOk && (want.length ? g.primary === g.items[0].id : g.primary == null) && ups === it.images.length;
    rows.push({ postId: it.postId, storyId: it.record.id, photoMode: it.photoMode, photos: files.length, primary: g.primary, uploads: ups, ok: !!ok });
  }
  check("every record, photo (order, bytes) and Primary matches the payload; zero-photo posts sent no upload", rows.every(x => x.ok), rows.filter(x => !x.ok).map(x => x.postId).join(","));
  check("P098 import text has no hashtag-only line", !P.items.find(i => i.postId === "P098").record.body.some(t => /^\s*(#\S+\s*)+$/.test(t)));
  check("pre-existing memories untouched", JSON.stringify(St.filter(s => !P.items.some(i => i.record.id === s.id))) === JSON.stringify(before));
  const out = { payload: path.basename(payloadFile), commit: execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim(), apiDiff: execFileSync("git", ["-C", dir, "diff", "--stat", "--", "api", "lib"]).toString().trim() || "(none)", rows, checks, passed: checks.every(c => c.ok) };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  console.log((out.passed ? "PASS" : "FAIL") + ": " + checks.filter(c => c.ok).length + "/" + checks.length + " checks");
  hookServer.close(); apiServer.close(); process.exitCode = out.passed ? 0 : 1;
})().catch(e => { console.error(e); process.exitCode = 1; hookServer.close(); apiServer.close(); });
