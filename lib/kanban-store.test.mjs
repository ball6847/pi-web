import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import lockfile from "proper-lockfile";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const store = await jiti.import("./kanban-store.ts");
const data = await jiti.import("./kanban-data.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
const { DatabaseSync } = await import("node:sqlite");
const { KANBAN_SCHEMA_VERSION } = await jiti.import("./kanban-types.ts");

const execFileAsync = promisify(execFile);
async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

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

/**
 * A temp agent dir (the PI_CODING_AGENT_DIR override the session tests use) and
 * a temp project dir that is an allowed root, so cwd validation passes.
 */
function fixture(t, { allow = true } = {}) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-web-kanban-store-")));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  resetGlobalState();
  if (allow) allowFileRoot(project);
  t.after(() => {
    resetGlobalState();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  // The board's shared location: under the (temp) agent dir, keyed by the resolved project root.
  const key = `--${project.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const path = join(agentDir, "kanban", key, "kanban.sqlite");
  return {
    root,
    agentDir,
    project,
    path,
    /** The board as the database holds it (a real read, not a cached one). */
    board: () => withDb(path, (db) => data.readBoardRows(db, project).board),
    /** The board's revision in the file. */
    revision: () => withDb(path, (db) => data.readBoardRevision(db)),
    /** The schema stamp in the file. */
    schema: () => withDb(path, (db) => Number(db.prepare("PRAGMA user_version").get().user_version ?? 0)),
    /** Raw rows, for the "nothing was rewritten" assertions. */
    rows: () => withDb(path, (db) => JSON.stringify({
      lanes: db.prepare("SELECT * FROM lanes ORDER BY position").all(),
      cards: db.prepare("SELECT * FROM cards ORDER BY position").all(),
      meta: db.prepare("SELECT * FROM meta ORDER BY key").all(),
    })),
    exists: () => fs.existsSync(path),
    stat: () => fs.statSync(path),
    kanbanDir: () => dirname(path),
    files: () => (fs.existsSync(dirname(path)) ? fs.readdirSync(dirname(path)) : []),
    /** The cards the file holds (the old `file().board.cards`). */
    cards: () => withDb(path, (db) => data.readBoardRows(db, project).board.cards),
    /** The lanes the file holds (the old `file().board.lanes`). */
    lanes: () => withDb(path, (db) => data.readBoardRows(db, project).board.lanes),
  };
}

/** Opens a board file for reading, closes it again (never creates one). */
function withDb(path, body) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return body(db);
  } finally {
    db.close();
  }
}

/** A fabricated `<agentDir>/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl` with just a header. */
function fabricateSession(agentDir, cwd, id) {
  const dir = join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  fs.mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd }) + "\n");
  return file;
}

function quietWarnings(t) {
  const previous = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = previous;
  });
}

/**
 * A second allowed project beside the fixture's own, in the same agent dir: two
 * boards on one machine, which is what the prefix namespace is about. The reset
 * clears the allowed roots, so both are re-allowed afterwards.
 */
function nearbyProject(t, f, name) {
  const dir = join(f.root, name);
  fs.mkdirSync(dir, { recursive: true });
  resetGlobalState();
  allowFileRoot(f.project);
  allowFileRoot(dir);
  return dir;
}

const add = (project, title, laneId = "lane-todo", extra = {}) =>
  store.applyMutation(project, { action: "add-card", laneId, title, ...extra });

test("first read creates the board file with six lanes and no cards; the second read writes nothing", async (t) => {
  const f = fixture(t);
  const first = await store.readBoard(f.project);
  assert.equal(first.ok, true);
  assert.equal(first.board.projectDir, f.project);
  assert.equal(first.board.lanes.length, 6);
  assert.equal(first.board.cards.length, 0);
  assert.equal(f.schema(), KANBAN_SCHEMA_VERSION, "the file carries the board schema stamp");
  const board = f.board();
  assert.equal(board.lanes.length, 6);
  assert.equal(board.lanes[0].id, "lane-backlog");
  assert.equal(board.lanes[0].fixed, true);
  assert.deepEqual(board.cards, []);
  assert.equal(first.revision, f.revision(), "the answered revision is the file's");
  assert.equal(fs.existsSync(join(f.project, ".pi")), false, "the move leaves nothing under the project");
  assert.deepEqual(f.files(), ["kanban.sqlite"], "the board is one self-contained file");

  const rows = f.rows();
  const mtime = fs.statSync(f.path).mtimeMs;
  const second = await store.readBoard(f.project);
  assert.equal(second.ok, true);
  assert.equal(second.revision, first.revision);
  assert.equal(f.rows(), rows, "no row was rewritten");
  assert.equal(fs.statSync(f.path).mtimeMs, mtime, "the file was not touched");
});

test("a mutation round-trips through the database and bumps the revision strictly each time", async (t) => {
  const f = fixture(t);
  const initial = await store.readBoard(f.project);
  const a = await add(f.project, "  First  ", "lane-todo", { cardId: "c1", description: "d" });
  assert.equal(a.ok, true);
  assert.ok(a.revision > initial.revision);
  const b = await add(f.project, "Second", "lane-plan", { cardId: "c2" });
  assert.ok(b.revision > a.revision);
  assert.equal(a.board.cards[0].title, "First", "the title is trimmed by the board's rules");

  const onDisk = f.board();
  assert.deepEqual(onDisk.cards.map((c) => [c.id, c.title, c.laneId]), [["c1", "First", "lane-todo"], ["c2", "Second", "lane-plan"]]);
  const reread = await store.readBoard(f.project);
  assert.deepEqual(reread.board, b.board, "a read returns exactly what the write answered");
  assert.equal(reread.revision, b.revision);

  const moved = await store.applyMutation(f.project, { action: "advance-card", cardId: "c1" });
  assert.equal(moved.board.cards.find((c) => c.id === "c1").laneId, "lane-plan");
  const lane = await store.applyMutation(f.project, { action: "rename-lane", laneId: "lane-todo", name: "Ready" });
  assert.equal(lane.board.lanes[1].name, "Ready");
  assert.equal(f.board().lanes[1].name, "Ready");
});

test("an edit that changes nothing writes nothing", async (t) => {
  const f = fixture(t);
  await add(f.project, "Only", "lane-todo", { cardId: "c1" });
  const rows = f.rows();
  const revision = f.revision();
  const same = await store.applyMutation(f.project, { action: "delete-card", cardId: "no-such-card" });
  assert.equal(same.ok, true);
  assert.equal(f.rows(), rows, "no row changed");
  assert.equal(f.revision(), revision, "the revision did not move");
  assert.equal(same.revision, revision);
});

test("a rule refusal is typed, writes nothing, and leaves the revision alone", async (t) => {
  const f = fixture(t);
  await add(f.project, "Last", "lane-done", { cardId: "c1" });
  const before = await store.readBoard(f.project);
  const rows = f.rows();
  const refused = await store.applyMutation(f.project, { action: "advance-card", cardId: "c1" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "refused");
  const sessionless = await store.applyMutation(f.project, { action: "move-card", cardId: "c1", laneId: "lane-todo" });
  assert.equal(sessionless.code, "refused");
  assert.equal(f.rows(), rows);
  assert.equal((await store.getBoardRevision(f.project)).revision, before.revision);
});

test("a file that is not a database is set aside as a backup sibling and replaced by a fresh board, without throwing", async (t) => {
  quietWarnings(t);
  const f = fixture(t);
  fs.mkdirSync(f.kanbanDir(), { recursive: true });
  const garbage = "{ this is not json \u0000\u0001";
  fs.writeFileSync(f.path, garbage);
  const result = await store.readBoard(f.project);
  assert.equal(result.ok, true);
  assert.equal(result.board.lanes.length, 6);
  assert.equal(result.board.cards.length, 0);
  const backups = f.files().filter((name) => name.startsWith("kanban.sqlite.corrupt-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(join(f.kanbanDir(), backups[0]), "utf8"), garbage, "the bad bytes are kept");
  assert.equal(f.schema(), KANBAN_SCHEMA_VERSION);
  assert.equal(f.board().lanes.length, 6);
});

test("a valid database that holds no board is corrupt too; a mutation also recovers", async (t) => {
  quietWarnings(t);
  const f = fixture(t);
  fs.mkdirSync(f.kanbanDir(), { recursive: true });
  // A stray SQLite database with tables of its own (not a 0-byte file, which
  // is adopted: an interrupted first open leaves exactly that).
  const stray = new DatabaseSync(f.path);
  stray.exec("CREATE TABLE something_else (x TEXT) STRICT");
  stray.close();
  const result = await add(f.project, "After corrupt", "lane-todo", { cardId: "c1" });
  assert.equal(result.ok, true);
  assert.equal(result.board.cards.length, 1);
  assert.equal(f.files().filter((n) => n.includes(".corrupt-")).length, 1);
});

test("a board from a newer schema is refused and left untouched", async (t) => {
  const f = fixture(t);
  await store.readBoard(f.project);
  const newer = new DatabaseSync(f.path);
  newer.exec(`PRAGMA user_version = ${KANBAN_SCHEMA_VERSION + 1}`);
  newer.close();
  const before = f.rows();
  const read = await store.readBoard(f.project);
  assert.equal(read.ok, false);
  assert.equal(read.code, "unsupported-schema");
  const write = await add(f.project, "x");
  assert.equal(write.code, "unsupported-schema");
  assert.equal((await store.getBoardRevision(f.project)).code, "unsupported-schema", "the poll refuses it too");
  assert.equal(f.rows(), before, "the file is left as found");
  assert.deepEqual(f.files(), ["kanban.sqlite"], "nothing was set aside");
});

test("a schema-1 board file is migrated in place: lanes gain instructions, rows and revision intact", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.kanbanDir(), { recursive: true });
  // The previous schema by hand: lanes without the instructions column.
  const db = new DatabaseSync(f.path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE lanes (
      id TEXT PRIMARY KEY, position INTEGER NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, fixed INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE cards (
      id TEXT PRIMARY KEY, position INTEGER NOT NULL, lane_id TEXT NOT NULL REFERENCES lanes(id),
      title TEXT NOT NULL, description TEXT NOT NULL, session_id TEXT, session_title TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX cards_session ON cards(session_id) WHERE session_id IS NOT NULL;
    INSERT INTO meta (key, value) VALUES ('revision', '7');
    INSERT INTO lanes (id, position, name, description, fixed) VALUES
      ('lane-backlog', 0, 'Backlog', 'Waiting', 1),
      ('lane-todo', 1, 'Todo', 'Ready', 0);
    INSERT INTO cards (id, position, lane_id, title, description, session_id, session_title, created_at, updated_at) VALUES
      ('c1', 0, 'lane-todo', 'Old card', 'body', NULL, NULL, 1, 2);
    PRAGMA user_version = 1;
  `);
  db.close();

  // The poll stays pure: it answers the revision without migrating anything.
  assert.equal((await store.getBoardRevision(f.project)).revision, 7);
  assert.equal(f.schema(), 1, "the revision poll never writes");

  const read = await store.readBoard(f.project);
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(f.schema(), KANBAN_SCHEMA_VERSION, "the open upgraded the file in place");
  // v4 gives every card a number the views now show, so this one step is
  // content: the revision moves and a cached client refetches for its keys.
  assert.equal(read.revision, 8, "the v4 step is visible, so it bumps the revision");
  assert.deepEqual(read.board.lanes.map((l) => l.id), ["lane-backlog", "lane-todo"]);
  assert.equal(read.board.lanes[0].fixed, true);
  assert.equal(read.board.lanes[1].instructions, undefined, "empty instructions read as absent");
  assert.deepEqual(read.board.cards.map((c) => [c.id, c.title, c.description]), [["c1", "Old card", "body"]], "every row survives");

  // A second read needs no migration and changes nothing on disk.
  const rows = f.rows();
  assert.equal((await store.readBoard(f.project)).ok, true);
  assert.equal(f.rows(), rows);
});

