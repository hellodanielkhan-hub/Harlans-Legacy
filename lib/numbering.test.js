// Story Number rules (lib/numbering.js) and the public policy / approved map.
//   node --test lib/numbering.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const N = require("./numbering.js");

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const RETIRED = [88, 105, 122, 137, 168, 191, 214, 226, 251, 302, ...range(303, 305), ...range(388, 430)];
// The approved Scenario 2+ map (record id -> Story No.) and the 12 verified Original Blog Numbers.
const MAP = { 404: 3, 406: 6, 407: 14, 408: 16, 409: 17, 410: 32, 411: 33, 412: 36, 413: 40, 414: 42, 415: 48, 416: 71, 417: 74, 418: 77, 419: 79, 420: 91,
  421: 124, 422: 136, 423: 143, 424: 144, 425: 148, 426: 149, 427: 150, 428: 173, 429: 177, 430: 179, 402: 385, 401: 386, 399: 387, 398: 431, 397: 432,
  394: 433, 303: 434, 304: 435, 305: 436, 388: 437, 389: 438, 390: 439, 392: 440, 391: 441, 393: 442, 395: 443, 396: 444, 400: 445, 403: 446, 405: 447 };
const BLOG = { 402: 382, 401: 383, 399: 384, 397: 385, 305: 388, 388: 388, 389: 389, 392: 391, 393: 393, 400: 396, 403: 397, 405: 398 };
const IMPORTED = new Set(range(406, 430));
const imp = postId => ({ system: N.IMPORT_SYSTEM, postId });

// 46 records as they stand before the release: no numbers yet.
const records = () => Object.keys(MAP).map(Number).map(id => ({ id, title: "R" + id, status: id === 404 || IMPORTED.has(id) ? "draft" : "published", featured: id === 405,
  importSource: IMPORTED.has(id) ? imp("T" + id) : undefined }));
const released = () => records().map(s => Object.assign(s, { storyNumber: MAP[s.id], originalBlogNumber: BLOG[s.id] || null }));

test("policy: the 56 retired numbers; 391 historical numbers below 448; new posts start at 448", () => {
  assert.deepEqual([...N.RETIRED], RETIRED);
  for (const n of RETIRED) assert.ok(N.isRetired(n));
  assert.ok(!N.isRetired(447) && !N.isRetired(448) && !N.isRetired(431));
  assert.equal(N.FIRST_NEW_STORY_NUMBER, 448);
  assert.equal(range(1, 447).filter(N.isHistorical).length, 391);
  assert.equal(N.policy().historicalEntries, 391);
  assert.match(N.policy().privateRegistrySha256, /^[0-9a-f]{64}$/);
  assert.match(N.policy().privateAssignmentsSha256, /^[0-9a-f]{64}$/);
});

test("public data: no source-post ids, post dates, Facebook links or titles", () => {
  for (const f of ["story-number-policy.json", "story-number-assignments.json"]) {
    const txt = fs.readFileSync(path.join(__dirname, "..", "data", f), "utf8");
    assert.ok(!/\bP\d{3}\b|sourcePostId|facebook|fbid|"title"/i.test(txt), f);
    assert.deepEqual((txt.match(/\d{4}-\d{2}-\d{2}/g) || []), ["2026-10-31"], f + ": only the adoption date");
  }
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "data", "story-number-registry.json")), "the source registry is not in the repository");
});

test("approved map: the 46 records, unique, none retired, with the 12 Original Blog Numbers", () => {
  const A = N.assignments();
  assert.equal(A.length, 46);
  assert.deepEqual(Object.fromEntries(A.map(a => [a.id, a.storyNumber])), Object.fromEntries(Object.entries(MAP).map(([k, v]) => [Number(k), v])));
  assert.equal(new Set(A.map(a => a.storyNumber)).size, 46);
  for (const a of A) {
    assert.ok(!N.isRetired(a.storyNumber));
    assert.equal(a.originalBlogNumber, BLOG[a.id] || null, "blog number of " + a.id);
    assert.deepEqual(Object.keys(a).sort(), ["id", "originalBlogNumber", "storyNumber"]);
  }
  assert.equal(A.filter(a => a.originalBlogNumber === 388).length, 2, "#388 appears twice (305 and 388)");
});

test("display helpers never fall back to the record id", () => {
  assert.equal(N.storyNo({ id: 405 }), null);
  assert.equal(N.label({ id: 405 }), "");
  assert.equal(N.label({ id: 405, storyNumber: 447 }), "No. 447");
  assert.equal(N.label({ id: 405, storyNumber: 447 }, "No.&nbsp;"), "No.&nbsp;447");
  assert.equal(N.blogNo({ id: 388 }), null);
});

