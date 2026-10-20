import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";
import { serializeByKey } from "./key-serializer";
import {
  closeKanbanDatabase,
  freshBoard,
  initializeBoard,
  inspectKanbanFile,
  inTransaction,
  kanbanBoardDir,
  kanbanBoardPath,
  openKanbanDatabase,
  readBoardRevision,
  readBoardRows,
  writeBoardRows,
  type KanbanSnapshot,
} from "./kanban-data";
import { applyKanbanAction, pruneDeadLinks } from "./kanban-shared";
import { KANBAN_SCHEMA_VERSION, type KanbanAction, type KanbanBoard, type KanbanCard } from "./kanban-types";
import { isMcpEntryRefusal, validateMcpProject } from "./mcp-entry-request";
import { readRegularFileText } from "./regular-file";
import { invalidateSessionPathCache, readSessionHeader, resolveSessionPath } from "./session-reader";
import { listWorktrees, resolveProject } from "./worktree";

// SERVER-ONLY. The kanban board's policy: which file holds a project's board,
// which folder a request may name, the lock around a read-modify-write, the
// revision the client polls, dead-link pruning, and every typed refusal. The
// rows, the schema and the file's shape live one level down in
// `lib/kanban-data.ts`; the board's rules in `lib/kanban-shared.ts`. Callers
// (the route) see typed results only: nothing here throws.
//
// Storage is one SQLite file per project under pi's shared agent storage:
// `<agentDir>/kanban/<encoded-project-root>/kanban.sqlite`, keyed by the
// *resolved* project root, so every worktree of a repository shares it. Boards
// written by the previous JSON storage (`kanban.json` beside it, and before
// that `<projectDir>/.pi/kanban.json`) are imported on first access and then
// moved aside — never deleted before their content is safe in the database.

/** One queue chain per board file, so this process's writes never interleave. */
const QUEUE_KEY: symbol = Symbol.for("pi-web:kanban-write-queue");

const MAX_LEGACY_BYTES = 4 * 1024 * 1024;

/** How long SQLite waits on a busy file; the proper-lockfile lock keeps this rare. */
const DB_TIMEOUT_MS = 5_000;

/** About three seconds of retries, as for `session-ui-state.json` and `mcp.json`. */
const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
  onCompromised: (error: Error) => {
    console.warn(`[pi-web] the kanban board lock was compromised: ${error.message}`);
  },
};

export type KanbanFailureCode =
  | "cwd-invalid"
  | "cwd-denied"
  | "cwd-not-directory"
  | "session-missing"
  | "refused"
  | "locked"
  | "unsupported-schema"
  | "internal";

export interface KanbanFailure {
  ok: false;
  code: KanbanFailureCode;
  error: string;
}

export type KanbanBoardResult = { ok: true; board: KanbanBoard; revision: number } | KanbanFailure;

/** Another process held the board's lock for longer than the retries wait. */
export class KanbanLockedError extends Error {
  constructor(message = "Another process holds the kanban board lock") {
    super(message);
    this.name = "KanbanLockedError";
  }
}

/** The file was written by a newer pi-web: it is left alone, not set aside. */
class KanbanSchemaError extends Error {}

