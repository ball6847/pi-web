import {
  makeKanbanId,
  type KanbanAction,
  type KanbanBoard,
  type KanbanCard,
  type KanbanLane,
} from "./kanban-types";

// The board's rules as pure reducers, shared by the route (the authority) and
// the client cache (optimistic application). No I/O, and no clock: callers
// pass `now`. Every mutation returns a new board and leaves its argument
// alone; a mutation that changes nothing returns the SAME board object, so a
// caller can tell "no change" by identity. `null` means refused: a guard was
// violated and the board is left as it was.
//
// The first lane is the fixed "backlog": it is never renamed, moved or
// removed, and the cards that rest there hold no session. The lanes after it
// are work lanes.

// ---------------------------------------------------------------------------
// Read helpers
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

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function replaceCard(board: KanbanBoard, cardId: string, change: (card: KanbanCard) => KanbanCard): KanbanBoard {
  return { ...board, cards: board.cards.map((card) => (card.id === cardId ? change(card) : card)) };
}

/** One session, one card: every card but `exceptCardId` that carries `sessionId` drops the link (the snapshot title stays). */
function dropOtherLinks(cards: KanbanCard[], sessionId: string, exceptCardId: string | null, now: number): KanbanCard[] {
  return cards.map((card) =>
    card.sessionId === sessionId && card.id !== exceptCardId ? { ...card, sessionId: null, updatedAt: now } : card,
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * A new card at the end of `laneId`. Refused (null) for a blank title, an
 * unknown lane, or an id already on the board. A session given here moves off
 * any other card that carries it.
 */
export function addCard(
  board: KanbanBoard,
  laneId: string,
  input: { title: string; description?: string; sessionId?: string | null; sessionTitle?: string | null; id?: string },
  now: number,
): KanbanBoard | null {
  const title = input.title.trim();
  const lane = laneById(board, laneId);
  if (!title || !lane) return null;
  const id = input.id ?? makeKanbanId();
  if (board.cards.some((card) => card.id === id)) return null;
  const sessionId = input.sessionId ?? null;
  if (sessionId && lane.fixed) return null; // The backlog never takes a session.
  const card: KanbanCard = {
    id,
    title,
    description: (input.description ?? "").trim(),
    laneId,
    sessionId,
    sessionTitle: input.sessionTitle ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const others = sessionId ? dropOtherLinks(board.cards, sessionId, null, now) : board.cards;
  return { ...board, cards: [...others, card] };
}

/**
 * The board's sessionless cards for an "attach to card" menu: newest first
 * (your recent cards are the top hits), ties keep the board's order. The list
 * self-shrinks as linking consumes cards; a busy backlog is the growth case.
 */
export function sessionlessCardsByRecency(board: KanbanBoard): KanbanCard[] {
  return board.cards
    .filter((card) => card.sessionId === null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Title and description edits. Refused (null) for an unknown card; a blank title is ignored. */
export function updateCard(
  board: KanbanBoard,
  cardId: string,
  patch: { title?: string; description?: string },
  now: number,
): KanbanBoard | null {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) return null;
  const title = patch.title?.trim();
  const nextTitle = title ? title : card.title;
  const nextDescription = patch.description !== undefined ? patch.description.trim() : card.description;
  if (nextTitle === card.title && nextDescription === card.description) return board;
  return replaceCard(board, cardId, (c) => ({ ...c, title: nextTitle, description: nextDescription, updatedAt: now }));
}

/** Removes the card; an unknown card is already gone, so the board is returned as it is. */
export function deleteCard(board: KanbanBoard, cardId: string): KanbanBoard {
  if (!board.cards.some((card) => card.id === cardId)) return board;
  return { ...board, cards: board.cards.filter((card) => card.id !== cardId) };
}

/**
 * Whether the move-card rules allow `card` to rest in `lane`: a sessionless
 * card only in the fixed backlog, a linked card nowhere near it. The view
 * uses it to mark undroppable lanes during a drag (the same gate
 * moveCardToLane applies on the write).
 */
export function canRestInLane(card: KanbanCard, lane: KanbanLane): boolean {
  return (card.sessionId === null) === !!lane.fixed;
}

/**
 * Moves a card to another lane (a lane transition; the card goes last in it).
 * Refused (null) for an unknown card or lane; for a sessionless card going to
 * a work lane (a sessionless card only rests in the backlog); and for a card
 * with a session going to the backlog (which holds none). The link is never
 * touched.
 */
export function moveCardToLane(board: KanbanBoard, cardId: string, laneId: string, now: number): KanbanBoard | null {
  const card = board.cards.find((c) => c.id === cardId);
  const lane = laneById(board, laneId);
  if (!card || !lane) return null;
  if (card.laneId === laneId) return board;
  if (card.sessionId === null && !lane.fixed) return null;
  if (card.sessionId !== null && lane.fixed) return null;
  const moved = { ...card, laneId, updatedAt: now };
  return { ...board, cards: [...board.cards.filter((c) => c.id !== cardId), moved] };
}

/**
 * The model's decision: the card's stage is done, it moves to the next lane.
 * Refused (null) for an unknown card or a card already in the last lane.
 */
export function advanceCard(board: KanbanBoard, cardId: string, now: number): KanbanBoard | null {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) return null;
  const index = laneIndex(board, card.laneId);
  const next = board.lanes[index + 1];
  if (index < 0 || !next) return null;
  return replaceCard(board, cardId, (c) => ({ ...c, laneId: next.id, updatedAt: now }));
}

/**
 * Links a session to a card; the session's card elsewhere drops the link (one
 * session, one card). Refused (null) for an unknown card or a card in the
 * fixed backlog, which never takes a session.
 */
export function linkCard(
  board: KanbanBoard,
  cardId: string,
  sessionId: string,
  sessionTitle: string,
  now: number,
): KanbanBoard | null {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) return null;
  if (laneById(board, card.laneId)?.fixed) return null;
  const others = dropOtherLinks(board.cards, sessionId, cardId, now);
  return {
    ...board,
    cards: others.map((c) => (c.id === cardId ? { ...c, sessionId, sessionTitle, updatedAt: now } : c)),
  };
}

/** Clears the card's session id only: the snapshot title stays for display. */
export function unlinkCard(board: KanbanBoard, cardId: string, now: number): KanbanBoard {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card || card.sessionId === null) return board;
  return replaceCard(board, cardId, (c) => ({ ...c, sessionId: null, updatedAt: now }));
}

/**
 * A session that started "tracked on board": a new card for it in the lane the
 * composer picked, falling back to the first work lane. A session that already
 * has a card keeps it (and its lane): only the title refreshes. No work lane
 * and no card: the board is returned as it is.
 */
export function createCardForSession(
  board: KanbanBoard,
  sessionId: string,
  sessionTitle: string,
  laneId: string | null,
  now: number,
  cardId?: string,
): KanbanBoard {
  const existing = cardForSession(board, sessionId);
  if (existing) {
    if (existing.sessionTitle === sessionTitle) return board;
    return replaceCard(board, existing.id, (c) => ({ ...c, sessionTitle, updatedAt: now }));
  }
  const wanted = laneId ? board.lanes.find((l) => l.id === laneId && !l.fixed) : null;
  const lane = wanted ?? firstWorkLane(board);
  if (!lane) return board;
  return addCard(board, lane.id, { title: sessionTitle.trim() || sessionId, sessionId, sessionTitle, id: cardId }, now) ?? board;
}

/**
 * Unlinks every card whose session is not in `alive`. A card keeps its lane and
 * its snapshot title. The same board comes back when nothing was dead.
 */
export function pruneDeadLinks(board: KanbanBoard, alive: Set<string>, now: number): KanbanBoard {
  if (!board.cards.some((card) => card.sessionId !== null && !alive.has(card.sessionId))) return board;
  return {
    ...board,
    cards: board.cards.map((card) =>
      card.sessionId !== null && !alive.has(card.sessionId) ? { ...card, sessionId: null, updatedAt: now } : card,
    ),
  };
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

/** A new work lane at the end. Refused (null) for a blank name or an id already used. */
export function addLane(board: KanbanBoard, name: string, description = "", id: string = makeKanbanId()): KanbanBoard | null {
  const trimmed = name.trim();
  if (!trimmed || board.lanes.some((lane) => lane.id === id)) return null;
  return { ...board, lanes: [...board.lanes, { id, name: trimmed, description: description.trim() }] };
}

/** Refused (null) for a blank name, an unknown lane or the fixed backlog; the same name changes nothing. */
export function renameLane(board: KanbanBoard, laneId: string, name: string): KanbanBoard | null {
  const trimmed = name.trim();
  const lane = laneById(board, laneId);
  if (!trimmed || !lane || lane.fixed) return null;
  if (lane.name === trimmed) return board;
  return { ...board, lanes: board.lanes.map((l) => (l.id === laneId ? { ...l, name: trimmed } : l)) };
}

/** One step left (-1) or right (1). Refused (null) off the ends, for the fixed lane, or past it. */
export function moveLane(board: KanbanBoard, laneId: string, direction: -1 | 1): KanbanBoard | null {
  const index = laneIndex(board, laneId);
  const target = index + direction;
  const lane = board.lanes[index];
  const other = board.lanes[target];
  if (index < 0 || !lane || !other || lane.fixed || other.fixed) return null;
  const lanes = [...board.lanes];
  lanes[index] = other;
  lanes[target] = lane;
  return { ...board, lanes };
}

/**
 * Moves a work lane to a final position. `toIndex` is the lane's index in the
 * lanes array AFTER the move: 0 belongs to the fixed backlog, so a 0 asked
 * for lands right after it (like a too-far index, clamped to the end).
 * Refused (null) for an unknown lane, the fixed backlog, or a non-integer
 * index; the same position changes nothing.
 */
export function reorderLane(board: KanbanBoard, laneId: string, toIndex: number): KanbanBoard | null {
  const from = laneIndex(board, laneId);
  const lane = board.lanes[from];
  if (from < 0 || !lane || lane.fixed) return null;
  if (!Number.isInteger(toIndex)) return null;
  const target = Math.min(Math.max(toIndex, 1), board.lanes.length - 1);
  if (target === from) return board;
  const lanes = board.lanes.filter((l) => l.id !== laneId);
  lanes.splice(target, 0, lane);
  return { ...board, lanes };
}

/**
 * Removes a work lane. Its cards are relocated to the backlog, which holds no
 * session: a card that carried one is unlinked (the snapshot title stays).
 * Refused (null) for an unknown lane or the fixed backlog.
 */
export function deleteLane(board: KanbanBoard, laneId: string, now: number): KanbanBoard | null {
  const lane = laneById(board, laneId);
  const backlog = board.lanes.find((l) => l.fixed);
  if (!lane || lane.fixed || !backlog) return null;
  return {
    ...board,
    lanes: board.lanes.filter((l) => l.id !== laneId),
    cards: board.cards.map((card) =>
      card.laneId === laneId ? { ...card, laneId: backlog.id, sessionId: null, updatedAt: now } : card,
    ),
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Applies one route action with the matching reducer; null when the rules refuse it. */
export function applyKanbanAction(board: KanbanBoard, request: KanbanAction, now: number): KanbanBoard | null {
  switch (request.action) {
    case "add-card":
      return addCard(
        board,
        request.laneId,
        { title: request.title, description: request.description, sessionId: request.sessionId, sessionTitle: request.sessionTitle, id: request.cardId },
        now,
      );
    case "edit-card":
      return updateCard(board, request.cardId, { title: request.title, description: request.description }, now);
    case "delete-card":
      return deleteCard(board, request.cardId);
    case "move-card":
      return moveCardToLane(board, request.cardId, request.laneId, now);
    case "advance-card":
      return advanceCard(board, request.cardId, now);
    case "link-session":
      return linkCard(board, request.cardId, request.sessionId, request.sessionTitle, now);
    case "unlink-session":
      return unlinkCard(board, request.cardId, now);
    case "create-card-for-session":
      return createCardForSession(board, request.sessionId, request.sessionTitle, request.laneId, now, request.cardId);
    case "add-lane":
      return addLane(board, request.name, request.description ?? "", request.laneId);
    case "rename-lane":
      return renameLane(board, request.laneId, request.name);
    case "move-lane":
      return moveLane(board, request.laneId, request.direction);
    case "reorder-lane":
      return reorderLane(board, request.laneId, request.toIndex);
    case "delete-lane":
      return deleteLane(board, request.laneId, now);
  }
}
