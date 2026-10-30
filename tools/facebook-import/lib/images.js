/* Local image checks: presence, type, dimensions, checksum, request-size limit, order. */
"use strict";

const fs = require("fs");
const crypto = require("crypto");

// Vercel serverless request bodies are capped at 4.5 MB; the Admin sends base64 JSON (≈ 4/3 of the file).
const MAX_FILE_BYTES = 3200000;

function dimensions(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: "jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return { type: "jpeg", width: null, height: null };
  }
  return { type: "unknown", width: null, height: null };
}

/* files: [{ order, path }] as listed in the manifest. expected: Facebook photo count (may be an estimate). */
function checkImages(files, expected, expectedIsEstimate) {
  const problems = [];
  const sorted = (files || []).slice().sort((a, b) => a.order - b.order);
  sorted.forEach((f, i) => { if (f.order !== i + 1) problems.push(`order gap/duplicate: expected order ${i + 1}, found ${f.order}`); });
  const out = sorted.map(f => {
    const r = { order: f.order, path: f.path, exists: fs.existsSync(f.path) };
    if (!r.exists) { problems.push(`missing file (order ${f.order}): ${f.path}`); return r; }
    const buf = fs.readFileSync(f.path);
    const d = dimensions(buf);
    Object.assign(r, { bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex"), type: d.type, width: d.width, height: d.height, base64Bytes: Math.ceil(buf.length / 3) * 4 });
    if (!["jpeg", "png"].includes(d.type)) problems.push(`not a JPEG/PNG (order ${f.order}): ${f.path}`);
    if (buf.length > MAX_FILE_BYTES) problems.push(`too large for one Admin upload (${buf.length} bytes, order ${f.order})`);
    return r;
  });
  const hashes = out.filter(r => r.sha256).map(r => r.sha256);
  if (new Set(hashes).size !== hashes.length) problems.push("the same image file appears twice");
  if (expected != null && out.length !== expected) problems.push(`photo count ${out.length} ≠ Facebook count ${expected}${expectedIsEstimate ? " (estimate from the Facebook grid)" : ""}`);
  return { files: out, primary: out[0] || null, problems };
}

module.exports = { checkImages, dimensions, MAX_FILE_BYTES };
