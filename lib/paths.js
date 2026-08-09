/* =========================================================================
   Harlan's Legacy — writable-root resolver (Phase 11A.9)

   The CMS/server writes data files, generated pages and uploaded images. On a
   normal host (local machine, container, VM, or any host with a writable
   filesystem) that is the app directory itself and NOTHING changes — ROOT is
   the app directory, exactly as before.

   On a read-only deployment filesystem (e.g. a serverless function where the
   code lives under a read-only /var/task), writing to the app directory throws
   `EROFS: read-only file system`. To keep publishing working, ROOT is
   relocated to a WRITABLE directory:
       • process.env.HL_DATA_DIR   — an explicit writable (ideally persistent)
                                     path the operator mounts/points at; OR
       • the OS temp directory      — a last-resort fallback so the CMS never
                                     crashes with EROFS.
   On first use the writable root is seeded once from the read-only bundle.

   Honest limitation: a purely ephemeral serverless filesystem (temp wiped on
   every cold start) cannot durably persist author edits without a persistent
   volume or external store. Point HL_DATA_DIR at a persistent writable disk
   (a mounted volume, or simply run the CMS on a host with a writable disk) for
   durable publishing. The generated STATIC site deploys fine on any read-only
   static host — this only concerns the authoring server.
   ========================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const APP_ROOT = path.resolve(__dirname, "..");

function isWritable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch (e) { return false; }
}

function resolveRoot() {
  if (process.env.HL_DATA_DIR) {
    const d = path.resolve(process.env.HL_DATA_DIR);
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
    return d;
  }
  if (isWritable(APP_ROOT)) return APP_ROOT;           // the normal case — unchanged
  const t = path.join(os.tmpdir(), "harlans-legacy");
  try { fs.mkdirSync(t, { recursive: true }); } catch (e) {}
  return t;
}

const ROOT = resolveRoot();
const RELOCATED = path.resolve(ROOT) !== APP_ROOT;

function copyInto(src, dst, skip) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skip && skip(name, src)) continue;
    const s = path.join(src, name), d = path.join(dst, name);
    let st; try { st = fs.statSync(s); } catch (e) { continue; }
    if (st.isDirectory()) copyInto(s, d, skip);
    else if (!fs.existsSync(d)) { try { fs.copyFileSync(s, d); } catch (e) {} }
  }
}

let seeded = false;
// Populate the writable root once from the bundled (read-only) app files.
function ensureSeed() {
  if (!RELOCATED || seeded) return;
  seeded = true;
  if (fs.existsSync(path.join(ROOT, "index.html"))) return; // already seeded
  copyInto(APP_ROOT, ROOT, function (name, src) {
    if (name === "node_modules" || name === ".git") return true;
    // never recurse the writable root into itself if it is nested under APP_ROOT
    if (path.resolve(path.join(src, name)) === path.resolve(ROOT)) return true;
    return false;
  });
}

module.exports = { ROOT, APP_ROOT, RELOCATED, ensureSeed };
