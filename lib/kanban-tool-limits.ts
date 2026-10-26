/**
 * Byte budgets of the agent-facing `kanban` tool, kept apart from the schema and
 * the reducers so both read the same numbers. A board in a large project holds
 * hundreds of cards with long descriptions; the tool answers with projections so
 * a question costs a few hundred tokens instead of the whole board.
 */

/** `search` returns at most this many cards without an explicit `limit`. */
export const KANBAN_SEARCH_DEFAULT_LIMIT = 20;

/** The `limit` ceiling: past it, narrow with `query` / `laneId` instead. */
export const KANBAN_SEARCH_MAX_LIMIT = 50;

/** Code points of a card's description in a search row. */
export const KANBAN_CARD_EXCERPT_BUDGET = 120;

/** A notice names at most this many lanes before it defers to `kanban read`. */
export const KANBAN_NOTICE_LANE_LIMIT = 24;

/**
 * Characters a lane's model-facing instructions may hold — the route's cap
 * (`app/api/kanban/route.ts` refuses longer) and the injection's own bound
 * (`lib/kanban-extension.ts` truncates with a marker, for hand-edited files).
 * 2000 characters is roughly 500 tokens, paid once per lane entry, not per turn.
 */
export const KANBAN_LANE_INSTRUCTIONS_MAX = 2000;
