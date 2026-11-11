// node --test tools/facebook-import/test/fast-backup.test.js
// backup(): bounded parallel reads, read-only retries and checksum-verified reuse give the SAME verified backup.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const snapLib = require("../lib/snapshot.js");

const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fast-backup-"));

// An in-memory site behind the same interface the live transport gives backup(): GET only.
function fakeSite({ records = 40, photosEvery = 2, latencyMs = 0, failFirst = {} } = {}) {
  const stories = [], galleries = {}, originals = {};
  const { PROTECTED_IDS } = require("../lib/batch.js");
  const ids = PROTECTED_IDS.slice().concat(Array.from({ length: records }, (_, i) => 500 + i));   // the snapshot requires every protected id
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    stories.push({ id, status: "published", featured: false, title: "Story " + id, body: ["x".repeat(200)] });
    if (i % photosEvery === 0) {
      const items = [1, 2].map(k => ({ id: "p" + id + "-" + k, file: "p" + id + "-" + k + ".jpg" }));
      galleries["story-" + id] = { primary: items[0].id, items };
      for (const it of items) originals[id + "/" + it.id] = Buffer.concat([Buffer.from([0xff, 0xd8]), crypto.randomBytes(300)]);
    }
  }
  const counts = { requests: 0, originals: 0, digests: 0, nonGet: 0, inflight: 0, maxInflight: 0 };
  const fails = Object.assign({}, failFirst);           // path prefix -> number of failures before success
  const delay = () => new Promise(r => setTimeout(r, latencyMs));
  async function answer(method, p, fn) {
    counts.requests++; if (method !== "GET") counts.nonGet++;
    counts.inflight++; counts.maxInflight = Math.max(counts.maxInflight, counts.inflight);
    try {
      await delay();
      for (const k of Object.keys(fails)) if (p.startsWith(k) && fails[k] > 0) { fails[k]--; if (fails[k] % 2) throw new Error("fetch failed"); return { status: 503, body: null }; }
      return fn();
    } finally { counts.inflight--; }
  }
  const live = {
    base: "http://fake",
    transport: (method, p) => answer(method, p, () => {
      if (p === "/api/stories") return { status: 200, body: stories };
      if (p === "/api/story-photos") return { status: 200, body: galleries };
      if (["/api/site", "/api/entities", "/api/photos"].includes(p)) return { status: 200, body: { doc: p } };
      const m = p.match(/^\/api\/stories\/(\d+)$/);
      if (m) { const s = stories.find(x => x.id === Number(m[1])); return s ? { status: 200, body: s } : { status: 404, body: {} }; }
      return { status: 404, body: {} };
    }),
    storedPhotoDigest: (id, item) => answer("GET", "/digest/" + id, () => { counts.digests++; const b = originals[id + "/" + item.id]; return { status: 200, body: { sha256: sha(b), bytes: b.length } }; }),
    readOriginal: (id, pid) => answer("GET", "/original/" + id, () => { counts.originals++; return { status: 200, bytes: originals[id + "/" + pid] }; }),
  };
  return { live, counts, originals };
}
const snapOf = async site => snapLib.takeSnapshot(site.live.transport, site.live.base);
const comparable = dir => { const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); return JSON.stringify({ files: m.files, memories: m.memories, counts: m.counts, problems: m.problems }); };

test("parallel backup = sequential backup (same files, hashes, memories), and it verifies", async () => {
  const site = fakeSite({ records: 30 }), snap = await snapOf(site);
  const a = path.join(tmp(), "a"), b = path.join(tmp(), "b");
  await snapLib.backup(site.live, snap, a, { concurrency: 1 });
  await snapLib.backup(site.live, snap, b, { concurrency: 8 });
  assert.equal(comparable(a), comparable(b));
  assert.equal(snapLib.verifyBackup(b).ok, true, snapLib.verifyBackup(b).problems.join("; "));
  assert.equal(site.counts.nonGet, 0, "backup sends only GETs");
});

test("bounded concurrency: never more parallel reads than asked, and much faster than one at a time", async () => {
  const s1 = fakeSite({ records: 24, latencyMs: 20 }), snap1 = await snapOf(s1);
  let t = Date.now(); await snapLib.backup(s1.live, snap1, path.join(tmp(), "x"), { concurrency: 1 }); const seq = Date.now() - t;
  const s6 = fakeSite({ records: 24, latencyMs: 20 }), snap6 = await snapOf(s6);
  t = Date.now(); await snapLib.backup(s6.live, snap6, path.join(tmp(), "y"), { concurrency: 6 }); const par = Date.now() - t;
  assert.ok(s6.counts.maxInflight <= 6, "max in flight " + s6.counts.maxInflight);
  assert.ok(par * 3 < seq, "parallel " + par + " ms vs sequential " + seq + " ms");
});

