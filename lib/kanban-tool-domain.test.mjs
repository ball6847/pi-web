import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  parseKanbanToolRequest, applyKanbanToolMutation, kanbanToolRead, kanbanToolOverview, kanbanToolSearch,
  kanbanCardExcerpt, kanbanToolMutationResult, kanbanToolComments, kanbanToolCommentResult, resolveKanbanToolCard,
} = await jiti.import("./kanban-tool-domain.ts");
const { KANBAN_COMMENT_BUDGET, KANBAN_COMMENT_MAX, KANBAN_COMMENT_READ_LIMIT } = await jiti.import("./kanban-tool-limits.ts");
const { defaultLanes } = await jiti.import("./kanban-types.ts");
const actor = { sessionId: "actor", sessionTitle: "Actor" };
const card = (id, laneId = "lane-backlog", sessionId = null) => ({ id, laneId, sessionId, sessionTitle: sessionId, title: id, description: "description", createdAt: 1, updatedAt: 1 });
const board = (...cards) => ({ projectDir: "/project", lanes: defaultLanes(), cards });
const apply = (b, request, who = actor, id = "new") => applyKanbanToolMutation(b, request, who, 42, id);

for (const input of [null, [], {}, { action: "advance" }, { action: "read", title: "x" }, { action: "read", cwd: "/elsewhere" }, { action: "read", cardId: "" }, { action: "read", query: "x" }, { action: "search", cardId: "x" }, { action: "search", limit: 1, title: "x" }, { action: "search", laneId: " " }, { action: "search", query: 4 }, { action: "search", limit: "5" }, { action: "search", limit: 0 }, { action: "search", limit: 2.5 }, { action: "search", limit: 51 }, { action: "create", cardId: "x", title: "x" }, { action: "create" }, { action: "create", title: "  " }, { action: "create", title: 4 }, { action: "update" }, { action: "update", cardId: "x" }, { action: "update", title: "\n " }, { action: "update", description: null }, { action: "update", laneId: " " }, { action: "update", title: "x", advance: true }, { action: "update", title: "x", sessionId: "other" }, { action: "comment" }, { action: "comment", body: "   " }, { action: "comment", body: 4 }, { action: "comment", body: "x".repeat(KANBAN_COMMENT_MAX + 1) }, { action: "comment", body: "x", laneId: "lane-todo" }, { action: "comment", body: "x", title: "t" }, JSON.parse('{"action":"read","__proto__":{}}')]) {
  test(`invalid parameters: ${JSON.stringify(input)}`, () => {
    const result = parseKanbanToolRequest(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid-request");
    assert.ok(result.error.length);
  });
}

test("valid flat requests retain omitted fields and allow clearing description", () => {
  for (const request of [{ action: "read" }, { action: "read", cardId: "x" }, { action: "search" }, { action: "search", query: "", laneId: "lane-todo", limit: 5 }, { action: "create", title: "task" }, { action: "update", description: "" }, { action: "update", cardId: "x", title: "t", laneId: "lane-todo" }, { action: "comment", body: "a note" }, { action: "comment", cardId: "x", body: "a note" }]) {
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

test("read is a projection: lanes with counts, the board total and only the caller's own card", () => {
  const b = board(card("a", "custom", "actor"), card("b"));
  b.lanes = [b.lanes[0], { id: "custom", name: "Review", description: "Review carefully" }, b.lanes[1]];
  const overview = kanbanToolOverview(b, 7, "actor");
  assert.deepEqual(overview, {
    ok: true, action: "read", projectDir: "/project", revision: 7, totalCards: 2,
    lanes: [
      { id: "lane-backlog", name: "Backlog", description: "Waiting work, no session yet", fixed: true, cardCount: 1 },
      { id: "custom", name: "Review", description: "Review carefully", cardCount: 1 },
      { id: "lane-todo", name: "Todo", description: "Ready to start", cardCount: 0 },
      ...b.lanes.slice(3).map((lane) => ({ ...lane, cardCount: 0 })),
    ],
    currentCard: b.cards[0],
  });
  // Nobody else's card is in the payload, however large the board is.
  assert.equal(JSON.stringify(overview).includes('"b"'), false);
  assert.equal(kanbanToolOverview(b, 7, "stranger").currentCard, null);
});

test("read with cardId returns one card in full with its lane and next lane", () => {
  const b = board(card("a", "custom", "actor"), card("b", "custom"));
  b.lanes = [b.lanes[0], { id: "custom", name: "Review", description: "Review carefully" }, b.lanes[1]];
  const read = kanbanToolRead(b, 7, "actor", "b");
  assert.deepEqual(read, {
    ok: true, action: "read", projectDir: "/project", revision: 7,
    card: b.cards[1], lane: b.lanes[1], nextLaneId: "lane-todo", currentCardId: "a",
    comments: [], commentCount: 0,
  });
  assert.equal(kanbanToolRead(b, 7, "actor", "missing").code, "refused");
  b.lanes.reverse();
  b.lanes = [b.lanes[2], b.lanes[0], b.lanes[1]];
  assert.equal(kanbanToolMutationResult(b, 8, "actor", "a", "update").nextLaneId, null);
});

test("search filters by literal text and lane, caps rows and says how many matched", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...card(`c${i}`, "lane-todo"), title: i % 2 ? `Fix bug ${i}` : `Ship ${i}` }));
  const b = board(...many, card("backlog-only"));
  const all = kanbanToolSearch(b, 3, "actor", { action: "search" });
  assert.equal(all.ok, true);
  assert.equal(all.cards.length, 20);
  assert.equal(all.matched, 31);
  assert.equal(all.total, 31);
  assert.equal(all.hasMore, true);
  assert.match(all.hint, /20 of 31/);
  assert.equal(all.currentCardId, null);
  assert.deepEqual(all.lanes[0], { id: "lane-backlog", name: "Backlog", cardCount: 1 });
  assert.deepEqual(all.lanes[1], { id: "lane-todo", name: "Todo", cardCount: 30 });
  const bugs = kanbanToolSearch(b, 3, "actor", { action: "search", query: "  BUG " });
  assert.equal(bugs.matched, 15);
  assert.equal(bugs.hasMore, false);
  assert.equal("hint" in bugs, false);
  const backlog = kanbanToolSearch(b, 3, "actor", { action: "search", laneId: "lane-backlog" });
  assert.deepEqual(backlog.cards.map((c) => c.id), ["backlog-only"]);
  assert.equal(backlog.matched, 1);
  assert.equal(kanbanToolSearch(b, 3, "actor", { action: "search", query: "nothing here" }).matched, 0);
  assert.equal(kanbanToolSearch(b, 3, "actor", { action: "search", laneId: "gone" }).code, "refused");
  assert.equal(kanbanToolSearch(b, 3, "actor", { action: "search", query: "bug", limit: 2 }).cards.length, 2);
});