function failure(code: KanbanFailureCode, error: string): KanbanFailure {
  return { ok: false, code, error };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** SQLITE_BUSY / SQLITE_LOCKED: another connection is writing the file right now. */
function isBusy(error: unknown): boolean {
  const errcode = (error as { errcode?: number } | undefined)?.errcode;
  return errcode === 5 || errcode === 6;
}

function toFailure(error: unknown): KanbanFailure {
  if (error instanceof KanbanLockedError) return failure("locked", error.message);
  if (error instanceof KanbanSchemaError) return failure("unsupported-schema", error.message);
  if (isBusy(error)) return failure("locked", "Another process is writing the kanban board");
  return failure("internal", errorMessage(error));
}

function unsupportedSchemaMessage(version: number): string {
  return `the kanban board was written by a newer pi-web (schema ${version}, this build reads ${KANBAN_SCHEMA_VERSION}); it was left untouched`;
}

/**
 * The board's key for a request's cwd: the resolved project root (a worktree
 * collapses to its main repo, the same rule the sidebar groups sessions by);
 * anything that is not a worktree's top level keeps its own identity.
 */
async function boardProjectRoot(cwd: string): Promise<string> {
  return (await resolveProject(cwd)).projectRoot;
}

/**
 * The project folder a request names, checked exactly as `/api/mcp` checks its
 * project (`validateMcpProject()`): absolute, inside the allowed roots as given,
 * and a directory. Nothing is read or written for a refused folder. The board
 * file itself lives under the agent directory, where sessions already live, so
 * the checked folder is the only filesystem boundary that matters.
 */
export async function validateKanbanCwd(value: unknown): Promise<{ ok: true; cwd: string } | KanbanFailure> {
  try {
    const result = await validateMcpProject(value);
    if (isMcpEntryRefusal(result)) return failure(result.body.reason as KanbanFailureCode, result.body.error);
    return { ok: true, cwd: result.cwd };
  } catch (error) {
    return failure("internal", errorMessage(error));
  }
}

// ---------------------------------------------------------------------------
// Session ownership
// ---------------------------------------------------------------------------

/**
 * Whether the session's file exists and belongs to this board's project: its
 * header's folder is the project root, or a worktree of it (a session may run
 * in any checkout of the repository).
 */
export async function validateSession(cwd: string, sessionId: string): Promise<boolean> {
  if (typeof sessionId !== "string" || !sessionId) return false;
  try {
    let path = await resolveSessionPath(sessionId);
    // A path cached before the file was deleted points at nothing: look again from the disk.
    if (path && !existsSync(path)) {
      invalidateSessionPathCache(sessionId);
      path = await resolveSessionPath(sessionId);
    }
    if (!path || !existsSync(path)) return false;
    const sessionCwd = readSessionHeader(path)?.cwd;
    if (!sessionCwd) return false;
    if (resolve(sessionCwd) === resolve(cwd)) return true;
    return resolve((await resolveProject(sessionCwd)).projectRoot) === resolve(cwd);
  } catch {
    return false;
  }
}

function linkedSessionIds(board: KanbanBoard): string[] {
  return [...new Set(board.cards.map((card) => card.sessionId).filter((id): id is string => id !== null))];
}

/** The board's linked sessions that still exist for this project. */
async function aliveSessions(cwd: string, board: KanbanBoard): Promise<Set<string>> {
  const ids = linkedSessionIds(board);
  const checks = await Promise.all(ids.map(async (id) => ((await validateSession(cwd, id)) ? id : null)));
  return new Set(checks.filter((id): id is string => id !== null));
}

/** Dead-link pruning (the same board back when nothing was dead). */
async function pruneBoard(cwd: string, board: KanbanBoard, now: number): Promise<KanbanBoard> {
  if (linkedSessionIds(board).length === 0) return board;
  return pruneDeadLinks(board, await aliveSessions(cwd, board), now);
}

// ---------------------------------------------------------------------------
// Opening a board file
// ---------------------------------------------------------------------------

/**
 * An opened board file. `ready` and `empty` carry the connection (the caller
 * closes it); `empty` is a valid database without the board schema — a 0-byte
 * file from an interrupted first open, or a stray database — which a writing
 * path initializes and a read-only path ignores. `newer` and `corrupt` carry no
 * connection.
 */
type Opened =
  | { kind: "ready"; db: DatabaseSync; snapshot: KanbanSnapshot }
  | { kind: "empty"; db: DatabaseSync }
  | { kind: "missing" }
  | { kind: "newer"; version: number }
  | { kind: "corrupt"; error: string };

/** Opens the board file and reads it when it is a board. Looking at a board never creates or writes one. */
function openBoard(path: string, projectDir: string): Opened {
  const { state, db } = inspectKanbanFile(path, { timeout: DB_TIMEOUT_MS });
  switch (state.kind) {
    case "missing":
      return { kind: "missing" };
    case "newer":
      return { kind: "newer", version: state.version };
    case "corrupt":
      return { kind: "corrupt", error: state.error };
    case "empty":
      return db ? { kind: "empty", db } : { kind: "corrupt", error: "the kanban database could not be opened" };
    case "ready": {
      if (!db) return { kind: "corrupt", error: "the kanban database could not be opened" };
      try {
        return { kind: "ready", db, snapshot: readBoardRows(db, projectDir) };
      } catch (error) {
        closeKanbanDatabase(db);
        return { kind: "corrupt", error: errorMessage(error) };
      }
    }
  }
}

/** Closes the connection an `Opened` carries, if any. */
function closeOpened(opened: Opened): void {
  if (opened.kind === "ready" || opened.kind === "empty") closeKanbanDatabase(opened.db);
}

/**
 * The board's revision, as a pure read: one `meta` row, no board parsing, no
 * write, no pruning (the client's poll). A board never written reads 0 and is
 * not created by asking.
 */
export async function getBoardRevision(cwd: string): Promise<{ ok: true; revision: number } | KanbanFailure> {
  const valid = await validateKanbanCwd(cwd);
  if (!valid.ok) return valid;
  const path = kanbanBoardPath(await boardProjectRoot(valid.cwd));
  if (!existsSync(path)) return { ok: true, revision: 0 };
  try {
    const opened = openBoard(path, valid.cwd);
    try {
      if (opened.kind === "newer") throw new KanbanSchemaError(unsupportedSchemaMessage(opened.version));
      if (opened.kind !== "ready") return { ok: true, revision: 0 }; // missing/corrupt/empty: the read replaces it
      return { ok: true, revision: opened.snapshot.revision };
    } finally {
      closeOpened(opened);
    }
  } catch (error) {
    return toFailure(error);
  }
}

// ---------------------------------------------------------------------------
// Migration: JSON -> SQLite (and the older `<project>/.pi/kanban.json`)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A previous JSON board (`{ schemaVersion: 1, board }`), read here only to move
 * an existing board into SQLite. Deliberately lenient, exactly as that storage
 * read it: a file that is not a board is `null`, a card in a vanished lane goes
 * to the backlog unlinked, and a session carried twice stays on its first card.
 */
function parseJsonBoard(text: string, projectDir: string): KanbanBoard | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.schemaVersion !== "number") return null;
  if (raw.schemaVersion > KANBAN_SCHEMA_VERSION) throw new KanbanSchemaError(unsupportedSchemaMessage(raw.schemaVersion));
  if (raw.schemaVersion !== KANBAN_SCHEMA_VERSION || !isRecord(raw.board)) return null;
  if (!Array.isArray(raw.board.lanes) || !Array.isArray(raw.board.cards)) return null;

  const lanes: KanbanLaneRow[] = [];
  for (const [index, value] of raw.board.lanes.entries()) {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.name !== "string") return null;
    if (lanes.some((lane) => lane.id === value.id)) return null;
    const fixed = value.fixed === true;
    if (index === 0 && !fixed) return null;
    const lane: KanbanLaneRow = { id: value.id, name: value.name, description: typeof value.description === "string" ? value.description : "" };
    if (fixed || index === 0) lane.fixed = true;
    lanes.push(lane);
  }
  const backlog = lanes[0];
  if (!backlog) return null;

  const time = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const cards: KanbanCard[] = [];
  const sessions = new Set<string>();
  for (const value of raw.board.cards) {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.title !== "string" || typeof value.laneId !== "string") continue;
    if (cards.some((card) => card.id === value.id)) continue;
    const card: KanbanCard = {
      id: value.id,
      title: value.title,
      description: typeof value.description === "string" ? value.description : "",
      laneId: value.laneId,
      sessionId: typeof value.sessionId === "string" && value.sessionId ? value.sessionId : null,
      sessionTitle: typeof value.sessionTitle === "string" ? value.sessionTitle : null,
      createdAt: time(value.createdAt),
      updatedAt: time(value.updatedAt),
    };
    if (!lanes.some((lane) => lane.id === card.laneId)) {
      card.laneId = backlog.id;
      card.sessionId = null;
    }
    if (card.sessionId !== null) {
      if (sessions.has(card.sessionId)) card.sessionId = null;
      else sessions.add(card.sessionId);
    }
    cards.push(card);
  }
  return { projectDir, lanes, cards };
}

