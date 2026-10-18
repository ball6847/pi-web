/**
 * In-memory kanban board mock — UI design phase.
 *
 * One board per project directory. The first lane is always the fixed
 * "backlog": its cards hold a title and a description only, never a pi
 * session. The lanes after it hold work the model takes on; a card moves to
 * the next lane only when the model decides the current stage is done — the
 * user never moves a card by hand. Cards can be linked to, and unlinked
 * from, a pi session at any time (a card in backlog and a card whose session
 * was unlinked are simply sessionless).
 *
 * State lives in this browser tab only (localStorage), so a refresh resumes
 * where the demo left off; nothing here talks to the server. Boards are
 * created on demand for every project, seeded with sample cards; the seeded
 * cards are offered the project's real pi sessions once, so a preview shows
 * the board, the chat strip and the sidebar speaking about the same work.
 */

import { useMemo, useSyncExternalStore } from "react";

export interface KanbanLane {
  id: string;
  name: string;
  description: string;
  /** The first lane, "backlog": never renamed, moved or removed. */
  fixed?: boolean;
}

export interface KanbanCard {
  id: string;
  title: string;
  description: string;
  laneId: string;
  /** The linked pi session id, or null for a sessionless card. */
  sessionId: string | null;
  /** Display name of the linked session, snapshotted at link time. */
  sessionTitle: string | null;
  /** One of the seeded sample cards: offered the project's real sessions once. */
  seeded?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface KanbanBoard {
  projectDir: string;
  lanes: KanbanLane[];
  cards: KanbanCard[];
  /** Set once the seeded cards have been offered the project's real sessions. */
  seedSynced: boolean;
}

const STORAGE_KEY = "pi-web:kanban-mock:v1";

type Boards = Record<string, KanbanBoard>;

export function makeKanbanId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `kb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultLanes(): KanbanLane[] {
  return [
    { id: "lane-backlog", name: "Backlog", description: "Waiting work, no session yet", fixed: true },
    { id: "lane-todo", name: "Todo", description: "Ready to start" },
    { id: "lane-plan", name: "Plan", description: "Planned" },
    { id: "lane-implement", name: "Implement", description: "In progress" },
    { id: "lane-deploy", name: "Deploy", description: "Shipping" },
    { id: "lane-done", name: "Done", description: "Finished" },
  ];
}

/**
 * The sample cards of a fresh board. Ids are deterministic (no clock, no
 * random) so a server render and the first client render of the same project
 * agree; a card id only has to be unique within its board. The titles are
 * deliberately project-neutral: a board exists for every project, and showing
 * one project's real work items in another reads as a bug.
 */
function seedCards(): KanbanCard[] {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const card = (
    index: number,
    laneId: string,
    title: string,
    description: string,
    ageDays: number,
    seeded = false,
  ): KanbanCard => ({
    id: `kb-seed-${index}`,
    title,
    description,
    laneId,
    sessionId: null,
    sessionTitle: null,
    ...(seeded ? { seeded: true } : {}),
    createdAt: now - ageDays * day,
    updatedAt: now - ageDays * day,
  });
  return [
    card(0, "lane-backlog", "Write release notes for the next tag", "Collect the changes since the last release into the notes.", 6),
    card(1, "lane-backlog", "Investigate the flaky tests", "A couple of suites fail only on rerun; find the shared state.", 5),
    card(2, "lane-todo", "Refactor the build scripts", "The same steps are duplicated across environments.", 4, true),
    card(3, "lane-todo", "Speed up the slowest startup path", "Profiling points at one heavy import.", 3, true),
    card(4, "lane-plan", "Draft the next milestone", "Scope the work that lands after this release.", 3),
    card(5, "lane-implement", "Replace ad-hoc logging with structured logs", "Errors are hard to follow across the stack.", 2),
    card(6, "lane-deploy", "Roll out the new toolchain", "Wait for the upstream change to land, then flip the switch.", 1),
    card(7, "lane-done", "Tidy the README", "Move stale notes into the docs folder.", 1),
  ];
}

/** A fresh board for a project: the fixed backlog, the sample lanes, the sample cards. */
export function seedBoard(projectDir: string): KanbanBoard {
  return {
    projectDir,
    lanes: defaultLanes(),
    cards: seedCards(),
    seedSynced: false,
  };
}

/** The mock enables a board for every project. */
export function boardExists(projectDir: string | null): boolean {
  return projectDir !== null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface Snapshot {
  version: number;
  boards: Boards;
}

class KanbanMockStore {
  private boards: Boards;
  private version = 0;
  private listeners = new Set<() => void>();
  private snapshot: Snapshot;
  /** Deterministic seeds, so a board never saved yet renders identically on server and client. */
  private seeds = new Map<string, KanbanBoard>();

  constructor() {
    this.boards = this.load();
    this.snapshot = { version: 0, boards: this.boards };
  }

  private load(): Boards {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Boards;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private commit(): void {
    this.version += 1;
    this.snapshot = { version: this.version, boards: this.boards };
    for (const listener of this.listeners) listener();
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.boards));
    } catch {
      // A full or blocked storage only loses persistence, never the view.
    }
  }

  /** The saved board, or its deterministic seed (the seed is cached for a stable identity). */
  board(projectDir: string | null): KanbanBoard | null {
    if (!projectDir) return null;
    const saved = this.boards[projectDir];
    if (saved) return saved;
    let seeded = this.seeds.get(projectDir);
    if (!seeded) {
      seeded = seedBoard(projectDir);
      this.seeds.set(projectDir, seeded);
    }
    return seeded;
  }

  /** Materialise the seed in the saved boards (post-hydration; no bump if already saved). */
  ensure(projectDir: string | null): void {
    if (!projectDir || this.boards[projectDir]) return;
    this.seeds.delete(projectDir);
    this.boards[projectDir] = seedBoard(projectDir);
    this.commit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  /**
   * SSR and hydration render the seed view; the saved boards follow after
   * hydration. A stable reference: `useSyncExternalStore` requires the server
   * snapshot to be cached, else it warns "should be cached to avoid an
   * infinite loop" and re-renders forever.
   */
  private static readonly serverSnapshot: Snapshot = { version: 0, boards: {} };

  getServerSnapshot = (): Snapshot => KanbanMockStore.serverSnapshot;

  // -- lanes ---------------------------------------------------------------

  addLane(projectDir: string | null, name: string, description = ""): void {
    const trimmed = name.trim();
    if (!projectDir || !trimmed) return;
    if (!projectDir) return;
    const dir = projectDir;
    this.ensure(dir);
    const target = this.boards[dir];
    if (!target) return;
    target.lanes.push({ id: makeKanbanId(), name: trimmed, description: description.trim() });
    this.commit();
  }

  renameLane(projectDir: string | null, laneId: string, name: string): void {
    const trimmed = name.trim();
    if (!projectDir || !trimmed) return;
    if (!projectDir) return;
    const dir = projectDir;
    this.ensure(dir);
    const lane = this.boards[dir]?.lanes.find((l) => l.id === laneId);
    if (!lane || lane.fixed || lane.name === trimmed) return;
    lane.name = trimmed;
    this.commit();
  }

  moveLane(projectDir: string | null, laneId: string, direction: -1 | 1): void {
    if (!projectDir) return;
    const dir = projectDir;
    this.ensure(dir);
    const board = this.boards[dir];
    if (!board) return;
    const index = board.lanes.findIndex((l) => l.id === laneId);
    const target = index + direction;
    const lane = board.lanes[index];
    if (index < 0 || target < 0 || target >= board.lanes.length || !lane || lane.fixed || board.lanes[target]?.fixed) return;
    board.lanes.splice(index, 1);
    board.lanes.splice(target, 0, lane);
    this.commit();
  }

  /** A lane with cards, or the fixed backlog, cannot go: the cards have nowhere to be. */
  deleteLane(projectDir: string | null, laneId: string): void {
    if (!projectDir) return;
    const dir = projectDir;
    this.ensure(dir);
    const board = this.boards[dir];
    if (!board) return;
    const index = board.lanes.findIndex((l) => l.id === laneId);
    const lane = board.lanes[index];
    if (index < 0 || !lane || lane.fixed) return;
    if (board.cards.some((c) => c.laneId === laneId)) return;
    board.lanes.splice(index, 1);
    this.commit();
  }

  // -- cards ---------------------------------------------------------------

  addCard(
    projectDir: string | null,
    laneId: string,
    input: { title: string; description?: string; sessionId?: string | null; sessionTitle?: string | null },
  ): KanbanCard | null {
    const title = input.title.trim();
    if (!projectDir || !title) return null;
    const dir = projectDir;
    this.ensure(dir);
    const board = this.boards[dir];
    if (!board || !board.lanes.some((l) => l.id === laneId)) return null;
    const now = Date.now();
    const card: KanbanCard = {
      id: makeKanbanId(),
      title,
      description: (input.description ?? "").trim(),
      laneId,
      sessionId: input.sessionId ?? null,
      sessionTitle: input.sessionTitle ?? null,
      createdAt: now,
      updatedAt: now,
    };
    board.cards.push(card);
    this.commit();
    return card;
  }

  updateCard(projectDir: string | null, cardId: string, patch: { title?: string; description?: string }): void {
    if (!projectDir) return;
    const dir = projectDir;
    this.ensure(dir);
    const card = this.boards[dir]?.cards.find((c) => c.id === cardId);
    if (!card) return;
    let changed = false;
    const title = patch.title?.trim();
    if (title !== undefined && title && title !== card.title) {
      card.title = title;
      changed = true;
    }
    if (patch.description !== undefined) {
      const description = patch.description.trim();
      if (description !== card.description) {
        card.description = description;
        changed = true;
      }
    }
    if (!changed) return;
    card.updatedAt = Date.now();
    this.commit();
  }

  deleteCard(projectDir: string | null, cardId: string): void {
    if (!projectDir) return;
    const dir = projectDir;
    this.ensure(dir);
    const board = this.boards[dir];
    if (!board) return;
    const index = board.cards.findIndex((c) => c.id === cardId);
    if (index < 0) return;
    board.cards.splice(index, 1);
    this.commit();
  }

  linkCard(projectDir: string | null, cardId: string, sessionId: string, sessionTitle: string): void {
    if (!projectDir) return;
    const dir = projectDir;
    this.ensure(dir);
    const board = this.boards[dir];
    if (!board) return;
    // One session, one card: the session's existing card elsewhere drops the link.
    for (const card of board.cards) {
      if (card.sessionId === sessionId) {
        card.sessionId = null;
        card.sessionTitle = null;
      }
    }
    const card = board.cards.find((c) => c.id === cardId);
    if (!card) return;
    // The backlog never takes a session.
    if (board.lanes.find((l) => l.id === card.laneId)?.fixed) return;
    card.sessionId = sessionId;
    card.sessionTitle = sessionTitle;
    card.updatedAt = Date.now();
    this.commit();
  }

  unlinkCard(projectDir: string | null, cardId: string): void {
    if (!projectDir) return;
    const dir = projectDir;
    this.ensure(dir);
    const card = this.boards[dir]?.cards.find((c) => c.id === cardId);
    if (!card || card.sessionId === null) return;
    card.sessionId = null;
    card.sessionTitle = null;
    card.updatedAt = Date.now();
    this.commit();
  }

  /** The model's decision: the card's stage is done, it moves to the next lane. */
  advanceCard(projectDir: string | null, cardId: string): KanbanLane | null {
    if (!projectDir) return null;
    const dir = projectDir;
    this.ensure(dir);
    const board = this.boards[dir];
    if (!board) return null;
    const card = board.cards.find((c) => c.id === cardId);
    if (!card) return null;
    const index = board.lanes.findIndex((l) => l.id === card.laneId);
    const next = board.lanes[index + 1];
    if (index < 0 || !next) return null;
    card.laneId = next.id;
    card.updatedAt = Date.now();
    this.commit();
    return next;
  }

  /**
   * A session that started "tracked on board": a new card for it in the lane
   * the composer picked (falling back to the first lane that takes sessions).
   */
  createCardForSession(
    projectDir: string | null,
    sessionId: string,
    sessionTitle: string,
    laneId: string | null,
  ): void {
    if (!projectDir) return;
    const dir = projectDir;
    this.ensure(dir);
    const board = this.boards[dir];
    if (!board) return;
    // One session, one card: replace whatever card carries it.
    const existing = board.cards.find((c) => c.sessionId === sessionId);
    if (existing) {
      existing.sessionTitle = sessionTitle;
      existing.updatedAt = Date.now();
      this.commit();
      return;
    }
    const wanted = laneId ? board.lanes.find((l) => l.id === laneId && !l.fixed) : null;
    const lane = wanted ?? board.lanes.find((l) => !l.fixed) ?? null;
    if (!lane) return;
    this.addCard(projectDir, lane.id, { title: sessionTitle, sessionId, sessionTitle });
  }

  /**
   * Offer the seeded, sessionless cards the project's real pi sessions, once.
   * After a user unlinks a seeded card it stays unlinked: the sync never
   * re-attaches work the user took off the board.
   */
  syncSeedLinks(projectDir: string | null, sessions: Array<{ id: string; title: string }>): void {
    if (!projectDir) return;
    const dir = projectDir;
    this.ensure(dir);
    const board = this.boards[dir];
    if (!board || board.seedSynced) return;
    const linkedIds = new Set(board.cards.map((c) => c.sessionId).filter((id): id is string => id !== null));
    let offered = 0;
    for (const card of board.cards) {
      if (!card.seeded || card.sessionId) continue;
      const session = sessions.find((s) => !linkedIds.has(s.id));
      if (!session) break;
      card.sessionId = session.id;
      card.sessionTitle = session.title;
      linkedIds.add(session.id);
      offered += 1;
      if (offered >= 2) break;
    }
    // Only a board whose seed actually took a session is synced: with zero
    // real sessions the seeded cards must stay eligible for the next time.
    if (offered > 0) {
      board.seedSynced = true;
      this.commit();
    }
  }
}

let instance: KanbanMockStore | null = null;
function store(): KanbanMockStore {
  instance ??= new KanbanMockStore();
  return instance;
}

/** Subscribe to every board in this tab; the snapshot's version bumps on any mutation. */
export function subscribeToKanban(listener: () => void): () => void {
  return store().subscribe(listener);
}

/**
 * The board of a project directory, reactive. `null` for no project. A board
 * never saved in this browser renders its deterministic seed, so a server
 * render and the first client render of the same project agree.
 */
export function useKanbanBoard(projectDir: string | null): KanbanBoard | null {
  const s = store();
  const snapshot = useSyncExternalStore(s.subscribe, s.getSnapshot, s.getServerSnapshot);
  void snapshot;
  return s.board(projectDir);
}

/** One tracked session's card, for rows that only need the lane and its position. */
export interface KanbanSessionInfo {
  laneName: string;
  /** Zero-based lane index. */
  index: number;
  total: number;
}

/**
 * Every session that has a card, in any board of this tab: the sidebar's
 * tracked marker reads from it. Built from the saved boards only (a board no
 * one touched is its seed, and its seeded links are saved the moment the sync
 * offers them real sessions). Unchanged entries keep their identity, so a
 * board change re-renders only the rows whose marker actually moved.
 */
const lastIndex = new Map<string, KanbanSessionInfo>();
export function useKanbanSessionIndex(): Map<string, KanbanSessionInfo> {
  const s = store();
  const snapshot = useSyncExternalStore(s.subscribe, s.getSnapshot, s.getServerSnapshot);
  return useMemo(() => {
    // Mutated in place (never reassigned): unchanged entries keep their
    // identity, so a board change re-renders only the rows whose marker moved.
    for (const [key] of lastIndex) if (!Object.values(snapshot.boards).some((board) => board.cards.some((card) => card.sessionId === key))) lastIndex.delete(key);
    for (const board of Object.values(snapshot.boards)) {
      if (!board.seedSynced) continue;
      for (const card of board.cards) {
        if (!card.sessionId) continue;
        const laneIndex = board.lanes.findIndex((lane) => lane.id === card.laneId);
        const lane = board.lanes[laneIndex];
        if (laneIndex < 0 || !lane) continue;
        const previous = lastIndex.get(card.sessionId);
        if (previous && previous.laneName === lane.name && previous.index === laneIndex && previous.total === board.lanes.length) continue;
        lastIndex.set(card.sessionId, { laneName: lane.name, index: laneIndex, total: board.lanes.length });
      }
    }
    return lastIndex;
  }, [snapshot.boards]);
}

// ---------------------------------------------------------------------------
// Actions (the components' only way in; every one is a no-op on missing input)
// ---------------------------------------------------------------------------

export function kanbanEnsure(projectDir: string | null): void { store().ensure(projectDir); }
export function kanbanAddLane(projectDir: string | null, name: string, description = ""): void { store().addLane(projectDir, name, description); }
export function kanbanRenameLane(projectDir: string | null, laneId: string, name: string): void { store().renameLane(projectDir, laneId, name); }
export function kanbanMoveLane(projectDir: string | null, laneId: string, direction: -1 | 1): void { store().moveLane(projectDir, laneId, direction); }
export function kanbanDeleteLane(projectDir: string | null, laneId: string): void { store().deleteLane(projectDir, laneId); }
export function kanbanAddCard(projectDir: string | null, laneId: string, input: { title: string; description?: string; sessionId?: string | null; sessionTitle?: string | null }): KanbanCard | null {
  return store().addCard(projectDir, laneId, input);
}
export function kanbanUpdateCard(projectDir: string | null, cardId: string, patch: { title?: string; description?: string }): void { store().updateCard(projectDir, cardId, patch); }
export function kanbanDeleteCard(projectDir: string | null, cardId: string): void { store().deleteCard(projectDir, cardId); }
export function kanbanLinkCard(projectDir: string | null, cardId: string, sessionId: string, sessionTitle: string): void { store().linkCard(projectDir, cardId, sessionId, sessionTitle); }
export function kanbanUnlinkCard(projectDir: string | null, cardId: string): void { store().unlinkCard(projectDir, cardId); }
export function kanbanAdvanceCard(projectDir: string | null, cardId: string): KanbanLane | null { return store().advanceCard(projectDir, cardId); }
export function kanbanCreateCardForSession(projectDir: string | null, sessionId: string, sessionTitle: string, laneId: string | null): void {
  store().createCardForSession(projectDir, sessionId, sessionTitle, laneId);
}
export function kanbanSyncSeedLinks(projectDir: string | null, sessions: Array<{ id: string; title: string }>): void {
  store().syncSeedLinks(projectDir, sessions);
}

// ---------------------------------------------------------------------------
// Read helpers (pure; take a board)
// ---------------------------------------------------------------------------

export function laneById(board: KanbanBoard, laneId: string | null): KanbanLane | null {
  if (!laneId) return null;
  return board.lanes.find((lane) => lane.id === laneId) ?? null;
}

export function laneIndex(board: KanbanBoard, laneId: string): number {
  return board.lanes.findIndex((lane) => lane.id === laneId);
}

export function cardsOfLane(board: KanbanBoard, laneId: string): KanbanCard[] {
  return board.cards.filter((card) => card.laneId === laneId);
}

export function cardForSession(board: KanbanBoard, sessionId: string | null): KanbanCard | null {
  if (!sessionId) return null;
  return board.cards.find((card) => card.sessionId === sessionId) ?? null;
}

export function firstWorkLane(board: KanbanBoard): KanbanLane | null {
  return board.lanes.find((lane) => !lane.fixed) ?? null;
}

/** The lane a card sits in, for views that only need the name and position. */
export function cardLaneOf(board: KanbanBoard, card: KanbanCard | null): KanbanLane | null {
  return card ? laneById(board, card.laneId) : null;
}