test("search rows carry a one-line excerpt and only the caller's own card id", () => {
  const b = board(
    { ...card("own", "lane-todo", "actor"), description: "line one\n\nline two   spaced" },
    { ...card("free"), description: "x".repeat(400) },
  );
  const result = kanbanToolSearch(b, 1, "actor", { action: "search" });
  const [own, free] = result.cards;
  assert.deepEqual(Object.keys(own).sort(), ["excerpt", "id", "laneId", "linked", "title"]);
  assert.equal(own.excerpt, "line one line two spaced");
  assert.equal(own.linked, true);
  assert.equal("linked" in free, false);
  assert.equal(Array.from(free.excerpt).length, 121);
  assert.ok(free.excerpt.endsWith("…"));
  assert.equal(result.currentCardId, "own");
  assert.equal(kanbanCardExcerpt("", "q"), "");
  // A hit deep in a long body is centered, with ellipses only at the cuts.
  const centered = kanbanCardExcerpt(`${"a".repeat(300)} needle ${"b".repeat(300)}`, "needle");
  assert.ok(centered.startsWith("…") && centered.endsWith("…"));
  assert.ok(centered.includes("needle"));
  assert.ok(Array.from(centered).length <= 122);
});

test("a large board costs a bounded payload: no read answer carries every card body", () => {
  const cards = Array.from({ length: 300 }, (_, i) => ({
    ...card(`c${i}`, i % 2 ? "lane-todo" : "lane-plan"),
    title: `Task ${i}`, description: "d".repeat(4000),
  }));
  const b = board(...cards);
  const overview = JSON.stringify(kanbanToolOverview(b, 9, "actor"));
  const search = JSON.stringify(kanbanToolSearch(b, 9, "actor", { action: "search" }));
  const one = JSON.stringify(kanbanToolRead(b, 9, "actor", "c7"));
  assert.ok(overview.length < 2_000, `overview was ${overview.length} bytes`);
  assert.ok(search.length < 8_000, `search was ${search.length} bytes`);
  assert.ok(one.length > 4_000 && one.length < 5_000, `one card was ${one.length} bytes`);
});

