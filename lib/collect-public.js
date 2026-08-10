/* =========================================================================
   Harlan's Legacy — assemble the deployable public directory (Phase 12)

   The generators write the site in place at the repo root (index.html, story/,
   assets/, …). For Vercel we deploy only the PUBLIC-facing output into ./public
   so the source of truth (data/*.json, incl. drafts), server code (lib/, *.js)
   and uploaded originals are NEVER served as static files. The /api serverless
   functions are handled by Vercel separately and are not copied here.

   Runs only in the Vercel build (npm run build:vercel). Local `npm run build`
   and `node server.js` are unaffected — they keep serving from the repo root.
   ========================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const { ROOT } = require("./paths.js");

const OUT = path.join(ROOT, "public");

// Exactly the public site: generated pages, the admin app, and static assets.
const FILES = ["index.html", "family.html", "site.webmanifest", "stories.js", "explore-data.js", "search-index.json"];
const DIRS = ["assets", "admin", "story", "family", "journey", "place", "object", "event"];

function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyRecursive(path.join(src, name), path.join(dst, name));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function collect() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  let files = 0, dirs = 0;
  for (const f of FILES) { const s = path.join(ROOT, f); if (fs.existsSync(s)) { copyRecursive(s, path.join(OUT, f)); files++; } }
  for (const d of DIRS) { const s = path.join(ROOT, d); if (fs.existsSync(s)) { copyRecursive(s, path.join(OUT, d)); dirs++; } }
  console.log(`collect-public: assembled ./public (${files} files, ${dirs} directories). data/, lib/ and source are excluded.`);
}

if (require.main === module) collect();
module.exports = { collect };
