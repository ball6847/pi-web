import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { serializeByKey } from "./key-serializer";
import { applyKanbanAction, pruneDeadLinks } from "./kanban-shared";
import {
  defaultLanes,
  KANBAN_SCHEMA_VERSION,
  type KanbanAction,
  type KanbanBoard,
  type KanbanCard,
  type KanbanEnvelope,
  type KanbanLane,
} from "./kanban-types";
import { isMcpEntryRefusal, validateMcpProject } from "./mcp-entry-request";
import { readRegularFileText } from "./regular-file";
import { invalidateSessionPathCache, readSessionHeader, resolveSessionPath } from "./session-reader";
import { listWorktrees, resolveProject } from "./worktree";

// SERVER-ONLY. One board per project under pi's shared agent storage:
// `<agentDir>/kanban/<encoded-project-root>/kanban.json` (`getAgentDir()` is
// `$PI_CODING_AGENT_DIR` or `~/.pi/agent`). The board's key is the *resolved*
// project root — a worktree collapses to its main repo — so every checkout of
// a repository reads and writes the one shared file instead of forking a copy
// per worktree (the board used to live at `<projectDir>/.pi/kanban.json`; an
// old file there is imported on first access and then deleted). The content
// is a `{ schemaVersion, board }` envelope of pure data (never executed, never
// treated as configuration: the project-trust gate does not apply). The rules
// live in `lib/kanban-shared.ts`; this file is the locked, atomic file store
// around them, patterned on `lib/session-ui-state.ts`: writes are serialized
// in-process, locked against other processes, replaced atomically, and a file
// that cannot be parsed is set aside, never overwritten. Every failure is a
// typed result: nothing here throws at a caller.

const MAX_BYTES = 4 * 1024 * 1024;
const QUEUE_KEY: symbol = Symbol.for("pi-web:kanban-write-queue");

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

/** Another process held the board file's lock for longer than the retries wait. */
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

function toFailure(error: unknown): KanbanFailure {
  if (error instanceof KanbanLockedError) return failure("locked", error.message);
  if (error instanceof KanbanSchemaError) return failure("unsupported-schema", error.message);
  return failure("internal", errorMessage(error));
}

/**
 * A project root encoded as its board's directory name — the same scheme pi's
 * session directories use for `~/.pi/agent/sessions/<encoded-cwd>/` (the SDK
 * SessionManager's `--<path with / \ : -> -->--` encoding), so a board sits
 * beside its project's sessions and stays human-readable.
 */
