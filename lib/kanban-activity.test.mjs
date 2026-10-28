import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { DatabaseSync } from "node:sqlite";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const derive = await jiti.import("./kanban-activity.ts");
const store = await jiti.import("./kanban-store.ts");
const data = await jiti.import("./kanban-data.ts");
const types = await jiti.import("./kanban-types.ts");
const { KANBAN_ACTIVITY_KEEP, KANBAN_ACTIVITY_PAGE_LIMIT } = await jiti.import("./kanban-types.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");

// A card's activity is history, not state: derived by the store from the board
// write that caused it. These pin what counts as an event (and what does not),
// how a move names its two lanes, that a lane deletion is one row, that the
// trail shares the board's transaction and revision, its retention, its paging
// and the one-card read's bounded projection.

const NOW = 1_000;

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

const board = (cards, extra = {}) => ({ projectDir: "/x", lanes: types.defaultLanes(), cards, ...extra });
const byId = (source, id) => source.cards.find((entry) => entry.id === id);

function deriveFrom(mutate, actor = null) {
  const before = board([card("c1", "lane-todo"), card("c2", "lane-plan", { sessionId: "s1", sessionTitle: "One" })]);
  const after = mutate(JSON.parse(JSON.stringify(before)));
  return derive.deriveKanbanActivity(before, after, NOW, actor);
}

test("a card added to a lane is one created row naming the lane", () => {
  const events = derive.deriveKanbanActivity(
    board([]),
    board([card("new", "lane-todo")]),
    NOW,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "created");
  assert.equal(events[0].from, null);
  assert.equal(events[0].to, "Todo");
  assert.equal(events[0].cardId, "new");
  assert.equal(events[0].createdAt, NOW);
  assert.equal(events[0].actorSessionId, null);
});

test("a move names both lanes; a same-lane reorder and a no-op emit nothing", () => {
  const moved = deriveFrom((next) => {
    byId(next, "c1").laneId = "lane-plan";
    return next;
  });
  assert.deepEqual(moved.map((event) => [event.kind, event.from, event.to]), [["moved", "Todo", "Plan"]]);

  // Position is not history: the same lane in another order changes no field.
  const reordered = deriveFrom((next) => {
    next.cards.reverse();
    return next;
  });
  assert.deepEqual(reordered, []);

  // The reducers' no-op returns the SAME board object, which cannot be history.
  const same = board([card("c1", "lane-todo")]);
  assert.deepEqual(derive.deriveKanbanActivity(same, same, NOW), []);
});

test("text edits record the values they changed, and a linked session records the snapshot name", () => {
  const events = deriveFrom((next) => {
    byId(next, "c1").title = "Renamed";
    byId(next, "c1").description = "now with a body";
    byId(next, "c1").sessionId = "s2";
    byId(next, "c1").sessionTitle = "Second";
    return next;
  });
  assert.deepEqual(
    events.map((event) => [event.kind, event.from, event.to]),
    [["title", "Card c1", "Renamed"], ["description", null, null], ["linked", null, "Second"]],
  );

  const unlinked = deriveFrom((next) => {
    byId(next, "c2").sessionId = null;
    return next;
  });
  assert.deepEqual(unlinked.map((event) => [event.kind, event.from, event.to]), [["unlinked", "One", null]]);
});

test("deleting a lane is ONE row per relocated card, not a move plus an unlink", () => {
  const before = board([card("c1", "lane-deploy", { sessionId: "s1", sessionTitle: "One" })]);
  const after = JSON.parse(JSON.stringify(before));
  after.lanes = after.lanes.filter((lane) => lane.id !== "lane-deploy");
  after.cards[0].laneId = "lane-backlog";
  after.cards[0].sessionId = null;
  const events = derive.deriveKanbanActivity(before, after, NOW);
  assert.deepEqual(events.map((event) => [event.kind, event.from, event.to]), [["lane-deleted", "Deploy", "Backlog"]]);
});

test("the actor of a write is stamped on its rows", () => {
  const events = deriveFrom(
    (next) => {
      byId(next, "c1").laneId = "lane-plan";
      return next;
    },
    { sessionId: "s9", sessionTitle: "Actor" },
  );
  assert.equal(events[0].actorSessionId, "s9");
  assert.equal(events[0].actorSessionTitle, "Actor");
});

// ---------------------------------------------------------------------------
// Store level: one transaction, one revision, no client writes
// ---------------------------------------------------------------------------

function resetGlobalState() {
  globalThis.__piSessionListCache = undefined;
  globalThis.__piSessionListPromise = undefined;
  globalThis.__piSessionListPromiseGeneration = undefined;
  globalThis.__piSessionListGeneration = 0;
  globalThis.__piSessionPathCache = undefined;
  globalThis.__piPathToSessionIdCache = undefined;
  globalThis.__piAllowedRootsCache = undefined;
  globalThis.__piAdditionalAllowedRoots = undefined;
  globalThis.__piProjectCache = undefined;
  globalThis.__piProjectRefresh = undefined;
  globalThis.__piProjectCacheGeneration = undefined;
}

