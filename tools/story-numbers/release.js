#!/usr/bin/env node
/* Story Number release (Scenario 2+) and Batch 1 publication for https://www.harlanslegacy.com.
   Two separate operations; run the second only after the first has completed and the site has rebuilt.

   Offline (no network, no token):
     node tools/story-numbers/release.js plan --stories <stories.json>
       What the release would write for a saved GET /api/stories list, and any reason it would refuse.
     node tools/story-numbers/release.js check-registry --registry <private folder>
       Verifies the private registry against the public policy and map (hashes, rule, sources).

   Read-only, public site (no token):
     node tools/story-numbers/release.js verify-public

   Production (interactive; the admin token is entered once per operation at a hidden prompt):
     node tools/story-numbers/release.js release-numbers --registry <private folder> --payload <batch-01-import-payload.json> --backup <empty dir> --ledger <file.jsonl>
     node tools/story-numbers/release.js publish-batch-1 --registry <private folder> --payload <batch-01-import-payload.json> --backup <another empty dir> --ledger <file.jsonl>
     node tools/story-numbers/release.js publish-batch --payload <batch-NN-import-payload.json> --fingerprint <approved payload fingerprint>
                                         --import-ledger <that batch's import ledger.jsonl> --backup <empty dir> --ledger <file.jsonl>
       (batches 02 and later, Unnumbered Publishing Mode; one batch per run)
   See lib/run.js for exactly what each one checks and writes. */
"use strict";

const fs = require("fs");
const path = require("path");
const numbering = require(path.join(__dirname, "..", "..", "lib", "numbering.js"));
const privateRegistry = require("./lib/private-registry.js");
const { Ledger } = require(path.join(__dirname, "..", "facebook-import", "lib", "ledger.js"));
const { ttyIo } = require(path.join(__dirname, "..", "facebook-import", "lib", "authorize.js"));
const { PRODUCTION_ORIGIN } = require(path.join(__dirname, "..", "facebook-import", "lib", "transport.js"));

function args() {
  const a = { _: [] };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i].startsWith("--")) { const k = v[i].slice(2); a[k] = v[i + 1] && !v[i + 1].startsWith("--") ? v[++i] : true; }
    else a._.push(v[i]);
  }
  return a;
}
const need = (a, k) => { if (!a[k] || a[k] === true) throw new Error("--" + k + " is required"); return a[k]; };
const OPERATIONS = { "release-numbers": "release", "publish-batch-1": "publish" };

async function main() {
  const a = args(), cmd = a._[0];
  if (a.api !== undefined || a.base !== undefined) throw new Error("the destination is fixed to " + PRODUCTION_ORIGIN + "; nothing was sent");

  if (cmd === "plan") {
    const stories = JSON.parse(fs.readFileSync(need(a, "stories"), "utf8"));
    const plan = numbering.checkRelease(stories);
    console.log(JSON.stringify({ fingerprint: numbering.assignmentsFingerprint(), writes: plan.writes, problems: plan.problems, alreadyAssigned: numbering.assignments().length - plan.writes.length }, null, 1));
    process.exitCode = plan.problems.length ? 1 : 0; return;
  }
  if (cmd === "check-registry") {
    const r = privateRegistry.load(need(a, "registry"));
    console.log("private registry verified: " + r.entries + " entries; hashes, numbering rule and the 46-record map all match");
    return;
  }
  if (cmd === "verify-public") {
    const { verifyPublic, publicStories } = require("./lib/run.js");
    const list = (await publicStories(globalThis.fetch, PRODUCTION_ORIGIN)).filter(s => s.published);
    const v = await verifyPublic(globalThis.fetch, PRODUCTION_ORIGIN, list.map(s => ({ id: s.id, storyNumber: s.storyNumber, slug: s.slug })));
    console.log(JSON.stringify({ origin: PRODUCTION_ORIGIN, published: list.length, problems: v.problems }, null, 1));
    process.exitCode = v.problems.length ? 1 : 0; return;
  }

  if (cmd === "publish-batch") {
    const run = require("./lib/run.js");
    const { createLiveTransport } = require("./lib/transport.js");
    const payload = JSON.parse(fs.readFileSync(need(a, "payload"), "utf8"));
    const approvedFingerprint = String(need(a, "fingerprint"));
    if (!/^[0-9a-f]{64}$/.test(approvedFingerprint)) throw new Error("--fingerprint must be the 64-character payload fingerprint; nothing was sent");
    const importEntries = new Ledger(need(a, "import-ledger")).read();
    const backupDir = need(a, "backup"), ledgerPath = need(a, "ledger");
    if (fs.existsSync(backupDir) && fs.readdirSync(backupDir).length) throw new Error("the backup folder is not empty: " + backupDir + "; nothing was sent");
    const io = ttyIo();
    if (!io.isTTY) throw new Error("needs an interactive terminal for the hidden token prompt");
    console.log("Operation: publish-batch (batch " + payload.batch + ")   Destination: " + PRODUCTION_ORIGIN + " (the admin token is sent only here, in a header)");
    const live = createLiveTransport({ token: await io.askHidden("Admin token (input hidden): "), operation: "publish-batch" });
    let report;
    try { report = await run.publishBatch({ live, io, backupDir, ledger: new Ledger(ledgerPath), payload, approvedFingerprint, importEntries, origin: PRODUCTION_ORIGIN }); }
    finally { live.close(); }
    const out = path.join(path.dirname(ledgerPath), "publish-batch-" + String(payload.batch).padStart(2, "0") + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
    fs.writeFileSync(out, JSON.stringify(report, null, 1));
    console.log((report.stopped ? "\nSTOPPED at " + report.stage + ": " + report.stopped : "\nCompleted.") + "\nReport: " + out);
    process.exitCode = report.stopped ? 1 : 0; return;
  }

  if (OPERATIONS[cmd]) {
    const run = require("./lib/run.js");
    const { createLiveTransport } = require("./lib/transport.js");
    const registry = privateRegistry.load(need(a, "registry"));          // refuses before any network call
    const payload = JSON.parse(fs.readFileSync(need(a, "payload"), "utf8"));
    const backupDir = need(a, "backup"), ledgerPath = need(a, "ledger");
    const io = ttyIo();
    if (!io.isTTY) throw new Error("needs an interactive terminal for the hidden token prompt");
    console.log("Operation: " + cmd + "   Destination: " + PRODUCTION_ORIGIN + " (the admin token is sent only here, in a header)");
    console.log("Map fingerprint: " + numbering.assignmentsFingerprint() + "   Private registry: verified (" + registry.entries + " entries)");
    const live = createLiveTransport({ token: await io.askHidden("Admin token (input hidden): "), operation: OPERATIONS[cmd] });
    let report;
    try {
      const opts = { live, io, backupDir, ledger: new Ledger(ledgerPath), payload, registry, origin: PRODUCTION_ORIGIN };
      report = cmd === "release-numbers" ? await run.releaseNumbers(opts) : await run.publishBatch1(opts);
    } finally { live.close(); }
    const out = path.join(path.dirname(ledgerPath), cmd + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
    fs.writeFileSync(out, JSON.stringify(report, null, 1));
    console.log((report.stopped ? "\nSTOPPED at " + report.stage + ": " + report.stopped : "\nCompleted.") + "\nReport: " + out);
    process.exitCode = report.stopped ? 1 : 0; return;
  }

  console.error("usage: node tools/story-numbers/release.js plan | check-registry | verify-public | release-numbers | publish-batch-1 | publish-batch   (see the header)");
  process.exitCode = 2;
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
