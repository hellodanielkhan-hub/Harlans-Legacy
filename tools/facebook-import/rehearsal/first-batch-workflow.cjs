/* First-batch Production workflow, rehearsed end to end in isolation. Never touches production:
   no Supabase, no network beyond 127.0.0.1, random throwaway tokens.

     node first-batch-workflow.cjs <checkoutA> <checkoutB> <checkoutC> <batch-NN-import-payload.json> <out.json>

   Each <checkout> is a separate throwaway git worktree of the commit under test. Its real api/[...path].js
   (header-only auth, the admin-only stored-photo routes) runs in FILE mode on 127.0.0.1. Stubs: Supabase
   Storage writes (store.uploadObject writes under <checkout>/story-photos/, where the file backend's
   readObject reads them) and the Vercel deploy hook (a local counter). Protected ids missing from the
   repo data (388-404) are seeded as fictional "STAND-IN" records. The payload's photos are only read.

   A: authentication, the stored-photo routes, the transport allow-list, id allocation
   B: snapshot + backup integrity, the authorization gate, the full batch through lib/run.js
   C: interruption, partial failure and resume through lib/run.js */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const [dirA, dirB, dirC, payloadFile, outFile] = process.argv.slice(2).map(v => path.resolve(v));
for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HL_DATA_DIR", "HARLAN_NARRATION_PUBLISH_GATE", "HARLAN_ENV_FILE", "HL_ADMIN_TOKEN"]) delete process.env[k];
const TOKEN = crypto.randomBytes(16).toString("hex"), MOD = crypto.randomBytes(16).toString("hex");
process.env.ADMIN_TOKEN = TOKEN;
process.env.HARLAN_MODERATORS = JSON.stringify({ [MOD]: { id: "mod1", name: "Test Moderator" } });
process.on("exit", () => { delete process.env.ADMIN_TOKEN; delete process.env.HARLAN_MODERATORS; });

const { IMPORT_SYSTEM, PROTECTED_IDS, uploadName, storedName } = require("../lib/batch.js");
// The rehearsals talk to isolated loopback copies through the rehearsal-only transport; the live transport
// (createLiveTransport) only ever accepts https://www.harlanslegacy.com and is used here only to prove that.
const { createLiveTransport, createRehearsalTransport } = require("../lib/transport.js");
const connectTo = (base, fetch) => ({ origin: new URL(base).origin, open: token => createRehearsalTransport({ base, token, fetch }) });
const snap = require("../lib/snapshot.js");
const { runProduction } = require("../lib/run.js");
const { payloadFingerprint, batchIdOf, confirmPhrase } = require("../lib/authorize.js");
const { Ledger } = require("../lib/ledger.js");

const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const report = { commit: execFileSync("git", ["-C", dirB, "rev-parse", "HEAD"]).toString().trim(), started: new Date().toISOString(), checks: [], phases: {} };
const check = (phase, name, ok, detail) => { report.checks.push({ phase, name, ok: !!ok, detail: detail == null ? "" : String(detail).slice(0, 600) }); console.log((ok ? "PASS " : "FAIL ") + "[" + phase + "] " + name + (ok || detail == null ? "" : " :: " + String(detail).slice(0, 300))); };

/* ---- deploy hook counter ---- */
const hooks = [];
const hookServer = http.createServer((req, res) => { if (req.method === "POST") hooks.push(Date.now()); res.end("ok"); });