test("a hand-edited board is read leniently: a card in a vanished lane goes to the backlog unlinked, a duplicate session stays on its first card, projectDir follows the folder", async (t) => {
  const f = fixture(t);
  fabricateSession(f.agentDir, f.project, "s");
  fs.mkdirSync(f.kanbanDir(), { recursive: true });
  // Rows written by hand (SQLite's own CLI or a script), not by this code.
  const db = new DatabaseSync(f.path);
  db.exec("PRAGMA foreign_keys = OFF"); // a hand-written row may point at a lane that is gone
  data.initializeBoard(db, data.freshBoard(f.project));
  db.exec("DELETE FROM lanes WHERE id NOT IN ('lane-backlog', 'lane-todo')");
  const card = db.prepare(
    "INSERT INTO cards (id, position, lane_id, title, description, session_id, session_title, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, ?, 1, 1)",
  );
  card.run("a", 0, "lane-gone", "a", null, null); // the lane is gone: the card goes to the backlog
  card.run("b", 1, "lane-todo", "b", null, null);
  card.run("c", 2, "lane-todo", "c", "s", "T");
  db.close();

  const result = await store.readBoard(f.project);
  assert.equal(result.board.projectDir, f.project);
  assert.deepEqual(result.board.cards.map((c) => [c.id, c.laneId, c.sessionId]), [
    ["a", "lane-backlog", null],
    ["b", "lane-todo", null],
    ["c", "lane-todo", "s"],
  ]);
  assert.equal(result.board.lanes.length, 2);
});

