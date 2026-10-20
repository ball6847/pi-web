import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { KANBAN_SCHEMA_VERSION, defaultLanes, type KanbanBoard, type KanbanCard, type KanbanLane } from "./kanban-types";

// SERVER-ONLY. The one place a kanban board touches disk: the SQLite board
// file of a project root, its schema, and the row <-> `KanbanBoard` mapping.
// `lib/kanban-store.ts` adds the policy on top (locks, revision, seeding,
// pruning, typed refusals); nothing above this file knows SQL or where the
// board lives.
//
// One file per project under pi's shared agent storage:
// `<agentDir>/kanban/<encoded-project-root>/kanban.sqlite` (`getAgentDir()` is
// `$PI_CODING_AGENT_DIR` or `~/.pi/agent`), keyed by the *resolved* project
// root, so every worktree of a repository shares the one file.
//
// Why SQLite: the board is moving from "one piece of JSON re-serialized on
// every edit" to a real dataset (card history, per-card agent state), and
// SQLite gives targeted updates, transactional multi-row edits and enforced
// invariants without inventing our own journal. Node's built-in `node:sqlite`
// means no new dependency. The default rollback journal keeps a board one
// self-contained file (no `-wal`/`-shm` sidecars); the store's lock serializes
// writers and every transaction is a handful of statements.
//
// The board's ORDER is still the ordered rows: `lanes.position` and
// `cards.position` ascending. Lanes and cards are independent tables with no
// dependencies (a card moves between lanes), so position is 0-based, dense and
// unconstrained per table.

