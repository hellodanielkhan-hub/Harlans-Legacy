/* The private registry checks (tools/story-numbers/lib/private-registry.js), on synthetic files; and, when
   HL_STORY_REGISTRY_DIR points at the real private folder (kept outside the repository), on the real files.
     node --test tools/story-numbers/test/private-registry.test.js */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const fx = require("./fixture.js");
const reg = require("../lib/private-registry.js");
const numbering = require(path.join(fx.WT, "lib", "numbering.js"));

const { root, registryDir } = fx.makeRoot();
test.after(() => fx.removeRoot(root));
const files = () => ({ r: JSON.parse(fs.readFileSync(path.join(registryDir, reg.REGISTRY_FILE), "utf8")), m: JSON.parse(fs.readFileSync(path.join(registryDir, reg.ASSIGNMENTS_FILE), "utf8")) });

test("a consistent registry loads; the hash guard refuses files that are not the recorded ones", () => {
  const r = reg.load(registryDir, { expectHashes: false });
  assert.equal(r.entries, 391);
  assert.equal(r.numberFor(r.sourceOfRecord(406)), 6);
  assert.equal(r.numberFor("not-a-post"), null);
  assert.throws(() => reg.load(registryDir), /not the registry the public policy was derived from/);
  assert.throws(() => reg.load(null), /required/);
});

test("rule violations are refused", () => {
  const cases = {
    "a renumbered entry": ({ r }) => { r.entries[10].storyNumber = 999; },
    "entries out of date order": ({ r }) => { const d = r.entries[5].date; r.entries[5].date = r.entries[6].date; r.entries[6].date = d; },
    "a missing entry": ({ r }) => { r.entries.pop(); },
    "a source post twice": ({ r }) => { r.entries[3].sourcePostId = r.entries[4].sourcePostId; },
    "a different retired set": ({ r }) => { r.retired = r.retired.slice(1); },
    "a private map that differs from the public one": ({ m }) => { m.assignments[0].storyNumber = 1; },
    "an approved number that is not its source post's registry number": ({ m }) => { m.assignments[0].sourcePostId = "S999"; }
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const f = files(); mutate(f);
    assert.ok(reg.problemsOf(f.r, f.m).length > 0, name + " must be refused");
  }
  const f = files(); assert.deepEqual(reg.problemsOf(f.r, f.m), []);
});

const REAL = process.env.HL_STORY_REGISTRY_DIR;
test("the real private registry (local only)", { skip: !REAL && "HL_STORY_REGISTRY_DIR not set" }, () => {
  const r = reg.load(REAL);                     // hashes against data/story-number-policy.json, rule, map, sources
  assert.equal(r.entries, numbering.policy().historicalEntries);
  for (const a of numbering.assignments()) assert.equal(r.numberFor(r.sourceOfRecord(a.id)), a.storyNumber, "record " + a.id);
});
