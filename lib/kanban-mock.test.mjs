import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The store is a per-module singleton whose only persistence is
 * window.localStorage. A tiny in-memory storage on globalThis.window (set
 * before the import so the store's load() sees it) makes every board
 * observable from the outside; each test uses a fresh projectDir so the
 * singleton's in-memory boards never leak between tests.
 */
class MemoryStorage {
  data = new Map();
  getItem(key) {
    return this.data.get(key) ?? null;
  }
  setItem(key, value) {
    this.data.set(key, String(value));
  }
  removeItem(key) {
    this.data.delete(key);
  }
}
const storage = new MemoryStorage();
globalThis.window = { localStorage: storage };

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const kanban = await jiti.import("./kanban-mock.ts");

const KEY = "pi-web:kanban-mock:v1";
let counter = 0;
const freshDir = () => `/tmp/kanban-test-${++counter}`;
const readBoard = (dir) => {
  const raw = storage.getItem(KEY);
  return raw ? JSON.parse(raw)[dir] : null;
};

test("boardExists is true for any project, false without one", () => {
  assert.equal(kanban.boardExists("/any/project"), true);
  assert.equal(kanban.boardExists(null), false);
});

test("seedBoard is deterministic: fixed first lane, kb-seed-N ids, two seeded cards in Todo", () => {
  const a = kanban.seedBoard("/x");
  const b = kanban.seedBoard("/x");
  assert.deepEqual(a.cards.map((c) => c.id), b.cards.map((c) => c.id));
  assert.deepEqual(a.cards.map((c) => c.id), Array.from({ length: 8 }, (_, i) => `kb-seed-${i}`));
  assert.equal(a.lanes[0].id, "lane-backlog");
  assert.equal(a.lanes[0].fixed, true);
  const seeded = a.cards.filter((c) => c.seeded);
  assert.equal(seeded.length, 2);
  assert.ok(seeded.every((c) => c.laneId === "lane-todo" && !c.sessionId));
});

test("addCard lands the card in the requested lane and persists the board", () => {
  const dir = freshDir();
  const card = kanban.kanbanAddCard(dir, "lane-plan", { title: "  My task  " });
  assert.equal(card.title, "My task");
  const board = readBoard(dir);
  assert.equal(board.lanes.some((l) => l.id === "lane-plan"), true);
  assert.equal(board.cards.length, 9); // seed + the new card
  assert.equal(board.cards.find((c) => c.id === card.id).laneId, "lane-plan");
});

test("addCard with an unknown lane is a no-op (the ensure still materialises the seed)", () => {
  const dir = freshDir();
  assert.equal(kanban.kanbanAddCard(dir, "lane-does-not-exist", { title: "Ghost" }), null);
  const board = readBoard(dir);
  assert.equal(board.cards.length, 8); // only the seed, no ghost card
});

test("linkCard refuses a card sitting in the fixed backlog lane", () => {
  const dir = freshDir();
  kanban.kanbanEnsure(dir);
  const board = readBoard(dir);
  const backlogCard = board.cards.find((c) => c.laneId === "lane-backlog");
  kanban.kanbanLinkCard(dir, backlogCard.id, "sess-1", "Session one");
  assert.equal(readBoard(dir).cards.find((c) => c.id === backlogCard.id).sessionId, null);
});

test("linkCard links a card in a work lane", () => {
  const dir = freshDir();
  kanban.kanbanEnsure(dir);
  const board = readBoard(dir);
  const todoCard = board.cards.find((c) => c.laneId === "lane-todo");
  kanban.kanbanLinkCard(dir, todoCard.id, "sess-1", "Session one");
  const linked = readBoard(dir).cards.find((c) => c.id === todoCard.id);
  assert.equal(linked.sessionId, "sess-1");
  assert.equal(linked.sessionTitle, "Session one");
});

test("one session, one card: linking a session elsewhere drops the old link", () => {
  const dir = freshDir();
  kanban.kanbanEnsure(dir);
  const board = readBoard(dir);
  const [a, b] = board.cards.filter((c) => c.laneId === "lane-todo");
  kanban.kanbanLinkCard(dir, a.id, "sess-1", "S");
  kanban.kanbanLinkCard(dir, b.id, "sess-1", "S renamed");
  const after = readBoard(dir).cards;
  assert.equal(after.find((c) => c.id === a.id).sessionId, null);
  assert.equal(after.find((c) => c.id === b.id).sessionId, "sess-1");
  assert.equal(after.find((c) => c.id === b.id).sessionTitle, "S renamed");
});

test("linkCard on a missing card is a no-op", () => {
  const dir = freshDir();
  kanban.kanbanLinkCard(dir, "no-such-card", "sess-1", "S");
  assert.ok(readBoard(dir).cards.every((c) => c.sessionId === null));
});

test("createCardForSession reuses the session's existing card", () => {
  const dir = freshDir();
  kanban.kanbanCreateCardForSession(dir, "sess-1", "First title", "lane-todo");
  kanban.kanbanCreateCardForSession(dir, "sess-1", "Renamed title", "lane-deploy");
  const board = readBoard(dir);
  const carriers = board.cards.filter((c) => c.sessionId === "sess-1");
  assert.equal(carriers.length, 1);
  assert.equal(carriers[0].sessionTitle, "Renamed title");
  assert.equal(carriers[0].laneId, "lane-todo"); // the lane is kept; only the title refreshes
});

test("createCardForSession with a fixed lane falls back to the first work lane", () => {
  const dir = freshDir();
  kanban.kanbanCreateCardForSession(dir, "sess-1", "S", "lane-backlog");
  const card = readBoard(dir).cards.find((c) => c.sessionId === "sess-1");
  assert.equal(card.laneId, "lane-todo");
});

test("advanceCard moves one lane right and returns the lane", () => {
  const dir = freshDir();
  kanban.kanbanEnsure(dir);
  const card = readBoard(dir).cards.find((c) => c.laneId === "lane-backlog");
  const next = kanban.kanbanAdvanceCard(dir, card.id);
  assert.equal(next.id, "lane-todo");
  assert.equal(readBoard(dir).cards.find((c) => c.id === card.id).laneId, "lane-todo");
});

test("advanceCard in the last lane is a no-op", () => {
  const dir = freshDir();
  kanban.kanbanEnsure(dir);
  const doneCard = readBoard(dir).cards.find((c) => c.laneId === "lane-done");
  assert.equal(kanban.kanbanAdvanceCard(dir, doneCard.id), null);
  assert.equal(readBoard(dir).cards.find((c) => c.id === doneCard.id).laneId, "lane-done");
});

test("unlinkCard clears the link", () => {
  const dir = freshDir();
  kanban.kanbanEnsure(dir);
  const card = readBoard(dir).cards.find((c) => c.laneId === "lane-todo");
  kanban.kanbanLinkCard(dir, card.id, "sess-1", "S");
  kanban.kanbanUnlinkCard(dir, card.id);
  assert.equal(readBoard(dir).cards.find((c) => c.id === card.id).sessionId, null);
});

test("deleteCard removes the card", () => {
  const dir = freshDir();
  kanban.kanbanEnsure(dir);
  const card = readBoard(dir).cards[0];
  kanban.kanbanDeleteCard(dir, card.id);
  assert.equal(readBoard(dir).cards.some((c) => c.id === card.id), false);
});

test("deleteLane refuses the fixed backlog lane", () => {
  const dir = freshDir();
  kanban.kanbanEnsure(dir);
  kanban.kanbanDeleteCard(dir, readBoard(dir).cards.find((c) => c.laneId === "lane-backlog").id);
  kanban.kanbanDeleteLane(dir, "lane-backlog");
  assert.equal(readBoard(dir).lanes.some((l) => l.id === "lane-backlog"), true);
});

test("deleteLane refuses a lane holding cards, then succeeds once empty", () => {
  const dir = freshDir();
  kanban.kanbanEnsure(dir);
  kanban.kanbanDeleteLane(dir, "lane-plan"); // still holds its seeded card
  assert.equal(readBoard(dir).lanes.some((l) => l.id === "lane-plan"), true);
  for (const card of [...readBoard(dir).cards].filter((c) => c.laneId === "lane-plan")) {
    kanban.kanbanDeleteCard(dir, card.id);
  }
  kanban.kanbanDeleteLane(dir, "lane-plan");
  assert.equal(readBoard(dir).lanes.some((l) => l.id === "lane-plan"), false);
});

test("renameLane refuses the fixed backlog lane", () => {
  const dir = freshDir();
  kanban.kanbanEnsure(dir);
  kanban.kanbanRenameLane(dir, "lane-backlog", "  ");
  assert.equal(readBoard(dir).lanes[0].name, "Backlog");
});

test("moveLane cannot swap a lane past the fixed backlog", () => {
  const dir = freshDir();
  kanban.kanbanEnsure(dir);
  const lanes = readBoard(dir).lanes.map((l) => l.id);
  kanban.kanbanMoveLane(dir, "lane-todo", -1); // left would put it on/over the backlog
  assert.deepEqual(readBoard(dir).lanes.map((l) => l.id), lanes);
});

test("syncSeedLinks links at most two seeded cards to real sessions and marks the board synced", () => {
  const dir = freshDir();
  kanban.kanbanSyncSeedLinks(dir, [
    { id: "s1", title: "First session" },
    { id: "s2", title: "Second session" },
    { id: "s3", title: "Third session" },
  ]);
  const board = readBoard(dir);
  assert.equal(board.seedSynced, true);
  const linked = board.cards.filter((c) => c.sessionId);
  assert.equal(linked.length, 2);
  assert.deepEqual(linked.map((c) => c.sessionId).sort(), ["s1", "s2"]);
  assert.ok(linked.every((c) => c.seeded));
});

test("syncSeedLinks with no sessions keeps the seed eligible (board materialises, nothing links)", () => {
  const dir = freshDir();
  kanban.kanbanSyncSeedLinks(dir, []);
  const board = readBoard(dir);
  assert.equal(board.seedSynced, false); // still offered to the next session that appears
  assert.ok(board.cards.every((c) => c.sessionId === null));
});

test("syncSeedLinks never re-attaches a card the user unlinked", () => {
  const dir = freshDir();
  kanban.kanbanSyncSeedLinks(dir, [{ id: "s1", title: "S1" }, { id: "s2", title: "S2" }]);
  const seeded = readBoard(dir).cards.filter((c) => c.seeded && c.sessionId);
  kanban.kanbanUnlinkCard(dir, seeded[0].id);
  kanban.kanbanSyncSeedLinks(dir, [{ id: "s1", title: "S1" }, { id: "s2", title: "S2" }, { id: "s3", title: "S3" }]);
  const after = readBoard(dir).cards;
  assert.equal(after.find((c) => c.id === seeded[0].id).sessionId, null);
});

test("a mutation notifies subscribers exactly once per commit", () => {
  const dir = freshDir();
  let ticks = 0;
  const unsubscribe = kanban.subscribeToKanban(() => ticks++);
  kanban.kanbanEnsure(dir);
  kanban.kanbanAddCard(dir, "lane-todo", { title: "Ping" });
  unsubscribe();
  kanban.kanbanAddCard(dir, "lane-todo", { title: "After unsubscribe" });
  assert.equal(ticks, 2);
});
