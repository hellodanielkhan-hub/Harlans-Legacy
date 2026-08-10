/* Minimal .env loader (zero-dependency). Populates process.env from a local
   .env file when present, without overriding already-set variables. The .env is
   git-ignored and never deployed, so this is a no-op in production (Vercel
   provides env vars directly). Use with:  node -r ./lib/loadenv <script>. */
"use strict";
const fs = require("fs");
const path = require("path");
try {
  const p = path.join(__dirname, "..", ".env");
  if (fs.existsSync(p)) {
    fs.readFileSync(p, "utf8").split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line || line[0] === "#") return;
      const i = line.indexOf("=");
      if (i < 0) return;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && !(k in process.env)) process.env[k] = v;
    });
  }
} catch (e) { /* ignore */ }