/** A board's row count is small (dozens), so a write replaces the rows wholesale inside one transaction. */
const SCHEMA = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE lanes (
  id          TEXT PRIMARY KEY,
  position    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  fixed       INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE cards (
  id            TEXT PRIMARY KEY,
  position      INTEGER NOT NULL,
  lane_id       TEXT NOT NULL REFERENCES lanes(id),
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  session_id    TEXT,
  session_title TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;

-- One card per session, the board's own rule, now enforced by the file too.
CREATE UNIQUE INDEX cards_session ON cards(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX cards_lane ON cards(lane_id, position);
CREATE INDEX cards_updated ON cards(updated_at);
`;

/** The agent directory's file name of a board. */
const KANBAN_DB_FILE = "kanban.sqlite";

/**
 * A project root encoded as its board's directory name — the same scheme pi's
 * session directories use for `~/.pi/agent/sessions/<encoded-cwd>/` (the SDK
 * SessionManager's `--<path with / \ : -> -->--` encoding), so a board sits
 * beside its project's sessions and stays human-readable.
 */
export function encodeKanbanProjectKey(projectRoot: string): string {
  return `--${projectRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** The board's directory: `<agentDir>/kanban/<key>`. */
export function kanbanBoardDir(projectRoot: string): string {
  return join(getAgentDir(), "kanban", encodeKanbanProjectKey(projectRoot));
}

/** The board file of a project root: `<agentDir>/kanban/<key>/kanban.sqlite`. */
export function kanbanBoardPath(projectRoot: string): string {
  return join(kanbanBoardDir(projectRoot), KANBAN_DB_FILE);
}

export interface KanbanDbOptions {
  /** How long a busy database is waited on (ms). The store's file lock normally keeps waits short. */
  timeout?: number;
}

/** Opens the board file. The caller closes it (`closeBoardFile`). */
export function openKanbanDatabase(path: string, options: KanbanDbOptions = {}): DatabaseSync {
  return new DatabaseSync(path, { timeout: options.timeout ?? 5_000 });
}

/** Closes the file, releasing its lock and removing the transient journal, so a closed board is one file again. */
export function closeKanbanDatabase(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    // Already closed, or closed after a failed open: nothing left to release.
  }
}

// ---------------------------------------------------------------------------
// Shape of the file on disk
// ---------------------------------------------------------------------------

/**
 * What is at the board path:
 * - `ready`: a board file of this schema version (`user_version` is the schema stamp);
 * - `missing`: no file at all — nothing is created by looking;
 * - `empty`: a file that is a valid SQLite database but carries no board schema
 *   (a 0-byte file left by an interrupted first open, or a stray database);
 * - `newer`: a board written by a newer pi-web, left alone;
 * - `corrupt`: not a SQLite database (garbage, a truncated file, …).
 */
export type KanbanFileState =
  | { kind: "ready" }
  | { kind: "missing" }
  | { kind: "empty" }
  | { kind: "newer"; version: number }
  | { kind: "corrupt"; error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Opens the file only when it exists: looking at a board never creates one. */
function openExisting(path: string, options: KanbanDbOptions): DatabaseSync | null {
  return existsSync(path) ? openKanbanDatabase(path, options) : null;
}

/**
 * The state of the file, and the open connection when there is one to use.
 * Opening does not write; only `initializeBoard` and `writeBoardRows` do.
 */
export function inspectKanbanFile(path: string, options: KanbanDbOptions = {}): { state: KanbanFileState; db: DatabaseSync | null } {
  const db = openExisting(path, options);
  if (!db) return { state: { kind: "missing" }, db: null };
  let version: number;
  try {
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    version = Number(row?.user_version ?? 0);
  } catch (error) {
    // `PRAGMA user_version` on garbage answers SQLITE_NOTADB: it is not ours.
    closeKanbanDatabase(db);
    return { state: { kind: "corrupt", error: errorMessage(error) }, db: null };
  }
  if (version > KANBAN_SCHEMA_VERSION) return { state: { kind: "newer", version }, db };
  if (version !== KANBAN_SCHEMA_VERSION) {
    // A version stamp this build does not know, and any tables that are not
    // ours, mean the file is not a board of this schema: only a file with
    // neither (a 0-byte file left by an interrupted first open) is adopted.
    const tables = tableCount(db);
    if (version === 0 && tables === 0) return { state: { kind: "empty" }, db };
    closeKanbanDatabase(db);
    return { state: { kind: "corrupt", error: `the database holds no kanban board of schema ${KANBAN_SCHEMA_VERSION}` }, db: null };
  }
  return { state: { kind: "ready" }, db };
}

function tableCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as
    | { n?: number }
    | undefined;
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Revision
// ---------------------------------------------------------------------------

/**
 * The board's revision: a counter in the file's `meta` table that every
 * committed write advances. The file is the only source (no in-process state),
 * so any reader — this process, another one, another pi-web — sees the same
 * number, and a client's poll only refetches when a write actually landed.
 */
export function readBoardRevision(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'revision'").get() as { value?: string } | undefined;
  const revision = Number(row?.value ?? 0);
  return Number.isFinite(revision) ? revision : 0;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Runs `body` in one `BEGIN IMMEDIATE` transaction: the write lock is taken up
 * front, so two web processes writing the same board never interleave a
 * read-modify-write (the caller's file lock keeps the wait short). Anything
 * thrown rolls back and is rethrown.
 */
export function inTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction was already rolled back by SQLite.
    }
    throw error;
  }
}

/** A read of the whole board in one transaction, so the rows and the revision agree. */
export function inReadTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite already ended the read transaction.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Rows <-> board
// ---------------------------------------------------------------------------

interface LaneRow {
  id: string;
  position: number;
  name: string;
  description: string;
  fixed: number;
}

interface CardRow {
  id: string;
  position: number;
  lane_id: string;
  title: string;
  description: string;
  session_id: string | null;
  session_title: string | null;
  created_at: number;
  updated_at: number;
}

function toLane(row: LaneRow): KanbanLane {
  const lane: KanbanLane = { id: row.id, name: row.name, description: row.description };
  if (row.position === 0 || row.fixed === 1) lane.fixed = true;
  return lane;
}

function toCard(row: CardRow): KanbanCard {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    laneId: row.lane_id,
    sessionId: row.session_id || null,
    sessionTitle: row.session_title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export interface KanbanSnapshot {
  board: KanbanBoard;
  revision: number;
}

/**
 * The board of a `ready` file, in row order. Read as one transaction: the board
 * and the revision belong together (a write that lands mid-read is not mixed
 * in). `projectDir` is the folder the caller resolved the board for — a label
 * only, never part of the stored rows.
 *
 * A hand-edited file is read as it is; the only repair is structural: a card
 * whose lane is gone (or that lost the backlog) goes to the backlog, and a
 * duplicate session id beyond the first card is dropped, as the JSON reader
 * used to do (the up-front unique index means this only ever sees the file
 * written by hands, not by this code).
 */
export function readBoardRows(db: DatabaseSync, projectDir: string): KanbanSnapshot {
  return inReadTransaction(db, () => {
    const laneRows = db.prepare("SELECT id, position, name, description, fixed FROM lanes ORDER BY position").all() as unknown as LaneRow[];
    const lanes = laneRows.map(toLane);
    const backlog = lanes.find((lane) => lane.fixed) ?? lanes[0];
    const cardRows = db
      .prepare("SELECT id, position, lane_id, title, description, session_id, session_title, created_at, updated_at FROM cards ORDER BY position")
      .all() as unknown as CardRow[];
    const laneIds = new Set(lanes.map((lane) => lane.id));
    const sessions = new Set<string>();
    const cards: KanbanCard[] = [];
    for (const row of cardRows) {
      const card = toCard(row);
      if (!laneIds.has(card.laneId)) {
        if (!backlog) continue;
        card.laneId = backlog.id;
        card.sessionId = null;
      }
      if (card.sessionId !== null) {
        if (sessions.has(card.sessionId)) card.sessionId = null;
        else sessions.add(card.sessionId);
      }
      cards.push(card);
    }
    return { board: { projectDir, lanes, cards }, revision: readBoardRevision(db) };
  });
}

/**
 * Writes the board's rows, replacing lanes and cards wholesale (a board is
 * dozens of rows, and one statement per table is cheaper than a diff), and
 * advances the revision by one. Call inside `inTransaction`, on a board file
 * that exists (`initializeBoard` or a previous write).
 *
 * The rows are exactly the board given: `updatedAt` belongs to the reducers in
 * `lib/kanban-shared.ts`, so the answered board and a later read agree.
 */
export function writeBoardRows(db: DatabaseSync, board: KanbanBoard): number {
  db.exec("DELETE FROM cards");
  db.exec("DELETE FROM lanes");
  const lane = db.prepare("INSERT INTO lanes (id, position, name, description, fixed) VALUES (?, ?, ?, ?, ?)");
  for (const [position, entry] of board.lanes.entries()) {
    lane.run(entry.id, position, entry.name, entry.description, entry.fixed ? 1 : 0);
  }
  const card = db.prepare(
    "INSERT INTO cards (id, position, lane_id, title, description, session_id, session_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [position, entry] of board.cards.entries()) {
    card.run(entry.id, position, entry.laneId, entry.title, entry.description, entry.sessionId, entry.sessionTitle, entry.createdAt, entry.updatedAt);
  }
  const revision = readBoardRevision(db) + 1;
  db.prepare("INSERT INTO meta (key, value) VALUES ('revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(revision));
  return revision;
}

/**
 * Creates the board schema and its opening revision (`1`), in one transaction:
 * the default lanes for a board that has never been written, or the rows of a
 * board being put in place (the JSON import).
 */
export function initializeBoard(db: DatabaseSync, board: KanbanBoard): number {
  return inTransaction(db, () => {
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${KANBAN_SCHEMA_VERSION}`);
    db.prepare("INSERT INTO meta (key, value) VALUES ('revision', '0')").run();
    return writeBoardRows(db, board);
  });
}

/** A board that has never been written: the six default lanes, no cards. */
export function freshBoard(projectDir: string): KanbanBoard {
  return { projectDir, lanes: defaultLanes(), cards: [] };
}
