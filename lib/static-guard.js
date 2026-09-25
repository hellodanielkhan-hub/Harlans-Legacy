/* =========================================================================
   Harlan's Legacy — static-file guard for the local dev server (server.js)

   The dev server serves files straight from the repo root, which also holds
   secrets (.env) and non-public trees. This guard refuses:
     • any path segment that starts with "." (.env, .git, .claude, .vercel …)
     • malformed percent-encoding
     • anything that resolves outside the served root
   Production (Vercel) never uses this server: it serves the allow-listed
   public/ bundle built by lib/collect-public.js.
   ========================================================================= */
"use strict";

const path = require("path");

// Decode a URL pathname to a root-relative path, or return null when it must not be served.
function safeRelative(pathname) {
  let rel;
  try { rel = decodeURIComponent(String(pathname || "").replace(/^\/+/, "")); }
  catch (e) { return null; }                                   // malformed %-encoding
  if (rel.indexOf("\0") >= 0) return null;
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  if (segs.some(s => s.startsWith("."))) return null;          // dotfiles/dirs, and "." / ".." traversal
  if (rel === "") rel = "index.html";
  if (rel.endsWith("/") || rel.endsWith("\\")) rel += "index.html";
  return rel;
}

// True when abs is root itself or strictly inside it (not a sibling sharing the prefix).
function isInside(root, abs) {
  const r = path.resolve(root), a = path.resolve(abs);
  return a === r || a.startsWith(r + path.sep);
}

const LOOPBACK = ["127.0.0.1", "::1", "localhost"];
function isLoopback(host) { return LOOPBACK.indexOf(String(host)) >= 0; }

module.exports = { safeRelative, isInside, isLoopback };
