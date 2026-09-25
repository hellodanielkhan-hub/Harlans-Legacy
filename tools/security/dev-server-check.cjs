/* =========================================================================
   Regression check: the local dev server must never serve secrets and must
   bind to loopback by default.
     node tools/security/dev-server-check.cjs        (exit 0 = pass)
   Starts a throwaway server.js on a free port, sends RAW request paths (no
   client-side normalization), then stops it. Never prints file contents.
   ========================================================================= */
"use strict";
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const ROOT = path.resolve(__dirname, "..", "..");

function freePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); }); }
function raw(port, p) {
  return new Promise(resolve => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: p }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", e => resolve("ERR:" + e.code)); req.end();
  });
}
function reachable(host, port) {
  return new Promise(resolve => {
    const s = net.connect({ host, port, timeout: 1500 }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false)); s.on("timeout", () => { s.destroy(); resolve(false); });
  });
}

(async () => {
  const port = await freePort();
  const env = Object.assign({}, process.env, { PORT: String(port) }); delete env.HOST;
  const srv = cp.spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; srv.stdout.on("data", d => out += d); srv.stderr.on("data", d => out += d);
  for (let i = 0; i < 100 && !/listening on/.test(out); i++) await new Promise(r => setTimeout(r, 100));
  let n = 0, fails = 0;
  const ok = (name, cond, got) => { n++; if (!cond) fails++; console.log((cond ? "PASS " : "FAIL ") + name + (got !== undefined ? "  (" + got + ")" : "")); };
  try {
    ok("server announces a loopback bind", /listening on 127\.0\.0\.1:/.test(out));
    const blocked = ["/.env", "/%2eenv", "/%2Eenv", "/.%65nv", "/assets/../.env", "/assets/..%2f.env", "/assets/..%5c.env", "/..%5c.env",
                     "/.env.local", "/.git/config", "/.claude/settings.json", "/story/%2e%2e/.env", "/%00.env", "/%E0%A4%A"];
    for (const p of blocked) { const s = await raw(port, p); ok("blocked " + p, s === 404 || s === 403 || s === 400, s); }
    ok("server still alive after malformed paths", (await raw(port, "/")) === 200);
    for (const p of ["/", "/assets/listen-cinematic.js", "/story/214-the-blue-chair.html", "/admin/"]) { const s = await raw(port, p); ok("still serves " + p, s === 200, s); }
    const lan = [].concat(...Object.values(os.networkInterfaces())).filter(a => a && a.family === "IPv4" && !a.internal).map(a => a.address);
    if (!lan.length) console.log("SKIP no non-loopback IPv4 interface to probe");
    for (const ip of lan) ok("not reachable on " + ip, !(await reachable(ip, port)));
  } finally { srv.kill(); }
  console.log("\n" + (n - fails) + "/" + n + " dev-server security checks passed");
  process.exitCode = fails ? 1 : 0;
})().catch(e => { console.error("CHECK_ERR", e); process.exitCode = 2; });
