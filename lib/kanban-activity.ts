/**
 * Client-safe, pure: the activity trail of a card edit, derived from the board
 * before and after the write.
 *
 * Nothing above `lib/kanban-store.ts` posts an event. The store hands the two
 * boards to `deriveKanbanActivity` inside the same lock and transaction as the
 * board write, so a drag, a menu move, the demo advance and the agent's
 * `kanban update` all record the same thing by construction — and a write that
 * changed nothing records nothing (the reducers return the same board object,
 * so `before === after`).
 *
 * The trail is history, not state: it never feeds the board payload, the
 * revision poll's shape or the run notice. A position-only reorder is not an
 * event (one row per drag with nothing to learn), and neither is a lane rename
 * (the card did not move). Deleting a lane is the one structural change that
 * gets its own kind, because `delete-lane` relocates and unlinks the lane's
 * cards: one `lane-deleted` row per card reads better than a move plus an
 * unlink that the reader has to connect themselves.
 */

import { makeKanbanId } from "./kanban-types";
import type { KanbanActivity, KanbanBoard, KanbanCard } from "./kanban-types";

/** Who wrote the change: `null` (a person in the browser) or the agent's session. */
export interface KanbanActivityActor {
  sessionId: string;
  sessionTitle?: string | null;
}

/** Lane ids to their names, for the rows that name a lane. */
function laneNames(board: KanbanBoard): Map<string, string> {
  return new Map(board.lanes.map((lane) => [lane.id, lane.name]));
}

function cardIndex(board: KanbanBoard): Map<string, KanbanCard> {
  return new Map(board.cards.map((card) => [card.id, card]));
}

/**
 * The events one write produced, oldest first within the write and in board
 * order across cards. Empty when the board is the same object (a no-op) or only
 * positions changed.
 */
export function deriveKanbanActivity(
  before: KanbanBoard,
  after: KanbanBoard,
  now: number,
  actor?: KanbanActivityActor | null,
): KanbanActivity[] {
  if (before === after) return [];
  const previous = cardIndex(before);
  const beforeLanes = laneNames(before);
  const afterLanes = laneNames(after);
  // A lane the write removed: its cards were relocated, not moved by choice.
  const removed = new Set(
    before.lanes.filter((lane) => !after.lanes.some((entry) => entry.id === lane.id)).map((lane) => lane.id),
  );
  const events: KanbanActivity[] = [];
  const emit = (card: KanbanCard, kind: KanbanActivity["kind"], from: string | null, to: string | null) => {
    events.push({
      id: makeKanbanId(),
      cardId: card.id,
      kind,
      from,
      to,
      actorSessionId: actor?.sessionId ?? null,
      actorSessionTitle: actor?.sessionTitle ?? null,
      createdAt: now,
    });
  };

  for (const card of after.cards) {
    const prior = previous.get(card.id);
    if (!prior) {
      // A new card: its creation is the one row, not a creation plus a link.
      emit(card, "created", null, afterLanes.get(card.laneId) ?? null);
      continue;
    }
    const priorLane = beforeLanes.get(prior.laneId) ?? prior.laneId;
    if (prior.laneId !== card.laneId) {
      if (removed.has(prior.laneId)) {
        // One row for the whole relocation; the unlink it also does is implied.
        emit(card, "lane-deleted", priorLane, afterLanes.get(card.laneId) ?? null);
        continue;
      }
      emit(card, "moved", priorLane, afterLanes.get(card.laneId) ?? null);
    }
    if (prior.title !== card.title) emit(card, "title", prior.title, card.title);
    if (prior.description !== card.description) emit(card, "description", null, null);
    if (prior.sessionId !== card.sessionId) {
      if (card.sessionId === null) emit(card, "unlinked", prior.sessionTitle ?? prior.sessionId, null);
      else emit(card, "linked", null, card.sessionTitle ?? card.sessionId);
    }
  }
  return events;
}