type KanbanLaneRow = KanbanBoard["lanes"][number];

/** The board an old JSON file holds, or null when there is nothing importable. */
function readJsonBoard(path: string, projectDir: string): KanbanBoard | null {
  const text = readRegularFileText(path, MAX_LEGACY_BYTES);
  return text === undefined ? null : parseJsonBoard(text, projectDir);
}

/** The pre-agent-dir location: `<projectRoot>/.pi/kanban.json`. */
export function projectJsonBoardPath(projectRoot: string): string {
  return join(projectRoot, ".pi", "kanban.json");
}

/** The JSON storage SQLite replaced: `<agentDir>/kanban/<key>/kanban.json`, beside the database. */
export function previousJsonBoardPath(projectRoot: string): string {
  return join(kanbanBoardDir(projectRoot), "kanban.json");
}

/** The linked worktrees of a repository (the main checkout excluded), or none when it is not a repository. */
async function worktreePaths(projectRoot: string): Promise<string[]> {
  try {
    const worktrees = await listWorktrees(projectRoot);
    return worktrees.filter((worktree) => !worktree.isMain).map((worktree) => worktree.path);
  } catch {
    return [];
  }
}

type Seed = { board: KanbanBoard; sources: ImportedSource[] };

/**
 * A JSON board file the import touched: one whose content went in, one that
 * could not be read, or one an already-imported board made redundant.
 */
