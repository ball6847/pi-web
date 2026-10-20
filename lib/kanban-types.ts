/**
 * Client-safe types and constants of the kanban domain: one board per project,
 * stored server-side under pi's shared agent storage
 * (`<agentDir>/kanban/<encoded-project-root>/kanban.json`, `lib/kanban-store.ts`).
 * No node: imports here; the rules live in `lib/kanban-shared.ts`.
 */

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
  /** Display name of the session, snapshotted at link time and kept after an unlink. */
  sessionTitle: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface KanbanBoard {
  projectDir: string;
  lanes: KanbanLane[];
  cards: KanbanCard[];
}

export const KANBAN_SCHEMA_VERSION = 1;

/** What the board's shared `kanban.json` holds. */
export interface KanbanEnvelope {
  schemaVersion: typeof KANBAN_SCHEMA_VERSION;
  board: KanbanBoard;
}

/** The id of the fixed first lane of every board. */
export const KANBAN_BACKLOG_LANE_ID = "lane-backlog";

/**
 * What a fresh composer's session will do on the board once it exists: nothing,
 * a new card in a lane, or a link onto an existing sessionless card. The
 * composer's "Track on board" control picks it, and the board card menu's
 * "Start session" pre-picks the attach form, so both directions meet in this
 * one control. Before the session exists it is only a plan; the shell applies
 * it when pi answers with the real session id.
 */
export type KanbanNewSessionPick =
  | { kind: "off" }
  | { kind: "new-card"; laneId: string }
  | { kind: "attach"; cardId: string; cardTitle: string };

/** A pick held by the shell, pinned to the board (project root) it was made for. */
export type KanbanNewSessionPending =
  | { kind: "off" }
  | { kind: "new-card"; projectDir: string; laneId: string }
  | { kind: "attach"; projectDir: string; cardId: string; cardTitle: string };

export const KANBAN_OFF_PENDING: KanbanNewSessionPending = { kind: "off" };

export function makeKanbanId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `kb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultLanes(): KanbanLane[] {
  return [
    { id: KANBAN_BACKLOG_LANE_ID, name: "Backlog", description: "Waiting work, no session yet", fixed: true },
    { id: "lane-todo", name: "Todo", description: "Ready to start" },
    { id: "lane-plan", name: "Plan", description: "Planned" },
    { id: "lane-implement", name: "Implement", description: "In progress" },
    { id: "lane-deploy", name: "Deploy", description: "Shipping" },
    { id: "lane-done", name: "Done", description: "Finished" },
  ];
}

/**
 * One board mutation, as the route's POST body carries it (minus `cwd`). The
 * optional `cardId` / `laneId` on the creating actions let a client pick the
 * id, so an optimistic card and the server's card agree.
 */
export type KanbanAction =
  | { action: "add-card"; laneId: string; title: string; description?: string; sessionId?: string | null; sessionTitle?: string | null; cardId?: string }
  | { action: "edit-card"; cardId: string; title?: string; description?: string }
  | { action: "delete-card"; cardId: string }
  | { action: "move-card"; cardId: string; laneId: string; beforeCardId?: string | null }
  | { action: "advance-card"; cardId: string }
  | { action: "link-session"; cardId: string; sessionId: string; sessionTitle: string }
  | { action: "unlink-session"; cardId: string }
  | { action: "create-card-for-session"; sessionId: string; sessionTitle: string; laneId: string | null; cardId?: string }
  | { action: "add-lane"; name: string; description?: string; laneId?: string }
  | { action: "rename-lane"; laneId: string; name: string }
  | { action: "move-lane"; laneId: string; direction: -1 | 1 }
  | { action: "reorder-lane"; laneId: string; toIndex: number }
  | { action: "delete-lane"; laneId: string };

export type KanbanActionName = KanbanAction["action"];

export const KANBAN_ACTION_NAMES: readonly KanbanActionName[] = [
  "add-card",
  "edit-card",
  "delete-card",
  "move-card",
  "advance-card",
  "link-session",
  "unlink-session",
  "create-card-for-session",
  "add-lane",
  "rename-lane",
  "move-lane",
  "reorder-lane",
  "delete-lane",
];

/** The route's answer to a read and to every successful mutation. */
export interface KanbanBoardResponse {
  board: KanbanBoard;
  revision: number;
}
