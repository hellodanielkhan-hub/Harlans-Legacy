/* Stored-photo route security, in isolation. Never touches production: no Supabase, no network beyond
   127.0.0.1, random throwaway tokens, synthetic stories and photos held in an in-memory mock storage.

     node photo-route-security.cjs <checkout> <out.json>

   <checkout> is a throwaway git worktree of the commit under test; its real api/[...path].js answers on
   127.0.0.1 in three routing modes:
     raw           req.query absent: segments come from the raw pathname (percent-encoding kept), as locally
     vercel-array  req.query.path = the percent-DECODED path split on "/", as the Vercel rewrite delivers it
     vercel-string req.query.path = the percent-decoded path as one string
   Every lib/store.js function is replaced by a counting mock (reads served from memory, writes refused), and
   fs reads are counted, so "zero storage reads" is measured per request. The mock's readObject resolves
   paths like a filesystem and serves sentinel decoys for .env, etc/passwd and data/*: if a caller-controlled
   value ever reached a storage path, the sentinel would come back and be detected. */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const [dir, outFile] = process.argv.slice(2).map(v => path.resolve(v));
for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "HL_DATA_DIR", "HARLAN_NARRATION_PUBLISH_GATE", "HARLAN_ENV_FILE", "HL_ADMIN_TOKEN", "VERCEL_DEPLOY_HOOK_URL"]) delete process.env[k];
const TOKEN = crypto.randomBytes(16).toString("hex"), MOD = crypto.randomBytes(16).toString("hex");
process.env.ADMIN_TOKEN = TOKEN;
process.env.HARLAN_MODERATORS = JSON.stringify({ [MOD]: { id: "mod1", name: "Test Moderator" } });
process.on("exit", () => { delete process.env.ADMIN_TOKEN; delete process.env.HARLAN_MODERATORS; });

const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const report = { commit: execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim(), started: new Date().toISOString(), checks: [] };
const check = (phase, name, ok, detail) => { report.checks.push({ phase, name, ok: !!ok, detail: detail == null ? "" : String(detail).slice(0, 600) }); console.log((ok ? "PASS " : "FAIL ") + "[" + phase + "] " + name + (ok || detail == null ? "" : " :: " + String(detail).slice(0, 300))); };

/* ---- synthetic fixtures ---- */
const jpeg = n => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n)]);
const PHOTO = { "story-9101/synth-a.jpg": jpeg(4096), "story-9101/synth-b.jpg": jpeg(2048), "story-9102/other-c.jpg": jpeg(1024) };
const SENT = { env: "HL_SENTINEL_ENV=" + crypto.randomBytes(8).toString("hex"), passwd: "root:x:0:0:SENTINEL-" + crypto.randomBytes(8).toString("hex"), data: "SENTINEL-DATA-" + crypto.randomBytes(8).toString("hex") };
const STORIES = [9101, 9102].map(id => ({ id, title: "SYNTHETIC " + id, status: "draft", featured: false }));
const item = (id, file) => ({ id, file, caption: "", year: null, location: null, source: null, alt: null, focus: { x: 50, y: 50 }, url: "", portrait: [], full: [] });
const MANIFEST = { "story-9101": { primary: "synth-a", items: [item("synth-a", "synth-a.jpg"), item("synth-b", "synth-b.jpg")] },
  "story-9102": { primary: "other-c", items: [item("other-c", "other-c.jpg"), item("evil", "../../.env")] } };
const GALLERY_FILES = ["synth-a.jpg", "synth-b.jpg", "other-c.jpg"];

