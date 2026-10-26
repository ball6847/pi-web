import { StringEnum, Type } from "@earendil-works/pi-ai";
import { KANBAN_SEARCH_DEFAULT_LIMIT, KANBAN_SEARCH_MAX_LIMIT } from "./kanban-tool-limits";

/** Flat parameters keep provider schemas and the web's argument rows simple. */
export const KanbanToolParameters = Type.Object({
  action: StringEnum(["read", "search", "create", "update"] as const),
  cardId: Type.Optional(Type.String({ minLength: 1, description: "read: one card in full. update: its target; omit for your linked card." })),
  query: Type.Optional(Type.String({ description: "search: literal text, matched against title or description. Empty lists the first cards." })),
  laneId: Type.Optional(Type.String({ minLength: 1, description: "search: only this lane. create/update: the target lane (a work lane claims the card for this session)." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: KANBAN_SEARCH_MAX_LIMIT, description: `search: most rows returned (default ${KANBAN_SEARCH_DEFAULT_LIMIT}).` })),
  title: Type.Optional(Type.String({ minLength: 1, description: "Required for create; optional update. Must not be blank." })),
  description: Type.Optional(Type.String({ description: "create/update only. Omit to preserve on update; empty string clears it." })),
}, { additionalProperties: false });

const NullableString = Type.Union([Type.String(), Type.Null()]);
const Lane = Type.Object({ id: Type.String(), name: Type.String(), description: Type.String(), fixed: Type.Optional(Type.Boolean()) });
const Card = Type.Object({
  id: Type.String(), title: Type.String(), description: Type.String(), laneId: Type.String(),
  sessionId: NullableString, sessionTitle: NullableString, createdAt: Type.Number(), updatedAt: Type.Number(),
});
/* Read and search answer with projections, never whole card bodies. */
const LaneOverview = Type.Object({
  id: Type.String(), name: Type.String(), description: Type.String(),
  fixed: Type.Optional(Type.Boolean()), cardCount: Type.Number(),
});
const LaneCount = Type.Object({ id: Type.String(), name: Type.String(), cardCount: Type.Number() });
const CardSummary = Type.Object({
  id: Type.String(), title: Type.String(), laneId: Type.String(),
  linked: Type.Optional(Type.Literal(true)), excerpt: Type.String(),
});
const Position = { currentCardId: NullableString, revision: Type.Number() };

export const KanbanToolOutputSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true), action: Type.Literal("read"), projectDir: Type.String(),
    lanes: Type.Array(LaneOverview), totalCards: Type.Number(),
    currentCard: Type.Union([Card, Type.Null()]), revision: Type.Number(),
  }),
  Type.Object({
    ok: Type.Literal(true), action: Type.Literal("read"), projectDir: Type.String(),
    card: Card, lane: Lane, nextLaneId: NullableString, ...Position,
  }),
  Type.Object({
    ok: Type.Literal(true), action: Type.Literal("search"), projectDir: Type.String(),
    lanes: Type.Array(LaneCount), cards: Type.Array(CardSummary),
    matched: Type.Number(), total: Type.Number(), hasMore: Type.Boolean(),
    hint: Type.Optional(Type.String()), ...Position,
  }),
  Type.Object({
    ok: Type.Literal(true), action: StringEnum(["create", "update"] as const), card: Card, lane: Lane,
    nextLaneId: NullableString, ...Position,
  }),
  Type.Object({
    ok: Type.Literal(false), code: StringEnum([
      "invalid-request", "read-only", "cwd-invalid", "cwd-denied", "cwd-not-directory",
      "session-missing", "refused", "locked", "unsupported-schema", "internal",
    ] as const), error: Type.String(),
  }),
]);
