import type { KanbanBoard, KanbanCard } from "./kanban-types";

export function normalizeKanbanQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** Fields stay separate: no match can straddle title and description. */
export function cardMatchesQuery(card: Pick<KanbanCard, "title" | "description">, query: string): boolean {
  const needle = normalizeKanbanQuery(query);
  return !needle || card.title.toLowerCase().includes(needle) || card.description.toLowerCase().includes(needle);
}

/** A view projection, never a replacement board for a mutation or configuration. */
export function searchKanbanBoard(board: KanbanBoard, query: string, editingCardId?: string | null) {
  const needle = normalizeKanbanQuery(query);
  const lanes = board.lanes.map((lane) => {
    const all = board.cards.filter((card) => card.laneId === lane.id);
    const cards = all.filter((card) => cardMatchesQuery(card, needle));
    const matches = new Set(cards.map((card) => card.id));
    return {
      lane,
      total: all.length,
      cards,
      // An active edit keeps its position and component key, not a fake match.
      renderedCards: all.filter((card) => matches.has(card.id) || card.id === editingCardId),
    };
  });
  return { active: needle.length > 0, matched: lanes.reduce((sum, lane) => sum + lane.cards.length, 0), total: board.cards.length, lanes };
}

export interface KanbanHighlightPart { text: string; match: boolean }

/** Original UTF-16 boundaries for literal matches in the lowercased text. */
function matchRanges(text: string, query: string): Array<{ start: number; end: number }> {
  const needle = normalizeKanbanQuery(query);
  if (!needle) return [];
  // Lowercase the whole string (context-sensitive final sigma), then map its
  // offsets back to original code points (İ expands to i + combining dot).
  const folded = text.toLowerCase();
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const point of text) {
    for (let i = 0; i < point.toLowerCase().length; i++) {
      starts.push(offset);
      ends.push(offset + point.length);
    }
    offset += point.length;
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + needle.length)) {
    const start = starts[at];
    const end = ends[at + needle.length - 1];
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  return ranges;
}

/** Plain strings for React text nodes / marks, never markup or a query regexp. */
export function highlightKanbanText(text: string, query: string): KanbanHighlightPart[] {
  const parts: KanbanHighlightPart[] = [];
  let offset = 0;
  for (const { start, end } of matchRanges(text, query)) {
    if (start > offset) parts.push({ text: text.slice(offset, start), match: false });
    parts.push({ text: text.slice(start, end), match: true });
    offset = end;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset), match: false });
  return parts;
}

/** A short preview around the first description hit; budgets count code points. */
export function kanbanDescriptionExcerpt(text: string, query: string, budget = 120) {
  const points = Array.from(text);
  const hit = matchRanges(text, query)[0];
  const hitStart = hit ? Array.from(text.slice(0, hit.start)).length : 0;
  const hitLength = hit ? Array.from(text.slice(hit.start, hit.end)).length : 0;
  const size = Math.max(1, budget, hitLength);
  const start = Math.max(0, Math.min(hitStart - Math.floor((size - hitLength) / 2), points.length - size));
  const end = Math.min(points.length, start + size);
  return { text: points.slice(start, end).join(""), leading: start > 0, trailing: end < points.length };
}

export interface KanbanSearchState { projectDir: string | null; query: string }

/** One project's page-memory query, not a history of saved searches. */
export function kanbanSearchForProject(state: KanbanSearchState, projectDir: string | null): KanbanSearchState {
  return state.projectDir === projectDir ? state : { projectDir, query: "" };
}

/** Called for an explicit jump, never for an ordinary chat/board toggle. */
export function kanbanSearchForJump(state: KanbanSearchState, projectDir: string, card: KanbanCard | null): KanbanSearchState {
  const scoped = kanbanSearchForProject(state, projectDir);
  return card && cardMatchesQuery(card, scoped.query) ? scoped : { projectDir, query: "" };
}
