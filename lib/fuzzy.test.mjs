import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const fuzzy = await jiti.import("./fuzzy.ts");

// The palette's matcher: the tier decides the order, so the tiers are pinned
// here (a title that starts with the query beats one that only contains it),
// and so is the rule that every term of a query must land somewhere.

test("an equal text is an exact match", () => {
  const match = fuzzy.fuzzyMatch("kanban", "kanban");
  assert.equal(match.tier, "exact");
  assert.equal(match.score, fuzzy.FUZZY_TIER_SCORE.exact);
});

test("a text that starts with the query is a prefix match", () => {
  const match = fuzzy.fuzzyMatch("ses", "session-fork.ts");
  assert.equal(match.tier, "prefix");
  assert.deepEqual(match.positions, [0, 1, 2]);
});

test("a query at a word boundary is a word match", () => {
  const match = fuzzy.fuzzyMatch("fork", "session-fork.ts");
  assert.equal(match.tier, "word");
  assert.deepEqual(match.positions, [8, 9, 10, 11]);
});

test("a camelCase hump is a word match", () => {
  const match = fuzzy.fuzzyMatch("Board", "KanbanBoard.tsx");
  assert.equal(match.tier, "word");
  assert.deepEqual(match.positions, [6, 7, 8, 9, 10]);
});

test("camelCase initials match as a word", () => {
  const match = fuzzy.fuzzyMatch("kb", "KanbanBoard.tsx");
  assert.equal(match.tier, "word");
  assert.deepEqual(match.positions, [0, 6]);
});

test("a query inside a word is a substring match", () => {
  const match = fuzzy.fuzzyMatch("ban", "KanbanBoard.tsx");
  assert.equal(match.tier, "substring");
});

test("letters in order with gaps are a subsequence match", () => {
  const match = fuzzy.fuzzyMatch("kbn", "KanbanBoard.tsx");
  assert.equal(match.tier, "subsequence");
  assert.deepEqual(match.positions, [0, 3, 5]);
});

test("one edit away from a word is a typo match", () => {
  const match = fuzzy.fuzzyMatch("sesion", "the session list");
  assert.equal(match.tier, "typo");
  assert.deepEqual(match.positions, [4, 5, 6, 7, 8, 9, 10]);
});

test("a query that is nowhere does not match", () => {
  assert.equal(fuzzy.fuzzyMatch("zzz", "KanbanBoard.tsx"), null);
});

test("every term of a query must match", () => {
  assert.equal(fuzzy.fuzzyMatch("kanban drag", "kanban board"), null);
  const match = fuzzy.fuzzyMatch("kanban drag", "kanban card drag");
  assert.ok(match);
  assert.equal(match.tier, "word");
});

test("a query's tier is its weakest term's tier", () => {
  const match = fuzzy.fuzzyMatch("kanban sesion", "kanban session");
  assert.equal(match.tier, "typo");
});

test("the tiers are ordered from the best to the worst", () => {
  assert.ok(fuzzy.fuzzyTierRank("exact") < fuzzy.fuzzyTierRank("prefix"));
  assert.ok(fuzzy.fuzzyTierRank("prefix") < fuzzy.fuzzyTierRank("word"));
  assert.ok(fuzzy.fuzzyTierRank("word") < fuzzy.fuzzyTierRank("substring"));
  assert.ok(fuzzy.fuzzyTierRank("substring") < fuzzy.fuzzyTierRank("subsequence"));
  assert.ok(fuzzy.fuzzyTierRank("subsequence") < fuzzy.fuzzyTierRank("typo"));
});

test("matched positions are inside the text and ascending", () => {
  const match = fuzzy.fuzzyMatch("drag", "fix kanban card drag ghost");
  assert.ok(match);
  for (const position of match.positions) {
    assert.ok(position >= 0 && position < "fix kanban card drag ghost".length);
  }
  assert.deepEqual([...match.positions].sort((a, b) => a - b), match.positions);
});

test("a term matches case-insensitively", () => {
  assert.equal(fuzzy.fuzzyMatch("KANBAN", "kanban").tier, "exact");
});

test("one edit apart is one edit apart", () => {
  assert.equal(fuzzy.isOneEditApart("session", "sesion"), true);
  assert.equal(fuzzy.isOneEditApart("session", "sessions"), true);
  assert.equal(fuzzy.isOneEditApart("session", "session"), false);
  assert.equal(fuzzy.isOneEditApart("session", "sesxion"), true);
  assert.equal(fuzzy.isOneEditApart("session", "sesiorn"), false);
});

test("letters scattered over prose stay a subsequence", () => {
  // "drag" over ordinary words: the letters are there, but they are not a
  // word, and prose's word-initial capitals must not make it one.
  const match = fuzzy.fuzzyMatch("drag", "Board smoke test. Do exactly this, in order, and nothing else");
  assert.equal(match.tier, "subsequence");
});
