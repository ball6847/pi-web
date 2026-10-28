import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const types = await jiti.import("./kanban-types.ts");
const k = await jiti.import("./kanban-shared.ts");

const NOW = 1_000;
const LATER = 2_000;

const card = (id, laneId, extra = {}) => ({
  id,
  title: `Card ${id}`,
  description: "",
  laneId,
  sessionId: null,
  sessionTitle: null,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

/** Default lanes; a sessionless card in backlog and in Todo, a linked one in Plan and in Done. */
function fixture() {
  return {
    projectDir: "/x",
    lanes: types.defaultLanes(),
    cards: [
      card("b1", "lane-backlog"),
      card("t1", "lane-todo"),
      card("t2", "lane-todo"),
      card("p1", "lane-plan", { sessionId: "s-plan", sessionTitle: "Plan session" }),
      card("d1", "lane-done", { sessionId: "s-done", sessionTitle: "Done session" }),
    ],
  };
}
const byId = (board, id) => board.cards.find((c) => c.id === id);

test("defaultLanes: six lanes, only the first fixed, backlog id", () => {
  const lanes = types.defaultLanes();
  assert.equal(lanes.length, 6);
  assert.equal(lanes[0].id, "lane-backlog");
  assert.equal(lanes[0].fixed, true);
  assert.ok(lanes.slice(1).every((l) => !l.fixed));
  assert.equal(types.KANBAN_SCHEMA_VERSION, 4);
  assert.notEqual(types.makeKanbanId(), types.makeKanbanId());
});

test("reducers never mutate their input", () => {
  const board = fixture();
  const snapshot = JSON.stringify(board);
  k.addCard(board, "lane-plan", { title: "x" }, NOW);
  k.updateCard(board, "t1", { title: "renamed" }, NOW);
  k.deleteCard(board, "t1");
  k.moveCardToLane(board, "p1", "lane-deploy", NOW);
  k.advanceCard(board, "t1", NOW);
  k.linkCard(board, "t1", "s-new", "New", NOW);
  k.unlinkCard(board, "p1", NOW);
  k.pruneDeadLinks(board, new Set(), NOW);
  k.addLane(board, "Lane", "", "l-x");
  k.renameLane(board, "lane-todo", "Renamed");
  k.moveLane(board, "lane-todo", 1);
  k.deleteLane(board, "lane-todo", NOW);
  assert.equal(JSON.stringify(board), snapshot);
});

test("addCard lands a trimmed card in the requested lane, last in order", () => {
  const board = k.addCard(fixture(), "lane-plan", { title: "  My task  ", description: " d ", id: "n1" }, NOW);
  const added = byId(board, "n1");
  assert.equal(added.title, "My task");
  assert.equal(added.description, "d");
  assert.equal(added.laneId, "lane-plan");
  assert.equal(added.sessionId, null);
  assert.equal(added.createdAt, NOW);
  assert.equal(added.updatedAt, NOW);
  assert.equal(board.cards.length, 6);
  assert.equal(board.cards.at(-1).id, "n1");
});

test("addCard generates an id and refuses unknown lane, blank title, duplicate id", () => {
  const board = fixture();
  const added = k.addCard(board, "lane-todo", { title: "Auto" }, NOW);
  assert.ok(added.cards.at(-1).id.length > 0);
  assert.equal(k.addCard(board, "lane-nope", { title: "Ghost" }, NOW), null);
  assert.equal(k.addCard(board, "lane-todo", { title: "   " }, NOW), null);
  assert.equal(k.addCard(board, "lane-todo", { title: "dup", id: "t1" }, NOW), null);
});

test("addCard with a session moves the session off its other card (a card cannot exist twice)", () => {
  const board = k.addCard(fixture(), "lane-implement", { title: "Again", sessionId: "s-plan", sessionTitle: "Plan session", id: "n1" }, LATER);
  assert.equal(byId(board, "p1").sessionId, null);
  assert.equal(byId(board, "p1").sessionTitle, "Plan session");
  assert.equal(board.cards.filter((c) => c.sessionId === "s-plan").length, 1);
  assert.equal(byId(board, "n1").sessionId, "s-plan");
});

test("addCard with a session is refused on the fixed backlog lane", () => {
  const board = k.addCard(fixture(), "lane-backlog", { title: "Tracked", sessionId: "s-todo", sessionTitle: "Todo session" }, NOW);
  assert.equal(board, null, "the backlog never takes a session, at add time either");
});

test("updateCard edits title and description, ignores a blank title, no-op keeps identity", () => {
  const board = fixture();
  const edited = k.updateCard(board, "t1", { title: " New ", description: " Desc " }, LATER);
  assert.equal(byId(edited, "t1").title, "New");
  assert.equal(byId(edited, "t1").description, "Desc");
  assert.equal(byId(edited, "t1").updatedAt, LATER);
  const blank = k.updateCard(board, "t1", { title: "  " }, LATER);
  assert.equal(blank, board);
  assert.equal(k.updateCard(board, "t1", { title: "Card t1" }, LATER), board);
  assert.equal(k.updateCard(board, "nope", { title: "x" }, LATER), null);
});

test("deleteCard removes the card; an unknown card changes nothing", () => {
  const board = fixture();
  const after = k.deleteCard(board, "t1");
  assert.equal(after.cards.some((c) => c.id === "t1"), false);
  assert.equal(after.cards.length, 4);
  assert.equal(k.deleteCard(board, "nope"), board);
});

test("linkCard refuses a card sitting in the fixed backlog lane", () => {
  assert.equal(k.linkCard(fixture(), "b1", "sess-1", "S", NOW), null);
});

test("linkCard links a card in a work lane, snapshots the title, and does not move the card", () => {
  const board = k.linkCard(fixture(), "t1", "sess-1", "Session one", LATER);
  assert.equal(byId(board, "t1").sessionId, "sess-1");
  assert.equal(byId(board, "t1").sessionTitle, "Session one");
  assert.equal(byId(board, "t1").laneId, "lane-todo");
  assert.equal(byId(board, "t1").updatedAt, LATER);
});

test("one session, one card: relinking a session moves the link", () => {
  let board = k.linkCard(fixture(), "t1", "sess-1", "S", NOW);
  board = k.linkCard(board, "t2", "sess-1", "S renamed", LATER);
  assert.equal(byId(board, "t1").sessionId, null);
  assert.equal(byId(board, "t2").sessionId, "sess-1");
  assert.equal(byId(board, "t2").sessionTitle, "S renamed");
  assert.equal(board.cards.filter((c) => c.sessionId === "sess-1").length, 1);
});

test("a refused link leaves the session's existing card linked", () => {
  const board = fixture();
  assert.equal(k.linkCard(board, "b1", "s-plan", "S", NOW), null);
  assert.equal(byId(board, "p1").sessionId, "s-plan");
  assert.equal(k.linkCard(board, "no-such-card", "s-plan", "S", NOW), null);
});

test("unlinkCard clears the session id only and keeps the snapshot title", () => {
  const board = k.unlinkCard(fixture(), "p1", LATER);
  assert.equal(byId(board, "p1").sessionId, null);
  assert.equal(byId(board, "p1").sessionTitle, "Plan session");
  assert.equal(byId(board, "p1").laneId, "lane-plan");
  const same = fixture();
  assert.equal(k.unlinkCard(same, "t1", LATER), same);
});

test("createCardForSession reuses the session's existing card: only the title refreshes", () => {
  let board = k.createCardForSession(fixture(), "sess-1", "First title", "lane-todo", NOW);
  board = k.createCardForSession(board, "sess-1", "Renamed title", "lane-deploy", LATER);
  const carriers = board.cards.filter((c) => c.sessionId === "sess-1");
  assert.equal(carriers.length, 1);
  assert.equal(carriers[0].sessionTitle, "Renamed title");
  assert.equal(carriers[0].title, "First title");
  assert.equal(carriers[0].laneId, "lane-todo");
});

test("createCardForSession with the backlog or unknown lane falls back to the first work lane", () => {
  const a = k.createCardForSession(fixture(), "sess-1", "S", "lane-backlog", NOW);
  assert.equal(a.cards.find((c) => c.sessionId === "sess-1").laneId, "lane-todo");
  const b = k.createCardForSession(fixture(), "sess-2", "S", null, NOW);
  assert.equal(b.cards.find((c) => c.sessionId === "sess-2").laneId, "lane-todo");
  const c = k.createCardForSession(fixture(), "sess-3", "S", "lane-deploy", NOW, "fixed-id");
  assert.equal(byId(c, "fixed-id").laneId, "lane-deploy");
});

test("createCardForSession on a board with only the backlog changes nothing", () => {
  const board = { projectDir: "/x", lanes: [types.defaultLanes()[0]], cards: [] };
  assert.equal(k.createCardForSession(board, "s", "S", null, NOW), board);
});

test("advanceCard moves one lane right — a sessionless backlog card too (advance is not session-guarded)", () => {
  const board = k.advanceCard(fixture(), "b1", LATER);
  assert.equal(byId(board, "b1").laneId, "lane-todo");
  assert.equal(byId(board, "b1").updatedAt, LATER);
});

test("advanceCard in the last lane is refused (null), and so is an unknown card", () => {
  assert.equal(k.advanceCard(fixture(), "d1", NOW), null);
  assert.equal(k.advanceCard(fixture(), "nope", NOW), null);
});

test("moveCardToLane moves a linked card between work lanes and keeps the link", () => {
  const board = k.moveCardToLane(fixture(), "p1", "lane-deploy", LATER);
  assert.equal(byId(board, "p1").laneId, "lane-deploy");
  assert.equal(byId(board, "p1").sessionId, "s-plan");
  assert.equal(k.moveCardToLane(fixture(), "p1", "lane-nope", NOW), null);
  assert.equal(k.moveCardToLane(fixture(), "nope", "lane-deploy", NOW), null);
});

test("a sessionless card moving to a work lane is refused (null); it may rest in backlog", () => {
  assert.equal(k.moveCardToLane(fixture(), "b1", "lane-implement", NOW), null);
  assert.equal(k.moveCardToLane(fixture(), "t1", "lane-implement", NOW), null);
  const board = k.moveCardToLane(fixture(), "t1", "lane-backlog", LATER);
  assert.equal(byId(board, "t1").laneId, "lane-backlog");
});

test("a linked card cannot move into the backlog", () => {
  assert.equal(k.moveCardToLane(fixture(), "p1", "lane-backlog", NOW), null);
});

test("addCard with a session is refused for the backlog; the same card is allowed in a work lane", () => {
  const input = { title: "Linked", sessionId: "s-new", sessionTitle: "S", id: "c-new" };
  assert.equal(k.addCard(fixture(), "lane-backlog", input, NOW), null);
  const board = k.addCard(fixture(), "lane-todo", input, NOW);
  assert.equal(byId(board, "c-new").sessionId, "s-new");
});

test("moveCardToLane to the lane it is already in changes nothing", () => {
  const board = fixture();
  assert.equal(k.moveCardToLane(board, "p1", "lane-plan", NOW), board);
});

test("moveCardToLane reorders inside a lane: before a named card, or last without one", () => {
  // t1, t2 -> t2, t1
  const reordered = k.moveCardToLane(fixture(), "t2", "lane-todo", LATER, "t1");
  assert.deepEqual(k.cardsOfLane(reordered, "lane-todo").map((c) => c.id), ["t2", "t1"]);
  assert.equal(byId(reordered, "t2").updatedAt, LATER);
  // t1 is already last: dropping it at the lane's end writes nothing.
  assert.equal(k.moveCardToLane(reordered, "t1", "lane-todo", LATER, null), reordered);
  // Anchored on itself is the same non-move (the anchor is filtered out first).
  assert.equal(k.moveCardToLane(reordered, "t1", "lane-todo", LATER, "t1"), reordered);
  // And t2 to the end restores the old order.
  const restored = k.moveCardToLane(reordered, "t2", "lane-todo", LATER, null);
  assert.deepEqual(k.cardsOfLane(restored, "lane-todo").map((c) => c.id), ["t1", "t2"]);
});

test("a cross-lane move inserts anywhere in the target lane, not just at its end", () => {
  // Plan holds only p1, so a linked card may enter it before p1.
  const board = k.moveCardToLane(fixture(), "d1", "lane-plan", LATER, "p1");
  assert.deepEqual(k.cardsOfLane(board, "lane-plan").map((c) => c.id), ["d1", "p1"]);
  assert.equal(byId(board, "d1").sessionId, "s-done");
  // Without an anchor it goes last.
  const appended = k.moveCardToLane(fixture(), "d1", "lane-plan", LATER);
  assert.deepEqual(k.cardsOfLane(appended, "lane-plan").map((c) => c.id), ["p1", "d1"]);
  // No other lane's order moved.
  assert.deepEqual(k.cardsOfLane(appended, "lane-todo").map((c) => c.id), ["t1", "t2"]);
  assert.deepEqual(k.cardsOfLane(appended, "lane-done").map((c) => c.id), []);
});

test("an anchor that is gone or in another lane falls back to the end of the target lane", () => {
  const board = k.moveCardToLane(fixture(), "d1", "lane-plan", LATER, "t1");
  assert.deepEqual(k.cardsOfLane(board, "lane-plan").map((c) => c.id), ["p1", "d1"]);
  const gone = k.moveCardToLane(fixture(), "d1", "lane-plan", LATER, "nope");
  assert.deepEqual(k.cardsOfLane(gone, "lane-plan").map((c) => c.id), ["p1", "d1"]);
});

test("a card anchored on itself stays where it is — the first card is not sent to the lane's end", () => {
  const board = fixture();
  // t1 is first in Todo: dropping it above itself is a no-op, not a move to the end.
  assert.equal(k.moveCardToLane(board, "t1", "lane-todo", LATER, "t1"), board);
  assert.deepEqual(k.cardsOfLane(board, "lane-todo").map((c) => c.id), ["t1", "t2"]);
  // The same under a cross-lane spelling: its own id is not an anchor elsewhere either.
  assert.equal(k.moveCardToLane(board, "t1", "lane-todo", LATER, "t1"), board);
  // Anchored on its own successor it is already there, so nothing is written.
  assert.equal(k.moveCardToLane(board, "t1", "lane-todo", LATER, "t2"), board);
});

test("the backlog boundary holds for every move, reorder or not", () => {
  assert.equal(k.moveCardToLane(fixture(), "b1", "lane-todo", NOW, "t1"), null);
  assert.equal(k.moveCardToLane(fixture(), "t1", "lane-plan", NOW, "p1"), null);
  assert.equal(k.moveCardToLane(fixture(), "p1", "lane-backlog", NOW, null), null);
  // The one backlog card is already last in its lane: a same-lane move writes nothing.
  const board = fixture();
  assert.equal(k.moveCardToLane(board, "b1", "lane-backlog", NOW, null), board);
});

test("advanceCard lands the card last in the next lane", () => {
  // b1 advances into Todo, which already holds t1 and t2.
  const board = k.advanceCard(fixture(), "b1", LATER);
  assert.deepEqual(k.cardsOfLane(board, "lane-todo").map((c) => c.id), ["t1", "t2", "b1"]);
  const intoPlan = k.advanceCard(board, "p1", LATER);
  assert.deepEqual(k.cardsOfLane(intoPlan, "lane-implement").map((c) => c.id), ["p1"]);
});

test("canRestInLane is the backlog boundary the views gate drop targets with", () => {
  const lanes = types.defaultLanes();
  const backlog = lanes[0];
  const todo = lanes[1];
  assert.equal(k.canRestInLane(card("x", "lane-backlog"), backlog), true);
  assert.equal(k.canRestInLane(card("x", "lane-backlog"), todo), false);
  assert.equal(k.canRestInLane(card("x", "lane-todo", { sessionId: "s" }), todo), true);
  assert.equal(k.canRestInLane(card("x", "lane-todo", { sessionId: "s" }), backlog), false);
});

test("addLane appends a trimmed work lane; blank name and duplicate id refused", () => {
  const board = k.addLane(fixture(), "  Review ", " QA ", "l-review");
  assert.deepEqual(board.lanes.at(-1), { id: "l-review", name: "Review", description: "QA" });
  assert.equal(k.addLane(fixture(), "   "), null);
  assert.equal(k.addLane(fixture(), "x", "", "lane-todo"), null);
  assert.ok(k.addLane(fixture(), "Auto").lanes.at(-1).id.length > 0);
});

test("renameLane renames a work lane, refuses the fixed backlog, blank names and unknown lanes", () => {
  const board = fixture();
  assert.equal(k.renameLane(board, "lane-todo", " Ready ").lanes[1].name, "Ready");
  assert.equal(k.renameLane(board, "lane-backlog", "  "), null);
  assert.equal(k.renameLane(board, "lane-backlog", "Inbox"), null);
  assert.equal(k.renameLane(board, "lane-todo", "  "), null);
  assert.equal(k.renameLane(board, "nope", "x"), null);
  assert.equal(k.renameLane(board, "lane-todo", "Todo"), board);
});

test("editLane patches the description and the model-facing instructions, refusing the fixed backlog", () => {
  const board = fixture();
  const snapshot = JSON.stringify(board);
  const set = k.editLane(board, "lane-todo", { instructions: "  Run the suite before leaving.  " });
  assert.equal(set.lanes[1].instructions, "Run the suite before leaving.", "instructions are trimmed");
  assert.equal(set.lanes[0].instructions, undefined, "other lanes keep theirs");
  // The patch is per field: description untouched, instructions untouched when omitted.
  assert.equal(k.editLane(board, "lane-todo", { description: "UI text" }).lanes[1].description, "UI text");
  assert.equal(k.editLane(board, "lane-todo", { description: "UI text" }).lanes[1].instructions, undefined);
  // An empty string clears; cleared reads as absent again.
  const cleared = k.editLane(set, "lane-todo", { instructions: "" });
  assert.equal("instructions" in cleared.lanes[1], false);
  // Refusals and no-ops.
  assert.equal(k.editLane(board, "lane-backlog", { instructions: "x" }), null);
  assert.equal(k.editLane(board, "nope", { instructions: "x" }), null);
  assert.equal(k.editLane(set, "lane-todo", { instructions: "Run the suite before leaving." }), set);
  assert.equal(k.editLane(board, "lane-todo", {}), board);
  // The reducers never mutate their input.
  k.editLane(board, "lane-todo", { instructions: "x" });
  assert.equal(JSON.stringify(board), snapshot);
});

test("moveLane swaps work lanes but never past the fixed backlog or off the ends", () => {
  const board = fixture();
  assert.equal(k.moveLane(board, "lane-todo", -1), null);
  assert.equal(k.moveLane(board, "lane-backlog", 1), null);
  assert.equal(k.moveLane(board, "lane-done", 1), null);
  assert.equal(k.moveLane(board, "nope", 1), null);
  const moved = k.moveLane(board, "lane-todo", 1);
  assert.deepEqual(moved.lanes.map((l) => l.id).slice(0, 3), ["lane-backlog", "lane-plan", "lane-todo"]);
});

test("reorderLane moves a work lane to its final position, clamped past the backlog", () => {
  const board = fixture();
  // lane-todo (1) to the end (5): the drop a lane drag posts.
  assert.deepEqual(k.reorderLane(board, "lane-todo", 5).lanes.map((l) => l.id), [
    "lane-backlog", "lane-plan", "lane-implement", "lane-deploy", "lane-done", "lane-todo",
  ]);
  // lane-done (5) right after the backlog (1).
  assert.deepEqual(k.reorderLane(board, "lane-done", 1).lanes.map((l) => l.id), [
    "lane-backlog", "lane-done", "lane-todo", "lane-plan", "lane-implement", "lane-deploy",
  ]);
  // A 0 asked for lands right after the fixed backlog; too-far indexes clamp.
  assert.deepEqual(k.reorderLane(board, "lane-implement", 0).lanes.map((l) => l.id).slice(0, 2), [
    "lane-backlog", "lane-implement",
  ]);
  assert.equal(k.reorderLane(board, "lane-todo", 99).lanes.at(-1).id, "lane-todo");
});

test("reorderLane refuses the fixed backlog, an unknown lane, and a non-integer", () => {
  const board = fixture();
  assert.equal(k.reorderLane(board, "lane-backlog", 3), null);
  assert.equal(k.reorderLane(board, "nope", 3), null);
  assert.equal(k.reorderLane(board, "lane-todo", 1.5), null);
});

test("reorderLane to the current position returns the same board", () => {
  const board = fixture();
  assert.equal(k.reorderLane(board, "lane-todo", 1), board);
  assert.equal(k.reorderLane(board, "lane-done", 5), board);
});

test("deleteLane refuses the fixed backlog and an unknown lane", () => {
  assert.equal(k.deleteLane(fixture(), "lane-backlog", NOW), null);
  assert.equal(k.deleteLane(fixture(), "nope", NOW), null);
});

test("deleteLane relocates its cards to the backlog (linked ones unlinked, title kept)", () => {
  const board = k.deleteLane(fixture(), "lane-plan", LATER);
  assert.equal(board.lanes.some((l) => l.id === "lane-plan"), false);
  const moved = byId(board, "p1");
  assert.equal(moved.laneId, "lane-backlog");
  assert.equal(moved.sessionId, null);
  assert.equal(moved.sessionTitle, "Plan session");
  assert.equal(board.cards.length, 5);
  assert.equal(byId(board, "t1").laneId, "lane-todo");
  const todo = k.deleteLane(fixture(), "lane-todo", LATER);
  assert.equal(byId(todo, "t1").laneId, "lane-backlog");
  assert.equal(byId(todo, "t2").laneId, "lane-backlog");
});

test("pruneDeadLinks unlinks dead sessions but keeps lane and snapshot title", () => {
  const board = k.pruneDeadLinks(fixture(), new Set(["s-done"]), LATER);
  const pruned = byId(board, "p1");
  assert.equal(pruned.sessionId, null);
  assert.equal(pruned.sessionTitle, "Plan session");
  assert.equal(pruned.laneId, "lane-plan");
  assert.equal(pruned.updatedAt, LATER);
  assert.equal(byId(board, "d1").sessionId, "s-done");
  assert.equal(byId(board, "d1").updatedAt, 1);
});

test("pruneDeadLinks with every session alive returns the same board", () => {
  const board = fixture();
  assert.equal(k.pruneDeadLinks(board, new Set(["s-plan", "s-done"]), LATER), board);
});

test("lookup helpers", () => {
  const board = fixture();
  assert.equal(k.laneById(board, "lane-todo").name, "Todo");
  assert.equal(k.laneById(board, null), null);
  assert.equal(k.laneById(board, "nope"), null);
  assert.equal(k.laneIndex(board, "lane-plan"), 2);
  assert.equal(k.laneIndex(board, "nope"), -1);
  assert.deepEqual(k.cardsOfLane(board, "lane-todo").map((c) => c.id), ["t1", "t2"]);
  assert.equal(k.cardForSession(board, "s-plan").id, "p1");
  assert.equal(k.cardForSession(board, null), null);
  assert.equal(k.firstWorkLane(board).id, "lane-todo");
  assert.equal(k.cardLaneOf(board, byId(board, "p1")).id, "lane-plan");
  assert.equal(k.cardLaneOf(board, null), null);
});

test("applyKanbanAction dispatches every action name; refusals are null", () => {
  const board = fixture();
  const run = (request) => k.applyKanbanAction(board, request, LATER);
  assert.ok(run({ action: "add-card", laneId: "lane-todo", title: "n", cardId: "n1" }));
  assert.ok(run({ action: "edit-card", cardId: "t1", title: "z" }));
  assert.ok(run({ action: "delete-card", cardId: "t1" }));
  assert.ok(run({ action: "move-card", cardId: "p1", laneId: "lane-deploy" }));
  assert.ok(run({ action: "advance-card", cardId: "t1" }));
  assert.ok(run({ action: "link-session", cardId: "t1", sessionId: "s", sessionTitle: "S" }));
  assert.ok(run({ action: "unlink-session", cardId: "p1" }));
  assert.ok(run({ action: "create-card-for-session", sessionId: "s", sessionTitle: "S", laneId: null }));
  assert.ok(run({ action: "add-lane", name: "L" }));
  assert.ok(run({ action: "rename-lane", laneId: "lane-todo", name: "R" }));
  assert.ok(run({ action: "edit-lane", laneId: "lane-todo", instructions: "how to work" }));
  assert.equal(run({ action: "edit-lane", laneId: "lane-backlog", instructions: "x" }), null);
  assert.ok(run({ action: "move-lane", laneId: "lane-todo", direction: 1 }));
  assert.ok(run({ action: "reorder-lane", laneId: "lane-todo", toIndex: 5 }));
  assert.equal(run({ action: "reorder-lane", laneId: "lane-backlog", toIndex: 3 }), null);
  assert.ok(run({ action: "delete-lane", laneId: "lane-todo" }));
  assert.equal(run({ action: "advance-card", cardId: "d1" }), null);
  assert.equal(types.KANBAN_ACTION_NAMES.length, 14);
});

test("sessionlessCardsByRecency: newest first, linked cards dropped, ties keep board order", () => {
  const board = {
    projectDir: "/p",
    lanes: types.defaultLanes(),
    cards: [
      card("a", "lane-backlog", { updatedAt: 5 }),
      card("b", "lane-backlog", { updatedAt: 9, sessionId: "s1" }),
      card("c", "lane-backlog"),
      card("d", "lane-todo", { updatedAt: 1 }),
    ],
  };
  assert.deepEqual(k.sessionlessCardsByRecency(board).map((c) => c.id), ["a", "c", "d"]);
});

// ---------------------------------------------------------------------------
// attachSessionCard: a fresh composer's pick, applied before the first prompt
// ---------------------------------------------------------------------------

test("attachSessionCard links a work-lane card as it is", () => {
  const board = fixture();
  const next = k.attachSessionCard(board, "s-new", "New session", { cardId: "t1" }, NOW);
  assert.equal(byId(next, "t1").sessionId, "s-new");
  assert.equal(byId(next, "t1").sessionTitle, "New session");
  assert.equal(byId(next, "t1").laneId, "lane-todo", "no move: the card was already in a work lane");
  assert.equal(byId(board, "t1").sessionId, null, "the input board is untouched");
});

test("attachSessionCard advances a backlog card one lane, then links it", () => {
  const next = k.attachSessionCard(fixture(), "s-new", "New session", { cardId: "b1" }, NOW);
  assert.equal(byId(next, "b1").laneId, "lane-todo", "the backlog never takes a session");
  assert.equal(byId(next, "b1").sessionId, "s-new");
});

test("attachSessionCard refuses another session's card, an unknown card and a card that cannot leave the backlog", () => {
  const board = fixture();
  assert.equal(k.attachSessionCard(board, "s-thief", "Thief", { cardId: "p1" }, NOW), null);
  assert.equal(k.attachSessionCard(board, "s-new", "New", { cardId: "gone" }, NOW), null);
  const onlyBacklog = { ...board, lanes: board.lanes.slice(0, 1) };
  assert.equal(k.attachSessionCard(onlyBacklog, "s-new", "New", { cardId: "b1" }, NOW), null);
});

test("attachSessionCard's new-card pick lands in the chosen lane and reuses an existing card", () => {
  const board = fixture();
  const planned = k.attachSessionCard(board, "s-new", "Plan it", { laneId: "lane-implement" }, NOW);
  const own = planned.cards.find((c) => c.sessionId === "s-new");
  assert.equal(own.laneId, "lane-implement");
  assert.equal(own.title, "Plan it");
  const again = k.attachSessionCard(planned, "s-new", "Renamed", { laneId: "lane-implement" }, LATER);
  assert.equal(again.cards.filter((c) => c.sessionId === "s-new").length, 1, "a retried prompt is not a second card");
  assert.equal(again.cards.find((c) => c.sessionId === "s-new").sessionTitle, "Renamed");
});
