import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { normalizeKanbanQuery, cardMatchesQuery, highlightKanbanText, kanbanDescriptionExcerpt, searchKanbanBoard, kanbanSearchForProject, kanbanSearchForJump } = await jiti.import("./kanban-search.ts");
const card = (id, laneId, title, description = "") => ({ id, laneId, title, description, sessionId: "session-secret", sessionTitle: "Hidden session title", createdAt: 1, updatedAt: 1 });
const board = {
  projectDir: "/project",
  lanes: [{ id: "a", name: "Backlog", fixed: true }, { id: "b", name: "Plan" }, { id: "empty", name: "Empty" }],
  cards: [card("1", "a", "Fix AUTH", "Read docs"), card("2", "b", "Unrelated", "late auth match"), card("3", "a", "Other")],
};

test("trimmed, case-insensitive literal matching of title OR description only", () => {
  assert.equal(normalizeKanbanQuery(" \tAuTh\n"), "auth");
  for (const query of ["", "   ", "auth", " AUTH ", "docs"]) assert.equal(cardMatchesQuery(board.cards[0], query), true, query);
  for (const query of ["session-secret", "Hidden session title", "1", "AUTH Read", "AUTHRead", "AUTH|docs", "a.*h"]) assert.equal(cardMatchesQuery(board.cards[0], query), false, query);
  assert.equal(cardMatchesQuery(card("x", "a", "Use [a.*] + $"), "[a.*]"), true);
  assert.equal(cardMatchesQuery(card("x", "a", "修复搜尋 🚀"), "搜尋 🚀"), true);
});

test("projection preserves all lanes, card order and canonical identities without mutation", () => {
  const before = JSON.stringify(board);
  const result = searchKanbanBoard(board, " AUTH ");
  assert.equal(result.active, true);
  assert.equal(result.matched, 2);
  assert.equal(result.total, 3);
  assert.deepEqual(result.lanes.map(({ lane, cards, total }) => [lane.id, cards.map(c => c.id), total]), [["a", ["1"], 2], ["b", ["2"], 1], ["empty", [], 0]]);
  assert.equal(result.lanes[0].lane, board.lanes[0]);
  assert.equal(result.lanes[0].cards[0], board.cards[0]);
  assert.equal(JSON.stringify(board), before);
  const cleared = searchKanbanBoard(board, "  ");
  assert.equal(cleared.active, false);
  assert.deepEqual(cleared.lanes[0].cards.map(c => c.id), ["1", "3"]);
});

test("an edited nonmatch remains rendered in place but never inflates match counts", () => {
  const result = searchKanbanBoard(board, "auth", "3");
  assert.deepEqual(result.lanes[0].renderedCards.map(c => c.id), ["1", "3"]);
  assert.equal(result.lanes[0].cards.length, 1);
  assert.equal(result.matched, 2);
  assert.deepEqual(searchKanbanBoard(board, "auth").lanes[0].renderedCards.map(c => c.id), ["1"], "Save/Cancel drops the pinned nonmatch");
  assert.equal(searchKanbanBoard(board, "nope", "1").matched, 0);
  assert.deepEqual(searchKanbanBoard(board, "nope", "1").lanes[0].renderedCards.map(c => c.id), ["1"]);
  assert.deepEqual(searchKanbanBoard(board, "nope", "deleted").lanes[0].renderedCards, []);
});

test("highlight parts are literal original text, all occurrences, no HTML interpretation", () => {
  assert.deepEqual(highlightKanbanText("<script>[a.*] [A.*]</script>", "[a.*]"), [
    { text: "<script>", match: false }, { text: "[a.*]", match: true }, { text: " ", match: false }, { text: "[A.*]", match: true }, { text: "</script>", match: false },
  ]);
  assert.deepEqual(highlightKanbanText("Auth", "  "), [{ text: "Auth", match: false }]);
  assert.deepEqual(highlightKanbanText("", "x"), []);
});

test("Unicode lowercase expansions never shift highlights or split astral characters", () => {
  for (const [text, query, matches] of [
    ["İ before AUTH 🚀", "auth", ["AUTH"]],
    ["İx", "i", ["İ"]],
    ["İx", "i\u0307", ["İ"]],
    ["🚀修复 🚀", "🚀", ["🚀", "🚀"]],
    ["ΟΣ", "ος", ["ΟΣ"]],
  ]) {
    const parts = highlightKanbanText(text, query);
    assert.equal(parts.map(p => p.text).join(""), text);
    assert.deepEqual(parts.filter(p => p.match).map(p => p.text), matches);
  }
});

test("description excerpts center late matches, preserve the full query and use code-point boundaries", () => {
  const text = "🚀".repeat(160) + " AUTH " + "界".repeat(160);
  const excerpt = kanbanDescriptionExcerpt(text, "auth", 60);
  assert.ok(excerpt.text.includes("AUTH"));
  assert.equal(excerpt.leading, true);
  assert.equal(excerpt.trailing, true);
  assert.equal(Array.from(excerpt.text).length, 60);
  assert.ok(excerpt.text.isWellFormed());
  const long = "界".repeat(100);
  assert.ok(kanbanDescriptionExcerpt("prefix " + long + " suffix", long, 40).text.includes(long));
  assert.deepEqual(kanbanDescriptionExcerpt("short auth", "auth"), { text: "short auth", leading: false, trailing: false });
  assert.deepEqual(kanbanDescriptionExcerpt("abcdef", "nope", 3), { text: "abc", leading: false, trailing: true });
  assert.deepEqual(kanbanDescriptionExcerpt("", "auth"), { text: "", leading: false, trailing: false });
});

test("query lifetime: same project/chat round-trip retains, project change/reload clears, hidden jumps clear", () => {
  const state = { projectDir: "/project", query: " auth " };
  assert.equal(kanbanSearchForProject(state, "/project"), state);
  const away = kanbanSearchForProject(state, "/other");
  assert.deepEqual(away, { projectDir: "/other", query: "" });
  assert.equal(kanbanSearchForProject(away, "/project").query, "");
  assert.equal(kanbanSearchForProject({ projectDir: null, query: "" }, "/project").query, "");
  assert.equal(kanbanSearchForJump(state, "/project", board.cards[0]), state);
  assert.equal(kanbanSearchForJump(state, "/project", board.cards[2]).query, "");
  assert.equal(kanbanSearchForJump(state, "/project", null).query, "", "an explicit jump before data arrives must not remain hidden");
  assert.equal(state.query, " auth ");
});