/* ---- counting mock storage (every export of lib/store.js) ---- */
const store = require(path.join(dir, "lib", "store.js"));
if (store.USE_SUPABASE) throw new Error("must run without Supabase");
const calls = [];
const mock = {
  getStories: async () => JSON.parse(JSON.stringify(STORIES)),
  getStoryPhotos: async () => JSON.parse(JSON.stringify(MANIFEST)),
  readObject: async (bucket, objPath) => {
    const p = path.posix.normalize(String(bucket) + "/" + String(objPath)).replace(/\\/g, "/");
    if (/(^|\/)\.env$/.test(p)) return Buffer.from(SENT.env);
    if (/etc\/passwd$/.test(p)) return Buffer.from(SENT.passwd);
    if (/(^|\/)data\//.test(p)) return Buffer.from(SENT.data);
    const rel = p.startsWith("story-photos/") ? p.slice("story-photos/".length) : null;
    if (rel && PHOTO[rel]) return Buffer.from(PHOTO[rel]);
    const e = new Error("ENOENT " + p); e.code = "ENOENT"; throw e;
  }
};
for (const [name, fn] of Object.entries(store)) {
  if (typeof fn !== "function") continue;
  store[name] = async (...args) => { calls.push({ name, args: args.map(a => typeof a === "string" ? a : typeof a) }); if (mock[name]) return mock[name](...args); throw new Error("unexpected storage call " + name); };
}
/* ---- fs read counter (anything but code) ---- */
let fsReads = [];
const isCode = p => /\.(c?js|mjs|node)$/i.test(String(p)) || /node_modules/.test(String(p));
for (const name of ["readFileSync", "readFile", "createReadStream", "openSync", "open"]) {
  const orig = fs[name]; fs[name] = function (p, ...rest) { if (!isCode(p)) fsReads.push(name + " " + String(p)); return orig.call(this, p, ...rest); };
}
const origPromRead = fs.promises.readFile, origPromOpen = fs.promises.open;
fs.promises.readFile = function (p, ...rest) { if (!isCode(p)) fsReads.push("promises.readFile " + String(p)); return origPromRead.call(this, p, ...rest); };
fs.promises.open = function (p, ...rest) { if (!isCode(p)) fsReads.push("promises.open " + String(p)); return origPromOpen.call(this, p, ...rest); };

const handler = require(path.join(dir, "api", "[...path].js"));

/* ---- three routing modes ---- */
function vercelize(req, asString) {
  const rawPath = String(req.url).split("?")[0];   // as received: no dot-segment or backslash normalization
  let decoded;
  try { decoded = decodeURIComponent(rawPath.replace(/^\/api\/?/, "")); } catch (e) { return false; }   // the platform refuses malformed escapes
  req.query = { path: asString ? decoded : decoded.split("/") };
  return true;
}
const MODES = {
  raw: (q, s) => handler(q, s),
  "vercel-array": (q, s) => { if (!vercelize(q, false)) { s.statusCode = 400; return s.end("bad request"); } return handler(q, s); },
  "vercel-string": (q, s) => { if (!vercelize(q, true)) { s.statusCode = 400; return s.end("bad request"); } return handler(q, s); }
};
async function startMode(fn) {
  const server = http.createServer(fn);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  // the path is sent exactly as written (an options object, not a URL string, so the client never normalizes it)
  const raw = (method, p, headers) => new Promise(resolve => {
    calls.length = 0; fsReads = [];
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: headers || {} }, x => { const c = []; x.on("data", d => c.push(d)); x.on("end", () => { const b = Buffer.concat(c); let j = null; try { j = JSON.parse(b.toString()); } catch (e) {} resolve({ status: x.statusCode, headers: x.headers, bytes: b, body: j, text: b.toString("latin1"), calls: calls.slice(), fsReads: fsReads.slice() }); }); });
    r.on("error", e => resolve({ status: "ERR " + e.code, bytes: Buffer.alloc(0), text: "", calls: calls.slice(), fsReads: fsReads.slice() }));
    r.end();
  });
  return { server, raw };
}

const ADM = { "x-admin-token": TOKEN }, MODH = { "x-moderator-token": MOD };
const reads = x => x.calls.filter(c => c.name === "readObject" || c.name === "downloadObject").length;
const leaks = x => [SENT.env, SENT.passwd, SENT.data].filter(s => x.text.includes(s)).length;
const showsGallery = x => GALLERY_FILES.some(f => x.text.includes(f));
const brief = x => x.status + " storage=" + x.calls.map(c => c.name).join(",") + " fs=" + x.fsReads.length;

