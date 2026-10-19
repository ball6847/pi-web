---
createdAt: "2026-10-19T00:00:00Z"
implementedAt: null
reviewedAt: null
# SIGN-OFF: PENDING — per GOAL.md's convention the operator records a sign-off
# line here before coding starts. The features below were requested and scoped
# by the operator on 2026-10-19 (see ASSUMPTIONS.md); this header gate still
# applies until a `signoff: "<operator>, <date>"` line is added.
signoff: null
---

# Plan: Card activity indicator (M5) and manual drag-and-drop moves (M6)

Operator direction 2026-10-19: postpone model-driven card advancement (now M7)
behind two UI features that make the board usable by hand in the meantime.

## Feature A — M5: card activity indicator for a linked session

A card's linked-session chip shows the same state the sidebar row shows, with
the same visuals and precedence (components/SessionTree.tsx:594-609 is the
reference):

- linked session is **awaiting input** (run parked on a blocking dialog) → an
  amber dot, `session-tree-awaiting`, `role="img"`,
  `aria-label`/tooltip from the existing `sidebar.agentAwaitingInput` key;
- else linked session is **running** → `SpinnerIcon size={12}` with the
  existing `sidebar.agentRunning` key (`is-running`);
- else (idle, gone session, no linked session) → no indicator, card unchanged.

Precedence and styling stay identical to the sidebar by reusing the same
classes, icon and i18n keys — no new `kanban.*` keys unless review shows the
sidebar labels read wrong on a card.

Data flow: AppShell already holds `runningIds`/`awaitingIds` for the sidebar
rows (`GET /api/agent/running`, `SessionTreeInput`). Pass them (or a
`(sessionId) => "running" | "awaiting" | null` lookup) into `KanbanBoard` as
props — no new polling, no new fetches; the board re-renders when the props
change. The kanban session index already maps sessions to cards.

### M5 test cases

1. Board shows the spinner on a card whose `sessionId` is in `runningIds`.
2. Amber dot wins over the spinner when the session is in both sets (sidebar
   precedence).
3. No indicator for an idle linked session, a `sessionGone` chip, or an
   unlinked card.
4. The indicator does not break the card menu / open-session click target
   (chip stays clickable, indicator is decorative to the pointer).
5. i18n parity holds (no new keys, or equal key counts if any are added).

Rendering rules are React-side; per repo convention they are verified by
review + the existing story of classes, not node tests — the pure lookup
helper (sessionId → status) gets a table test in `lib/`.

## Feature B — M6: drag-and-drop manual moves between lanes

The board rule "the user never moves a card by hand" is **changed by operator
decision** for this feature: manual moves are allowed while model-driven
advancement is future work (M7). The card/lane-strip "Demo: advance" menu
entries retire when this lands — their stated reason ("without it the menu
reads as a manual move, which the rules forbid") collapses once manual moves
are legal; `kanban.menuAdvance` comes off all three locales (parity kept).
M7 then lands without the demo-removal step.

Design:

- Client gains `kanbanMoveCard(projectDir, cardId, laneId)` — the plain
  `move-card` action through the existing write pipeline (optimistic overlay,
  one-at-a-time POST, retry/rollback semantics already tested). The route
  action and reducer rules exist and are tested; nothing server-side changes.
- HTML5 drag from the card (or its grip) with drop targets per lane body; drop
  on the same lane is a no-op (the reducer's no-change rule already skips the
  POST). Drop targets highlight while dragging.
- Touch/pen parity follows the sidebar group-drag pattern
  (`hooks/useGroupDrag.ts`: long-press to lift, auto-scroll near edges).
- Accessible/mouse-free fallback: the card menu gains "Move to {lane}"
  entries (one per other lane; disabled for the current lane) calling the
  same `kanbanMoveCard` — same rule set as the drag.

Open question flagged for review: drop semantics inside a lane — append to
the end (simple) vs. insert at the hovered position (needs a card-order
concept the reducer does not have today; cards are ordered per lane by
insertion). Default: **append**, keep order untouched otherwise.

### M6 test cases

1. `kanbanMoveCard` posts `move-card`, applies optimistically, adopts the
   server answer (mirrors the existing action tests).
2. A refused move (e.g. unsupported-schema, or the project's file corrupting
   mid-write) rolls the card back — the pipeline's existing behavior, named
   once for the drag path.
3. Same-lane drop: no POST (no-change rule through the client).
4. Drag onto a non-lane target (header, gap, outside the board) does nothing.
5. Menu "Move to {lane}" entries: enabled only for other lanes, disabled for
   the card's current lane, hidden when the session is gone? (no — moves are
   session-independent; only the card must exist).
6. `Demo:` string absent from `lib/i18n/messages/en.ts` after the retirement;
   key counts equal in en / zh-CN / zh-TW.
7. `docs/agents/kanban.md`: Board rules state the manual move allowance (and
   that it may be narrowed again when M7 lands), Traps' Demo-prefix bullet is
   rewritten or removed.

## Sequencing

M5 and M6 are independent of each other and of M4 (shared storage); both land
before M7 (model-driven advancement, postponed). M6 changes the rules M7's
plan was written under — M7's plan gets a delta note when M6 lands (its tool
stays the only *model* way to move a card; manual moves remain allowed unless
the operator says otherwise).