test("the revision is the file's counter: a write moves it forward, and a later write continues from there", async (t) => {
  const f = fixture(t);
  // No file yet: 0, and asking creates nothing.
  const none = await store.getBoardRevision(f.project);
  assert.deepEqual(none, { ok: true, revision: 0 });
  assert.equal(fs.existsSync(join(f.agentDir, "kanban")), false, "no directory is created for an unwritten board");

  const created = await store.readBoard(f.project);
  const before = await store.getBoardRevision(f.project);
  assert.equal(before.revision, created.revision);

  const written = await add(f.project, "Later");
  assert.ok(written.revision > before.revision);
  assert.equal((await store.getBoardRevision(f.project)).revision, written.revision);

  // An edit from another connection (another pi-web process) also moves the
  // counter, so the poll notices it without any in-process bookkeeping.
  const other = new DatabaseSync(f.path);
  other.prepare("UPDATE meta SET value = ? WHERE key = 'revision'").run(String(written.revision + 500));
  other.close();
  assert.equal((await store.getBoardRevision(f.project)).revision, written.revision + 500);
});

test("a linked session that exists is linked; one whose file is gone is pruned on read (lane and title kept)", async (t) => {
  const f = fixture(t);
  const sessionFile = fabricateSession(f.agentDir, f.project, "sess-1");
  fabricateSession(f.agentDir, f.project, "sess-2");
  await add(f.project, "Card one", "lane-implement", { cardId: "c1" });
  await add(f.project, "Card two", "lane-plan", { cardId: "c2" });
  const l1 = await store.applyMutation(f.project, { action: "link-session", cardId: "c1", sessionId: "sess-1", sessionTitle: "Session one" });
  assert.equal(l1.ok, true);
  const l2 = await store.applyMutation(f.project, { action: "link-session", cardId: "c2", sessionId: "sess-2", sessionTitle: "Session two" });
  assert.equal(l2.board.cards.find((c) => c.id === "c1").sessionId, "sess-1");

  fs.rmSync(sessionFile);
  const read = await store.readBoard(f.project);
  assert.equal(read.ok, true);
  const pruned = read.board.cards.find((c) => c.id === "c1");
  assert.equal(pruned.sessionId, null);
  assert.equal(pruned.sessionTitle, "Session one");
  assert.equal(pruned.laneId, "lane-implement");
  assert.equal(read.board.cards.find((c) => c.id === "c2").sessionId, "sess-2");
  assert.ok(read.revision > l2.revision);
  assert.equal(f.cards().find((c) => c.id === "c1").sessionId, null); // written back

  const again = await store.readBoard(f.project);
  assert.equal(again.revision, read.revision); // nothing left to prune: no rewrite
});