/* ---- one isolated site per checkout ---- */
const P = JSON.parse(fs.readFileSync(payloadFile, "utf8"));
const BATCH = batchIdOf(P), FP = payloadFingerprint(P), PHRASE = confirmPhrase(BATCH);
function seed(dir) {
  const records = require(path.join(dir, "lib", "records.js"));
  const f = path.join(dir, "data", "stories.json");
  const list = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const id of PROTECTED_IDS) if (!list.some(s => s.id === id)) {
    const r = records.normalize({ title: "STAND-IN " + id, status: id === 404 ? "draft" : "published", featured: false, publishedISO: "2026-01-0" + (id % 9 + 1), lead: "Fictional stand-in record " + id + " for an isolated rehearsal.", body: [] });
    r.id = id; list.push(r);
  }
  fs.writeFileSync(f, JSON.stringify(list, null, 2) + "\n");
  // a two-photo gallery on stand-in No. 403, so backups and protection cover stored originals
  const img = P.items.find(i => i.images.length).images[0].file;
  const gdir = path.join(dir, "story-photos", "story-403");
  fs.mkdirSync(gdir, { recursive: true });
  fs.copyFileSync(img, path.join(gdir, "standin-a.jpg"));
  fs.writeFileSync(path.join(gdir, "standin-b.jpg"), Buffer.concat([fs.readFileSync(img), Buffer.from("x")]));
  const mf = path.join(dir, "data", "story-photos.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  m["story-403"] = { primary: "standin-a", items: ["standin-a", "standin-b"].map(id => ({ id, file: id + ".jpg", caption: "", year: null, location: null, source: null, alt: null, focus: { x: 50, y: 50 }, url: "", portrait: [], full: [] })) };
  fs.writeFileSync(mf, JSON.stringify(m, null, 2) + "\n");
}
async function startSite(dir) {
  seed(dir);
  const store = require(path.join(dir, "lib", "store.js"));
  if (store.USE_SUPABASE) throw new Error("must run in file mode");
  const fault = { upload: null };
  store.uploadObject = async (bucket, objPath, buf) => {
    if (fault.upload && fault.upload(objPath)) throw new Error("simulated storage failure");
    const d = path.join(dir, bucket, objPath); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.writeFileSync(d, buf);
  };
  store.removeObject = async () => { throw new Error("removeObject must never be called in this rehearsal"); };
  const handler = require(path.join(dir, "api", "[...path].js"));
  const server = http.createServer((q, s) => handler(q, s));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const raw = (method, p, headers, body) => new Promise(resolve => {
    const r = http.request(base + p, { method, headers: Object.assign(body ? { "Content-Type": "application/json" } : {}, headers || {}) }, x => { const c = []; x.on("data", d => c.push(d)); x.on("end", () => { const b = Buffer.concat(c); let j = null; try { j = JSON.parse(b.toString()); } catch (e) {} resolve({ status: x.statusCode, headers: x.headers, bytes: b, body: j, text: b.toString() }); }); });
    r.on("error", e => resolve({ status: "ERR " + e.code })); if (body) r.write(JSON.stringify(body)); r.end();
  });
  const stories = () => JSON.parse(fs.readFileSync(path.join(dir, "data", "stories.json"), "utf8"));
  const galleries = () => JSON.parse(fs.readFileSync(path.join(dir, "data", "story-photos.json"), "utf8"));
  const stateHash = () => { const h = crypto.createHash("sha256"); for (const f of ["stories.json", "story-photos.json", "site.json", "entities.json", "photos.json"]) { const p = path.join(dir, "data", f); if (fs.existsSync(p)) h.update(fs.readFileSync(p)); } const walk = d => { if (!fs.existsSync(d)) return; for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else h.update(n).update(fs.readFileSync(p)); } }; walk(path.join(dir, "story-photos")); return h.digest("hex"); };
  return { dir, base, server, raw, store, fault, stories, galleries, stateHash };
}
// fetch wrapper: counts requests by method, can drop the connection after N POSTs
function counter(opts) {
  const c = { GET: 0, POST: 0, PUT: 0, DELETE: 0, other: 0, dropAfterPosts: (opts && opts.dropAfterPosts) || null, lost: [] };
  c.fetch = async (url, init) => {
    const m = (init && init.method) || "GET";
    if (m === "POST" && c.dropAfterPosts != null && c.POST >= c.dropAfterPosts) throw new Error("simulated network drop");
    c[m in c ? m : "other"]++;
    const r = await fetch(url, init);
    // the server handled the request, but the answer never arrives
    if (opts && opts.loseResponse && opts.loseResponse(m, String(url)) && !c.lost.length) { c.lost.push(m + " " + url); throw new Error("simulated lost response"); }
    return r;
  };
  return c;
}
const scriptedIo = (answers, opts) => { const a = answers.slice(); return { isTTY: !(opts && opts.notTTY), ask: async () => a.shift(), askHidden: async () => (opts && "token" in opts ? opts.token : TOKEN), print: () => {} }; };
const goodIo = () => scriptedIo([BATCH, FP, PHRASE]);

