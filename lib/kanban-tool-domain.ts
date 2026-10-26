import { cardForSession, moveCardToLane } from "./kanban-shared";
import { cardMatchesQuery, kanbanDescriptionExcerpt } from "./kanban-search";
import { KANBAN_CARD_EXCERPT_BUDGET, KANBAN_SEARCH_DEFAULT_LIMIT, KANBAN_SEARCH_MAX_LIMIT } from "./kanban-tool-limits";
import type { KanbanFailureCode } from "./kanban-store";
import type { KanbanBoard, KanbanCard, KanbanLane } from "./kanban-types";

/** Agent requests are deliberately separate from the browser's link-stealing actions. */
export type KanbanToolRequest =
  | { action: "read"; cardId?: string }
  | { action: "search"; query?: string; laneId?: string; limit?: number }
  | { action: "create"; title: string; description?: string; laneId?: string }
  | { action: "update"; cardId?: string; title?: string; description?: string; laneId?: string };
export type KanbanToolSearch = Extract<KanbanToolRequest, { action: "search" }>;
export type KanbanToolMutation = Exclude<KanbanToolRequest, { action: "read" | "search" }>;
export type KanbanToolActor = { sessionId: string; sessionTitle?: string | null };
export type KanbanToolFailure = { ok: false; code: KanbanFailureCode | "invalid-request" | "read-only"; error: string };
// Mapped data types also satisfy Pi's JsonValue contract (interfaces have no index signature).
type CardData = { [K in keyof KanbanCard]: KanbanCard[K] };
type LaneData = { [K in keyof KanbanLane]: KanbanLane[K] };
/** A lane without its cards: enough to choose one, cheap enough to always send. */
export type KanbanLaneOverviewData = { id: string; name: string; description: string; fixed?: boolean; cardCount: number };
/** One search hit: no id-less body, just the field a model picks a card with. */
export type KanbanCardSummaryData = { id: string; title: string; laneId: string; linked?: true; excerpt: string };
export type KanbanToolResult = KanbanToolFailure | {
  ok: true;
  action: "read";
  projectDir: string;
  lanes: KanbanLaneOverviewData[];
  totalCards: number;
  currentCard: CardData | null;
  revision: number;
} | {
  ok: true;
  action: "read";
  projectDir: string;
  card: CardData;
  lane: LaneData;
  nextLaneId: string | null;
  currentCardId: string | null;
  revision: number;
} | {
  ok: true;
  action: "search";
  projectDir: string;
  lanes: Array<{ id: string; name: string; cardCount: number }>;
  cards: KanbanCardSummaryData[];
  matched: number;
  total: number;
  hasMore: boolean;
  hint?: string;
  currentCardId: string | null;
  revision: number;
} | {
  ok: true;
  action: "create" | "update";
  card: CardData;
  lane: LaneData;
  nextLaneId: string | null;
  currentCardId: string | null;
  revision: number;
};

const REQUEST_KEYS = {
  read: ["action", "cardId"],
  search: ["action", "query", "laneId", "limit"],
  create: ["action", "title", "description", "laneId"],
  update: ["action", "cardId", "title", "description", "laneId"],
} as const;

/** Do not trust SDK validation alone: nested/programmatic callers must obey the same contract. */
export function parseKanbanToolRequest(input: unknown): { ok: true; request: KanbanToolRequest } | KanbanToolFailure {
  const invalid = (error: string): KanbanToolFailure => ({ ok: false, code: "invalid-request", error });
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("kanban expects an object with action read, search, create, or update.");
  const raw = input as Record<string, unknown>;
  const action = raw.action;
  if (action !== "read" && action !== "search" && action !== "create" && action !== "update") {
    return invalid("action must be read, search, create, or update.");
  }
  const keys: readonly string[] = REQUEST_KEYS[action];
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) return invalid(`Unknown field "${key}" for kanban ${action}. Allowed fields: ${keys.join(", ")}.`);
  }
  if (action === "search") {
    for (const key of ["query", "laneId"] as const) {
      if (raw[key] === undefined) continue;
      if (typeof raw[key] !== "string" || (key === "laneId" && !(raw[key] as string).trim())) {
        return invalid(`${key} must be ${key === "laneId" ? "a nonblank string" : "a string (empty matches every card)"}.`);
      }
    }
    if (raw.limit !== undefined && (typeof raw.limit !== "number" || !Number.isInteger(raw.limit)
      || raw.limit < 1 || raw.limit > KANBAN_SEARCH_MAX_LIMIT)) {
      return invalid(`limit must be a whole number from 1 to ${KANBAN_SEARCH_MAX_LIMIT}. Narrow with query or laneId instead.`);
    }
    return { ok: true, request: { ...raw } as KanbanToolSearch };
  }
  for (const key of Object.keys(raw)) {
    if (key !== "action" && (typeof raw[key] !== "string" || (key !== "description" && !(raw[key] as string).trim()))) {
      return invalid(`${key} must be ${key === "description" ? "a string (empty clears it)" : "a nonblank string"}.`);
    }
  }
  if (action === "create" && typeof raw.title !== "string") return invalid("create requires a nonblank title.");
  if (action === "update" && !["title", "description", "laneId"].some((key) => Object.hasOwn(raw, key))) {
    return invalid("update requires at least one of title, description, or laneId.");
  }
  return { ok: true, request: { ...raw } as KanbanToolRequest };
}