type ImportedSource = { path: string; kind: "imported" | "corrupt" | "superseded" };

/**
 * What a missing board file starts from, newest storage first:
 *   1. the JSON board of the same project (`kanban.json` beside the database —
 *      the storage this schema replaced), then
 *   2. the project's own `<projectRoot>/.pi/kanban.json` (the location before
 *      that), then
 *   3. the newest such file one of the repository's worktrees kept (only the
 *      newest, so a stale copy never shadows a fresher board), then
 *   4. the empty default board.
 *
 * A file that cannot be read is kept aside as a corrupt backup and the next
 * candidate is tried. A file from a *newer* schema is left exactly where it
 * is: importing it would make every later read refuse the board, so the fresh
 * board starts beside it instead.
 */
async function seedBoard(projectRoot: string): Promise<Seed> {
  const sources: ImportedSource[] = [];
  const candidates = [previousJsonBoardPath(projectRoot), projectJsonBoardPath(projectRoot)];
  for (const [index, candidate] of candidates.entries()) {
    if (!existsSync(candidate)) continue;
    const seed = readSeedFile(candidate, projectRoot);
    if (seed.kind === "newer") {
      // Left in place, and the search stops here: importing it is impossible,
      // and an older copy elsewhere is staler than a file this build cannot read.
      return { board: freshBoard(projectRoot), sources };
    }
    if (seed.kind === "board") {
      sources.push({ path: candidate, kind: "imported" });
      // Every other JSON board for this project is older than the one just
      // imported (the candidates are in newest-first order, and a worktree copy
      // is older than either), so none of them may be imported again if the
      // database ever goes missing: they are moved aside as superseded.
      for (const stale of candidates.slice(index + 1)) {
        if (existsSync(stale)) sources.push({ path: stale, kind: "superseded" });
      }
      for (const stale of await worktreeBoardPaths(projectRoot)) {
        if (existsSync(stale)) sources.push({ path: stale, kind: "superseded" });
      }
      return { board: seed.board, sources };
    }
    sources.push({ path: candidate, kind: "corrupt" });
  }
  const newest = (await worktreeBoardPaths(projectRoot))[0];
  if (newest) {
    const seed = readSeedFile(newest, projectRoot);
    if (seed.kind === "board") {
      sources.push({ path: newest, kind: "imported" });
      return { board: seed.board, sources };
    }
    if (seed.kind === "corrupt") sources.push({ path: newest, kind: "corrupt" });
  }
  return { board: freshBoard(projectRoot), sources };
}

