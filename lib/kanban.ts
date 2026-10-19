/**
 * Client store and hooks of the kanban board: a module-level cache of the
 * boards the server holds (`/api/kanban`, shared storage under `~/.pi/agent`;
 * see `lib/kanban-store.ts`).
 *
 * One entry per project directory — callers key by the project root
 * (`projectRoot ?? cwd`), which is also how the server matches sessions to a
 * board. An entry keeps the last board the server answered (`serverBoard`) and
 * the writes still on their way (`pending`); the board a component sees is the
 * server's board with the pending writes applied on top, the same way
 * `hooks/useSessionUiState.ts` does it. A mutation is first run through the
 * shared reducers (`lib/kanban-shared.ts`) — the same rules the route enforces,
 * so a refusal there never posts — then posted; the server's `{ board,
 * revision }` replaces the cache on success, and a failure drops the pending
 * write (the optimistic change rolls back) and flips the status to `error`.
 *
 * Boards are fetched when a component first watches one, then a visibility-aware
 * poll asks the route for the revision only (`revOnly=1`) and refetches the
 * board when it moved, so two tabs converge without a reload. Client-safe: no
 * node: imports, and no fetch at module load.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { applyKanbanAction, laneById } from "./kanban-shared";
import {
  makeKanbanId,
  type KanbanAction,
  type KanbanBoard,
  type KanbanBoardResponse,
  type KanbanCard,
  type KanbanLane,
} from "./kanban-types";

const KANBAN_URL = "/api/kanban";
/** The cadence of the running-sessions poll in the sidebar; two open tabs converge within it. */
const KANBAN_POLL_MS = 2500;
/**
 * pi writes a session's file only after its first message, so a link to a
 * session that was just created may 404 for a moment: the write is re-posted a
 * few times before it counts as failed.
 */
const SESSION_MISSING_RETRIES = 3;
const SESSION_MISSING_RETRY_MS = 1500;

export type KanbanBoardStatus = "loading" | "ready" | "error";

export interface KanbanBoardStatusView {
  status: KanbanBoardStatus;
  error?: string;
  retry(): void;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

class KanbanRequestError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

async function requestJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { cache: "no-store", ...init });
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // Not JSON: reported below by status.
  }
  const body = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new KanbanRequestError(
      typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
      typeof body.code === "string" ? body.code : undefined,
    );
  }
  return body;
}

async function requestBoard(url: string, init?: RequestInit): Promise<KanbanBoardResponse> {
  const body = await requestJson(url, init);
  const board = body.board as KanbanBoard | undefined;
  if (!board || !Array.isArray(board.lanes) || !Array.isArray(board.cards) || typeof body.revision !== "number") {
    throw new KanbanRequestError("Unexpected kanban response");
  }
  return { board, revision: body.revision };
}

async function requestRevision(cwd: string): Promise<number> {
  const body = await requestJson(`${KANBAN_URL}?cwd=${encodeURIComponent(cwd)}&revOnly=1`);
  if (typeof body.revision !== "number") throw new KanbanRequestError("Unexpected kanban response");
  return body.revision;
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface PendingWrite {
  action: KanbanAction;
  now: number;
  attempts: number;
}

interface Entry {
  key: string;
  /** The board as the server last answered it. */
  serverBoard: KanbanBoard | null;
  /** `serverBoard` with `pending` applied: what components render. */
  board: KanbanBoard | null;
  revision: number | null;
  pending: PendingWrite[];
  /** Writes that failed on a session that did not exist yet: `retry()` posts them again. */
  retryable: KanbanAction[];
  error: string | null;
  errorSource: "load" | "write" | null;
  view: { status: KanbanBoardStatus; error?: string };
  fetching: Promise<void> | null;
  /** Bumped by every adopted write: a GET started before it must not overwrite it. */
  loadId: number;
  writeChain: Promise<void>;
  watchers: number;
  /** Watchers that may create the board file (the board view); 0 = read-only. */
  creatingWatchers: number;
  stopPolling: (() => void) | null;
}

const LOADING_VIEW: { status: KanbanBoardStatus; error?: string } = { status: "loading" };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let storeVersion = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  storeVersion += 1;
  for (const listener of listeners) listener();
}

function entryFor(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      key,
      serverBoard: null,
      board: null,
      revision: null,
      pending: [],
      retryable: [],
      error: null,
      errorSource: null,
      view: LOADING_VIEW,
      fetching: null,
      loadId: 0,
      writeChain: Promise.resolve(),
      watchers: 0,
      creatingWatchers: 0,
      stopPolling: null,
    };
    entries.set(key, entry);
  }
  return entry;
}

