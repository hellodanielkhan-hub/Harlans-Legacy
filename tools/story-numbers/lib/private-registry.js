/* The private Story Number registry: which historical weekly post owns each reserved number.

   Kept OUTSIDE the public repository (it lists internal source-post ids and dates, including posts on
   hold). Used only by local tools: the importer (to give a new Draft its reserved number) and the release
   tool (to prove the approved map and Batch 1 trace back to the registry). The public code only knows the
   policy (retired numbers, first new number) and the approved map by record id.

   A folder holding two files:
     story-number-registry.full.json      { retired, policy, entries: [{ position, sourcePostId, date, storyNumber, … }] }
     story-number-assignments.full.json   { assignments: [{ id, storyNumber, originalBlogNumber, sourcePostId }] }
   load() refuses the folder unless both files have exactly the SHA-256 recorded in the public
   data/story-number-policy.json, the registry follows the numbering rule, and the private map equals the
   public data/story-number-assignments.json with every source matching the registry entry of its number. */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const numbering = require(path.join(__dirname, "..", "..", "..", "lib", "numbering.js"));

const REGISTRY_FILE = "story-number-registry.full.json";
const ASSIGNMENTS_FILE = "story-number-assignments.full.json";
const sha = b => crypto.createHash("sha256").update(b).digest("hex");

// Every problem with the two parsed files against the public policy and map (empty = consistent).
function problemsOf(reg, map) {
  const problems = [];
  const E = (reg && reg.entries) || [];
  const pol = numbering.policy();
  if (E.length !== pol.historicalEntries) problems.push("registry has " + E.length + " entries, the policy says " + pol.historicalEntries);
  const retired = [...((reg && reg.retired) || [])].sort((a, b) => a - b);
  if (JSON.stringify(retired) !== JSON.stringify(numbering.RETIRED)) problems.push("registry retired set differs from the policy");
  let n = 0;
  E.forEach((e, i) => {
    n++; while (numbering.isRetired(n)) n++;
    if (e.position !== i + 1) problems.push("entry " + (i + 1) + " has position " + e.position);
    if (e.storyNumber !== n) problems.push("entry " + (i + 1) + " has Story No. " + e.storyNumber + ", the rule gives " + n);
    if (i && !(String(e.date) > String(E[i - 1].date))) problems.push("entry " + (i + 1) + " is not after entry " + i);
  });
  if (n >= numbering.FIRST_NEW_STORY_NUMBER) problems.push("registry numbers reach " + n + ", the first new number is " + numbering.FIRST_NEW_STORY_NUMBER);
  if (new Set(E.map(e => e.sourcePostId)).size !== E.length) problems.push("a source post appears twice in the registry");
  const byNumber = new Map(E.map(e => [e.storyNumber, e]));
  const priv = (map && map.assignments) || [];
  const pub = numbering.assignments();
  if (priv.length !== pub.length) problems.push("private map has " + priv.length + " rows, the public map " + pub.length);
  for (const a of pub) {
    const p = priv.find(x => x.id === a.id);
    if (!p) { problems.push("record " + a.id + " is missing from the private map"); continue; }
    if (p.storyNumber !== a.storyNumber || (p.originalBlogNumber == null ? null : p.originalBlogNumber) !== a.originalBlogNumber)
      problems.push("record " + a.id + ": private and public maps differ");
    const e = byNumber.get(a.storyNumber);
    if (!e || e.sourcePostId !== p.sourcePostId) problems.push("record " + a.id + ": Story No. " + a.storyNumber + " is not the registry number of its source post");
  }
  return problems;
}

function build(reg, map) {
  const bySource = new Map(reg.entries.map(e => [e.sourcePostId, e]));
  const sourceById = new Map(map.assignments.map(a => [a.id, a.sourcePostId]));
  return {
    entries: reg.entries.length,
    // the Story Number reserved for a source post, or null when the post is not in the registry
    numberFor: postId => { const e = bySource.get(postId); return e ? e.storyNumber : null; },
    // the source post the approved map derived a record's number from
    sourceOfRecord: id => sourceById.get(id) || null
  };
}

/* Load and verify the private folder. opts.expectHashes (default true) checks the two files against the
   SHA-256 values in the public policy; tests pass synthetic files with opts.expectHashes = false. */
function load(dir, opts) {
  opts = opts || {};
  if (!dir || dir === true) throw new Error("the private registry folder is required (--registry <folder>)");
  const rb = fs.readFileSync(path.join(dir, REGISTRY_FILE)), mb = fs.readFileSync(path.join(dir, ASSIGNMENTS_FILE));
  const problems = [];
  if (opts.expectHashes !== false) {
    const pol = numbering.policy();
    if (sha(rb) !== pol.privateRegistrySha256) problems.push(REGISTRY_FILE + " is not the registry the public policy was derived from");
    if (sha(mb) !== pol.privateAssignmentsSha256) problems.push(ASSIGNMENTS_FILE + " is not the map the public policy was derived from");
  }
  const reg = JSON.parse(rb.toString("utf8")), map = JSON.parse(mb.toString("utf8"));
  problems.push(...problemsOf(reg, map));
  if (problems.length) throw new Error("private registry refused: " + problems.join("; "));
  return build(reg, map);
}

module.exports = { load, problemsOf, REGISTRY_FILE, ASSIGNMENTS_FILE };