// photo-id segments that must be refused (400/404) with zero storage reads of any kind
const MALICIOUS_PHOTO = [
  ["../../.env (encodeURIComponent)", encodeURIComponent("../../.env")],
  ["x/../../../etc/passwd (encodeURIComponent)", encodeURIComponent("x/../../../etc/passwd")],
  ["../../.env (unencoded)", "../../.env"],
  ["x/../../../etc/passwd (unencoded)", "x/../../../etc/passwd"],
  ["..%2F..%2F.env", "..%2F..%2F.env"],
  ["%2e%2e%2f%2e%2e%2f.env", "%2e%2e%2f%2e%2e%2f.env"],
  ["%2E%2E%2F%2E%2E%2F.env (upper case)", "%2E%2E%2F%2E%2E%2F.env"],
  ["..%2f..%2fdata%2fstories.json", "..%2f..%2fdata%2fstories.json"],
  ["synth-a%2F..%2F..%2F.env (valid id prefix)", "synth-a%2F..%2F..%2F.env"],
  ["%2Fetc%2Fpasswd (absolute)", "%2Fetc%2Fpasswd"],
  ["dot segment ..", ".."], ["dot segment .", "."], ["%2e%2e", "%2e%2e"], ["%2e", "%2e"],
  ["double-encoded ..%252F..%252F.env", "..%252F..%252F.env"],
  ["double-encoded %252e%252e%252f.env", "%252e%252e%252f.env"],
  ["triple-encoded ..%25252F.env", "..%25252F.env"],
  ["backslash encoded ..%5C..%5C.env", "..%5C..%5C.env"],
  ["backslash unencoded ..\\..\\.env", "..\\..\\.env"],
  ["mixed ..%5c..%2f.env", "..%5c..%2f.env"],
  ["windows C:%5Cwindows%5Cwin.ini", "C:%5Cwindows%5Cwin.ini"],
  ["NUL %00", "%00"], ["synth-a%00", "synth-a%00"], ["synth-a%00.jpg", "synth-a%00.jpg"], ["double-encoded NUL synth-a%2500", "synth-a%2500"],
  ["newline synth-a%0a", "synth-a%0a"], ["tab synth-a%09", "synth-a%09"],
  ["overlong UTF-8 %c0%ae%c0%ae%c0%af.env", "%c0%ae%c0%ae%c0%af.env"],
  ["unicode one-dot leader %e2%80%a4%e2%80%a4", "%e2%80%a4%e2%80%a4"],
  ["file name with dot synth-a.jpg", "synth-a.jpg"],
  ["leading hyphen -synth-a", "-synth-a"],
  ["over-long id (300 chars)", "a".repeat(300)]
];
// story-id segments that must be refused with zero storage reads
const MALICIOUS_STORY = [
  ["abc", "abc"], ["..", ".."], ["..%2F..%2F.env", "..%2F..%2F.env"], [encodeURIComponent("../../.env"), encodeURIComponent("../../.env")],
  ["9101%00", "9101%00"], ["-1", "-1"], ["1e3", "1e3"], ["0x10", "0x10"], ["9101.0", "9101.0"], ["9101%2F..", "9101%2F.."], ["over-long 9999999999", "9999999999"]
];