/** Recomputes what the entry shows (server board + pending writes, status) and tells the subscribers. */
function publish(entry: Entry): void {
  let board = entry.serverBoard;
  if (board) {
    for (const write of entry.pending) {
      board = applyKanbanAction(board, write.action, write.now) ?? board;
    }
  }
  entry.board = board;
  const status: KanbanBoardStatus = entry.error !== null ? "error" : entry.serverBoard ? "ready" : "loading";
  if (entry.view.status !== status || entry.view.error !== (entry.error ?? undefined)) {
    entry.view = entry.error !== null ? { status, error: entry.error } : { status };
  }
  notify();
}

function setError(entry: Entry, message: string, source: "load" | "write"): void {
  entry.error = message;
  entry.errorSource = source;
}

function clearError(entry: Entry): void {
  entry.error = null;
  entry.errorSource = null;
}

/** Takes the server's answer; an identical board keeps its object so nothing re-renders. */
function adopt(entry: Entry, answer: KanbanBoardResponse): void {
  const same = entry.serverBoard !== null && JSON.stringify(entry.serverBoard) === JSON.stringify(answer.board);
  if (!same) entry.serverBoard = answer.board;
  entry.revision = answer.revision;
}

/**
 * Fetches the whole board. One request per board at a time. `report`: a failure
 * is shown (the first load, a retry); a background refetch of a board already
 * shown stays quiet.
 */
function fetchBoard(entry: Entry, report: boolean): Promise<void> {
  if (entry.fetching) return entry.fetching;
  const loadId = entry.loadId;
  const run = async () => {
    try {
      // Only the board view creates the file; a strip/composer-only board reads empty.
      const answer = await requestBoard(`${KANBAN_URL}?cwd=${encodeURIComponent(entry.key)}${entry.creatingWatchers > 0 ? "" : "&create=0"}`);
      // A write adopted meanwhile — or one still pending, whose change this
      // answer may already contain — is newer than this answer.
      if ((loadId !== entry.loadId || entry.pending.length > 0) && entry.serverBoard) return;
      adopt(entry, answer);
      if (entry.errorSource === "load") clearError(entry);
      publish(entry);
    } catch (err) {
      if (report || !entry.serverBoard) {
        setError(entry, errorMessage(err), "load");
        publish(entry);
      }
    } finally {
      entry.fetching = null;
    }
  };
  entry.fetching = run();
  return entry.fetching;
}

/** The poll's step: one stat of the route, a full refetch only when the revision moved. */
async function pollRevision(entry: Entry): Promise<void> {
  if (!entry.serverBoard || entry.fetching || entry.pending.length > 0) return;
  try {
    const revision = await requestRevision(entry.key);
    if (revision === entry.revision || entry.fetching || entry.pending.length > 0) return;
    await fetchBoard(entry, false);
  } catch {
    // A missed tick is retried by the next one.
  }
}