test("a link whose session file exists is kept even when its cwd no longer resolves to this project", async (t) => {
  const f = fixture(t);
  // A subagent that ran in an isolated worktree: its session file is there, its
  // recorded cwd is a folder that stopped being this project (a leftover
  // worktree, a removed one whose inference failed). Losing that link means
  // losing the only path back to the transcript.
  const elsewhere = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-web-kanban-elsewhere-")));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fabricateSession(f.agentDir, elsewhere, "elsewhere-1");
  await add(f.project, "Card", "lane-todo", { cardId: "c1" });

  // Linking is still strict: another project's session cannot be claimed here.
  const refused = await store.applyMutation(f.project, {
    action: "link-session", cardId: "c1", sessionId: "elsewhere-1", sessionTitle: "Elsewhere",
  });
  assert.equal(refused.ok, false);

  // A link written earlier — while the folder still belonged — survives pruning.
  const db = new DatabaseSync(f.path);
  db.prepare("UPDATE cards SET session_id = ?, session_title = ? WHERE id = 'c1'").run("elsewhere-1", "Elsewhere");
  db.close();

  const read = await store.readBoard(f.project);
  assert.equal(read.ok, true);
  assert.equal(read.board.cards.find((c) => c.id === "c1").sessionId, "elsewhere-1");
  assert.equal(await store.validateSession(f.project, "elsewhere-1"), false);

  // Only a session whose file is gone is unlinked.
  fs.rmSync(fs.readdirSync(join(f.agentDir, "sessions"))
    .flatMap((dir) => fs.readdirSync(join(f.agentDir, "sessions", dir)).map((file) => join(f.agentDir, "sessions", dir, file)))
    .find((file) => file.endsWith("_elsewhere-1.jsonl")));
  const pruned = await store.readBoard(f.project);
  assert.equal(pruned.board.cards.find((c) => c.id === "c1").sessionId, null);
});

test("every mutation prunes dead links from its result", async (t) => {
  const f = fixture(t);
  const sessionFile = fabricateSession(f.agentDir, f.project, "sess-1");
  await add(f.project, "Card", "lane-todo", { cardId: "c1" });
  await store.applyMutation(f.project, { action: "link-session", cardId: "c1", sessionId: "sess-1", sessionTitle: "S" });
  fs.rmSync(sessionFile);
  const result = await add(f.project, "Other", "lane-todo", { cardId: "c2" });
  assert.equal(result.ok, true);
  assert.equal(result.board.cards.find((c) => c.id === "c1").sessionId, null);
  assert.equal(result.board.cards.find((c) => c.id === "c1").sessionTitle, "S");
});

test("create-card-for-session makes a card for an existing session", async (t) => {
  const f = fixture(t);
  fabricateSession(f.agentDir, f.project, "sess-1");
  const result = await store.applyMutation(f.project, { action: "create-card-for-session", sessionId: "sess-1", sessionTitle: "Tracked", laneId: "lane-deploy" });
  assert.equal(result.ok, true);
  const card = result.board.cards.find((c) => c.sessionId === "sess-1");
  assert.equal(card.laneId, "lane-deploy");
  assert.equal(card.title, "Tracked");
  const unknown = await store.applyMutation(f.project, { action: "create-card-for-session", sessionId: "nope", sessionTitle: "x", laneId: null });
  assert.equal(unknown.code, "session-missing");
});

test("validateSession: exists for this cwd only", async (t) => {
  const f = fixture(t);
  fabricateSession(f.agentDir, f.project, "sess-1");
  const other = join(f.root, "other");
  fs.mkdirSync(other);
  fabricateSession(f.agentDir, other, "sess-other");
  assert.equal(await store.validateSession(f.project, "sess-1"), true);
  assert.equal(await store.validateSession(f.project, "sess-other"), false);
  assert.equal(await store.validateSession(f.project, "missing"), false);
  assert.equal(await store.validateSession(f.project, ""), false);
});

test("a fresh board is written 0644; an owner-changed mode is kept across rewrites", async (t) => {
  const f = fixture(t);
  const created = await store.readBoard(f.project);
  assert.equal(created.ok, true);
  assert.equal(fs.statSync(f.path).mode & 0o777, 0o644, "a new board is committable (0644)");

  fs.chmodSync(f.path, 0o600);
  const r = await add(f.project, "Mode");
  assert.equal(r.ok, true);
  assert.equal(fs.statSync(f.path).mode & 0o777, 0o600, "an existing file keeps its mode");
});