test("a comment resolves to the caller's own card, or an unlinked one, and never another session's", () => {
  const b = board(card("own", "lane-todo", "actor"), card("free"), card("theirs", "lane-plan", "other"));
  assert.equal(resolveKanbanToolCard(b, undefined, actor).card.id, "own");
  assert.equal(resolveKanbanToolCard(b, "free", actor).card.id, "free");
  assert.equal(resolveKanbanToolCard(b, "theirs", actor).code, "refused");
  assert.equal(resolveKanbanToolCard(b, "missing", actor).code, "refused");
  assert.equal(resolveKanbanToolCard(b, undefined, { sessionId: "stranger" }).code, "refused");
});

test("a card read carries the newest comments, each body bounded, with the whole count", () => {
  const b = board(card("c", "lane-todo", "actor"));
  const comments = Array.from({ length: KANBAN_COMMENT_READ_LIMIT + 4 }, (_, i) => ({
    id: `m${i}`, cardId: "c", author: i % 2 ? "agent" : "user", sessionId: i % 2 ? "actor" : null,
    sessionTitle: i % 2 ? "Actor" : null, body: i === 0 ? "z".repeat(KANBAN_COMMENT_BUDGET + 20) : `note ${i}`, createdAt: i,
  }));
  const read = kanbanToolRead(b, 5, "actor", "c", { comments, total: comments.length });
  assert.equal(read.ok, true);
  assert.equal(read.commentCount, comments.length);
  assert.equal(read.comments.length, KANBAN_COMMENT_READ_LIMIT, "the oldest entries are left out, not the newest");
  assert.equal(read.comments.at(-1).body, `note ${comments.length - 1}`);
  assert.equal(read.commentCount, comments.length);
  // The truncation itself: the head of a long note plus the marker.
  const long = kanbanToolComments([{ ...comments[0] }]);
  assert.equal(long[0].body.endsWith("…[truncated]"), true);
  assert.equal([...long[0].body].length, KANBAN_COMMENT_BUDGET + "…[truncated]".length);
});

test("the comment mutation result answers the card, its lane and next lane, beside the written note", () => {
  const b = board(card("c", "lane-plan", "actor"));
  const comment = { id: "m1", cardId: "c", author: "agent", sessionId: "actor", sessionTitle: "Actor", body: "hi", createdAt: 3 };
  const result = kanbanToolCommentResult(b, 9, "actor", "c", comment);
  assert.equal(result.ok, true);
  assert.equal(result.action, "comment");
  assert.equal(result.comment, comment);
  assert.equal(result.card.id, "c");
  assert.equal(result.lane.id, "lane-plan");
  assert.equal(result.nextLaneId, "lane-implement");
  assert.equal(result.currentCardId, "c");
  assert.equal(kanbanToolCommentResult(b, 9, "actor", "missing", comment).code, "refused");
});