/** The `.pi/kanban.json` copies the repository's linked worktrees kept, newest first. */
async function worktreeBoardPaths(projectRoot: string): Promise<string[]> {
  const paths: string[] = [];
  for (const worktree of await worktreePaths(projectRoot)) {
    const candidate = projectJsonBoardPath(worktree);
    try {
      if (statSync(candidate).isFile()) paths.push(candidate);
    } catch {
      // No file there.
    }
  }
  // Newest first: a board forked in a worktree is only imported when the
  // project itself has none, and then only the freshest copy.
  return paths.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** One JSON board file as seed material: the board it holds, or why it holds none. */
function readSeedFile(path: string, projectRoot: string): { kind: "board"; board: KanbanBoard } | { kind: "corrupt" } | { kind: "newer" } {
  try {
    const board = readJsonBoard(path, projectRoot);
    return board ? { kind: "board", board } : { kind: "corrupt" };
  } catch (error) {
    if (error instanceof KanbanSchemaError) {
      // Not ours to move, and importing it would make every later read refuse
      // this project's board.
      console.warn(`[pi-web] the JSON kanban board at ${path} was written by a newer pi-web; it stays in place and is not imported`);
      return { kind: "newer" };
    }
    console.warn(`[pi-web] the JSON kanban board at ${path} could not be read (${errorMessage(error)}); starting from an empty board`);
    return { kind: "corrupt" };
  }
}

/**
 * Moves a JSON board file aside once the database is authoritative. Nothing is
 * deleted: an import that ever went wrong leaves the user's cards on disk. The
 * suffix says what happened (`.imported-`, `.corrupt-`, `.superseded-`).
 */
function retireImportedFile(source: ImportedSource): void {
  const moved = `${source.path}.${source.kind}-${Date.now()}`;
  const what = {
    imported: "was imported into SQLite",
    corrupt: "was unreadable, so an empty board started",
    superseded: "was older than the board already imported",
  }[source.kind];
  try {
    renameSync(source.path, moved);
    console.warn(`[pi-web] the JSON kanban board at ${source.path} ${what}; the file was kept as ${moved}`);
  } catch (error) {
    console.warn(`[pi-web] the JSON kanban board at ${source.path} ${what} but could not be moved aside (${errorMessage(error)}); delete it manually`);
  }
}

/** Sets a file that is not a usable board aside, with its WAL sidecars; best effort. */
function backUpUnusableBoard(path: string): void {
  const backup = `${path}.corrupt-${Date.now()}`;
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${backup}${suffix}`);
    }
    console.warn(`[pi-web] ${path} could not be read as a kanban board; moved it to ${backup} and started from an empty board`);
  } catch (error) {
    console.warn(`[pi-web] ${path} could not be read as a kanban board and could not be moved aside (${errorMessage(error)}); starting from an empty board`);
  }
}

// ---------------------------------------------------------------------------
// Locked read-modify-write
// ---------------------------------------------------------------------------

type EditResult = { board: KanbanBoard } | { refused: true };

/**
 * Under the in-process queue and the file's lock: opens the board (a missing
 * file is seeded by the import or started with the default lanes; an unusable
 * one is set aside and replaced; a newer one is refused), applies `edit`, and
 * writes the rows when the edit returned a different board. A refused edit
 * still materializes a missing file, so the next read sees a real revision.
 * The connection is closed and the lock released on every path.
 */
async function editBoard(
  projectRoot: string,
  edit: (board: KanbanBoard, now: number) => Promise<EditResult>,
): Promise<{ ok: true; board: KanbanBoard; revision: number } | { ok: false; refused: true }> {
  const path = kanbanBoardPath(projectRoot);
  return serializeByKey(QUEUE_KEY, path, async () => {
    mkdirSync(dirname(path), { recursive: true });
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(path, LOCK_OPTIONS);
    } catch (error) {
      if (errorCode(error) === "ELOCKED") throw new KanbanLockedError();
      throw error;
    }
    try {
      const opened = openBoard(path, projectRoot);
      // One store connection per edit: the caller's edits close over it.
      try {
        if (opened.kind === "newer") throw new KanbanSchemaError(unsupportedSchemaMessage(opened.version));
        let board: KanbanBoard;
        let db: DatabaseSync;
        let sources: ImportedSource[] = [];
        if (opened.kind === "ready") {
          board = opened.snapshot.board;
          db = opened.db;
        } else {
          if (opened.kind === "corrupt") backUpUnusableBoard(path);
          // Every file that is not a board starts the same way: from the JSON
          // import when there is one (moved aside once its content is safe),
          // otherwise the default lanes. That includes a 0-byte file left by an
          // interrupted first open — it holds no board to keep.
          const seed = await seedBoard(projectRoot);
          board = seed.board;
          sources = seed.sources;
          db = opened.kind === "empty" ? opened.db : openKanbanDatabase(path, { timeout: DB_TIMEOUT_MS });
          initializeBoard(db, board);
        }
        const result = await edit(board, Date.now());
        if ("refused" in result) {
          for (const source of sources) retireImportedFile(source);
          return { ok: false as const, refused: true as const };
        }
        if (result.board !== board) {
          inTransaction(db, () => writeBoardRows(db, result.board));
        }
        for (const source of sources) retireImportedFile(source);
        return { ok: true as const, board: result.board, revision: readBoardRevision(db) };
      } finally {
        closeOpened(opened);
      }
    } finally {
      try {
        await release();
      } catch {
        // A compromised lock was already reported through onCompromised.
      }
    }
  });
}

/**
 * The project's board. A missing file is seeded by the import (a JSON board
 * beside the database, then the old `.pi/kanban.json`) and written with the
 * default lanes when there is nothing to import; an unusable one is set aside
 * and replaced. Cards whose session no longer exists are unlinked (lane and
 * snapshot title kept) and, when that changes the board, written back through
 * the locked path. With `{ create: false }` a missing or unusable file yields
 * the empty board and revision 0 without any write or import: for the watchers
 * that must not create files.
 */
export async function readBoard(cwd: string, options: { create?: boolean } = {}): Promise<KanbanBoardResult> {
  const valid = await validateKanbanCwd(cwd);
  if (!valid.ok) return valid;
  const projectRoot = await boardProjectRoot(valid.cwd);
  const path = kanbanBoardPath(projectRoot);
  try {
    const opened = openBoard(path, projectRoot);
    if (opened.kind === "newer") {
      closeOpened(opened);
      throw new KanbanSchemaError(unsupportedSchemaMessage(opened.version));
    }
    if (opened.kind === "ready") {
      const { board, revision } = opened.snapshot;
      closeOpened(opened);
      if (options.create === false) return { ok: true, board, revision };
      const alive = await aliveSessions(projectRoot, board);
      // Nothing dead: answer the read without taking the lock or writing.
      if (linkedSessionIds(board).every((id) => alive.has(id))) return { ok: true, board, revision };
      return editedResult(await editBoard(projectRoot, async (fresh, now) => ({ board: await pruneBoard(projectRoot, fresh, now) })));
    }
    closeOpened(opened);
    if (options.create === false) return { ok: true, board: freshBoard(projectRoot), revision: 0 };
    return editedResult(await editBoard(projectRoot, async (board, now) => ({ board: await pruneBoard(projectRoot, board, now) })));
  } catch (error) {
    return toFailure(error);
  }
}

function editedResult(edited: Awaited<ReturnType<typeof editBoard>>): KanbanBoardResult {
  return edited.ok ? edited : failure("internal", "The board could not be read");
}

/** The session a mutation links a card to, if any. */
function actionSessionId(action: KanbanAction): string | null {
  switch (action.action) {
    case "link-session":
    case "create-card-for-session":
      return action.sessionId;
    case "add-card":
      return action.sessionId ?? null;
    default:
      return null;
  }
}

/**
 * One mutation: the folder is checked, a session the action links must exist
 * (`session-missing`), then under the lock the reducer for the action runs on
 * the freshly read board; a refusal by the rules is `refused`. The resulting
 * board is pruned of dead links, written in one transaction, and returned with
 * its new revision. A refusal writes nothing but a newly materialized file.
 */
export async function applyMutation(cwd: string, action: KanbanAction): Promise<KanbanBoardResult> {
  const valid = await validateKanbanCwd(cwd);
  if (!valid.ok) return valid;
  const projectRoot = await boardProjectRoot(valid.cwd);
  try {
    const sessionId = actionSessionId(action);
    if (sessionId !== null && !(await validateSession(projectRoot, sessionId))) {
      return failure("session-missing", "That session does not exist in this project");
    }
    const edited = await editBoard(projectRoot, async (board, now) => {
      const next = applyKanbanAction(board, action, now);
      return next ? { board: await pruneBoard(projectRoot, next, now) } : { refused: true };
    });
    return edited.ok ? edited : failure("refused", `The board's rules refuse "${action.action}" here`);
  } catch (error) {
    return toFailure(error);
  }
}