test("writes: retired, duplicate and reserved numbers are refused", () => {
  const all = released();
  const draft = { id: 999, title: "new", status: "draft" };
  assert.match(N.prepareWrite({ storyNumber: 214 }, null, all, [], 999).problems[0], /retired/);
  assert.match(N.prepareWrite({ storyNumber: 405 }, null, all, [], 999).problems[0], /retired/);
  assert.match(N.prepareWrite({ storyNumber: 447 }, null, all, [], 999).problems[0], /already belongs/);
  assert.match(N.prepareWrite({ storyNumber: 9.5 }, null, all, [], 999).problems[0], /whole number/);
  assert.match(N.prepareWrite({ storyNumber: "abc" }, draft, all, [], 999).problems[0], /whole number/);
  assert.deepEqual(N.prepareWrite({ storyNumber: 448 }, null, all, [], 999).problems, []);
  // a historical number that no record holds: only an imported memory may take it
  assert.match(N.prepareWrite({ storyNumber: 1 }, null, all, [], 999).problems[0], /reserved for a historical weekly post/);
  assert.deepEqual(N.prepareWrite({ storyNumber: 1, importSource: imp("X1") }, null, all, [], 999).problems, []);
  // an approved number belongs to its record only, even before the release
  const pre = records();
  assert.match(N.prepareWrite({ storyNumber: 6, importSource: imp("X2") }, null, pre, [], 999).problems[0], /reserved for record 406/);
  assert.match(N.prepareWrite({ storyNumber: 7 }, pre.find(s => s.id === 406), pre, [], 406).problems[0], /approved Story No. is 6/);
  assert.deepEqual(N.prepareWrite({ storyNumber: 6 }, pre.find(s => s.id === 406), pre, [], 406).problems, []);
  assert.deepEqual(N.prepareWrite({ storyNumber: 447 }, pre.find(s => s.id === 405), pre, [], 405).problems, []);
});

test("writes: a Story Number is permanent; a save without the fields keeps both", () => {
  const all = released();
  const s405 = all.find(s => s.id === 405);
  assert.match(N.prepareWrite({ storyNumber: 448 }, s405, all, [], 405).problems[0], /permanent/);
  assert.match(N.prepareWrite({ storyNumber: null }, s405, all, [], 405).problems[0], /permanent/);
  const w = N.prepareWrite({ title: "edited" }, s405, all, [], 405);
  assert.deepEqual(w.problems, []);
  assert.deepEqual(w.apply({ title: "edited" }), { title: "edited", storyNumber: 447, originalBlogNumber: 398 });
  const same = N.prepareWrite({ storyNumber: 447, originalBlogNumber: 398 }, s405, all, [], 405);
  assert.deepEqual(same.problems, []);
  assert.equal(same.apply({}).storyNumber, 447);
});

test("writes: Original Blog Numbers are separate and may repeat", () => {
  const all = released();
  const w = N.prepareWrite({ originalBlogNumber: 388 }, all.find(s => s.id === 389), all, [], 389);
  assert.deepEqual(w.problems, []);
  assert.equal(w.apply({}).originalBlogNumber, 388);
  assert.equal(w.apply({}).storyNumber, 438, "changing the blog number never touches the Story Number");
});

test("writes: publishing needs a Story Number; existing published records stay editable", () => {
  const all = records();
  const d = all.find(s => s.id === 406);
  assert.match(N.prepareWrite({ status: "published" }, d, all, [], 406).problems[0], /required before a memory is published/);
  assert.deepEqual(N.prepareWrite({ status: "published", storyNumber: 6 }, d, all, [], 406).problems, []);
  assert.deepEqual(N.prepareWrite({ status: "published", title: "x" }, all.find(s => s.id === 405), all, [], 405).problems, []);
});

test("issued numbers are never issued again; the next new number skips retired and issued ones", () => {
  const all = released();
  assert.equal(N.nextNewStoryNumber(all, []), 448);
  assert.equal(N.nextNewStoryNumber(all, [448, 449]), 450);
  assert.match(N.prepareWrite({ storyNumber: 448 }, null, all, [448], 999).problems[0], /issued before/);
  assert.deepEqual(N.withIssued({ issued: [448] }, [448]), null);
  assert.deepEqual(N.withIssued(null, [449, 448, 449]).issued, [448, 449]);
});

test("release plan: 46 writes of exactly the two fields; idempotent; refuses conflicts", () => {
  const plan = N.checkRelease(records());
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.writes.length, 46);
  for (const w of plan.writes) assert.deepEqual(Object.keys(w.set).sort(), ["originalBlogNumber", "storyNumber"]);
  assert.equal(N.checkRelease(released()).writes.length, 0);
  const conflict = records(); conflict.find(s => s.id === 405).storyNumber = 500;
  assert.match(N.checkRelease(conflict).problems[0], /record 405 already has Story No. 500/);
  const blogConflict = records(); blogConflict.find(s => s.id === 389).originalBlogNumber = 1;
  assert.match(N.checkRelease(blogConflict).problems[0], /Original Blog No. 1/);
  const missing = records().filter(s => s.id !== 430);
  assert.match(N.checkRelease(missing).problems[0], /record 430 is missing/);
  const squatter = records().concat([{ id: 999, title: "x", status: "draft", storyNumber: 6, importSource: imp("X3") }]);
  assert.match(N.checkRelease(squatter).problems.join(" "), /record 406: Story No. 6 already belongs to another memory/);
  assert.match(N.assignmentsFingerprint(), /^[0-9a-f]{64}$/);
});
