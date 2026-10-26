import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseKanbanToolRequest, applyKanbanToolMutation, kanbanToolRead, kanbanToolMutationResult } = await jiti.import("./kanban-tool-domain.ts");
const { defaultLanes } = await jiti.import("./kanban-types.ts");
const actor = { sessionId: "actor", sessionTitle: "Actor" };
const card = (id, laneId = "lane-backlog", sessionId = null) => ({ id, laneId, sessionId, sessionTitle: sessionId, title: id, description: "description", createdAt: 1, updatedAt: 1 });
const board = (...cards) => ({ projectDir: "/project", lanes: defaultLanes(), cards });
const apply = (b, request, who = actor, id = "new") => applyKanbanToolMutation(b, request, who, 42, id);

for (const input of [null, [], {}, { action: "advance" }, { action: "read", title: "x" }, { action: "read", cwd: "/elsewhere" }, { action: "read", cardId: "" }, { action: "create", cardId: "x", title: "x" }, { action: "create" }, { action: "create", title: "  " }, { action: "create", title: 4 }, { action: "update" }, { action: "update", cardId: "x" }, { action: "update", title: "\n " }, { action: "update", description: null }, { action: "update", laneId: " " }, { action: "update", title: "x", advance: true }, { action: "update", title: "x", sessionId: "other" }, JSON.parse('{"action":"read","__proto__":{}}')]) {
  test(`invalid parameters: ${JSON.stringify(input)}`, () => {
    const result = parseKanbanToolRequest(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid-request");
    assert.ok(result.error.length);
  });
}

test("valid flat requests retain omitted fields and allow clearing description", () => {
  for (const request of [{ action: "read" }, { action: "read", cardId: "x" }, { action: "create", title: "task" }, { action: "update", description: "" }, { action: "update", cardId: "x", title: "t", laneId: "lane-todo" }]) {
    assert.deepEqual(parseKanbanToolRequest(request), { ok: true, request });
  }
});

test("create defaults to sessionless backlog even when actor already owns work", () => {
  const b = board(card("own", "lane-todo", "actor"));
  const result = apply(b, { action: "create", title: " New ", description: " D " });
  assert.equal(result.ok, true);
  assert.equal(result.cardId, "new");
  assert.deepEqual(result.board.cards[1], { ...card("new"), title: "New", description: "D", sessionTitle: null, createdAt: 42, updatedAt: 42 });
  assert.equal(result.board.cards[0], b.cards[0]);
  assert.equal(apply(b, { action: "create", title: "another", laneId: "lane-plan" }).ok, false);
});

test("work-lane creation attaches only the actor, never replaces its other link", () => {
  const result = apply(board(), { action: "create", title: "task", laneId: "lane-plan" });
  assert.equal(result.board.cards[0].sessionId, "actor");
  assert.equal(result.board.cards[0].sessionTitle, "Actor");
  assert.equal(result.board.cards[0].laneId, "lane-plan");
});

test("claim, patch and move are one immutable change; moves append in target lane", () => {
  const b = board(card("a"), card("b", "lane-todo", "other"), card("c"));
  const before = structuredClone(b);
  const result = apply(b, { action: "update", cardId: "a", title: " Edited ", description: "", laneId: "lane-todo" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.board.cards.map((c) => c.id), ["b", "a", "c"]);
  assert.deepEqual(result.board.cards[1], { ...b.cards[0], title: "Edited", description: "", laneId: "lane-todo", sessionId: "actor", sessionTitle: "Actor", updatedAt: 42 });
  assert.deepEqual(b, before);
});

test("same-lane retry never reorders, updates timestamps, or replaces the board", () => {
  const b = board(card("a", "lane-todo", "actor"), card("b", "lane-todo", "other"));
  assert.equal(apply(b, { action: "update", laneId: "lane-todo" }).board, b);
  assert.equal(apply(b, { action: "update", title: " a ", description: "description" }).board, b);
});

test("an explicit same work lane claims a free card without reordering", () => {
  const b = board(card("a", "lane-todo"), card("b", "lane-todo", "other"));
  const result = apply(b, { action: "update", cardId: "a", laneId: "lane-todo" });
  assert.equal(result.board.cards[0].sessionId, "actor");
  assert.deepEqual(result.board.cards.map((c) => c.id), ["a", "b"]);
});

test("partial and implicit updates preserve every omitted field", () => {
  const b = board(card("a", "lane-plan", "actor"));
  const result = apply(b, { action: "update", description: "" });
  assert.deepEqual(result.board.cards[0], { ...b.cards[0], description: "", updatedAt: 42 });
  const backlog = board(card("a"));
  const edit = apply(backlog, { action: "update", cardId: "a", title: "edited" });
  assert.equal(edit.board.cards[0].sessionId, null);
  assert.equal(edit.board.cards[0].description, "description");
});

for (const [name, b, request, reason] of [
  ["foreign ownership", board(card("a", "lane-plan", "foreign")), { action: "update", cardId: "a", title: "stolen", laneId: "lane-todo" }, /another session/],
  ["foreign text-only edit", board(card("a", "lane-plan", "foreign")), { action: "update", cardId: "a", description: "" }, /another session/],
  ["actor already linked", board(card("a"), card("own", "lane-todo", "actor")), { action: "update", cardId: "a", title: "stolen", laneId: "lane-plan" }, /already.*card/],
  ["no implicit target", board(card("a")), { action: "update", description: "" }, /no linked card/],
  ["unknown target", board(), { action: "update", cardId: "unknown", title: "x" }, /card.*not found/i],
  ["unknown lane", board(card("a")), { action: "update", cardId: "a", laneId: "unknown", title: "x" }, /lane.*not found/i],
  ["linked backlog", board(card("a", "lane-todo", "actor")), { action: "update", laneId: "lane-backlog", title: "x" }, /Backlog/],
]) {
  test(`${name} refuses without any partial edits`, () => {
    const before = structuredClone(b);
    const result = apply(b, request);
    assert.equal(result.ok, false);
    assert.equal(result.code, "refused");
    assert.match(result.error, reason);
    assert.deepEqual(b, before);
  });
}

test("unknown creation lane and duplicate generated id refuse", () => {
  assert.equal(apply(board(), { action: "create", title: "x", laneId: "gone" }).ok, false);
  assert.equal(apply(board(card("new")), { action: "create", title: "x" }).ok, false);
});

test("read selection, current card, custom lane order and last-lane result", () => {
  const b = board(card("a", "custom", "actor"), card("b"));
  b.lanes = [b.lanes[0], { id: "custom", name: "Review", description: "Review carefully" }, b.lanes[1]];
  const read = kanbanToolRead(b, 7, "actor", "b");
  assert.deepEqual(read, { ok: true, action: "read", projectDir: "/project", lanes: b.lanes, cards: [b.cards[1]], currentCardId: "a", revision: 7 });
  assert.equal(kanbanToolRead(b, 7, "actor").cards.length, 2);
  assert.equal(kanbanToolRead(b, 7, "actor", "missing").code, "refused");
  const mutation = kanbanToolMutationResult(b, 8, "actor", "a", "update");
  assert.equal(mutation.lane.id, "custom");
  assert.equal(mutation.nextLaneId, "lane-todo");
  b.lanes.reverse();
  b.lanes = [b.lanes[2], b.lanes[0], b.lanes[1]];
  assert.equal(kanbanToolMutationResult(b, 8, "actor", "a", "update").nextLaneId, null);
});