function refused(error: string): KanbanToolFailure & { code: "refused" } {
  return { ok: false, code: "refused", error };
}

/** Pure guarded patch/claim/move. The caller supplies identity/time; never silently drops another link. */
export function applyKanbanToolMutation(
  board: KanbanBoard,
  request: KanbanToolMutation,
  actor: KanbanToolActor,
  now: number,
  newCardId: string,
): { ok: true; board: KanbanBoard; cardId: string } | (KanbanToolFailure & { code: "refused" }) {
  const current = cardForSession(board, actor.sessionId);
  if (request.action === "create") {
    const lane = request.laneId === undefined ? board.lanes[0] : board.lanes.find((l) => l.id === request.laneId);
    if (!lane) return refused("Lane not found. Use kanban read to discover the current lane IDs.");
    if (!lane.fixed && current) return refused(`This session already owns card "${current.id}". Update it, or create an independent task in Backlog.`);
    if (board.cards.some((c) => c.id === newCardId)) return refused("The new card ID already exists. Read the board before trying again.");
    const card: KanbanCard = {
      id: newCardId, title: request.title.trim(), description: (request.description ?? "").trim(), laneId: lane.id,
      sessionId: lane.fixed ? null : actor.sessionId,
      sessionTitle: lane.fixed ? null : actor.sessionTitle ?? actor.sessionId,
      createdAt: now, updatedAt: now,
    };
    return { ok: true, board: { ...board, cards: [...board.cards, card] }, cardId: card.id };
  }
  const card = request.cardId === undefined ? current : board.cards.find((c) => c.id === request.cardId);
  if (!card) return refused(request.cardId === undefined
    ? "This session has no linked card. Read the board, then specify cardId and a work laneId to claim a free card."
    : "Card not found in this project's board. Use kanban read to discover current card IDs.");
  if (card.sessionId !== null && card.sessionId !== actor.sessionId) return refused(`Card "${card.id}" belongs to another session. Choose an unlinked card; links cannot be stolen.`);
  const lane = board.lanes.find((l) => l.id === (request.laneId ?? card.laneId));
  if (!lane) return refused("Lane not found. Use kanban read to discover the current lane IDs.");
  if (lane.fixed && card.sessionId !== null) return refused("A linked card cannot enter Backlog. Keep it in a work lane; create independent tasks in Backlog.");
  const claiming = request.laneId !== undefined && !lane.fixed && card.sessionId === null;
  if (claiming && current) return refused(`This session already owns card "${current.id}". Update that card instead of claiming another.`);
  const title = request.title === undefined ? card.title : request.title.trim();
  const description = request.description === undefined ? card.description : request.description.trim();
  let next = board;
  if (claiming || title !== card.title || description !== card.description) {
    const patched: KanbanCard = { ...card, title, description, updatedAt: now };
    if (claiming) {
      patched.sessionId = actor.sessionId;
      patched.sessionTitle = actor.sessionTitle ?? actor.sessionId;
    }
    next = { ...board, cards: board.cards.map((c) => c.id === card.id ? patched : c) };
  }
  // The browser mover's default is "end of lane"; never call it for same-lane retries.
  if (lane.id !== card.laneId) {
    const moved = moveCardToLane(next, card.id, lane.id, now);
    if (!moved) return refused("That lane move is not allowed. Read the board before choosing another lane.");
    next = moved;
  }
  return { ok: true, board: next, cardId: card.id };
}

/** One line of a description: whitespace flattened, first query hit centered, ellipses only at cuts. */
export function kanbanCardExcerpt(description: string, query = "", budget = KANBAN_CARD_EXCERPT_BUDGET): string {
  const flat = description.replace(/\s+/gu, " ").trim();
  if (!flat) return "";
  const { text, leading, trailing } = kanbanDescriptionExcerpt(flat, query, budget);
  return `${leading ? "…" : ""}${text}${trailing ? "…" : ""}`;
}

