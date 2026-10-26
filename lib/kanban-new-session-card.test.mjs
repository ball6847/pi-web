import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./kanban-store.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
const data = await jiti.import("./kanban-data.ts");

/**
 * A fresh composer's card is written by the prompt route *before* the run, where
 * pi has not written the session's file yet (it lands with the first message).
 * The write trusts that id — and must not prune it back out again.
 */
function fixture(t) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "kanban-new-session-")));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  fs.mkdirSync(project);
  fs.mkdirSync(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  allowFileRoot(root);
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sessionFile = (id) => {
    const dir = join(agentDir, "sessions", data.encodeKanbanProjectKey(project));
    fs.mkdirSync(dir, { recursive: true });
    return join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  };
  const withFile = (id) => {
    fs.writeFileSync(sessionFile(id), JSON.stringify({ type: "session", version: 3, id, cwd: project, timestamp: "2026-01-01T00:00:00Z" }) + "\n");
    return id;
  };
  const call = (sessionId, pick, sessionTitle = "Fix the thing") => store.attachNewSessionCard(project, { sessionId, sessionTitle }, pick);
  const board = async () => (await store.readBoard(project, { create: false })).board;
  const addCard = async (laneId, title) => {
    const added = await store.applyMutation(project, { action: "add-card", laneId, title });
    return added.board.cards.find((card) => card.title === title);
  };
  return { root, project, call, board, addCard, withFile, sessionFile };
}

test("a card is linked to a session whose file does not exist yet, and not pruned", async (t) => {
  const f = fixture(t);
  const card = await f.addCard("lane-todo", "attach me");
  assert.equal(fs.existsSync(f.sessionFile("new-session")), false);
  const linked = await f.call("new-session", { cardId: card.id });
  assert.equal(linked.ok, true, JSON.stringify(linked));
  const shown = (await f.board()).cards[0];
  assert.equal(shown.sessionId, "new-session");
  assert.equal(shown.sessionTitle, "Fix the thing");
  // The browser's board view reads *creating*, which prunes dead links. The file
  // pi has not written yet must not cost the fresh link: the attach's own grace
  // window keeps it alive until the first message lands.
  const creating = await store.readBoard(f.project, { create: true });
  assert.equal(creating.ok, true);
  assert.equal(creating.board.cards[0].sessionId, "new-session");
});

test("a backlog card advances one lane first: the backlog never takes a session", async (t) => {
  const f = fixture(t);
  const card = await f.addCard("lane-backlog", "from the backlog");
  const linked = await f.call("new-session", { cardId: card.id });
  assert.equal(linked.ok, true, JSON.stringify(linked));
  const shown = (await f.board()).cards[0];
  assert.equal(shown.laneId, "lane-todo");
  assert.equal(shown.sessionId, "new-session");
});

test("a new-card pick creates the session's card in the chosen lane, once", async (t) => {
  const f = fixture(t);
  const created = await f.call("new-session", { laneId: "lane-plan" }, "Plan it");
  assert.equal(created.ok, true, JSON.stringify(created));
  const first = (await f.board()).cards;
  assert.equal(first.length, 1);
  assert.equal(first[0].laneId, "lane-plan");
  assert.equal(first[0].sessionId, "new-session");
  assert.equal(first[0].title, "Plan it");
  // A retried prompt is not a second card.
  assert.equal((await f.call("new-session", { laneId: "lane-plan" })).ok, true);
  assert.equal((await f.board()).cards.length, 1);
});

test("an unknown card, another session's card, or an unknown lane is refused without a write", async (t) => {
  const f = fixture(t);
  const mine = await f.addCard("lane-todo", "someone else's");
  assert.equal((await f.call("owner-session", { cardId: mine.id })).ok, true);
  const before = await f.board();
  const other = (await f.call("thief", { cardId: mine.id })).ok;
  assert.equal(other, false, "links cannot be stolen");
  assert.equal((await f.call("new-session", { cardId: "missing" })).code, "refused");
  assert.equal((await f.call("new-session", { laneId: "lane-gone" })).ok, true, "an unknown lane falls back to the first work lane");
  const after = await f.board();
  assert.equal(after.cards[0].sessionId, "owner-session");
  assert.deepEqual(after.cards[0], before.cards[0]);
});

test("a board from a newer build is refused, never touched", async (t) => {
  const f = fixture(t);
  const card = await f.addCard("lane-todo", "x");
  const path = data.kanbanBoardPath(f.project);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  const newer = (await import("./kanban-types.ts")).KANBAN_SCHEMA_VERSION;
  db.exec(`PRAGMA user_version = ${Number(newer) + 1}`);
  db.close();
  const before = fs.readFileSync(path);
  const refused = await f.call("new-session", { cardId: card.id });
  assert.equal(refused.code, "unsupported-schema");
  assert.deepEqual(fs.readFileSync(path), before);
});