async function main() {
  const totals = { maliciousRequests: 0, maliciousStorageCalls: 0, maliciousFsReads: 0, maliciousLeaks: 0 };
  for (const [mode, fn] of Object.entries(MODES)) {
    const { server, raw } = await startMode(fn);
    const P = "[" + mode + "]";
    const D = (photo, what, h) => raw("GET", "/api/story-photos/9101/" + photo + "/" + what, h);

    // valid photo verification unchanged
    const ok = await D("synth-a", "digest", ADM);
    const want = sha(PHOTO["story-9101/synth-a.jpg"]);
    check(P + " valid", "valid photo id: 200 with the correct SHA-256, file and size", ok.status === 200 && ok.body.sha256 === want && ok.body.file === "synth-a.jpg" && ok.body.bytes === PHOTO["story-9101/synth-a.jpg"].length && ok.body.verification === "not-requested", JSON.stringify(ok.body));
    check(P + " valid", "valid photo id: exactly one storage object read, of the manifest's own path", reads(ok) === 1 && ok.calls.some(c => c.name === "readObject" && c.args[0] === "story-photos" && c.args[1] === "story-9101/synth-a.jpg"), brief(ok));
    const ob = await D("synth-b", "original", ADM);
    check(P + " valid", "valid photo id /original: 200, exact bytes, X-Content-SHA256", ob.status === 200 && sha(ob.bytes) === sha(PHOTO["story-9101/synth-b.jpg"]) && ob.headers["x-content-sha256"] === sha(PHOTO["story-9101/synth-b.jpg"]), brief(ob));
    const m1 = await D("synth-a", "digest?expect=" + want, ADM), m2 = await D("synth-a", "digest?expect=" + "0".repeat(64), ADM);
    check(P + " valid", "expect=<right hash> match; expect=<wrong hash> mismatch", m1.status === 200 && m1.body.verification === "match" && m2.status === 200 && m2.body.verification === "mismatch" && m2.body.sha256 === want);
    const gal = await raw("GET", "/api/story-photos/9101", ADM), all = await raw("GET", "/api/story-photos", ADM);
    check(P + " valid", "GET /api/story-photos/<id> and /api/story-photos still return the gallery and manifest", gal.status === 200 && gal.body.primary === "synth-a" && gal.body.items.length === 2 && all.status === 200 && all.body["story-9102"] && reads(gal) === 0 && reads(all) === 0, gal.status + "/" + all.status);

    // unknown, cross-story and unsafe-manifest ids: 404/400 and no object read
    const unk = await D("nope", "digest", ADM);
    check(P + " unknown", "unknown photo id: 404, zero storage object reads", unk.status === 404 && reads(unk) === 0 && !showsGallery(unk), brief(unk));
    const cross = await D("other-c", "digest", ADM);
    check(P + " unknown", "a photo id from ANOTHER memory's gallery: 404, zero object reads (membership is per memory)", cross.status === 404 && reads(cross) === 0, brief(cross));
    const us = await raw("GET", "/api/story-photos/99999/synth-a/digest", ADM);
    check(P + " unknown", "unknown story id: 404, zero object reads", us.status === 404 && reads(us) === 0, brief(us));
    const evil = await raw("GET", "/api/story-photos/9102/evil/digest", ADM), evil2 = await raw("GET", "/api/story-photos/9102/evil/original", ADM);
    check(P + " unknown", "a manifest entry whose file name is a path (../../.env): 400, zero object reads", evil.status === 400 && evil2.status === 400 && reads(evil) + reads(evil2) === 0 && !leaks(evil2), evil.status + "/" + evil2.status);

    // authentication unchanged; refusals read nothing
    const nt = await D("synth-a", "digest"), wt = await D("synth-a", "digest", { "x-admin-token": "wrong" });
    check(P + " auth", "no admin token: 401, zero storage calls", nt.status === 401 && wt.status === 401 && nt.calls.length === 0 && wt.calls.length === 0, brief(nt) + " / " + brief(wt));
    const md = await D("synth-a", "digest", MODH), mo = await D("synth-a", "original", MODH);
    check(P + " auth", "moderator token: 403 on /digest and /original, zero storage calls", md.status === 403 && mo.status === 403 && md.calls.length === 0 && mo.calls.length === 0, brief(md) + " / " + brief(mo));
    const qt = await raw("GET", "/api/story-photos/9101/synth-a/digest?token=" + TOKEN);
    check(P + " auth", "?token= in the URL: 400, zero storage calls", qt.status === 400 && qt.calls.length === 0);

    // malicious photo ids
    const bad = [];
    for (const [name, seg] of MALICIOUS_PHOTO) for (const what of ["digest", "original"]) {
      const x = await D(seg, what, ADM);
      totals.maliciousRequests++; totals.maliciousStorageCalls += x.calls.length; totals.maliciousFsReads += x.fsReads.length; totals.maliciousLeaks += leaks(x);
      if (!(x.status === 400 || x.status === 404) || x.calls.length || x.fsReads.length || leaks(x) || showsGallery(x)) bad.push(name + "/" + what + " -> " + brief(x) + (leaks(x) ? " LEAK" : "") + (showsGallery(x) ? " GALLERY" : ""));
    }
    check(P + " traversal", MALICIOUS_PHOTO.length * 2 + " malicious photo ids (traversal, encoded, double-encoded, backslash, NUL, control, invalid): 400/404, zero storage calls, zero fs reads, no file content, no gallery", !bad.length, bad.join(" | "));
    const statuses = {}; for (const [name, seg] of MALICIOUS_PHOTO.slice(0, 2)) { const x = await D(seg, "digest", ADM); statuses[name] = x.status; }
    check(P + " traversal", "the two Production probe ids answer 400 (were 200 on Vercel before the fix)", Object.values(statuses).every(s => s === 400), JSON.stringify(statuses));

    // malicious story ids
    const badS = [];
    for (const [name, seg] of MALICIOUS_STORY) {
      const x = await raw("GET", "/api/story-photos/" + seg + "/synth-a/digest", ADM);
      totals.maliciousRequests++; totals.maliciousStorageCalls += x.calls.length; totals.maliciousFsReads += x.fsReads.length; totals.maliciousLeaks += leaks(x);
      if (!(x.status === 400 || x.status === 404) || x.calls.length || x.fsReads.length || leaks(x) || showsGallery(x)) badS.push(name + " -> " + brief(x));
    }
    check(P + " story id", MALICIOUS_STORY.length + " invalid story ids: 400/404, zero storage calls", !badS.length, badS.join(" | "));
    const abc = await raw("GET", "/api/story-photos/abc/synth-a/digest", ADM);
    check(P + " story id", "invalid story id 'abc': 400", abc.status === 400, abc.status);

    // shapes that used to fall through to the gallery
    const shapes = [["GET", "/api/story-photos/9101/synth-a"], ["GET", "/api/story-photos/9101/synth-a/digest/extra"], ["GET", "/api/story-photos/9101/synth-a/x/digest"],
      ["GET", "/api/story-photos/9101/synth-a/../../../.env/digest"], ["GET", "/api/story-photos/9101/synth-a/digest/..%2F..%2F.env"], ["GET", "/api/story-photos/9101/synth-a/thumbnail"],
      ["POST", "/api/story-photos/9101/synth-a/digest"], ["DELETE", "/api/story-photos/9101/" + encodeURIComponent("../../.env")], ["DELETE", "/api/story-photos/9101/..%5C.env"]];
    const badShape = [];
    for (const [m, p] of shapes) {
      const x = await raw(m, p, ADM);
      totals.maliciousRequests++; totals.maliciousStorageCalls += x.calls.length; totals.maliciousFsReads += x.fsReads.length; totals.maliciousLeaks += leaks(x);
      if (!(x.status === 400 || x.status === 404) || x.calls.length || x.fsReads.length || leaks(x) || showsGallery(x)) badShape.push(m + " " + p + " -> " + brief(x));
    }
    check(P + " shapes", "extra segments, a photo id without an action, unknown actions, writes on read routes: 400/404, zero storage calls, never the gallery", !badShape.length, badShape.join(" | "));
    server.close();
  }
  check("totals", "malicious requests across all modes: zero storage calls, zero fs reads, zero sentinel bytes returned", totals.maliciousRequests > 0 && totals.maliciousStorageCalls === 0 && totals.maliciousFsReads === 0 && totals.maliciousLeaks === 0, JSON.stringify(totals));
  report.totals = totals;
  report.finished = new Date().toISOString();
  report.passed = report.checks.every(c => c.ok);
  report.summary = report.checks.filter(c => c.ok).length + "/" + report.checks.length;
  fs.writeFileSync(outFile, JSON.stringify(report, null, 1).split(TOKEN).join("<token>").split(MOD).join("<mod>"));
  console.log((report.passed ? "PASS" : "FAIL") + ": " + report.summary + " checks, commit " + report.commit.slice(0, 7));
  process.exit(report.passed ? 0 : 1);
}
main().catch(e => { console.error(String(e && e.stack || e).split(TOKEN).join("<token>")); process.exit(1); });