function startPolling(entry: Entry): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    if (stopped || document.visibilityState !== "visible") return;
    timer = setTimeout(() => void tick(), KANBAN_POLL_MS);
  };
  const tick = async () => {
    if (stopped || document.visibilityState !== "visible") return;
    await pollRevision(entry);
    schedule();
  };
  // Hidden tabs skip the poll; coming back checks once straight away.
  const onVisible = () => {
    if (document.visibilityState !== "visible") {
      clear();
      return;
    }
    void pollRevision(entry);
    schedule();
  };
  document.addEventListener("visibilitychange", onVisible);
  schedule();
  entry.stopPolling = () => {
    stopped = true;
    clear();
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** A component starts watching a board: fetch it if needed and keep it fresh. Returns the release. */
function acquire(key: string, creating = false): () => void {
  const entry = entryFor(key);
  entry.watchers += 1;
  if (creating) entry.creatingWatchers += 1;
  if (entry.watchers === 1) startPolling(entry);
  if (!entry.serverBoard) {
    if (entry.error === null) void fetchBoard(entry, true);
  } else {
    // A cached board may be old: check it now rather than at the next tick.
    void pollRevision(entry);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.watchers -= 1;
    if (creating) entry.creatingWatchers -= 1;
    if (entry.watchers === 0) {
      entry.stopPolling?.();
      entry.stopPolling = null;
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWrite(entry: Entry, write: PendingWrite): Promise<void> {
  for (;;) {
    try {
      const answer = await requestBoard(KANBAN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: entry.key, ...write.action }),
      });
      entry.loadId += 1;
      adopt(entry, answer);
      entry.pending = entry.pending.filter((item) => item !== write);
      clearError(entry);
      publish(entry);
      return;
    } catch (err) {
      const code = err instanceof KanbanRequestError ? err.code : undefined;
      if (code === "session-missing" && write.attempts < SESSION_MISSING_RETRIES) {
        write.attempts += 1;
        await delay(SESSION_MISSING_RETRY_MS);
        continue;
      }
      // Roll back: the pending write goes, the board shows what the server holds.
      entry.pending = entry.pending.filter((item) => item !== write);
      if (code === "session-missing") entry.retryable.push(write.action);
      setError(entry, errorMessage(err), "write");
      publish(entry);
      // A request that never got an answer may still have landed: resync quietly.
      void fetchBoard(entry, false);
      return;
    }
  }
}

/** Applies one action optimistically and posts it; writes of a board go out one at a time, in order. */
function enqueue(entry: Entry, action: KanbanAction): void {
  const write: PendingWrite = { action, now: Date.now(), attempts: 0 };
  entry.pending = [...entry.pending, write];
  publish(entry);
  const run = () => runWrite(entry, write);
  entry.writeChain = entry.writeChain.then(run, run);
}

function retryBoard(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  const again = entry.retryable;
  entry.retryable = [];
  clearError(entry);
  publish(entry);
  for (const action of again) enqueue(entry, action);
  void fetchBoard(entry, true);
}

/**
 * The shared reducers are the validation: a refusal (null) never posts and
 * nothing changes. A board that is not loaded yet cannot be validated, so
 * nothing is done. Returns the optimistic board, or null when refused.
 */
function mutate(projectDir: string | null, action: KanbanAction): KanbanBoard | null {
  const entry = projectDir ? entries.get(projectDir) : undefined;
  if (!entry?.board) return null;
  const next = applyKanbanAction(entry.board, action, Date.now());
  if (!next) return null;
  // The same board back: nothing changed, nothing to post.
  if (next === entry.board) return next;
  enqueue(entry, action);
  return next;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useWatchBoard(projectDir: string | null, creating = false): void {
  useEffect(() => {
    if (!projectDir) return;
    return acquire(projectDir, creating);
  }, [projectDir, creating]);
}

/**
 * The board of a project directory, reactive. `null` while it loads (and for
 * no project). Watching it fetches it and keeps it fresh.
 */
export function useKanbanBoard(projectDir: string | null): KanbanBoard | null {
  useWatchBoard(projectDir, false);
  const getSnapshot = useCallback(() => (projectDir ? entries.get(projectDir)?.board ?? null : null), [projectDir]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

/** Whether the board is loading, shown, or failed — and `retry()` for the failed case. */
export function useKanbanBoardStatus(projectDir: string | null): KanbanBoardStatusView {
  useWatchBoard(projectDir, true);
  const getSnapshot = useCallback(() => (projectDir ? entries.get(projectDir)?.view ?? LOADING_VIEW : LOADING_VIEW), [projectDir]);
  const view = useSyncExternalStore(subscribe, getSnapshot, () => LOADING_VIEW);
  const retry = useCallback(() => {
    if (projectDir) retryBoard(projectDir);
  }, [projectDir]);
  return useMemo(() => ({ status: view.status, error: view.error, retry }), [view, retry]);
}

/** One tracked session's card, for rows that only need the lane and its position. */
export interface KanbanSessionInfo {
  laneName: string;
  /** Zero-based lane index. */
  index: number;
  total: number;
}

/**
 * Every session that has a card, in any board this tab has loaded: the
 * sidebar's tracked marker reads from it. Unchanged entries keep their
 * identity, so a board change re-renders only the rows whose marker moved.
 */
const lastIndex = new Map<string, KanbanSessionInfo>();
export function useKanbanSessionIndex(): Map<string, KanbanSessionInfo> {
  const version = useSyncExternalStore(subscribe, () => storeVersion, () => 0);
  return useMemo(() => {
    void version;
    const boards = [...entries.values()].flatMap((entry) => (entry.board ? [entry.board] : []));
    // Mutated in place (never reassigned): unchanged entries keep their
    // identity, so a board change re-renders only the rows whose marker moved.
    for (const [key] of lastIndex) {
      if (!boards.some((board) => board.cards.some((card) => card.sessionId === key))) lastIndex.delete(key);
    }
    for (const board of boards) {
      for (const card of board.cards) {
        if (!card.sessionId) continue;
        const laneIdx = board.lanes.findIndex((lane) => lane.id === card.laneId);
        const lane = board.lanes[laneIdx];
        if (laneIdx < 0 || !lane) continue;
        const previous = lastIndex.get(card.sessionId);
        if (previous && previous.laneName === lane.name && previous.index === laneIdx && previous.total === board.lanes.length) continue;
        lastIndex.set(card.sessionId, { laneName: lane.name, index: laneIdx, total: board.lanes.length });
      }
    }
    return lastIndex;
  }, [version]);
}

// ---------------------------------------------------------------------------
// Actions (the components' only way in; every one is a no-op on missing or refused input)
// ---------------------------------------------------------------------------

export function kanbanAddLane(projectDir: string | null, name: string, description = ""): void {
  mutate(projectDir, { action: "add-lane", name, description, laneId: makeKanbanId() });
}
export function kanbanRenameLane(projectDir: string | null, laneId: string, name: string): void {
  mutate(projectDir, { action: "rename-lane", laneId, name });
}
export function kanbanMoveLane(projectDir: string | null, laneId: string, direction: -1 | 1): void {
  mutate(projectDir, { action: "move-lane", laneId, direction });
}
export function kanbanDeleteLane(projectDir: string | null, laneId: string): void {
  mutate(projectDir, { action: "delete-lane", laneId });
}
export function kanbanAddCard(
  projectDir: string | null,
  laneId: string,
  input: { title: string; description?: string; sessionId?: string | null; sessionTitle?: string | null },
): KanbanCard | null {
  const cardId = makeKanbanId();
  const next = mutate(projectDir, { action: "add-card", laneId, ...input, cardId });
  return next?.cards.find((card) => card.id === cardId) ?? null;
}
export function kanbanUpdateCard(projectDir: string | null, cardId: string, patch: { title?: string; description?: string }): void {
  mutate(projectDir, { action: "edit-card", cardId, ...patch });
}
export function kanbanDeleteCard(projectDir: string | null, cardId: string): void {
  mutate(projectDir, { action: "delete-card", cardId });
}
export function kanbanLinkCard(projectDir: string | null, cardId: string, sessionId: string, sessionTitle: string): void {
  mutate(projectDir, { action: "link-session", cardId, sessionId, sessionTitle });
}
export function kanbanUnlinkCard(projectDir: string | null, cardId: string): void {
  mutate(projectDir, { action: "unlink-session", cardId });
}
/** The model's decision: the card's stage is done, it moves to the next lane. Null when refused. */
export function kanbanAdvanceCard(projectDir: string | null, cardId: string): KanbanLane | null {
  const next = mutate(projectDir, { action: "advance-card", cardId });
  const card = next?.cards.find((c) => c.id === cardId);
  return next && card ? laneById(next, card.laneId) : null;
}
/**
 * A session that started "tracked on board": a new card for it in the lane the
 * composer picked. A board not loaded yet cannot be validated locally, so the
 * request goes straight to the server, which holds the rules.
 */
export function kanbanCreateCardForSession(projectDir: string | null, sessionId: string, sessionTitle: string, laneId: string | null): void {
  if (!projectDir) return;
  const action: KanbanAction = { action: "create-card-for-session", sessionId, sessionTitle, laneId, cardId: makeKanbanId() };
  const entry = entries.get(projectDir);
  if (entry?.board) {
    mutate(projectDir, action);
    return;
  }
  enqueue(entryFor(projectDir), action);
}

/**
 * The watch lifecycle the useWatchBoard hook drives: the first watcher on a
 * board starts its revision poll, the last one stops it, and a re-acquire on
 * a cached board checks now. Exported so node tests can drive it without a
 * renderer (same pattern as the store's resetKanbanStateForTests).
 */
export function acquireBoardWatcherForTests(key: string, creating = false): () => void {
  return acquire(key, creating);
}

/**
 * The board a `useKanbanBoard` subscriber would see, without a renderer:
 * `adopt` keeps the old object when a refetch's JSON is identical, so this
 * reference is stable across an unchanged poll — export it so node tests can
 * pin that rule (the store's resetKanbanStateForTests pattern).
 */
export function kanbanBoardSnapshotForTests(projectDir: string): KanbanBoard | null {
  return entries.get(projectDir)?.board ?? null;
}

/**
 * The banner's Retry, without a renderer: re-enqueues the entry's `retryable`
 * writes (the session-missing failures), clears the error and refetches.
 * Exported so node tests can pin that a Retry re-posts rather than drops
 * (the store's resetKanbanStateForTests pattern).
 */
export function retryBoardForTests(key: string): void {
  retryBoard(key);
}
