"use strict";
/* Hashtag-only lines in an import text: intentionally preserved original lines vs unapproved changes.
     node --test tools/facebook-import/test/retained-lines.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const { unapprovedHashtagLines } = require("../lib/retained-lines.js");
const { toStory } = require("../lib/text.js");

test("an interior hashtag-only line is the author's text and is accepted (P361-type)", () => {
  assert.deepEqual(unapprovedHashtagLines(["Shabbat Shalom — Episode 355", "#HarlansLegacy #ShabbatShalom #255075", "The story continues."], []), []);
  assert.deepEqual(unapprovedHashtagLines(["Opening.", "#HarlansLegacy #ShabbatShalom #relections", "Peace, Love & Equality For All!"], []), []);
});

test("an opening or closing hashtag-only line that was not approved is reported (the removal rule was skipped)", () => {
  const r = unapprovedHashtagLines(["#HarlansLegacy #ShabbatShalom #Badge", "A badge.", "#Tag1 #Tag2"], []);
  assert.deepEqual(r.map(x => [x.position, x.line]), [["start", "#HarlansLegacy #ShabbatShalom #Badge"], ["end", "#Tag1 #Tag2"]]);
});

test("edge lines the owner approved keeping (keepLines, exact) are accepted; others in the same run are still reported", () => {
  const p = ["#HarlansLegacy #shabbatshalom #thelegendofzelda #Week233", "#Another #Tag", "Story text.", "#Closing"];
  const r = unapprovedHashtagLines(p, ["#HarlansLegacy #shabbatshalom #thelegendofzelda #Week233", "#Closing"]);
  assert.deepEqual(r.map(x => x.line), ["#Another #Tag"]);
  assert.deepEqual(unapprovedHashtagLines(p, ["#HarlansLegacy #shabbatshalom #thelegendofzelda #Week233", "#Another #Tag", "#Closing"]), []);
});

test("typo'd opening tag lines count as hashtag-only and need explicit approval", () => {
  for (const l of ["#HarlansLegacy #ShabbatShalom#TheTable", "#HarlansLegacy##ShabbatShalom #Switch", "#HarlansLegacy. #shabbatshalom#Horn"]) {
    assert.equal(unapprovedHashtagLines([l, "Text."], []).length, 1, l);
    assert.deepEqual(unapprovedHashtagLines([l, "Text."], [l]), [], l);
  }
});

test("a line with words is not hashtag-only (e.g. Hal's Blog Issue header with hashtags)", () => {
  assert.deepEqual(unapprovedHashtagLines(["#HarlansLegacy #ShabbatShalom Blog Issue #377", "Let's reflect!"], []), []);
  assert.deepEqual(unapprovedHashtagLines(["Shabbat Shalom #329", "#HarlansLegacy #shabbatshalom #ChallahBackGirl", "Text."], []), []);
});

test("agrees with the importer: toStory's output never has an unapproved edge hashtag line, with or without keepLines", () => {
  const src = "#HarlansLegacy #ShabbatShalom #Pesach\nWhy is this night different?\n#HarlansLegacy #mid #line\nThe end.\n#Closing #Tags";
  assert.deepEqual(unapprovedHashtagLines(toStory(src, "X").paragraphs, []), []);
  const kept = ["#HarlansLegacy #ShabbatShalom #Pesach", "#Closing #Tags"];
  const withKeep = toStory(src, "X", { keepLines: kept }).paragraphs;
  assert.equal(withKeep[0], kept[0]); assert.equal(withKeep[withKeep.length - 1], kept[1]);
  assert.deepEqual(unapprovedHashtagLines(withKeep, kept), [], "kept lines are approved");
  assert.equal(unapprovedHashtagLines(withKeep, []).length, 2, "the same text without the approval is reported");
});

test("an unauthorized change is caught: an edge hashtag line added to a text that had none", () => {
  const original = toStory("#A #B\nThe story.", "X").paragraphs;
  assert.deepEqual(unapprovedHashtagLines(original, []), []);
  assert.equal(unapprovedHashtagLines(original.concat(["#Injected #Line"]), []).length, 1);
});
