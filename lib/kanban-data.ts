import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  KANBAN_ACTIVITY_KEEP,
  KANBAN_SCHEMA_VERSION,
  defaultCardPrefix,
  defaultLanes,
  type KanbanActivity,
  type KanbanBoard,
  type KanbanCard,
  type KanbanComment,
  type KanbanLane,
} from "./kanban-types";

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
  id           TEXT PRIMARY KEY,
  position     INTEGER NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  fixed        INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE cards (
  id            TEXT PRIMARY KEY,
  position      INTEGER NOT NULL,
  lane_id       TEXT NOT NULL REFERENCES lanes(id),
  number        INTEGER NOT NULL DEFAULT 0,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  session_id    TEXT,
  session_title TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;

-- A card's comments: the handoff trail between people and sessions. No foreign
-- key on purpose: the board's writes replace the cards wholesale, and an
-- ON DELETE CASCADE would take the thread with it on every unrelated edit. The
-- writer prunes rows whose card is gone, in the same transaction.
CREATE TABLE card_comments (
  id            TEXT PRIMARY KEY,
  card_id       TEXT NOT NULL,
  author        TEXT NOT NULL,
  session_id    TEXT,
  session_title TEXT,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
) STRICT;

-- One card per session, the board's own rule, now enforced by the file too.
CREATE UNIQUE INDEX cards_session ON cards(session_id) WHERE session_id IS NOT NULL;
-- A card number is unique per board and monotonic; 0 is the repair bucket a
-- hand-edited row carries until the reader numbers it.
CREATE UNIQUE INDEX cards_number ON cards(number) WHERE number > 0;
CREATE INDEX cards_lane ON cards(lane_id, position);
CREATE INDEX cards_updated ON cards(updated_at);
CREATE INDEX card_comments_card ON card_comments(card_id, created_at);

-- A card's activity: derived by the store from each board write and append-only.
-- No foreign key for the same reason card_comments has none: the board's writes
-- replace the card rows wholesale, so a cascade would take the history with it
-- on an unrelated edit. writeBoardRows prunes rows whose card is gone.
CREATE TABLE card_activity (
  id                  TEXT PRIMARY KEY,
  card_id             TEXT NOT NULL,
  kind                TEXT NOT NULL,
  from_value          TEXT,
  to_value            TEXT,
  actor_session_id    TEXT,
  actor_session_title TEXT,
  created_at          INTEGER NOT NULL
) STRICT;

CREATE INDEX card_activity_card ON card_activity(card_id);
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
 * The file's state is `ready` (this schema), `migrate` (an older schema this
 * build upgrades in place), `missing` (nothing is created by looking), `empty`
 * (a valid SQLite file with no board schema — what an interrupted first open
 * leaves), `newer` (a `user_version` above this build's) or `corrupt` (not a
 * database: garbage, truncation).
 */
