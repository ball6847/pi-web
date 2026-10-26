import { StringEnum, Type } from "@earendil-works/pi-ai";

/** Flat parameters keep provider schemas and the web's argument rows simple. */
export const KanbanToolParameters = Type.Object({
  action: StringEnum(["read", "create", "update"] as const),
  cardId: Type.Optional(Type.String({ minLength: 1, description: "read/update only. Omit on update to target this session's linked card." })),
  title: Type.Optional(Type.String({ minLength: 1, description: "Required for create; optional update. Must not be blank." })),
  description: Type.Optional(Type.String({ description: "create/update only. Omit to preserve on update; empty string clears it." })),
  laneId: Type.Optional(Type.String({ minLength: 1, description: "create/update only. Use an ID from read. Create defaults to Backlog; a work lane claims a free card for this session." })),
}, { additionalProperties: false });

const NullableString = Type.Union([Type.String(), Type.Null()]);
const Lane = Type.Object({ id: Type.String(), name: Type.String(), description: Type.String(), fixed: Type.Optional(Type.Boolean()) });
const Card = Type.Object({
  id: Type.String(), title: Type.String(), description: Type.String(), laneId: Type.String(),
  sessionId: NullableString, sessionTitle: NullableString, createdAt: Type.Number(), updatedAt: Type.Number(),
});
const Position = { currentCardId: NullableString, revision: Type.Number() };

export const KanbanToolOutputSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true), action: Type.Literal("read"), projectDir: Type.String(),
    lanes: Type.Array(Lane), cards: Type.Array(Card), ...Position,
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