export function encodeBoardKey(projectRoot: string): string {
  return `--${projectRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * The shared board file of a project root: `<agentDir>/kanban/<key>/kanban.json`.
 * Every worktree of a repository resolves to the same key, so they all read
 * and write this one file; a non-git directory keeps its own.
 */
export function getKanbanPath(projectRoot: string): string {
  return join(getAgentDir(), "kanban", encodeBoardKey(projectRoot), "kanban.json");
}

/** The pre-move location, read only to import a board on first access. */
function legacyBoardPath(projectRoot: string): string {
  return join(projectRoot, ".pi", "kanban.json");
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
// Revision
// ---------------------------------------------------------------------------

declare global {
  var __piWebKanbanRevisions: Map<string, number> | undefined;
}

// Route handlers are bundled separately and hot reload re-evaluates modules; globalThis keeps one counter per path.
function counters(): Map<string, number> {
  return (globalThis.__piWebKanbanRevisions ??= new Map());
}

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** One stat: the highest of this process's write counter and the file's mtime, so another process's edit is seen too. */
function revisionOf(path: string): number {
  return Math.max(counters().get(path) ?? 0, fileMtimeMs(path));
}

/**
 * After a write: the counter moves strictly forward of `before` (the revision
 * the write replaced), even for two writes inside one mtime tick or a file
 * whose mtime was set ahead of the clock.
 */
function noteWrite(path: string, before: number): void {
  const map = counters();
  map.set(path, Math.max((map.get(path) ?? 0) + 1, Math.floor(fileMtimeMs(path)), Math.floor(before) + 1));
}

/**
 * The board's revision, as a pure stat: no parse, no write, no pruning (the
 * client's poll). A board never written reads 0.
 */
export async function getBoardRevision(cwd: string): Promise<{ ok: true; revision: number } | KanbanFailure> {
  const valid = await validateKanbanCwd(cwd);
  if (!valid.ok) return valid;
  return { ok: true, revision: revisionOf(getKanbanPath(await boardProjectRoot(valid.cwd))) };
}

export function resetKanbanStateForTests(): void {
  globalThis.__piWebKanbanRevisions = undefined;
}

// ---------------------------------------------------------------------------
// File format
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyBoard(projectDir: string): KanbanBoard {
  return { projectDir, lanes: defaultLanes(), cards: [] };
}

function readLane(value: unknown, first: boolean): KanbanLane | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.name !== "string") return null;
  const lane: KanbanLane = { id: value.id, name: value.name, description: typeof value.description === "string" ? value.description : "" };
  if (first) {
    if (value.fixed !== true) return null;
    lane.fixed = true;
  }
  return lane;
}

function readCard(value: unknown): KanbanCard | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.title !== "string" || typeof value.laneId !== "string") return null;
  const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    id: value.id,
    title: value.title,
    description: typeof value.description === "string" ? value.description : "",
    laneId: value.laneId,
    sessionId: typeof value.sessionId === "string" && value.sessionId ? value.sessionId : null,
    sessionTitle: typeof value.sessionTitle === "string" ? value.sessionTitle : null,
    createdAt: time(value.createdAt),
    updatedAt: time(value.updatedAt),
  };
}

/**
 * The board of a parsed envelope, or null when it is not one. A hand-edited
 * file is read leniently: a card that is not a card is skipped, a card in a
 * lane that is gone goes to the backlog unlinked, and a session carried twice
 * stays on its first card. `projectDir` is always the folder the file was read
 * for (the board's key), so a project that moved on disk keeps its board.
 */
function normalizeEnvelope(raw: unknown, cwd: string): KanbanBoard | null {
  if (!isRecord(raw) || typeof raw.schemaVersion !== "number") return null;
  if (raw.schemaVersion > KANBAN_SCHEMA_VERSION) {
    throw new KanbanSchemaError(`kanban.json has schemaVersion ${raw.schemaVersion}, newer than this pi-web understands (${KANBAN_SCHEMA_VERSION})`);
  }
  if (raw.schemaVersion !== KANBAN_SCHEMA_VERSION || !isRecord(raw.board) || !Array.isArray(raw.board.lanes) || !Array.isArray(raw.board.cards)) return null;
  const lanes: KanbanLane[] = [];
  for (const [index, value] of raw.board.lanes.entries()) {
    const lane = readLane(value, index === 0);
    if (!lane || lanes.some((l) => l.id === lane.id)) return null;
    lanes.push(lane);
  }
  const backlog = lanes[0];
  if (!backlog) return null;
  const cards: KanbanCard[] = [];
  const sessions = new Set<string>();
  for (const value of raw.board.cards) {
    const card = readCard(value);
    if (!card || cards.some((c) => c.id === card.id)) continue;
    if (!lanes.some((l) => l.id === card.laneId)) {
      card.laneId = backlog.id;
      card.sessionId = null;
    }
    if (card.sessionId !== null) {
      if (sessions.has(card.sessionId)) card.sessionId = null;
      else sessions.add(card.sessionId);
    }
    cards.push(card);
  }
  return { projectDir: cwd, lanes, cards };
}

type Loaded = { kind: "ok"; board: KanbanBoard } | { kind: "missing" } | { kind: "corrupt" };

/** Reads the file. A file too large, not a regular file, or not a board is "corrupt"; a read that fails for another reason throws. */
function loadBoardFile(path: string, cwd: string): Loaded {
  let text: string | undefined;
  try {
    text = readRegularFileText(path, MAX_BYTES);
  } catch (error) {
    if (errorCode(error) !== undefined) throw error;
    return { kind: "corrupt" };
  }
  if (text === undefined) return { kind: "missing" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "corrupt" };
  }
  const board = normalizeEnvelope(raw, cwd);
  return board ? { kind: "ok", board } : { kind: "corrupt" };
}

/** Sets an unparsable file aside beside itself (the scheme of `session-ui-state.json`); best effort. */
function backUpCorruptFile(path: string): void {
  const backup = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, backup);
    console.warn(`[pi-web] ${path} could not be parsed; moved it to ${backup} and started from an empty board`);
  } catch (error) {
    console.warn(`[pi-web] ${path} could not be parsed and could not be moved aside (${errorMessage(error)}); starting from an empty board`);
  }
}

/** The file is replaced, never written in place: a temporary sibling, then a rename over it. */
function writeBoardFile(path: string, board: KanbanBoard): void {
  const envelope: KanbanEnvelope = { schemaVersion: KANBAN_SCHEMA_VERSION, board };
  let mode = 0o644;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // A new file.
  }
  const temp = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  let failed = false;
  try {
    writeFileSync(temp, JSON.stringify(envelope, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode, flush: true });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      unlinkSync(temp);
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && !failed) throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Migration from the old `<project>/.pi/kanban.json`
// ---------------------------------------------------------------------------

/**
 * The board an old file held, for import: the parsed board, or null when there
 * is nothing importable. A corrupt file is set aside beside the shared file
 * (where corrupt boards live); a file from a newer schema is left exactly
 * where it is, because importing it would make every later read refuse.
 */
function importLegacyBoard(legacy: string, projectRoot: string): KanbanBoard | null {
  let loaded: Loaded;
  try {
    loaded = loadBoardFile(legacy, projectRoot);
  } catch (error) {
    if (error instanceof KanbanSchemaError) {
      console.warn(`[pi-web] the old board ${legacy} has a newer schema than this pi-web; it stays in place and is not imported`);
      return null;
    }
    console.warn(`[pi-web] the old board ${legacy} could not be read (${errorMessage(error)}); starting from an empty board and leaving it in place`);
    return null;
  }
  if (loaded.kind === "missing") return null;
  if (loaded.kind === "corrupt") {
    const backup = `${getKanbanPath(projectRoot)}.corrupt-${Date.now()}`;
    try {
      renameSync(legacy, backup);
      console.warn(`[pi-web] the old board ${legacy} could not be parsed; moved it to ${backup} and started from an empty board`);
    } catch (error) {
      console.warn(`[pi-web] the old board ${legacy} could not be parsed and could not be moved aside (${errorMessage(error)}); starting from an empty board, leaving it in place`);
    }
    return null;
  }
  return loaded.board;
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

type Seed = { board: KanbanBoard; migratedFrom: string | null };

/**
 * What a missing shared file starts from: the project's old
 * `<projectRoot>/.pi/kanban.json` when it holds a board; failing that, the
 * newest such file one of the repository's worktrees kept (a board forked
 * there before the move) — only the newest, so a discarded corrupt one never
 * falls back to an older, staler state; failing that, the empty default. The
 * caller deletes the imported file once the shared one is written.
 */
async function seedBoard(projectRoot: string): Promise<Seed> {
  const legacy = legacyBoardPath(projectRoot);
  if (existsSync(legacy)) {
    const board = importLegacyBoard(legacy, projectRoot);
    return { board: board ?? emptyBoard(projectRoot), migratedFrom: board ? legacy : null };
  }
  const candidates: string[] = [];
  for (const worktree of await worktreePaths(projectRoot)) {
    const candidate = join(worktree, ".pi", "kanban.json");
    try {
      if (statSync(candidate).isFile()) candidates.push(candidate);
    } catch {
      // No file there.
    }
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const newest = candidates[0];
  if (newest) {
    const board = importLegacyBoard(newest, projectRoot);
    if (board) return { board, migratedFrom: newest };
  }
  return { board: emptyBoard(projectRoot), migratedFrom: null };
}

/** The imported file is deleted once its content is safe in the shared file; best effort. */
function deleteImportedFile(path: string): void {
  try {
    unlinkSync(path);
    console.warn(`[pi-web] the board moved from ${path} to the shared agent storage; the old file was deleted`);
  } catch (error) {
    console.warn(`[pi-web] the board was imported from ${path} but the old file could not be deleted (${errorMessage(error)}); delete it manually`);
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Whether the session's file exists and belongs to this board's project: its
 * header's folder is the project root, or a worktree of it (a session may
 * run in any checkout of the repository).
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
// Locked read-modify-write
// ---------------------------------------------------------------------------

type EditResult = { board: KanbanBoard } | { refused: true };
type Edited = { ok: true; board: KanbanBoard; revision: number } | { ok: false; refused: true };

/**
 * Under the in-process queue and the file's lock: reads the shared board (a
 * missing file is seeded by the migration or started with the default lanes,
 * an unparsable file is set aside for one), applies `edit`, and replaces the
 * file when the edit returned a different board, or the file had to be
 * materialized. A refused edit writes nothing but a newly materialized file.
 */
function editBoard(projectRoot: string, edit: (board: KanbanBoard, now: number) => Promise<EditResult>): Promise<Edited> {
  const path = getKanbanPath(projectRoot);
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
      const loaded = loadBoardFile(path, projectRoot);
      let board: KanbanBoard;
      let migratedFrom: string | null = null;
      const materialize = loaded.kind !== "ok";
      if (loaded.kind === "ok") {
        board = loaded.board;
      } else {
        if (loaded.kind === "corrupt") backUpCorruptFile(path);
        if (loaded.kind === "missing") {
          const seed = await seedBoard(projectRoot);
          board = seed.board;
          migratedFrom = seed.migratedFrom;
        } else {
          board = emptyBoard(projectRoot);
        }
      }
      const before = revisionOf(path);
      const result = await edit(board, Date.now());
      if ("refused" in result) {
        // Even a refused action materializes a missing file (with the
        // imported board, when there was one to import), so the next read
        // sees a real board with a real revision.
        if (materialize) {
          writeBoardFile(path, board);
          noteWrite(path, before);
          if (migratedFrom) deleteImportedFile(migratedFrom);
        }
        return { ok: false as const, refused: true as const };
      }
      if (materialize || result.board !== board) {
        writeBoardFile(path, result.board);
        noteWrite(path, before);
        if (migratedFrom) deleteImportedFile(migratedFrom);
      }
      return { ok: true as const, board: result.board, revision: revisionOf(path) };
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
 * The project's board. A missing shared file is seeded by the migration (the
 * project's old `.pi/kanban.json`, or a worktree's copy of it) and written
 * with the default lanes when there is nothing to import; an unparsable one is
 * set aside and replaced. Cards whose session no longer exists are unlinked
 * (lane and snapshot title kept) and, when that changes the board, written
 * back through the locked path. With `{ create: false }` a missing or
 * unusable file yields the empty board and revision 0 without any write or
 * import: for the watchers that must not create files.
 */
export async function readBoard(cwd: string, options: { create?: boolean } = {}): Promise<KanbanBoardResult> {
  const valid = await validateKanbanCwd(cwd);
  if (!valid.ok) return valid;
  const projectRoot = await boardProjectRoot(valid.cwd);
  try {
    const path = getKanbanPath(projectRoot);
    const loaded = loadBoardFile(path, projectRoot);
    if (loaded.kind === "ok") {
      const board = loaded.board;
      if (options.create === false) return { ok: true, board, revision: revisionOf(path) };
      const alive = await aliveSessions(projectRoot, board);
      if (linkedSessionIds(board).every((id) => alive.has(id))) return { ok: true, board, revision: revisionOf(path) };
    } else if (options.create === false) {
      return { ok: true, board: emptyBoard(projectRoot), revision: 0 };
    }
    const edited = await editBoard(projectRoot, async (board, now) => ({ board: await pruneBoard(projectRoot, board, now) }));
    return edited.ok ? edited : failure("internal", "The board could not be read");
  } catch (error) {
    return toFailure(error);
  }
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
 * board is pruned of dead links, written atomically, and returned with its new
 * revision. A refusal writes nothing but a newly materialized file.
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