test("a session that runs in one of the project's worktrees belongs to the project: validate, link and prune all accept it", { timeout: 60_000 }, async (t) => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-web-kanban-wt-")));
  const agentDir = join(root, "agent");
  const repo = join(root, "repo");
  const linked = join(root, "wt");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  resetGlobalState();
  t.after(() => {
    resetGlobalState();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(join(repo, "README.md"), "repo\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/wt", linked]);
  allowFileRoot(repo);

  // The session's header cwd is the worktree, not the board's folder — the
  // project-root rule is what accepts it.
  fabricateSession(agentDir, linked, "wt-1");
  assert.equal(await store.validateSession(repo, "wt-1"), true);
  assert.equal(await store.validateSession(repo, "missing"), false);

  const added = await store.applyMutation(repo, { action: "add-card", laneId: "lane-todo", title: "W", cardId: "c1" });
  assert.equal(added.ok, true);
  const linkedResult = await store.applyMutation(repo, { action: "link-session", cardId: "c1", sessionId: "wt-1", sessionTitle: "Wt" });
  assert.equal(linkedResult.ok, true, JSON.stringify(linkedResult));
  assert.equal(linkedResult.board.cards.find((c) => c.id === "c1").sessionId, "wt-1");
  const reread = await store.readBoard(repo);
  assert.equal(reread.ok, true);
  assert.equal(reread.board.cards.find((c) => c.id === "c1").sessionId, "wt-1", "a worktree session is alive, not pruned");

  // M4: the board lives under the agent dir keyed by the main repo, and a request
  // named for the worktree resolves to the very same file (no forked copy).
  const shared = join(agentDir, "kanban", `--${repo.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`, "kanban.sqlite");
  assert.ok(fs.existsSync(shared), "the shared file is under the agent dir");
  assert.equal(fs.existsSync(join(linked, ".pi")), false, "the worktree never gets its own copy");
  allowFileRoot(linked);
  const fromWorktree = await store.readBoard(linked);
  assert.equal(fromWorktree.ok, true);
  assert.equal(fromWorktree.board.projectDir, repo, "a worktree request serves the main repo's board");
  assert.equal(fromWorktree.board.cards.find((c) => c.id === "c1").sessionId, "wt-1");
  assert.deepEqual(fs.readdirSync(dirname(shared)), ["kanban.sqlite"], "one shared file for both cwds");
});

test("TC-06: link-session with an unknown session is a 404-style refusal; board and revision unchanged", async (t) => {
  const f = fixture(t);
  await add(f.project, "Card", "lane-todo", { cardId: "c1" });
  const before = await store.readBoard(f.project);
  const rows = f.rows();
  const mtime = fs.statSync(f.path).mtimeMs;
  const result = await store.applyMutation(f.project, { action: "link-session", cardId: "c1", sessionId: "does-not-exist", sessionTitle: "Ghost" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "session-missing");
  const added = await add(f.project, "With ghost session", "lane-todo", { cardId: "c2", sessionId: "does-not-exist" });
  assert.equal(added.code, "session-missing");
  assert.equal(f.rows(), rows);
  assert.equal(fs.statSync(f.path).mtimeMs, mtime);
  const after = await store.readBoard(f.project);
  assert.deepEqual(after.board, before.board);
  assert.equal(after.revision, before.revision);
});

test("a create:false read writes nothing: a missing board reads empty (revision 0), a corrupt one is left alone", async (t) => {
  const f = fixture(t);
  const read = await store.readBoard(f.project, { create: false });
  assert.equal(read.ok, true);
  assert.equal(read.revision, 0);
  assert.equal(read.board.cards.length, 0);
  assert.equal(read.board.lanes.length, 6);
  assert.equal(fs.existsSync(f.path), false);
  fs.mkdirSync(f.kanbanDir(), { recursive: true });
  fs.writeFileSync(f.path, "not json at all");
  const corrupt = await store.readBoard(f.project, { create: false });
  assert.equal(corrupt.ok, true);
  assert.equal(corrupt.revision, 0);
  assert.equal(fs.readFileSync(f.path, "utf8"), "not json at all");
  assert.ok(!fs.readdirSync(f.kanbanDir()).some((name) => name.startsWith("kanban.json.corrupt-")));
});

test("TC-08: a bad cwd is a typed refusal and nothing is created", async (t) => {
  const f = fixture(t);
  const missing = join(f.root, "definitely-not-a-project");
  allowFileRoot(missing);
  const file = join(f.root, "a-file");
  fs.writeFileSync(file, "x");
  allowFileRoot(file);
  const outside = join(f.root, "outside");
  fs.mkdirSync(outside); // exists, but is not an allowed root

  for (const [cwd, code] of [
    [missing, "cwd-denied"], // outside the roots as given: the same answer whether or not it exists, as /api/mcp
    [file, "cwd-not-directory"],
    [outside, "cwd-denied"],
    ["relative/dir", "cwd-invalid"],
    ["", "cwd-invalid"],
    [undefined, "cwd-invalid"],
  ]) {
    const read = await store.readBoard(cwd);
    assert.equal(read.ok, false, String(cwd));
    assert.equal(read.code, code, String(cwd));
    assert.equal(typeof read.error, "string");
    const write = await store.applyMutation(cwd, { action: "add-lane", name: "x" });
    assert.equal(write.code, code, String(cwd));
    const revision = await store.getBoardRevision(cwd);
    assert.equal(revision.code, code, String(cwd));
  }
  assert.equal(fs.existsSync(missing), false);
  assert.equal(fs.existsSync(join(f.agentDir, "kanban")), false, "a refused cwd creates no shared file for any project");
  assert.equal(fs.readFileSync(file, "utf8"), "x");
});

test("concurrent mutations in one process are serialized: none is lost", async (t) => {
  const f = fixture(t);
  await store.readBoard(f.project);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => add(f.project, `Card ${i}`, "lane-todo", { cardId: `c${i}` })));
  assert.ok(results.every((r) => r.ok));
  assert.equal(f.cards().length, 12);
  const revisions = results.map((r) => r.revision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b));
  assert.equal(new Set(revisions).size, 12);
});