export type KanbanFileState =
  | { kind: "ready" }
  | { kind: "migrate"; from: number }
  | { kind: "missing" }
  | { kind: "empty" }
  | { kind: "newer"; version: number }
  | { kind: "corrupt"; error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The schema stamp in the file (`PRAGMA user_version`; 0 = no stamp). */
function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/** Opens the file only when it exists: looking at a board never creates one. */
function openExisting(path: string, options: KanbanDbOptions): DatabaseSync | null {
  return existsSync(path) ? openKanbanDatabase(path, options) : null;
}

/**
 * The state of the file, and the open connection when there is one to use.
 * Opening does not write; only `migrateKanbanDatabase`, `initializeBoard` and
 * `writeBoardRows` do.
 */
export function inspectKanbanFile(path: string, options: KanbanDbOptions = {}): { state: KanbanFileState; db: DatabaseSync | null } {
  const db = openExisting(path, options);
  if (!db) return { state: { kind: "missing" }, db: null };
  let version: number;
  try {
    version = readSchemaVersion(db);
  } catch (error) {
    // `PRAGMA user_version` on garbage answers SQLITE_NOTADB: it is not ours.
    closeKanbanDatabase(db);
    return { state: { kind: "corrupt", error: errorMessage(error) }, db: null };
  }
  if (version > KANBAN_SCHEMA_VERSION) return { state: { kind: "newer", version }, db };
  if (version === KANBAN_SCHEMA_VERSION) return { state: { kind: "ready" }, db };
  // A version stamp this build does not know, and any tables that are not
  // ours, mean the file is not a board of this schema: only a file with
  // neither (a 0-byte file left by an interrupted first open) is adopted.
  const tables = tableCount(db);
  if (version === 0 && tables === 0) return { state: { kind: "empty" }, db };
  if (version >= 1 && tables > 0) return { state: { kind: "migrate", from: version }, db };
  closeKanbanDatabase(db);
  return { state: { kind: "corrupt", error: `the database holds no kanban board of schema ${KANBAN_SCHEMA_VERSION}` }, db: null };
}

function tableCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as
    | { n?: number }
    | undefined;
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * One step per schema version, keyed by the version it migrates FROM. Each
 * step is additive and lossless: an existing board keeps every row and its
 * revision, and the new columns arrive with their defaults.
 */
const MIGRATIONS: Record<number, string[]> = {
  // v1 -> v2: lanes gain the model-facing instructions.
  1: ["ALTER TABLE lanes ADD COLUMN instructions TEXT NOT NULL DEFAULT ''"],
  // v2 -> v3: card comments (a new table, so no existing row changes).
  2: [
    `CREATE TABLE card_comments (
      id            TEXT PRIMARY KEY,
      card_id       TEXT NOT NULL,
      author        TEXT NOT NULL,
      session_id    TEXT,
      session_title TEXT,
      body          TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    ) STRICT`,
    "CREATE INDEX card_comments_card ON card_comments(card_id, created_at)",
  ],
  // v3 -> v4: a card's activity trail (a new table, so no existing row changes).
  3: [
    `CREATE TABLE card_activity (
      id                  TEXT PRIMARY KEY,
      card_id            TEXT NOT NULL,
      kind                TEXT NOT NULL,
      from_value          TEXT,
      to_value            TEXT,
      actor_session_id    TEXT,
      actor_session_title TEXT,
      created_at          INTEGER NOT NULL
    ) STRICT`,
    "CREATE INDEX card_activity_card ON card_activity(card_id)",
  ],
  // v4 -> v5: card keys (`PIWEB-42`). Existing cards are numbered in creation
  // order, and the counter starts after the highest — so the unique index can
  // be built, and a card deleted later never hands its number to a new one.
  // One version belongs to one step: v3 -> v4 is the activity trail's, so the
  // numbers ride on the step after it and a v4 board gains the column here.
  4: [
    "ALTER TABLE cards ADD COLUMN number INTEGER NOT NULL DEFAULT 0",
    `UPDATE cards SET number = (
      SELECT rn FROM (SELECT id AS cid, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM cards)
      WHERE cid = cards.id
    )`,
    "CREATE UNIQUE INDEX cards_number ON cards(number) WHERE number > 0",
    `INSERT INTO meta (key, value)
     VALUES ('next_card_number', (SELECT COALESCE(MAX(number), 0) + 1 FROM cards))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ],
};

/**
 * Upgrades an older board file to `KANBAN_SCHEMA_VERSION` in place: the steps
 * from its stamp up, each inside the caller's transaction (the store calls
 * this under its file lock; `BEGIN IMMEDIATE` re-checked makes two concurrent
 * openers safe — the second one finds the stamp already current and no-ops).
 * A failure rolls back, leaving the file at its old version. No revision bump —
 * the data is unchanged, only its storage — except into v5, which gives every
 * card a number the views now show: a client holding a cached board must
 * refetch for its card keys, and a moved revision is how it is told.
 */
export function migrateKanbanDatabase(db: DatabaseSync): void {
  if (readSchemaVersion(db) === KANBAN_SCHEMA_VERSION) return;
  const startedAt = readSchemaVersion(db);
  inTransaction(db, () => {
    let from = startedAt;
    while (from < KANBAN_SCHEMA_VERSION) {
      for (const statement of MIGRATIONS[from] ?? []) db.exec(statement);
      from += 1;
      db.exec(`PRAGMA user_version = ${from}`);
    }
    // The numbers step is the only one at v4: crossing into 5 ran it.
    if (startedAt < 5 && from >= 5) bumpRevision(db);
  });
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
  instructions: string;
  fixed: number;
}

interface CardRow {
  id: string;
  position: number;
  lane_id: string;
  number: number;
  title: string;
  description: string;
  session_id: string | null;
  session_title: string | null;
  created_at: number;
  updated_at: number;
}

interface CommentRow {
  id: string;
  card_id: string;
  author: string;
  session_id: string | null;
  session_title: string | null;
  body: string;
  created_at: number;
}

interface ActivityRow {
  id: string;
  card_id: string;
  kind: string;
  from_value: string | null;
  to_value: string | null;
  actor_session_id: string | null;
  actor_session_title: string | null;
  created_at: number;
}

const ACTIVITY_KINDS = new Set<KanbanActivity["kind"]>(["created", "moved", "title", "description", "linked", "unlinked", "lane-deleted"]);

/**
 * A hand-edited row with an unknown kind is dropped, not guessed at: the trail
 * is a log, and a reader cannot use an event it does not understand.
 */
function toActivity(row: ActivityRow): KanbanActivity | null {
  const kind = row.kind as KanbanActivity["kind"];
  if (!ACTIVITY_KINDS.has(kind)) return null;
  return {
    id: row.id,
    cardId: row.card_id,
    kind,
    from: row.from_value,
    to: row.to_value,
    actorSessionId: row.actor_session_id || null,
    actorSessionTitle: row.actor_session_title,
    createdAt: Number(row.created_at),
  };
}

function toComment(row: CommentRow): KanbanComment {
  return {
    id: row.id,
    cardId: row.card_id,
    author: row.author === "agent" ? "agent" : "user",
    sessionId: row.session_id || null,
    sessionTitle: row.session_title,
    body: row.body,
    createdAt: Number(row.created_at),
  };
}

function toLane(row: LaneRow): KanbanLane {
  const lane: KanbanLane = { id: row.id, name: row.name, description: row.description };
  // Absent when empty, so an untouched board's lanes keep their old shape.
  if (row.instructions) lane.instructions = row.instructions;
  if (row.position === 0 || row.fixed === 1) lane.fixed = true;
  return lane;
}

function toCard(row: CardRow): KanbanCard {
  return {
    id: row.id,
    number: Number(row.number) || 0,
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
  /**
   * Whether the file holds a `card_prefix` row. A board that never stored one
   * (a v3 file migrated in place, or a hand-rolled file) renders the folder's
   * derived prefix; the store picks a collision-free one before persisting it.
   */
  storedCardPrefix: boolean;
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
    const laneRows = db.prepare("SELECT id, position, name, description, instructions, fixed FROM lanes ORDER BY position").all() as unknown as LaneRow[];
    const lanes = laneRows.map(toLane);
    const backlog = lanes.find((lane) => lane.fixed) ?? lanes[0];
    const cardRows = db
      .prepare("SELECT id, position, lane_id, number, title, description, session_id, session_title, created_at, updated_at FROM cards ORDER BY position")
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
    const meta = readBoardMeta(db);
    // A hand-edited row without a number gets one after the board's highest, in
    // row order: the key a view renders must always be readable, and the repair
    // itself lands with the next write.
    let nextCardNumber = Math.max(meta.nextCardNumber, highestCardNumber(cards) + 1);
    const seen = new Set<number>();
    for (const card of cards) {
      if (card.number > 0 && !seen.has(card.number)) {
        seen.add(card.number);
        continue;
      }
      // Unnumbered (a hand-edited row) or a duplicate: numbered after the rest.
      card.number = nextCardNumber;
      seen.add(card.number);
      nextCardNumber += 1;
    }
    const cardPrefixAliases = meta.prefixAliases.length ? { cardPrefixAliases: meta.prefixAliases } : {};
    return {
      board: {
        projectDir,
        lanes,
        cards,
        cardPrefix: meta.cardPrefix ?? defaultCardPrefix(projectDir),
        nextCardNumber,
        ...cardPrefixAliases,
      },
      revision: readBoardRevision(db),
      storedCardPrefix: meta.cardPrefix !== null,
    };
  });
}

/** The highest number any card carries (0 for a board with no numbered card). */
function highestCardNumber(cards: readonly KanbanCard[]): number {
  let highest = 0;
  for (const card of cards) if (card.number > highest) highest = card.number;
  return highest;
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
  const lane = db.prepare("INSERT INTO lanes (id, position, name, description, instructions, fixed) VALUES (?, ?, ?, ?, ?, ?)");
  for (const [position, entry] of board.lanes.entries()) {
    lane.run(entry.id, position, entry.name, entry.description, entry.instructions ?? "", entry.fixed ? 1 : 0);
  }
  const card = db.prepare(
    "INSERT INTO cards (id, position, lane_id, number, title, description, session_id, session_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [position, entry] of board.cards.entries()) {
    card.run(entry.id, position, entry.laneId, entry.number, entry.title, entry.description, entry.sessionId, entry.sessionTitle, entry.createdAt, entry.updatedAt);
  }
  writeBoardMeta(db, board);
  // A card that is gone takes its thread and its history: the one cleanup
  // rule, applied where the board is written (neither is a row of `cards`).

  db.exec("DELETE FROM card_comments WHERE card_id NOT IN (SELECT id FROM cards)");
  db.exec("DELETE FROM card_activity WHERE card_id NOT IN (SELECT id FROM cards)");
  return bumpRevision(db);
}

/** Advances the revision by one: the poll's whole signal that something changed. */
export function bumpRevision(db: DatabaseSync): number {
  const revision = readBoardRevision(db) + 1;
  db.prepare("INSERT INTO meta (key, value) VALUES ('revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(revision));
  return revision;
}

// ---------------------------------------------------------------------------
// Card-key metadata (`PIW-42`)
// ---------------------------------------------------------------------------

const META_CARD_PREFIX = "card_prefix";
const META_CARD_PREFIX_ALIASES = "card_prefix_aliases";
const META_NEXT_CARD_NUMBER = "next_card_number";

/** The board's card-key state, as the `meta` rows hold it (absent before the first write). */
export interface KanbanCardKeyMeta {
  /** Null when the board never stored one: the reader falls back to the folder's name. */
  cardPrefix: string | null;
  /** Prefixes a rename left behind, newest first, so old references still resolve. */
  prefixAliases: string[];
  /** 0 when the board never stored one: the reader derives it from the cards. */
  nextCardNumber: number;
}

function readMetaValue(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | undefined;
  return typeof row?.value === "string" ? row.value : null;
}

/** Alias rows are a JSON array of prefixes; anything else reads as none. */
function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

/** The board's card-key meta rows. Never creates anything: a missing row reads as its default. */
export function readBoardMeta(db: DatabaseSync): KanbanCardKeyMeta {
  const nextCardNumber = Number(readMetaValue(db, META_NEXT_CARD_NUMBER) ?? 0);
  return {
    cardPrefix: readMetaValue(db, META_CARD_PREFIX) || null,
    prefixAliases: parseAliases(readMetaValue(db, META_CARD_PREFIX_ALIASES)),
    nextCardNumber: Number.isFinite(nextCardNumber) ? Math.max(0, Math.trunc(nextCardNumber)) : 0,
  };
}

function writeBoardMeta(db: DatabaseSync, board: KanbanBoard): void {
  const write = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  write.run(META_CARD_PREFIX, board.cardPrefix);
  write.run(META_NEXT_CARD_NUMBER, String(Math.max(1, board.nextCardNumber)));
  const aliases = board.cardPrefixAliases ?? [];
  if (aliases.length > 0) write.run(META_CARD_PREFIX_ALIASES, JSON.stringify(aliases));
  else db.prepare("DELETE FROM meta WHERE key = ?").run(META_CARD_PREFIX_ALIASES);
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/**
 * One card's comments, oldest first. `limit` keeps the newest rows (the thread
 * reads top-down, so a page holds its tail); `total` counts them all.
 */
export function readCardComments(
  db: DatabaseSync,
  cardId: string,
  limit = 100,
): { comments: KanbanComment[]; total: number } {
  const total = db.prepare("SELECT count(*) AS n FROM card_comments WHERE card_id = ?").get(cardId) as { n?: number } | undefined;
  const rows = db
    .prepare("SELECT id, card_id, author, session_id, session_title, body, created_at FROM card_comments WHERE card_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(cardId, Math.max(1, Math.trunc(limit))) as unknown as CommentRow[];
  return { comments: rows.map(toComment).reverse(), total: Number(total?.n ?? 0) };
}

export function insertCardComment(db: DatabaseSync, comment: KanbanComment): void {
  db.prepare(
    "INSERT INTO card_comments (id, card_id, author, session_id, session_title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(comment.id, comment.cardId, comment.author, comment.sessionId, comment.sessionTitle, comment.body, comment.createdAt);
}

/** Deletes one comment; the card it belonged to, or null when it was already gone. */
export function deleteCardComment(db: DatabaseSync, commentId: string): string | null {
  const row = db.prepare("SELECT card_id FROM card_comments WHERE id = ?").get(commentId) as { card_id?: string } | undefined;
  if (!row?.card_id) return null;
  db.prepare("DELETE FROM card_comments WHERE id = ?").run(commentId);
  return row.card_id;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * One card's activity, oldest first. `limit` keeps the newest rows of the page
 * that ends before `beforeId` (the cursor is the oldest row already shown), so
 * the detail tab can page backwards without an offset that a concurrent write
 * would shift. `total` counts the whole trail.
 */
export function readCardActivity(
  db: DatabaseSync,
  cardId: string,
  limit = 50,
  beforeId: string | null = null,
): { activity: KanbanActivity[]; total: number } {
  const total = db.prepare("SELECT count(*) AS n FROM card_activity WHERE card_id = ?").get(cardId) as { n?: number } | undefined;
  const size = Math.max(1, Math.trunc(limit));
  const columns = "id, card_id, kind, from_value, to_value, actor_session_id, actor_session_title, created_at";
  let rows: ActivityRow[];
  if (beforeId) {
    const cursor = db.prepare("SELECT rowid AS seq FROM card_activity WHERE id = ? AND card_id = ?").get(beforeId, cardId) as
      | { seq?: number }
      | undefined;
    // An unknown cursor (a row another tab already pruned) reads the newest page
    // instead of failing: the tab then simply shows its own first page again.
    rows = cursor?.seq === undefined
      ? (db.prepare(`SELECT ${columns} FROM card_activity WHERE card_id = ? ORDER BY rowid DESC LIMIT ?`).all(cardId, size) as unknown as ActivityRow[])
      : (db
          .prepare(`SELECT ${columns} FROM card_activity WHERE card_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`)
          .all(cardId, cursor.seq, size) as unknown as ActivityRow[]);
  } else {
    rows = db.prepare(`SELECT ${columns} FROM card_activity WHERE card_id = ? ORDER BY rowid DESC LIMIT ?`).all(cardId, size) as unknown as ActivityRow[];
  }
  return {
    activity: rows.map(toActivity).filter((entry): entry is KanbanActivity => entry !== null).reverse(),
    total: Number(total?.n ?? 0),
  };
}

/**
 * Appends events and keeps each touched card's trail at `KANBAN_ACTIVITY_KEEP`
 * rows: a board file lives forever, a card's history does not need to. Call
 * inside the write's transaction.
 */
export function insertCardActivity(db: DatabaseSync, events: readonly KanbanActivity[]): void {
  if (events.length === 0) return;
  const insert = db.prepare(
    "INSERT INTO card_activity (id, card_id, kind, from_value, to_value, actor_session_id, actor_session_title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const touched = new Set<string>();
  for (const event of events) {
    insert.run(event.id, event.cardId, event.kind, event.from, event.to, event.actorSessionId, event.actorSessionTitle, event.createdAt);
    touched.add(event.cardId);
  }
  const prune = db.prepare(
    `DELETE FROM card_activity
      WHERE card_id = ?
        AND rowid <= (SELECT rowid FROM card_activity WHERE card_id = ? ORDER BY rowid DESC LIMIT 1 OFFSET ?)`,
  );
  for (const cardId of touched) prune.run(cardId, cardId, KANBAN_ACTIVITY_KEEP);
}

/**
 * Creates the board schema and its opening revision (`1`), in one transaction:
 * the default lanes for a board that has never been written, or the rows of a
 * board being put in place (the JSON import). The caller has checked the file
 * is not an older board — those are migrated by `migrateKanbanDatabase`, never
 * re-created. `activity` is the trail the mutation that created this file
 * produced (an `add-card` on a project with no board yet): it lands in the same
 * transaction, so a new board's first card is not the one card with no history.
 */
export function initializeBoard(db: DatabaseSync, board: KanbanBoard, activity: readonly KanbanActivity[] = []): number {
  return inTransaction(db, () => {
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${KANBAN_SCHEMA_VERSION}`);
    db.prepare("INSERT INTO meta (key, value) VALUES ('revision', '0')").run();
    const revision = writeBoardRows(db, board);
    insertCardActivity(db, activity);
    return revision;
  });
}

/** A board that has never been written: the six default lanes, no cards, and the folder's own prefix. */
export function freshBoard(projectDir: string): KanbanBoard {
  return { projectDir, lanes: defaultLanes(), cards: [], cardPrefix: defaultCardPrefix(projectDir), nextCardNumber: 1 };
}