test("reuse: identical bytes from an earlier backup are not downloaded again; every digest is still read", async () => {
  const site = fakeSite({ records: 20 }), snap = await snapOf(site);
  const first = path.join(tmp(), "first");
  await snapLib.backup(site.live, snap, first);
  const photos = Object.keys(site.originals).length;
  site.counts.originals = 0; site.counts.digests = 0;
  const second = path.join(tmp(), "second");
  const r = await snapLib.backup(site.live, snap, second, { reuseFrom: [first] });
  assert.equal(site.counts.originals, 0, "no original downloaded");
  assert.equal(site.counts.digests, photos, "every server digest read");
  assert.equal(r.stats.photosReused, photos);
  assert.equal(comparable(first), comparable(second));
  assert.equal(snapLib.verifyBackup(second).ok, true);
});

test("reuse never uses changed bytes: a damaged earlier file is downloaded fresh", async () => {
  const site = fakeSite({ records: 10 }), snap = await snapOf(site);
  const first = path.join(tmp(), "first");
  await snapLib.backup(site.live, snap, first);
  const victim = fs.readdirSync(path.join(first, "images")).map(d => path.join(first, "images", d)).find(d => fs.readdirSync(d).length);
  const f = path.join(victim, fs.readdirSync(victim)[0]);
  fs.writeFileSync(f, Buffer.from("tampered"));
  site.counts.originals = 0;
  const second = path.join(tmp(), "second");
  const r = await snapLib.backup(site.live, snap, second, { reuseFrom: [first] });
  assert.equal(site.counts.originals, 1, "exactly the damaged photo is downloaded");
  assert.equal(r.problems.length, 0);
  assert.equal(snapLib.verifyBackup(second).ok, true);
});

test("an interrupted backup is resumed from its partial folder: downloads are not repeated", async () => {
  const site = fakeSite({ records: 30 }), snap = await snapOf(site);
  const partial = path.join(tmp(), "partial");
  const failing = Object.assign({}, site.live, { transport: async (m, p) => { if (p === "/api/stories/520") throw new Error("fetch failed"); return site.live.transport(m, p); } });
  await assert.rejects(snapLib.backup(failing, snap, partial, { concurrency: 1, retries: 0 }), /fetch failed/);
  assert.ok(!fs.existsSync(path.join(partial, "manifest.json")), "an interrupted folder never looks complete");
  assert.equal(snapLib.verifyBackup(partial).ok, false);
  const downloadedBefore = site.counts.originals;
  site.counts.originals = 0;
  const resumed = path.join(tmp(), "resumed");
  const r = await snapLib.backup(site.live, snap, resumed, { reuseFrom: [partial] });
  assert.ok(downloadedBefore > 0 && r.stats.photosReused >= downloadedBefore, "reused " + r.stats.photosReused + " of " + downloadedBefore);
  assert.equal(site.counts.originals, Object.keys(site.originals).length - r.stats.photosReused);
  assert.equal(snapLib.verifyBackup(resumed).ok, true);
});

test("transient read failures are retried; persistent ones still fail the backup", async () => {
  const site = fakeSite({ records: 8, failFirst: { "/api/stories/50": 3, "/digest/502": 2 } }), snap = await snapOf(site);
  const r = await snapLib.backup(site.live, snap, path.join(tmp(), "ok"), { retries: 3, backoffMs: 1 });
  assert.equal(r.problems.length, 0);
  assert.ok(r.stats.readRetries >= 3, "retries " + r.stats.readRetries);
  const bad = fakeSite({ records: 8, failFirst: { "/api/stories/503": 99 } }), snap2 = await snapOf(bad);
  await assert.rejects(snapLib.backup(bad.live, snap2, path.join(tmp(), "bad"), { retries: 2, backoffMs: 1 }));
});

test("a non-empty target folder is still refused, and the target is never its own reuse source", async () => {
  const site = fakeSite({ records: 3 }), snap = await snapOf(site);
  const d = path.join(tmp(), "d");
  await snapLib.backup(site.live, snap, d);
  await assert.rejects(snapLib.backup(site.live, snap, d, { reuseFrom: [d] }), /not empty/);
  assert.equal(snapLib.reuseIndex([d], d).size(), 0);
});
