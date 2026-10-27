import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const store = await jiti.import("./kanban-store.ts");
const data = await jiti.import("./kanban-data.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
const { KANBAN_COMMENT_BUDGET, KANBAN_COMMENT_MAX, KANBAN_COMMENT_READ_LIMIT } = await jiti.import("./kanban-tool-limits.ts");
const { DatabaseSync } = await import("node:sqlite");

// A card's comments: their own table, their own read, the same board lock and
// revision. These cover the browser's two writes, the agent's `comment` action,
// the bounded read projection, and what happens to a thread when its card goes.

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
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-web-kanban-comments-")));
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
  return {
    agentDir,
    project,
    path,
    revision: () => withDb(path, (db) => data.readBoardRevision(db)),
    commentRows: () => withDb(path, (db) => db.prepare("SELECT * FROM card_comments ORDER BY created_at, rowid").all()),
    schema: () => withDb(path, (db) => Number(db.prepare("PRAGMA user_version").get().user_version ?? 0)),
  };
}

function withDb(path, body) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return body(db);
  } finally {
    db.close();
  }
}

/** A fabricated session header, so `validateSession` accepts the id. */
function fabricateSession(agentDir, cwd, id) {
  const dir = join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  fs.mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`);
  return file;
}

/** A board with one work-lane card, one backlog card, and `sessionId` linked to the work card. */
async function boardWithCard(f, sessionId = null) {
  const created = await store.applyMutation(f.project, { action: "add-card", laneId: "lane-todo", title: "Card", cardId: "card-1" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const backlog = await store.applyMutation(f.project, { action: "add-card", laneId: "lane-backlog", title: "Free", cardId: "card-2" });
  assert.equal(backlog.ok, true);
  if (sessionId) {
    fabricateSession(f.agentDir, f.project, sessionId);
    const linked = await store.applyMutation(f.project, { action: "link-session", cardId: "card-1", sessionId, sessionTitle: "Actor" });
    assert.equal(linked.ok, true, JSON.stringify(linked));
  }
  return { cardId: "card-1", freeCardId: "card-2" };
}

test("a comment round-trips through its own read: author, order, and one revision bump with the board untouched", async (t) => {
  const f = fixture(t);
  const { cardId } = await boardWithCard(f);
  const before = f.revision();

  const first = await store.applyMutation(f.project, { action: "add-comment", cardId, body: "  first note  " });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.revision, before + 1, "a comment is a change the poll must see");
  const second = await store.applyMutation(f.project, { action: "add-comment", cardId, body: "second note" });
  assert.equal(second.ok, true);

  const thread = await store.readCardCommentsFor(f.project, cardId);
  assert.equal(thread.ok, true);
  assert.deepEqual(thread.comments.map((comment) => comment.body), ["first note", "second note"], "trimmed, oldest first");
  assert.equal(thread.total, 2);
  assert.equal(thread.comments[0].author, "user");
  assert.equal(thread.comments[0].sessionId, null);
  assert.equal(thread.revision, second.revision);

  // The board itself did not move: no card row changed.
  const board = await store.readBoard(f.project);
  assert.equal(board.ok, true);
  assert.deepEqual(board.board.cards.map((card) => [card.id, card.title]), [["card-1", "Card"], ["card-2", "Free"]]);
});

test("a comment on a card that is not on the board is refused and writes nothing", async (t) => {
  const f = fixture(t);
  await boardWithCard(f);
  const before = f.revision();
  const refused = await store.applyMutation(f.project, { action: "add-comment", cardId: "missing", body: "x" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "refused");
  assert.equal(f.revision(), before, "no write, no bump");
  assert.deepEqual(f.commentRows(), []);
});

test("deleting a card takes its thread with it, in the same write", async (t) => {
  const f = fixture(t);
  const { cardId, freeCardId } = await boardWithCard(f);
  await store.applyMutation(f.project, { action: "add-comment", cardId, body: "goes with the card" });
  await store.applyMutation(f.project, { action: "add-comment", cardId: freeCardId, body: "stays" });
  assert.equal(f.commentRows().length, 2);

  const deleted = await store.applyMutation(f.project, { action: "delete-card", cardId });
  assert.equal(deleted.ok, true);
  assert.deepEqual(f.commentRows().map((row) => row.body), ["stays"], "the untouched card keeps its note");
  const gone = await store.readCardCommentsFor(f.project, cardId);
  assert.equal(gone.ok, true);
  assert.equal(gone.total, 0);
});

test("deleting a comment removes it; an id that is already gone is not a failure", async (t) => {
  const f = fixture(t);
  const { cardId } = await boardWithCard(f);
  await store.applyMutation(f.project, { action: "add-comment", cardId, body: "one" });
  await store.applyMutation(f.project, { action: "add-comment", cardId, body: "two" });
  const [first] = (await store.readCardCommentsFor(f.project, cardId)).comments;

  const removed = await store.applyMutation(f.project, { action: "delete-comment", commentId: first.id });
  assert.equal(removed.ok, true);
  const thread = await store.readCardCommentsFor(f.project, cardId);
  assert.deepEqual(thread.comments.map((comment) => comment.body), ["two"]);

  const again = await store.applyMutation(f.project, { action: "delete-comment", commentId: first.id });
  assert.equal(again.ok, true, "two tabs racing to delete the same note is not an error");
  assert.deepEqual((await store.readCardCommentsFor(f.project, cardId)).comments.map((comment) => comment.body), ["two"]);
});

test("a reading board creates nothing; an empty read answers an empty thread at revision 0", async (t) => {
  const f = fixture(t);
  const empty = await store.readCardCommentsFor(f.project, "anything");
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.comments, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.revision, 0);
  assert.equal(fs.existsSync(f.path), false, "looking at a thread never creates a board");
});

test("a v2 board gains the comments table in place: rows, revision and lanes intact", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(dirname(f.path), { recursive: true });
  const db = new DatabaseSync(f.path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE lanes (
      id TEXT PRIMARY KEY, position INTEGER NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', fixed INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE cards (
      id TEXT PRIMARY KEY, position INTEGER NOT NULL, lane_id TEXT NOT NULL REFERENCES lanes(id),
      title TEXT NOT NULL, description TEXT NOT NULL, session_id TEXT, session_title TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX cards_session ON cards(session_id) WHERE session_id IS NOT NULL;
    INSERT INTO meta (key, value) VALUES ('revision', '7');
    INSERT INTO lanes (id, position, name, description, instructions, fixed) VALUES
      ('lane-backlog', 0, 'Backlog', 'Waiting', '', 1),
      ('lane-todo', 1, 'Todo', 'Ready', 'work here', 0);
    INSERT INTO cards (id, position, lane_id, title, description, session_id, session_title, created_at, updated_at) VALUES
      ('c1', 0, 'lane-todo', 'Old card', 'body', NULL, NULL, 1, 2);
    PRAGMA user_version = 2;
  `);
  db.close();

  const opened = await store.readBoard(f.project);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(f.schema(), 3, "the open added the comments table");
  assert.equal(opened.revision, 7, "a migration is storage, not content");
  assert.deepEqual(f.commentRows(), [], "and it starts empty");

  const added = await store.applyMutation(f.project, { action: "add-comment", cardId: "c1", body: "after the upgrade" });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.revision, 8);
  assert.deepEqual((await store.readCardCommentsFor(f.project, "c1")).comments.map((comment) => comment.body), ["after the upgrade"]);
});