async function main() {
  await new Promise(r => hookServer.listen(0, "127.0.0.1", r));
  process.env.VERCEL_DEPLOY_HOOK_URL = "http://127.0.0.1:" + hookServer.address().port + "/hook";
  const A = await startSite(dirA), B = await startSite(dirB), C = await startSite(dirC);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hl-firstbatch-"));
  const ADM = { "x-admin-token": TOKEN }, MODH = { "x-moderator-token": MOD };

  /* ================= A1: header-only authentication ================= */
  {
    const r = [
      ["no credential -> 401", await A.raw("GET", "/api/stories"), 401],
      ["admin header -> 200", await A.raw("GET", "/api/stories", ADM), 200],
      ["moderator header -> 200", await A.raw("GET", "/api/stories", MODH), 200],
      ["wrong header -> 401", await A.raw("GET", "/api/stories", { "x-admin-token": "wrong" }), 401],
      ["?token=<admin> -> 400", await A.raw("GET", "/api/stories?token=" + TOKEN), 400],
      ["?token=<admin> WITH a valid header -> 400", await A.raw("GET", "/api/stories?token=" + TOKEN, ADM), 400],
      ["?access_token= -> 400", await A.raw("GET", "/api/stories?access_token=" + TOKEN), 400],
      ["?admin_token= on a write -> 400", await A.raw("POST", "/api/build?admin_token=" + TOKEN, {}), 400],
      ["?TOKEN= (case) -> 400", await A.raw("GET", "/api/stories?TOKEN=" + MOD), 400]
    ];
    for (const [n, x, want] of r) check("A1 auth", n, x.status === want, x.status);
    check("A1 auth", "no response body or header ever echoes a token", r.every(([, x]) => !x.text.includes(TOKEN) && !x.text.includes(MOD) && !JSON.stringify(x.headers).includes(TOKEN)));
  }

  /* ================= A2: admin-only stored-photo routes ================= */
  {
    const before = A.stateHash(), hooks0 = hooks.length;
    const f403 = path.join(A.dir, "story-photos", "story-403", "standin-a.jpg"), want = sha(fs.readFileSync(f403));
    const D = (p, h) => A.raw("GET", "/api/story-photos/403/" + p, h);
    const ok = await D("standin-a/digest", ADM);
    check("A2 digest", "admin: 200 with the SHA-256 of the stored bytes, file and size", ok.status === 200 && ok.body.sha256 === want && ok.body.file === "standin-a.jpg" && ok.body.bytes === fs.statSync(f403).size && ok.body.verification === "not-requested", JSON.stringify(ok.body));
    check("A2 digest", "no token -> 401", (await D("standin-a/digest")).status === 401);
    check("A2 digest", "moderator token -> 403 (admin only)", (await D("standin-a/digest", MODH)).status === 403);
    check("A2 digest", "?token= in the URL -> 400", (await A.raw("GET", "/api/story-photos/403/standin-a/digest?token=" + TOKEN)).status === 400);
    const m1 = await D("standin-a/digest?expect=" + want, ADM), m2 = await D("standin-a/digest?expect=" + "0".repeat(64), ADM), m3 = await D("standin-a/digest?expect=XYZ", ADM);
    check("A2 digest", "expect=<right hash> -> verification match", m1.status === 200 && m1.body.verification === "match");
    check("A2 digest", "expect=<wrong hash> -> verification mismatch (SHA-256 mismatch reported)", m2.status === 200 && m2.body.verification === "mismatch" && m2.body.sha256 === want);
    check("A2 digest", "malformed expect -> 400", m3.status === 400);
    const inv = [["/api/story-photos/abc/standin-a/digest", 400], ["/api/story-photos/99999/standin-a/digest", 404], ["/api/story-photos/403/nope/digest", 404],
      ["/api/story-photos/403/..%2F..%2F.env/digest", 404], ["/api/story-photos/403/%2e%2e%2fdata%2fstories.json/digest", 404], ["/api/story-photos/302/x/digest", 404]];
    const invR = []; for (const [p, w] of inv) { const x = await A.raw("GET", p, ADM); invR.push(p + "=" + x.status); if (x.status !== w) invR.push("!want " + w); }
    check("A2 digest", "invalid id 400; unknown story/photo and traversal attempts 404 (looked up in the manifest, never used as a path)", !invR.some(s => s.startsWith("!")), invR.join(" "));
    // unsafe file name in a manifest entry, and a missing stored object
    const mf = path.join(A.dir, "data", "story-photos.json"), m0 = fs.readFileSync(mf);
    const m = JSON.parse(m0); m["story-402"] = { primary: "evil", items: [{ id: "evil", file: "../../data/stories.json" }, { id: "gone", file: "gone.jpg" }] }; fs.writeFileSync(mf, JSON.stringify(m));
    const ev = await A.raw("GET", "/api/story-photos/402/evil/digest", ADM), ev2 = await A.raw("GET", "/api/story-photos/402/evil/original", ADM), gone = await A.raw("GET", "/api/story-photos/402/gone/digest", ADM);
    fs.writeFileSync(mf, m0);
    check("A2 digest", "a manifest file name with a path (../../data/stories.json) -> 400, nothing read", ev.status === 400 && ev2.status === 400 && !ev2.text.includes("STAND-IN"), ev.status + "/" + ev2.status);
    check("A2 digest", "stored object missing -> 404", gone.status === 404, gone.status);
    const o = await D("standin-a/original", ADM), oM = await D("standin-a/original", MODH), oN = await D("standin-a/original");
    check("A2 original", "admin: 200, exact bytes, X-Content-SHA256, no-store, attachment", o.status === 200 && sha(o.bytes) === want && o.headers["x-content-sha256"] === want && /no-store/.test(o.headers["cache-control"]) && /attachment/.test(o.headers["content-disposition"]));
    check("A2 original", "moderator 403, no token 401", oM.status === 403 && oN.status === 401);
    check("A2 routes", "read-only: data files and stored objects byte-identical, no rebuild", A.stateHash() === before && hooks.length === hooks0);
  }

  /* ================= A3: transport allow-list (nothing leaves the process) ================= */
  {
    const c = counter();
    const t = createRehearsalTransport({ base: A.base, token: TOKEN, fetch: c.fetch, allowIds: [9001] });
    const tries = [
      ["PUT an existing memory", () => t.transport("PUT", "/api/stories/304", { title: "x" })],
      ["DELETE a memory", () => t.transport("DELETE", "/api/stories/9001")],
      ["DELETE a photo", () => t.transport("DELETE", "/api/story-photos/403/standin-a")],
      ["POST a published story", () => t.transport("POST", "/api/stories", { id: 9001, status: "published", featured: false, importSource: { system: IMPORT_SYSTEM } }, { "x-defer-rebuild": "1" })],
      ["POST a featured Draft", () => t.transport("POST", "/api/stories", { id: 9001, status: "draft", featured: true, importSource: { system: IMPORT_SYSTEM } }, { "x-defer-rebuild": "1" })],
      ["POST an id not allocated to this run", () => t.transport("POST", "/api/stories", { id: 9002, status: "draft", featured: false, importSource: { system: IMPORT_SYSTEM } }, { "x-defer-rebuild": "1" })],
      ["POST without the deferred header", () => t.transport("POST", "/api/stories", { id: 9001, status: "draft", featured: false, importSource: { system: IMPORT_SYSTEM } })],
      ["POST a record without importSource", () => t.transport("POST", "/api/stories", { id: 9001, status: "draft", featured: false }, { "x-defer-rebuild": "1" })],
      ["upload a photo to protected No. 403", () => t.transport("POST", "/api/story-photos/403", { filename: "a.jpg", data: "x" }, { "x-defer-rebuild": "1" })],
      ["upload a photo to an id not created by this run", () => t.transport("POST", "/api/story-photos/305", { filename: "a.jpg", data: "x" }, { "x-defer-rebuild": "1" })],
      ["PUT a gallery (reorder/Primary of an existing memory)", () => t.transport("PUT", "/api/story-photos/305", { items: [] })],
      ["PUT site settings", () => t.transport("PUT", "/api/site", {})],
      ["POST narration", () => t.transport("POST", "/api/narration/304/generate", {})]
    ];
    const res = [];
    for (const [n, f] of tries) { try { await f(); res.push(n + ": SENT"); } catch (e) { res.push(n + ": " + (/transport refused/.test(e.message) ? "refused" : e.message)); } }
    check("A3 transport", "every non-import write is refused before any request (" + tries.length + " cases)", res.every(x => /: refused$/.test(x)) && c.POST + c.PUT + c.DELETE + c.GET === 0, res.join(" | "));
    const prot = PROTECTED_IDS.map(id => { const t2 = createRehearsalTransport({ base: A.base, token: TOKEN, fetch: c.fetch, allowIds: [id] }); return t2.transport("POST", "/api/stories", { id, status: "draft", featured: false, importSource: { system: IMPORT_SYSTEM } }, { "x-defer-rebuild": "1" }).then(() => "SENT " + id, e => /protected/.test(e.message) ? "refused" : e.message); });
    const pr = await Promise.all(prot);
    check("A3 transport", "a create at any protected id is refused even if allocated (303-305, 388-404)", pr.every(x => x === "refused") && c.POST === 0, pr.filter(x => x !== "refused").join(","));
    const b1 = await t.transport("POST", "/api/build", {}); let second; try { await t.transport("POST", "/api/build", {}); second = "SENT"; } catch (e) { second = "refused"; }
    check("A3 transport", "at most one build per run", b1.status === 200 && second === "refused");
    const bad = [];
    for (const base of ["http://example.com", "https://attacker.example", "https://www.harlanslegacy.com.attacker.example", "https://user:pw@www.harlanslegacy.com", "https://www.harlanslegacy.com/?token=x", "https://www.harlanslegacy.com/api", "https://www.harlanslegacy.com:8443", A.base]) { try { createLiveTransport({ base, token: TOKEN }); bad.push(base + " accepted"); } catch (e) { if (!/destination refused/.test(e.message)) bad.push(base + ": " + e.message); } }
    for (const base of ["https://www.harlanslegacy.com", "http://attacker.example"]) { try { createRehearsalTransport({ base, token: TOKEN }); bad.push("rehearsal transport accepted " + base); } catch (e) { } }
    check("A3 transport", "the live transport refuses every destination but the production origin (incl. this loopback copy); the rehearsal transport is loopback only", !bad.length, bad.join(", "));
    let leaked = ""; try { await createRehearsalTransport({ base: A.base, token: TOKEN, fetch: async () => { throw new Error("boom " + TOKEN + " x-admin-token: " + TOKEN); } }).transport("GET", "/api/stories"); } catch (e) { leaked = e.message; }
    check("A3 transport", "errors never carry the token", leaked && !leaked.includes(TOKEN), leaked);
    const t3 = createRehearsalTransport({ base: A.base, token: TOKEN }); t3.close(); let closed = ""; try { await t3.transport("GET", "/api/stories"); } catch (e) { closed = e.message; }
    check("A3 transport", "close() forgets the token", /closed/.test(closed) && !JSON.stringify(t3).includes(TOKEN));
    hooks.length = hooks.length;  // the one build above is A's own; B and C measure their own windows
  }

  /* ================= A4: collision-free id allocation ================= */
  {
    // occupy max+1 and max+3 with ordinary (non-import) records
    const s0 = await snap.takeSnapshot(createRehearsalTransport({ base: A.base, token: TOKEN }).transport);
    const max = s0.maxId;
    const list = A.stories(); for (const id of [max + 1, max + 3]) list.push({ id, title: "OCCUPIED " + id, status: "draft", featured: false });
    fs.writeFileSync(path.join(A.dir, "data", "stories.json"), JSON.stringify(list, null, 2));
    const t = createRehearsalTransport({ base: A.base, token: TOKEN });
    const s1 = await snap.takeSnapshot(t.transport);
    const items = P.items.slice(0, 5);
    const al = snap.allocateIds(items, s1, {});
    const ids = Object.values(al.ids);
    check("A4 ids", "fresh ids are above every occupied and protected id and skip occupied ones", ids.every(id => id > Math.max(max + 3, 404)) && !ids.includes(max + 1) && !ids.includes(max + 3) && new Set(ids).size === ids.length, ids.join(","));
    check("A4 ids", "the provisional ids 405-429 are not trusted: allocation starts after the highest id in the fresh snapshot", al.problems.length === 0 && ids[0] === max + 4 && JSON.stringify(ids) === JSON.stringify([max + 4, max + 5, max + 6, max + 7, max + 8]), ids.join(","));
    // a direct check catches an id taken after the snapshot
    const list2 = A.stories(); list2.push({ id: ids[2], title: "TAKEN AFTER SNAPSHOT", status: "draft", featured: false }); fs.writeFileSync(path.join(A.dir, "data", "stories.json"), JSON.stringify(list2, null, 2));
    const busy = await snap.confirmFree(t.transport, al.fresh);
    check("A4 ids", "an id occupied after the snapshot is caught by the direct 404 check", busy.length === 1 && busy[0].startsWith(String(ids[2])), busy.join(","));
    const led = { [items[0].postId]: { storyId: 304 } };
    check("A4 ids", "a ledger claiming a protected or foreign id is refused", snap.allocateIds(items, s1, led).problems.length === 1);
  }

  /* ================= B1: snapshot and backup ================= */
  const bkB = path.join(tmp, "backup-B");
  {
    const live = createRehearsalTransport({ base: B.base, token: TOKEN });
    const s = await snap.takeSnapshot(live.transport, live.base);
    const b = await snap.backup(live, s, bkB);
    const v = snap.verifyBackup(bkB);
    const photos = Object.values(B.galleries()).reduce((n, g) => n + (g.items || []).length, 0);
    check("B1 backup", "fresh read-only snapshot lists every memory, every protected id included", s.count === B.stories().length && PROTECTED_IDS.every(id => s.memories.some(m => m.id === id)), s.count);
    check("B1 backup", "backup has every record, the site documents and every stored photo; it verifies", v.ok && v.fresh && b.counts.memories === s.count && b.counts.photos === photos && b.counts.photos >= 4, JSON.stringify(b.counts) + " " + v.problems.join("; "));
    const man = JSON.parse(fs.readFileSync(path.join(bkB, "manifest.json"), "utf8"));
    const allPhotos = man.memories.flatMap(m => m.gallery.map(g => Object.assign({}, g, { storyId: m.id })));
    check("B1 backup", "every backed-up photo equals the stored original and the server-side digest", allPhotos.every(g => g.backupSha256 === g.serverSha256 && g.backupSha256 === sha(fs.readFileSync(path.join(B.dir, "story-photos", "story-" + g.storyId, g.file)))), allPhotos.length);
    const tamper = (name, fn) => { const d = path.join(tmp, "bk-" + name); fs.cpSync(bkB, d, { recursive: true }); fn(d); return snap.verifyBackup(d); };
    const img = allPhotos[0].path;
    const t1 = tamper("byte", d => { const f = path.join(d, img); const b2 = fs.readFileSync(f); b2[100] ^= 1; fs.writeFileSync(f, b2); });
    const t2 = tamper("record", d => fs.unlinkSync(path.join(d, "records", "304.json")));
    const t3 = tamper("manifest", d => { const f = path.join(d, "manifest.json"); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"counts"', '"counts" ')); });
    const t4 = tamper("photo", d => fs.unlinkSync(path.join(d, img)));
    check("B1 backup", "verification catches a changed photo byte, a missing record, an edited manifest and a missing photo", !t1.ok && !t2.ok && !t3.ok && !t4.ok, [t1, t2, t3, t4].map(x => x.problems[0]).join(" | "));
    check("B1 backup", "a backup older than 6 hours is reported stale", snap.verifyBackup(bkB, Date.now() + 7 * 3600e3).fresh === false);
    live.close();
  }

  /* ================= B2: mandatory explicit authorization ================= */
  const ledB = path.join(tmp, "ledger-B.jsonl");
  {
    const go = async (io, extra) => { const c = counter(); const r = await runProduction(Object.assign({ payload: P, backupDir: bkB, ledgerPath: ledB, connect: connectTo(B.base, c.fetch), io }, extra || {})); return { r, c }; };
    const before = B.stateHash(), h0 = hooks.length;
    const cases = [
      ["no interactive terminal", await go(scriptedIo([BATCH, FP, PHRASE], { notTTY: true })), "authorize", 0],
      ["wrong batch identifier", await go(scriptedIo(["batch-02", FP, PHRASE])), "authorize", 0],
      ["wrong payload fingerprint", await go(scriptedIo([BATCH, FP.replace(/^./, c => c === "a" ? "b" : "a"), PHRASE])), "authorize", 0],
      ["empty hidden token", await go(scriptedIo([BATCH, FP, PHRASE], { token: "" })), "authorize", 0],
      ["confirmation phrase not typed", await go(scriptedIo([BATCH, FP, "yes"])), "confirm", null],
      ["confirmation phrase lower-case", await go(scriptedIo([BATCH, FP, PHRASE.toLowerCase()])), "confirm", null],
      ["stale backup", await go(goodIo(), { now: Date.now() + 7 * 3600e3 }), "backup", 0]
    ];
    for (const [n, { r, c }, stage, gets] of cases) check("B2 authorization", n + " -> stops at " + stage + ", no write", r.stopped && r.stage === stage && c.POST === 0 && c.PUT === 0 && c.DELETE === 0 && (gets == null || c.GET === gets), r.stage + " " + r.stopped + " GET=" + c.GET + " POST=" + c.POST);
    // environment variables and process arguments cannot stand in for the prompts
    const saved = {}; const envs = { HL_IMPORT_CONFIRM: "1", HL_CONFIRM: "yes", HL_ASSUME_YES: "1", CI: "1", FORCE: "1", YES: "1", HL_ADMIN_TOKEN: TOKEN };
    for (const [k, v] of Object.entries(envs)) { saved[k] = process.env[k]; process.env[k] = v; }
    process.argv.push("--yes", "--force", "--confirm");
    const e1 = await go(scriptedIo([BATCH, FP, "nope"])), e2 = await go(scriptedIo([], { notTTY: true }));
    process.argv.splice(-3);
    for (const k of Object.keys(envs)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    check("B2 authorization", "confirmation/yes/force environment variables and --yes/--force/--confirm flags change nothing", e1.r.stage === "confirm" && e2.r.stage === "authorize" && e1.c.POST + e2.c.POST + e2.c.GET === 0);
    const dests = [];
    for (const bad of ["https://attacker.example", "https://www.harlanslegacy.com.attacker.example", "https://user:pw@www.harlanslegacy.com", B.base]) {
      const asked = []; const c = counter();
      const r = await runProduction({ payload: P, backupDir: bkB, ledgerPath: ledB, base: bad, io: { isTTY: true, ask: async q => { asked.push(q); return BATCH; }, askHidden: async q => { asked.push(q); return TOKEN; }, print: () => {} }, fetch: c.fetch });
      dests.push({ bad, ok: r.stage === "destination" && !asked.length && c.GET + c.POST === 0 });
    }
    check("B2 authorization", "a requested destination other than the production origin (incl. this loopback copy) stops the run before the token prompt and any request", dests.every(d => d.ok), JSON.stringify(dests.filter(d => !d.ok)));
    const tampered = JSON.parse(JSON.stringify(P)); tampered.items[3].record.title += " (edited)";
    const tp = await go(goodIo(), { payload: tampered });
    check("B2 authorization", "a payload edited after approval stops before any request", tp.r.stage === "payload" && tp.c.GET + tp.c.POST === 0, tp.r.stopped);
    check("B2 authorization", "nothing changed on the site and no build after all refused attempts", B.stateHash() === before && hooks.length === h0 && !fs.existsSync(ledB));
  }

  /* ================= B3: the full first batch ================= */
  let resB;
  {
    const before = B.stories(), gBefore = B.galleries(), h0 = hooks.length;
    const c = counter();
    resB = await runProduction({ payload: P, backupDir: bkB, ledgerPath: ledB, connect: connectTo(B.base, c.fetch), io: goodIo() });
    const r = resB;
    report.phases.B3 = { stage: r.stage, stopped: r.stopped, ids: r.ids, finalBuild: r.run && r.run.finalBuild, writes: r.run && r.run.writes, counts: r.counts, requests: c };
    check("B3 import", "batch completes: 25 Drafts verified, nothing stopped", !r.stopped && r.run && r.run.posts.length === 25 && r.run.posts.every(p => p.result === "verified"), r.stopped);
    check("B3 import", "counts: 25 posts, 21 with photos, 4 text-only, 23 photos", r.counts.posts === 25 && r.counts.withPhotos === 21 && r.counts.withoutPhotos === 4 && r.counts.photos === 23, JSON.stringify(r.counts));
    const ids = r.ids.ids, maxBefore = Math.max(...before.map(s => s.id));
    check("B3 import", "ids allocated fresh above every existing id, none protected, none reused", Object.values(ids).every(id => id > maxBefore && !PROTECTED_IDS.includes(id) && !before.some(s => s.id === id)) && new Set(Object.values(ids)).size === 25, Object.values(ids).join(","));
    const after = B.stories(), g = B.galleries();
    const bad = [];
    for (const it of P.items) {
      const id = ids[it.postId], s = after.find(x => x.id === id);
      if (!(s && s.status === "draft" && !s.featured && s.importSource && s.importSource.system === IMPORT_SYSTEM && s.importSource.postId === it.postId && s.title === it.record.title && JSON.stringify(s.body) === JSON.stringify(it.record.body) && s.lead === it.record.lead)) bad.push(it.postId + " record");
      const gal = g["story-" + id] || { primary: null, items: [] };
      if (gal.items.length !== it.images.length) bad.push(it.postId + " photo count " + gal.items.length);
      it.images.forEach((im, i) => { const gi = gal.items[i]; const f = gi && path.join(B.dir, "story-photos", "story-" + id, gi.file); if (!(gi && gi.file === storedName(uploadName(im.file)) && fs.existsSync(f) && sha(fs.readFileSync(f)) === im.sha256)) bad.push(it.postId + " photo " + (i + 1)); });
      if (it.images.length ? gal.primary !== (gal.items[0] && gal.items[0].id) : gal.primary != null) bad.push(it.postId + " primary");
    }
    check("B3 import", "every record stored as approved, non-featured Draft with this importer's importSource", !bad.some(b => / record$/.test(b)), bad.join(","));
    check("B3 import", "every photo stored in the approved order with the approved SHA-256; photo 1 is Primary", !bad.some(b => /photo|primary/.test(b)), bad.join(","));
    const textOnly = P.items.filter(i => i.photoMode === "none");
    const reqs = r.requests;
    check("B3 import", "the 4 text-only Drafts made no photo request and have no gallery", textOnly.length === 4 && textOnly.every(it => !reqs.some(q => q.path === "/api/story-photos/" + ids[it.postId] && q.method === "POST") && !(g["story-" + ids[it.postId]] || { items: [] }).items.length));
    const posts = reqs.filter(q => q.method === "POST");
    check("B3 import", "requests: only GET and POST; 25 creates, 23 uploads, 1 build", reqs.every(q => q.method === "GET" || q.method === "POST") && posts.filter(q => q.path === "/api/stories").length === 25 && posts.filter(q => /^\/api\/story-photos\/\d+$/.test(q.path)).length === 23 && posts.filter(q => q.path === "/api/build").length === 1 && c.PUT + c.DELETE === 0, posts.length);
    check("B3 import", "stored photos verified through the admin-only digest route (23 reads)", reqs.filter(q => /\/digest$/.test(q.path)).length === 23);
    check("B3 import", "exactly one build, sent after every post verified", hooks.length - h0 === 1 && r.run.finalBuild.sent === true && r.run.finalBuild.status === 200, hooks.length - h0);
    const unchanged = before.every(s => JSON.stringify(after.find(x => x.id === s.id)) === JSON.stringify(s)) && Object.keys(gBefore).every(k => JSON.stringify(g[k]) === JSON.stringify(gBefore[k]));
    check("B3 import", "every pre-existing memory and gallery (incl. 303-305, 388-404) is byte-identical; the post-run snapshot agrees", unchanged && r.after.unchangedProblems.length === 0, r.after.unchangedProblems.join("; "));
    // running the same command again changes nothing
    const h1 = hooks.length, c2 = counter();
    const again = await runProduction({ payload: P, backupDir: bkB, ledgerPath: ledB, connect: connectTo(B.base, c2.fetch), io: goodIo() });
    check("B3 import", "re-running the completed batch: no new Draft, photo or build", !again.stopped && c2.POST === 0 && hooks.length === h1 && B.stories().length === after.length && again.run.finalBuild.sent === false, JSON.stringify(again.run && again.run.finalBuild) + " POST=" + c2.POST);
  }

  /* ================= C: interruption, partial failure, resume ================= */
  {
    const bkC = path.join(tmp, "backup-C"), ledC = path.join(tmp, "ledger-C.jsonl");
    const live = createRehearsalTransport({ base: C.base, token: TOKEN });
    await snap.backup(live, await snap.takeSnapshot(live.transport, live.base), bkC); live.close();
    const before = C.stories(), h0 = hooks.length;
    // 1. the connection drops after 9 writes (mid-batch, between a create and its photos)
    const c1 = counter({ dropAfterPosts: 9 });
    const r1 = await runProduction({ payload: P, backupDir: bkC, ledgerPath: ledC, connect: connectTo(C.base, c1.fetch), io: goodIo() });
    const imported1 = C.stories().filter(s => s.importSource && s.importSource.system === IMPORT_SYSTEM);
    check("C interruption", "a dropped connection stops the batch with no build; created posts stay unpublished Drafts", r1.stopped && hooks.length === h0 && imported1.length > 0 && imported1.every(s => s.status === "draft" && !s.featured), r1.stopped + " drafts=" + imported1.length);
    // 1b. resume, but the answer to the next create is lost after the server saved it (no ledger line)
    const cL = counter({ loseResponse: (m, u) => m === "POST" && /\/api\/stories$/.test(u) });
    const rL = await runProduction({ payload: P, backupDir: bkC, ledgerPath: ledC, connect: connectTo(C.base, cL.fetch), io: goodIo() });
    const importedL = C.stories().filter(s => s.importSource && s.importSource.system === IMPORT_SYSTEM);
    check("C interruption", "a create whose answer is lost stops the batch with no build; the Draft exists without a ledger line", rL.stopped && cL.lost.length === 1 && hooks.length === h0 && importedL.length === imported1.length + 1, rL.stopped + " drafts=" + importedL.length + " lost=" + cL.lost.join(""));
    // 2. the resume hits a storage failure on one upload (HTTP 500 from the API)
    const victim = P.items.filter(i => i.images.length).slice(-1)[0];
    C.fault.upload = p => p.includes(storedName(uploadName(victim.images[0].file)));
    const c2 = counter();
    const r2 = await runProduction({ payload: P, backupDir: bkC, ledgerPath: ledC, connect: connectTo(C.base, c2.fetch), io: goodIo() });
    C.fault.upload = null;
    check("C partial failure", "an upload failure (HTTP 500) stops the batch with no build", r2.stopped && hooks.length === h0 && /500|upload/i.test(r2.stopped), r2.stopped);
    // 3. resume to completion
    const c3 = counter();
    const r3 = await runProduction({ payload: P, backupDir: bkC, ledgerPath: ledC, connect: connectTo(C.base, c3.fetch), io: goodIo() });
    const imported = C.stories().filter(s => s.importSource && s.importSource.system === IMPORT_SYSTEM);
    const g = C.galleries();
    const dupPhotos = imported.filter(s => { const it = P.items.find(i => i.postId === s.importSource.postId); return ((g["story-" + s.id] || { items: [] }).items.length) !== it.images.length; });
    check("C resume", "resume completes the batch: all 25 verified (earlier runs' posts report \"already verified\" and are not touched again)", !r3.stopped && r3.run.posts.length === 25 && r3.run.posts.every(p => p.result === "verified" || p.result === "already verified") && r3.run.posts.some(p => p.result === "already verified"), r3.stopped + " " + JSON.stringify(r3.run && r3.run.posts.map(p => p.result)));
    check("C resume", "no duplicate Drafts (25 import Drafts, one per post) and no duplicate photos", imported.length === 25 && new Set(imported.map(s => s.importSource.postId)).size === 25 && !dupPhotos.length, imported.length + " dup=" + dupPhotos.map(s => s.id).join(","));
    check("C resume", "ids kept across all four runs (ledger ids, and the Draft whose answer was lost is adopted, not duplicated)", JSON.stringify(r3.ids.ids) === JSON.stringify(r1.ids.ids) && JSON.stringify(rL.ids.ids) === JSON.stringify(r1.ids.ids), r3.ids.reused.length + " reused");
    check("C resume", "exactly one build across the interrupted, lost-answer, failed and resumed runs", hooks.length - h0 === 1, hooks.length - h0);
    const after = C.stories();
    check("C resume", "pre-existing memories unchanged after all three runs", before.every(s => JSON.stringify(after.find(x => x.id === s.id)) === JSON.stringify(s)) && r3.after.unchangedProblems.length === 0);
  }

  for (const s of [A, B, C]) s.server.close();
  hookServer.close();
  report.passed = report.checks.every(c => c.ok);
  report.summary = report.checks.filter(c => c.ok).length + "/" + report.checks.length;
  fs.writeFileSync(outFile, JSON.stringify(report, null, 1).split(TOKEN).join("<token>").split(MOD).join("<mod>"));
  console.log((report.passed ? "PASS" : "FAIL") + ": " + report.summary + " checks");
  process.exitCode = report.passed ? 0 : 1;
}
main().catch(e => { console.error(String(e && e.stack || e).split(TOKEN).join("<token>")); process.exit(1); });