function fixture(t) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-web-kanban-activity-")));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  resetGlobalState();
  allowFileRoot(project);
  t.after(() => {
    resetGlobalState();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const key = `--${project.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const path = join(agentDir, "kanban", key, "kanban.sqlite");
  const withDb = (body) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return body(db);
    } finally {
      db.close();
    }
  };
  return {
    agentDir,
    project,
    path,
    revision: () => withDb((db) => data.readBoardRevision(db)),
    rows: () => withDb((db) => db.prepare("SELECT * FROM card_activity ORDER BY rowid").all()),
  };
}

/** A fabricated session header, so `validateSession` accepts the id. */
function fabricateSession(agentDir, cwd, id) {
  const dir = join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  fs.mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`);
  return file;
}

/** A card that survives a move into a work lane: it carries a session (the board's entry rule). */
async function linkedCard(f, laneId = "lane-todo") {
  fabricateSession(f.agentDir, f.project, "s-owner");
  const created = await store.applyMutation(f.project, {
    action: "add-card", laneId, title: "Card", cardId: "card-1", sessionId: "s-owner", sessionTitle: "Owner",
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return created;
}

test("a mutation and its activity land in one write, with one revision bump", async (t) => {
  const f = fixture(t);
  const created = await store.applyMutation(f.project, { action: "add-card", laneId: "lane-todo", title: "Card", cardId: "card-1" });
  assert.equal(created.ok, true, JSON.stringify(created));
  // A board created by this very write still records the creation.
  assert.deepEqual(f.rows().map((row) => [row.kind, row.to_value]), [["created", "Todo"]]);

  const moved = await store.applyMutation(f.project, { action: "move-card", cardId: "card-1", laneId: "lane-backlog" });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.revision, created.revision + 1, "one bump covers the board and its history");
  assert.deepEqual(
    f.rows().map((row) => [row.kind, row.from_value, row.to_value]),
    [["created", null, "Todo"], ["moved", "Todo", "Backlog"]],
  );

  const trail = await store.readCardActivityFor(f.project, "card-1");
  assert.equal(trail.ok, true);
  assert.deepEqual(trail.activity.map((event) => event.kind), ["created", "moved"]);
  assert.equal(trail.total, 2);
  assert.equal(trail.revision, moved.revision);

  // Without a card id the board read carries none of it.
  const listed = await store.readBoard(f.project);
  assert.equal(JSON.stringify(listed.board).includes("lane-deleted"), false);
});

test("a comment and a refused write add no activity; a no-op adds none either", async (t) => {
  const f = fixture(t);
  await store.applyMutation(f.project, { action: "add-card", laneId: "lane-todo", title: "Card", cardId: "card-1" });
  const before = f.rows().length;
  const noted = await store.applyMutation(f.project, { action: "add-comment", cardId: "card-1", body: "note" });
  assert.equal(noted.ok, true);
  assert.equal(f.rows().length, before, "a note is not a card state transition");
  const refused = await store.applyMutation(f.project, { action: "move-card", cardId: "card-1", laneId: "lane-plan" });
  assert.equal(refused.ok, false);
  assert.equal(f.rows().length, before, "a refusal writes nothing");
  // A same-lane move is the reducers' no-op: the board object is unchanged.
  const same = await store.applyMutation(f.project, { action: "move-card", cardId: "card-1", laneId: "lane-todo" });
  assert.equal(same.ok, true);
  assert.equal(f.rows().length, before);
});

test("the agent's own update attributes its rows to the session", async (t) => {
  const f = fixture(t);
  await store.applyMutation(f.project, { action: "add-card", laneId: "lane-todo", title: "Card", cardId: "card-1" });
  fabricateSession(f.agentDir, f.project, "s1");
  const moved = await store.executeKanbanToolRequest(f.project, { sessionId: "s1", sessionTitle: "Actor" }, {
    action: "update", cardId: "card-1", laneId: "lane-implement",
  });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  // Claiming a free card in a work lane is one write: a move AND its link.
  const written = f.rows().slice(-2);
  assert.deepEqual(written.map((row) => row.kind), ["moved", "linked"]);
  assert.equal(written.every((row) => row.actor_session_id === "s1"), true, "both rows name the session that wrote them");
  assert.equal(written[0].actor_session_title, "Actor");
});

test("one card's trail pages backwards by its oldest row, and keeps the newest KANBAN_ACTIVITY_KEEP", async (t) => {
  const f = fixture(t);
  await linkedCard(f);
  const lanes = ["lane-plan", "lane-todo", "lane-implement", "lane-todo"];
  for (let index = 0; index < KANBAN_ACTIVITY_PAGE_LIMIT + 3; index += 1) {
    const laneId = lanes[index % lanes.length];
    const result = await store.applyMutation(f.project, { action: "move-card", cardId: "card-1", laneId });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const total = KANBAN_ACTIVITY_PAGE_LIMIT + 4;
  const first = await store.readCardActivityFor(f.project, "card-1");
  assert.equal(first.ok, true);
  assert.equal(first.total, total);
  assert.equal(first.activity.length, KANBAN_ACTIVITY_PAGE_LIMIT, "the newest page");
  const older = await store.readCardActivityFor(f.project, "card-1", KANBAN_ACTIVITY_PAGE_LIMIT, first.activity[0].id);
  assert.equal(older.ok, true);
  assert.equal(older.activity.length, total - KANBAN_ACTIVITY_PAGE_LIMIT, "the rest, in front of it");
  assert.equal(older.activity.at(-1).createdAt <= first.activity[0].createdAt, true);
  assert.equal(new Set([...older.activity, ...first.activity].map((event) => event.id)).size, total, "no row twice");

  // An unknown cursor reads the newest page instead of failing.
  const unknown = await store.readCardActivityFor(f.project, "card-1", KANBAN_ACTIVITY_PAGE_LIMIT, "gone");
  assert.equal(unknown.ok, true);
  assert.equal(unknown.activity.at(-1).id, first.activity.at(-1).id);

  // Retention: the oldest rows go once a card's trail passes its cap.
  await store.applyMutation(f.project, { action: "add-lane", name: "Extra" });
  for (let index = 0; index < KANBAN_ACTIVITY_KEEP; index += 1) {
    await store.applyMutation(f.project, { action: "edit-card", cardId: "card-1", title: `Card ${index}` });
  }
  assert.equal(f.rows().length, KANBAN_ACTIVITY_KEEP, "one card's trail is bounded");
  const capped = await store.readCardActivityFor(f.project, "card-1", KANBAN_ACTIVITY_KEEP);
  assert.equal(capped.total, KANBAN_ACTIVITY_KEEP);
  assert.equal(capped.activity.at(-1).kind, "title", "the newest rows are the ones kept");
});

test("deleting a card takes its history with it, in the same write", async (t) => {
  const f = fixture(t);
  await store.applyMutation(f.project, { action: "add-card", laneId: "lane-todo", title: "One", cardId: "card-1" });
  await store.applyMutation(f.project, { action: "add-card", laneId: "lane-todo", title: "Two", cardId: "card-2" });
  const deleted = await store.applyMutation(f.project, { action: "delete-card", cardId: "card-1" });
  assert.equal(deleted.ok, true);
  const rows = f.rows();
  assert.equal(rows.every((row) => row.card_id === "card-2"), true, "only the untouched card keeps its trail");
  const gone = await store.readCardActivityFor(f.project, "card-1");
  assert.equal(gone.ok, true);
  assert.equal(gone.total, 0);
});

test("a dead session link is unlinked by a read, and that is recorded", async (t) => {
  const f = fixture(t);
  await store.applyMutation(f.project, { action: "add-card", laneId: "lane-todo", title: "Card", cardId: "card-1" });
  const file = fabricateSession(f.agentDir, f.project, "s1");
  const linked = await store.applyMutation(f.project, { action: "link-session", cardId: "card-1", sessionId: "s1", sessionTitle: "Actor" });
  assert.equal(linked.ok, true, JSON.stringify(linked));
  fs.rmSync(file);
  const read = await store.readBoard(f.project);
  assert.equal(read.ok, true);
  const trail = await store.readCardActivityFor(f.project, "card-1");
  assert.equal(trail.ok, true);
  const unlinked = trail.activity.at(-1);
  assert.equal(unlinked.kind, "unlinked");
  assert.equal(unlinked.from, "Actor", "the kept snapshot name names who left");
});

test("read { cardId } carries the newest five activity lines, and the overview carries none", async (t) => {
  const f = fixture(t);
  await store.applyMutation(f.project, { action: "add-card", laneId: "lane-todo", title: "Card", cardId: "card-1" });
  fabricateSession(f.agentDir, f.project, "s1");
  const actor = { sessionId: "s1", sessionTitle: "Actor" };
  const lanes = ["lane-plan", "lane-implement", "lane-todo", "lane-plan", "lane-done", "lane-todo"];
  for (const laneId of lanes) {
    const moved = await store.executeKanbanToolRequest(f.project, actor, { action: "update", cardId: "card-1", laneId });
    assert.equal(moved.ok, true, JSON.stringify(moved));
  }
  const read = await store.executeKanbanToolRequest(f.project, actor, { action: "read", cardId: "card-1" });
  assert.equal(read.ok, true);
  assert.equal(read.activityTotal, f.rows().length, "the whole trail is counted");
  assert.equal(read.activity.length, 5, "the projection is bounded");
  assert.equal(read.activity.at(-1).kind, "moved");
  assert.equal(read.activity.at(-1).actor, "Actor");
  assert.equal(typeof read.activity.at(-1).at, "number");
  assert.equal(read.activity.at(-1).kind === "moved" ? read.activity.at(-1).to : null, "Todo");

  const overview = await store.executeKanbanToolRequest(f.project, actor, { action: "read" });
  assert.equal("activity" in overview, false, "the overview stays the cheap read");
  const search = await store.executeKanbanToolRequest(f.project, actor, { action: "search", query: "Card" });
  assert.equal("activity" in search, false);
});