test("the agent writes a comment on its own card, an unlinked card, and nowhere else", async (t) => {
  const f = fixture(t);
  const { cardId, freeCardId } = await boardWithCard(f, "s1");
  const actor = { sessionId: "s1", sessionTitle: "Actor" };

  const own = await store.executeKanbanToolRequest(f.project, actor, { action: "comment", body: "Handoff: next step is the route." });
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.equal(own.action, "comment");
  assert.equal(own.comment.cardId, cardId, "an omitted cardId is the session's own card");
  assert.equal(own.comment.author, "agent");
  assert.equal(own.comment.sessionId, "s1");
  assert.equal(own.comment.sessionTitle, "Actor");
  assert.equal(own.card.id, cardId);

  // A sessionless card is fair game, exactly like a text edit on it.
  const free = await store.executeKanbanToolRequest(f.project, actor, { action: "comment", cardId: freeCardId, body: "noted" });
  assert.equal(free.ok, true, JSON.stringify(free));
  assert.equal(free.comment.cardId, freeCardId);

  // Another session's card is refused.
  fabricateSession(f.agentDir, f.project, "s2");
  const other = await store.applyMutation(f.project, {
    action: "add-card", laneId: "lane-plan", title: "Other's card", cardId: "card-3", sessionId: "s2", sessionTitle: "Other",
  });
  assert.equal(other.ok, true, JSON.stringify(other));
  const foreign = await store.executeKanbanToolRequest(f.project, actor, { action: "comment", cardId: "card-3", body: "nope" });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, "refused");
  assert.match(foreign.error, /another session/);
});

test("read { cardId } carries the newest comments, bounded, with the total count", async (t) => {
  const f = fixture(t);
  const { cardId } = await boardWithCard(f, "s1");
  const actor = { sessionId: "s1", sessionTitle: "Actor" };
  const long = "x".repeat(KANBAN_COMMENT_BUDGET + 50);
  for (let index = 0; index < KANBAN_COMMENT_READ_LIMIT + 2; index += 1) {
    const body = index === KANBAN_COMMENT_READ_LIMIT + 1 ? long : `note ${index}`;
    const written = await store.executeKanbanToolRequest(f.project, actor, { action: "comment", body });
    assert.equal(written.ok, true, JSON.stringify(written));
  }

  const read = await store.executeKanbanToolRequest(f.project, actor, { action: "read", cardId });
  assert.equal(read.ok, true);
  assert.equal(read.commentCount, KANBAN_COMMENT_READ_LIMIT + 2, "the count is the whole thread");
  assert.equal(read.comments.length, KANBAN_COMMENT_READ_LIMIT, "the payload is the newest page");
  assert.equal(read.comments.at(-1).body.endsWith("…[truncated]"), true, "a long note is cut with a marker");
  assert.equal([...read.comments.at(-1).body].length, KANBAN_COMMENT_BUDGET + "…[truncated]".length);
  assert.equal(read.comments[0].author, "agent");

  // The overview and search never carry comments: only the one-card read does.
  const overview = await store.executeKanbanToolRequest(f.project, actor, { action: "read" });
  assert.equal(JSON.stringify(overview).includes("note 0"), false);
  const search = await store.executeKanbanToolRequest(f.project, actor, { action: "search", query: "Card" });
  assert.equal(JSON.stringify(search).includes("note 0"), false);
});

test("a comment body over the cap is refused before any write", async (t) => {
  const f = fixture(t);
  const { cardId } = await boardWithCard(f, "s1");
  const before = f.revision();
  const tooLong = await store.executeKanbanToolRequest(f.project, { sessionId: "s1" }, { action: "comment", cardId, body: "y".repeat(KANBAN_COMMENT_MAX + 1) });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, "invalid-request");
  assert.equal(f.revision(), before);
  assert.deepEqual(f.commentRows(), []);
});