test("another process holding the lock gives a typed `locked` refusal, never a throw", { timeout: 30_000 }, async (t) => {
  quietWarnings(t);
  const f = fixture(t);
  await store.readBoard(f.project);
  const release = await lockfile.lock(f.path, { realpath: false, stale: 60_000 });
  const rows = f.rows();
  try {
    const result = await add(f.project, "Blocked");
    assert.equal(result.ok, false);
    assert.equal(result.code, "locked");
    assert.equal(f.rows(), rows, "a locked board is not written");
  } finally {
    await release();
  }
  const after = await add(f.project, "Unblocked");
  assert.equal(after.ok, true);
});

// ---------------------------------------------------------------------------
// Migration from the old <project>/.pi/kanban.json (the M4 move)
// ---------------------------------------------------------------------------

function legacyBoardPath(project) {
  return join(project, ".pi", "kanban.json");
}

function writeLegacyBoard(project, board) {
  fs.mkdirSync(join(project, ".pi"), { recursive: true });
  fs.writeFileSync(legacyBoardPath(project), JSON.stringify(board) + "\n");
}

function twoLaneBoard(projectDir) {
  return {
    schemaVersion: 1,
    board: {
      projectDir,
      lanes: [
        { id: "lane-backlog", name: "Backlog", description: "", fixed: true },
        { id: "lane-todo", name: "Todo", description: "" },
      ],
      cards: [{ id: "c1", title: "Migrated", description: "", laneId: "lane-todo", sessionId: null, sessionTitle: null, createdAt: 1, updatedAt: 1 }],
    },
  };
}

test("a legacy .pi/kanban.json board is imported into the shared location on first read, and the legacy file deleted", async (t) => {
  quietWarnings(t);
  const f = fixture(t);
  writeLegacyBoard(f.project, twoLaneBoard(f.project));

  const result = await store.readBoard(f.project);
  assert.equal(result.ok, true);
  assert.equal(result.board.projectDir, f.project);
  assert.deepEqual(result.board.lanes.map((l) => l.id), ["lane-backlog", "lane-todo"]);
  assert.deepEqual(result.board.cards.map((c) => [c.id, c.title, c.laneId]), [["c1", "Migrated", "lane-todo"]]);
  assert.ok(f.exists(), "the shared file now holds the board");
  assert.equal(fs.existsSync(legacyBoardPath(f.project)), false, "the imported legacy file is deleted");
  assert.ok(fs.existsSync(join(f.project, ".pi")), "the .pi dir itself stays: it may hold other files");

  // A later read is an ordinary read of the shared file: same board, same revision.
  const again = await store.readBoard(f.project);
  assert.equal(again.ok, true);
  assert.equal(again.revision, result.revision);
  assert.deepEqual(again.board.cards, result.board.cards);
});