/** The rows a search sends: id, title, lane and a bounded excerpt, never the full body. */
export function kanbanCardSummary(card: KanbanCard, query = ""): KanbanCardSummaryData {
  return {
    id: card.id,
    title: card.title,
    laneId: card.laneId,
    ...(card.sessionId === null ? {} : { linked: true as const }),
    excerpt: kanbanCardExcerpt(card.description, query),
  };
}

const laneCardCounts = (board: KanbanBoard): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const card of board.cards) counts.set(card.laneId, (counts.get(card.laneId) ?? 0) + 1);
  return counts;
};

/**
 * The cheap entry point: lanes with their counts, the board total, and this
 * session's own card in full. No other card body is sent, whatever the board
 * size — and no lane instructions either: those are injected when the card
 * enters a lane, not listed on every read.
 */
export function kanbanToolOverview(board: KanbanBoard, revision: number, sessionId: string): KanbanToolResult {
  const counts = laneCardCounts(board);
  return {
    ok: true,
    action: "read",
    projectDir: board.projectDir,
    lanes: board.lanes.map((lane) => ({
      id: lane.id,
      name: lane.name,
      description: lane.description,
      ...(lane.fixed ? { fixed: true as const } : {}),
      cardCount: counts.get(lane.id) ?? 0,
    })),
    totalCards: board.cards.length,
    currentCard: cardForSession(board, sessionId) ?? null,
    revision,
  };
}

/** `read { cardId }`: exactly one card, in full, with the lane it sits in. */
export function kanbanToolRead(board: KanbanBoard, revision: number, sessionId: string, cardId: string): KanbanToolResult {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) return refused("Card not found in this project's board. Use kanban read without cardId, then kanban search, to discover current card IDs.");
  const index = board.lanes.findIndex((l) => l.id === card.laneId);
  if (index < 0) return refused("That card's lane is missing from this board. Read the board before continuing.");
  return {
    ok: true,
    action: "read",
    projectDir: board.projectDir,
    card,
    lane: board.lanes[index],
    nextLaneId: board.lanes[index + 1]?.id ?? null,
    currentCardId: cardForSession(board, sessionId)?.id ?? null,
    revision,
  };
}

/**
 * `search`: literal text and/or one lane, at most `limit` compact rows. Matching
 * counts are reported so a model narrows the query instead of paging the board.
 */
export function kanbanToolSearch(board: KanbanBoard, revision: number, sessionId: string, request: KanbanToolSearch): KanbanToolResult {
  if (request.laneId !== undefined && !board.lanes.some((l) => l.id === request.laneId)) {
    return refused("Lane not found. Use kanban read to discover the current lane IDs.");
  }
  const query = request.query ?? "";
  const matched = board.cards.filter((card) => (request.laneId === undefined || card.laneId === request.laneId) && cardMatchesQuery(card, query));
  const limit = request.limit ?? KANBAN_SEARCH_DEFAULT_LIMIT;
  const cards = matched.slice(0, limit).map((card) => kanbanCardSummary(card, query));
  const hasMore = matched.length > cards.length;
  const counts = laneCardCounts(board);
  return {
    ok: true,
    action: "search",
    projectDir: board.projectDir,
    lanes: board.lanes.map((lane) => ({ id: lane.id, name: lane.name, cardCount: counts.get(lane.id) ?? 0 })),
    cards,
    matched: matched.length,
    total: board.cards.length,
    hasMore,
    ...(hasMore ? { hint: `${cards.length} of ${matched.length} matches shown; narrow with query or laneId, or raise limit (max ${KANBAN_SEARCH_MAX_LIMIT}).` } : {}),
    currentCardId: cardForSession(board, sessionId)?.id ?? null,
    revision,
  };
}

export function kanbanToolMutationResult(board: KanbanBoard, revision: number, sessionId: string, cardId: string, action: "create" | "update"): KanbanToolResult {
  const card = board.cards.find((c) => c.id === cardId);
  const index = board.lanes.findIndex((l) => l.id === card?.laneId);
  if (!card || index < 0) return refused("The updated card or its lane is missing. Read the board before continuing.");
  return { ok: true, action, card, lane: board.lanes[index], nextLaneId: board.lanes[index + 1]?.id ?? null, currentCardId: cardForSession(board, sessionId)?.id ?? null, revision };
}