test("a corrupt legacy board is set aside beside the shared file and the board starts fresh", async (t) => {
  quietWarnings(t);
  const f = fixture(t);
  fs.mkdirSync(join(f.project, ".pi"), { recursive: true });
  fs.writeFileSync(legacyBoardPath(f.project), "{ not json ");

  const result = await store.readBoard(f.project);
  assert.equal(result.ok, true);
  assert.equal(result.board.lanes.length, 6, "a fresh default board");
  assert.equal(result.board.cards.length, 0);
  assert.ok(f.exists());
  assert.equal(fs.existsSync(legacyBoardPath(f.project)), false, "the corrupt legacy is moved, not left behind");
  const backups = fs.readdirSync(join(f.project, ".pi")).filter((name) => name.includes(".corrupt-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(join(f.project, ".pi", backups[0]), "utf8"), "{ not json ");
});

test("a legacy board from a newer schema stays in place and the board starts fresh", async (t) => {
  quietWarnings(t);
  const f = fixture(t);
  const newer = { schemaVersion: 2, board: { projectDir: f.project, lanes: [], cards: [] } };
  writeLegacyBoard(f.project, newer);

  const result = await store.readBoard(f.project);
  assert.equal(result.ok, true, "a schema refusal of the legacy is not a refusal of the read");
  assert.equal(result.board.cards.length, 0);
  assert.equal(result.board.lanes.length, 6, "a fresh default board");
  assert.equal(fs.readFileSync(legacyBoardPath(f.project), "utf8"), JSON.stringify(newer) + "\n", "the newer file is untouched");
  assert.ok(f.exists());
});

test("a worktree's legacy board is imported when the main checkout has none; the newest copy wins and only it is deleted", { timeout: 60_000 }, async (t) => {
  quietWarnings(t);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-web-kanban-wt-migrate-")));
  const agentDir = join(root, "agent");
  const repo = join(root, "repo");
  const wt1 = join(root, "wt1");
  const wt2 = join(root, "wt2");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  resetGlobalState();
  t.after(() => {
    resetGlobalState();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(join(repo, "README.md"), "repo\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/a", wt1]);
  await git(repo, ["worktree", "add", "-b", "feature/b", wt2]);
  allowFileRoot(repo);

  const boardWith = (title) => {
    const b = twoLaneBoard(repo);
    b.board.cards[0].title = title;
    return b;
  };
  writeLegacyBoard(wt1, boardWith("Older copy"));
  writeLegacyBoard(wt2, boardWith("Newer copy"));
  const older = legacyBoardPath(wt1);
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(older, past, past); // wt2's copy is the newest

  const result = await store.readBoard(repo);
  assert.equal(result.ok, true);
  assert.deepEqual(result.board.cards.map((c) => c.title), ["Newer copy"], "the newest worktree copy wins");
  const shared = join(agentDir, "kanban", `--${repo.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`, "kanban.sqlite");
  assert.ok(fs.existsSync(shared), "the imported board lands in the shared file");
  assert.equal(fs.existsSync(legacyBoardPath(wt2)), false, "the imported worktree copy is deleted");
  assert.ok(fs.existsSync(older), "the older copy is left alone: only the imported file is deleted");
  assert.equal(fs.existsSync(join(repo, ".pi", "kanban.json")), false, "no copy is created for the main checkout");
});

test("the JSON board beside the database is imported into it on first read, and the JSON kept aside", async (t) => {
  quietWarnings(t);
  const f = fixture(t);
  const jsonPath = store.previousJsonBoardPath(f.project);
  assert.equal(dirname(jsonPath), f.kanbanDir(), "the JSON storage this schema replaced sits beside the database");
  fs.mkdirSync(f.kanbanDir(), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(twoLaneBoard(f.project)));

  const result = await store.readBoard(f.project);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.board.lanes.map((l) => l.id), ["lane-backlog", "lane-todo"]);
  assert.deepEqual(result.board.cards.map((c) => [c.id, c.title]), [["c1", "Migrated"]]);
  assert.ok(f.exists(), "the board now lives in the database");
  assert.equal(fs.existsSync(jsonPath), false, "the JSON is moved aside, not left to be imported again");
  const kept = f.files().filter((name) => name.startsWith("kanban.json.imported-"));
  assert.equal(kept.length, 1, "the imported JSON is kept: a bad import must stay recoverable");
  assert.deepEqual(JSON.parse(fs.readFileSync(join(f.kanbanDir(), kept[0]), "utf8")).board.cards[0].title, "Migrated");

  const again = await store.readBoard(f.project);
  assert.deepEqual(again.board, result.board);
  assert.equal(again.revision, result.revision, "a later read is an ordinary read of the database");
});

test("a 0-byte database left by an interrupted first open still imports the JSON board", async (t) => {
  quietWarnings(t);
  const f = fixture(t);
  fs.mkdirSync(f.kanbanDir(), { recursive: true });
  fs.writeFileSync(f.path, ""); // a valid, empty SQLite file: no board schema yet
  const jsonPath = store.previousJsonBoardPath(f.project);
  fs.writeFileSync(jsonPath, JSON.stringify(twoLaneBoard(f.project)));

  const result = await store.readBoard(f.project);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.board.cards.map((c) => c.title), ["Migrated"], "the JSON board is not thrown away");
  assert.equal(f.schema(), KANBAN_SCHEMA_VERSION);
});

test("the JSON board wins over the older .pi/kanban.json, and both are moved aside", async (t) => {
  quietWarnings(t);
  const f = fixture(t);
  fs.mkdirSync(f.kanbanDir(), { recursive: true });
  const newerStorage = twoLaneBoard(f.project);
  newerStorage.board.cards[0].title = "From the JSON storage";
  fs.writeFileSync(store.previousJsonBoardPath(f.project), JSON.stringify(newerStorage));
  const older = twoLaneBoard(f.project);
  older.board.cards[0].title = "From .pi";
  writeLegacyBoard(f.project, older);

  const result = await store.readBoard(f.project);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.board.cards.map((c) => c.title), ["From the JSON storage"], "the newest storage wins");
  assert.equal(fs.existsSync(store.previousJsonBoardPath(f.project)), false, "the imported JSON is moved aside");
  assert.equal(fs.existsSync(legacyBoardPath(f.project)), false, "the older file is moved aside too, so it cannot be imported later");
});

test("a create:false read never imports a legacy board: the legacy stays until a creating read", async (t) => {
  quietWarnings(t);
  const f = fixture(t);
  writeLegacyBoard(f.project, twoLaneBoard(f.project));

  const read = await store.readBoard(f.project, { create: false });
  assert.equal(read.ok, true);
  assert.equal(read.revision, 0);
  assert.equal(read.board.cards.length, 0, "an empty board, not the legacy one");
  assert.ok(fs.existsSync(legacyBoardPath(f.project)), "the legacy is untouched");
  assert.equal(f.exists(), false, "nothing is written under the agent dir either");
});

// ---------------------------------------------------------------------------
// Card keys (`PIW-42`): the prefix, the counter, and references by key
// ---------------------------------------------------------------------------

test("a fresh board derives its prefix from the project folder and numbers its cards from one", async (t) => {
  const f = fixture(t);
  const first = await store.readBoard(f.project);
  assert.equal(first.board.cardPrefix, "PROJE", "the folder's own name, shortened and uppercased");
  assert.equal(first.board.nextCardNumber, 1);

  const a = await add(f.project, "One", "lane-todo", { cardId: "c1" });
  const b = await add(f.project, "Two", "lane-todo", { cardId: "c2" });
  assert.deepEqual(b.board.cards.map((card) => card.number), [1, 2]);
  assert.equal(b.board.nextCardNumber, 3);

  // A deleted card's number is never handed out again.
  assert.equal((await store.applyMutation(f.project, { action: "delete-card", cardId: "c2" })).ok, true);
  const c = await add(f.project, "Three", "lane-todo", { cardId: "c3" });
  assert.equal(c.board.cards.find((card) => card.id === "c3").number, 3);
  assert.equal(a.board.cardPrefix, "PROJE");
});

test("two projects whose folders derive the same prefix get distinct ones", async (t) => {
  const f = fixture(t);
  // A folder whose own name derives the same five characters as `project`.
  const other = nearbyProject(t, f, "project-two");

  const first = await store.readBoard(f.project);
  const theirs = await store.readBoard(other);
  assert.equal(first.board.cardPrefix, "PROJE");
  assert.equal(theirs.board.cardPrefix, "PROJE2", "the second board moves aside, never silently sharing a prefix");
  assert.notEqual(f.board().cardPrefix, theirs.board.cardPrefix, "and both stored prefixes survive a re-read");
});

test("set-card-prefix renames every key at once, refuses a prefix another board owns, and keeps the old one resolving", async (t) => {
  const f = fixture(t);
  await add(f.project, "One", "lane-todo", { cardId: "c1" });
  const other = nearbyProject(t, f, "neighbour");
  const neighbour = await store.readBoard(other);
  assert.equal((await store.applyMutation(other, { action: "set-card-prefix", prefix: "NEIGH" })).ok, true);

  const taken = await store.applyMutation(f.project, { action: "set-card-prefix", prefix: "neigh" });
  assert.equal(taken.ok, false);
  assert.match(taken.error, /another project's board/);
  assert.equal(f.board().cardPrefix, "PROJE", "a refused save writes nothing");

  const renamed = await store.applyMutation(f.project, { action: "set-card-prefix", prefix: "web" });
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.equal(renamed.board.cardPrefix, "WEB");
  assert.deepEqual(renamed.board.cardPrefixAliases, ["PROJE"]);
  assert.equal(renamed.board.cards[0].number, 1, "the numbers do not change: only the prefix did");

  // A reference written before the rename still reaches the card.
  const renamedTitle = await store.applyMutation(f.project, { action: "edit-card", cardId: "PROJE-1", title: "Renamed by its old key" });
  assert.equal(renamedTitle.ok, true, JSON.stringify(renamedTitle));
  assert.equal(renamedTitle.board.cards[0].id, "c1");
  assert.equal(renamedTitle.board.cards[0].title, "Renamed by its old key");
  // And so does the new one, case-insensitively.
  const advanced = await store.applyMutation(f.project, { action: "advance-card", cardId: "web-1" });
  assert.equal(advanced.ok, true, JSON.stringify(advanced));
  assert.equal(advanced.board.cards[0].laneId, "lane-plan");

  // An invalid prefix is refused without a write.
  const before = f.rows();
  const invalid = await store.applyMutation(f.project, { action: "set-card-prefix", prefix: "1bad" });
  assert.equal(invalid.ok, false);
  assert.equal(f.rows(), before);
  assert.ok(neighbour.ok);
});

test("a card key of another project's prefix never resolves here", async (t) => {
  const f = fixture(t);
  await add(f.project, "One", "lane-todo", { cardId: "c1" });
  const other = nearbyProject(t, f, "neighbour");
  await store.readBoard(other);
  assert.equal((await store.applyMutation(other, { action: "set-card-prefix", prefix: "OTHER" })).ok, true);
  const miss = await store.applyMutation(f.project, { action: "edit-card", cardId: "OTHER-1", title: "hijacked" });
  assert.equal(miss.ok, false, "a foreign key is not this board's card 1");
  assert.equal(miss.code, "refused");
});
