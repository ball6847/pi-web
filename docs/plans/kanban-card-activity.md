# Card activity logs — UX/UI design

Created: 2026-02-17
Status: implemented (merged timeline signed off; see "Shipped" below)

## Problem

A card's comments answer *"what did the last session leave for me?"*. Nothing answers
*"what happened to this card?"* — it moved Plan → Implement, its title changed twice, a
session was linked, then unlinked, someone rewrote the description. Today that history
exists only as `cards.updated_at` and as the session transcripts themselves, so a person
coming back to a stale card cannot tell motion from neglect, and a fresh session cannot
tell what its predecessor already did without reading comments that may not exist.

Goal: an **automatic, append-only activity trail per card** that is cheap to store, cheap
to read, and visible in the one place a card is read — its detail tab.

## Recommendation (ranked)

**1. One merged timeline in the card detail tab, titled "Activity" — recommended.**
Comments and system events share one chronological list: a comment is a full-width entry
(the existing `CommentEntry` card), an event is a slim one-line row on a vertical rail.
GitHub/Jira issue-timeline shape. One scroll, one fetch, one refetch trigger (the board
revision), and no "which tab was that in" tax. Handoffs and motions are the same story.

**2. Two stacked sections: "Comments" (today's block) + "Activity" (new, collapsible).**
Cheapest to build (the comments section already exists untouched), but the reader has to
scan two lists to reconstruct one sequence, and an event between two comments reads out of
order. Take this only if noise from drags turns out to dominate.

**3. A segmented `All · Comments · Changes` control above the merged timeline.**
Same as (1) plus a filter. Buildable later on top of (1) without moving data; do **not**
ship it in v1 — with grouping (below) the event volume is low, and a filter on a list that
is usually 5 rows is a setting wearing a button's clothes.

## What is recorded

Everything is derived **server-side from the mutation that already happened**, inside the
same lock and transaction as the board write (`editBoard`). The client never posts an
event, so a hand-written board edit or another browser's drag cannot produce a wrong trail.

| event | fired by | row text |
| --- | --- | --- |
| `created` | `add-card`, `create-card-for-session` | *Created in Backlog* |
| `moved` | `move-card`, `advance-card`, agent `update { laneId }`, `attachNewSessionCard` | *Moved to Implement* + dim `from Plan` |
| `title` | `edit-card`, agent `update { title }` | *Title changed* + old title as dim quoted text (truncated to 60) |
| `description` | `edit-card`, agent `update { description }` | *Description updated* (+ `— 1 240 → 1 890 chars` in the hover title only) |
| `linked` | `link-session`, `create-card-for-session`, attach | *Session linked* + the session's name as a chip |
| `unlinked` | `unlink-session`, pruning of a dead session | *Session unlinked* (+ chip with the kept snapshot title; hover says *session file gone* when pruning did it) |
| `laneDeleted` | `delete-lane` | *Lane "Deploy" deleted, card moved to Backlog* — one row, not two |

Not recorded, deliberately: position-only reorders inside a lane (a drag's gap is not
history; it would add a row per drag with no reader value), lane renames, comments (they
are entries, not events), and anything board-wide (lane added/reordered) — those belong to
the board, not a card.

Actors: a row records the writing session (`session_id`, `session_title`) when the agent
tool wrote it. The UI shows attribution **only** for agent writes (`via <session>` in dim
text on link/unlink/move rows), because a user's own drag needs no author line. No avatars.

## Surfaces

### 1. Card detail tab (`components/KanbanCardDetail.tsx`) — the only new UI
Today's "Comments" block becomes **"Activity"**:

```
ACTIVITY                                                    12
──────────────────────────────────────────────────────────────
 ●  You                                    Moved to Implement
 |                                         from Plan · 2 m ago
 ●  <agent session chip>                       Description updated
 |                                         14 m ago
 ┌───────────────────────────────┐
 │ Comment card (unchanged)      │
 │ You · 1 h ago            ×    │
 └───────────────────────────────┘
 ●  Session linked  <chip>                    3 h ago
 |
──────────────────────────────────────────────────────────────
[ Add a comment — Ctrl+Enter                     ] [ Comment ]
```

- Section header keeps the count (`comments.total + activityTotal`), label uppercase as today.
- Order oldest → newest, identical to the comments thread; the composer stays pinned at the
  bottom of the same block. **No auto-scroll** and no "N new" pill: a refetch on revision
  change appends, exactly as comments already behave. Consistency beats novelty here.
- Draft mode (`card:draft:<n>`) shows the existing `kanban.detailCommentsDraft` line — a
  card that does not exist has no history.
- Loading: nothing (as today). Empty: *"No activity yet."* dim line replacing the current
  empty-comments copy. Error: one dim red line + Retry, reusing the comments error row.
- Paging: newest 50 events, a `Load older` text button at the **top** of the list when
  `activityTotal > shown` (comments keep their 100/oldest-first rule untouched; the two
  reads page independently even though they render in one list).

### 2. Agent-facing read — the payoff, but no new tool surface
`kanban read { cardId }` gains `activity: [{ kind, at, from?, to?, actor? }]` — newest **5**
events, one line each, plus `activityTotal`. `read {}` and `search` stay unchanged (the
token discipline in `docs/agents/kanban.md` is not negotiable). The board notice is **not**
touched: activity is not a state transition, same rule comments already follow.

### 3. Declined surfaces (say no now, so nobody asks later)
- **No badge on the card face.** A per-card "new activity" dot needs a per-card cursor in
  the board payload, which the whole board re-fetches every 2.5 s for every drag; the
  sidebar's session unread dot already covers "this card's session did something". If the
  board ever needs it, the cheap version is a count on the existing `updatedAt`, not a new
  payload field.
- **No activity in the lane strip or the sidebar** — both answer "where is this now".
- **No board-wide feed** ("recent activity across the board"): that is a second read shape,
  a second poll, and a second place to look. Out of scope.

## Visual spec

- Rail: 1 px vertical line `var(--border)` at x = 7 px inside a 16 px icon gutter; runs the
  full section, broken by comment cards (the rail stops above a comment card and resumes
  below it — the card is the interruption).
- Icon: 12 px stroke glyph in a `--bg` circle that masks the rail (created `+`, moved `→`,
  title `T`/pencil, description pencil, link/unlink chain, lane-deleted trash). Color
  `--text-dim`; `moved` uses `--accent` because it is the event people actually scan for.
- Row text: 11.5 px, `--text-muted`; the **destination** (`Implement`, the new title) in
  `--text`, the origin (`from Plan`, the old title) at 90 % opacity of `--text-dim`.
- Time: right-aligned, `fontVariantNumeric: tabular-nums`, 10 px `--text-dim`, relative
  ("2 m ago") via the existing `relativeTime()`; the absolute local timestamp is the
  `title` attribute. No ticking timer (same rule as comments).
- **Grouping**: consecutive events by the same actor whose gap is under 10 minutes share one
  time label on the last row, and the earlier rows drop theirs (keeps a drag-then-edit
  burst from showing three "now"s). Grouping is render-only; storage stays one row per event.
- Height: ~22 px per row. Events never get a background, border or box — that is what makes
  the comment cards read as the authored content and the events as the frame.
- Long values: title/title-old truncated at 60 code points with `…`; the full value lives in
  the row's `title` attribute. No expandable rows.
- Respect `prefers-reduced-motion`: the only animation is a 1.2 s `--accent` left-border
  fade on rows that arrived from a live revision bump while the tab was open; none under
  reduced motion, none on first load.

## Mobile

On a phone the detail tab is a full-screen panel, so the timeline is the same component:
one column, 22 px rows (never below 20 px — text only, not a tap target), the rail hidden
below 420 px to keep the text measure, times moved under the text instead of right-aligned.
`Load older` becomes a full-width 36 px button. The composer keeps its existing
soft-keyboard behavior; nothing new here.

## Data and routes (minimum needed by the UI above)

- **`card_activity`** table, schema v4 (`MIGRATIONS` additive step, no revision bump):
  `(id, card_id, kind, from_value, to_value, actor_session_id, actor_session_title, created_at)`,
  index `(card_id, created_at)`. **No FK to `cards`** — the same reason `card_comments` has
  none: the board write replaces card rows wholesale; the existing orphan prune gains one
  more `DELETE ... WHERE card_id NOT IN (SELECT id FROM cards)`.
- Retention: newest **200** per card, oldest rows deleted in the insert's transaction (a
  board file lives forever; a card cannot).
- Read: `GET /api/kanban/activity?cwd=&cardId=&before=` → `{ cardId, activity, total, revision }`,
  never creating, never pruning — the comments route's contract, copied. A separate route
  rather than widening `/api/kanban/comments`: the two page differently and the comments
  route is pinned by tests.
- Writes: none from the client. Events are emitted in `editBoard`'s transaction from the
  reducer's diff (`before`/`after` card row + action name), so a no-op write emits nothing
  (and a refused write emits nothing).
- Client: one cache entry per card alongside `commentEntries` in `lib/kanban.ts`, refetched
  on the same `useKanbanBoardRevision` bump. No optimistic rows: the server stamps them.

## i18n keys (`lib/i18n/messages/{en,zh-CN,zh-TW}.ts`)

`kanban.activity` (section label), `kanban.activityEmpty`, `kanban.activityLoadOlder`,
`kanban.activityCreated`, `kanban.activityMoved`, `kanban.activityMovedFrom`,
`kanban.activityTitleChanged`, `kanban.activityDescriptionUpdated`,
`kanban.activityLinked`, `kanban.activityUnlinked`, `kanban.activitySessionGone`,
`kanban.activityLaneDeleted`, `kanban.activityVia` (`via {session}`),
`kanban.activityFrom` (`from {lane}`).

## Test hooks and coverage

Browser fixture attributes: `data-kanban-activity`, `data-kanban-activity-row="<kind>"`,
`data-kanban-activity-count`. Pure tests: `lib/kanban-activity*.test.mjs` (diff → events:
move, title, description, link/unlink, lane-deleted = one row, no-op = none, retention cap,
pruning). Component tests: merged order, grouping, `Load older`, empty/error, draft mode,
`relativeTime` reuse. Store test: an event and its board change land in one transaction; a
refused action writes neither.

## Out of scope

Board-wide feed, per-card unread badge, activity filters/search, editing or deleting
events, undo, retention settings, and any activity in the board payload or the run notice.

## Shipped

What landed, against the design above:

- `lib/kanban-activity.ts` (`deriveKanbanActivity(previous, next, now, actor?)`), `card_activity` + schema v4 migration, `insertCardActivity` with the 200/card prune, the orphan prune in `writeBoardRows`, `readCardActivity` paged by rowid cursor.
- `editBoard` derives the rows from the before/after boards inside the board write's transaction; `initializeBoard` takes the trail a first write produced. `activityActor` attributes a tool call.
- `GET /api/kanban/activity` (+ `?before=<id>`), `readCardActivityFor`, `useKanbanCardActivity` with a backwards page and a newest-page merge, `Load older`.
- `components/KanbanCardDetail.tsx`: the comments block became the merged **Activity** journal (rail, glyphs, 10-minute same-actor grouping, `via <session>`, oldest first, composer under it, no auto-scroll).
- `kanban read { cardId }` carries the newest 5 rows as `{ kind, at, from?, to?, actor? }` + `activityTotal`; overview and search unchanged; output schema updated.
- Tests: `lib/kanban-activity.test.mjs` (12 cases: pure derivation incl. no-op/position-only/lane-deleted, one transaction + one revision, comments and refusals add none, actor attribution, paging, retention, card deletion, dead-link unlink, the bounded one-card read). Existing kanban suites green.
- Smoke: dev server on :30141, real board migrated 3 → 4 in place, a scratch card created/moved/renamed/edited then deleted (its trail went with it), desktop and phone screenshots read.

Deviations from the design, deliberate:

- No 60-code-point truncation of old titles: a row wraps instead (one less rule, and the full value is the point of the row).
- No character-delta in the description row's hover: `from`/`to` stay null for it, so there is nothing to hover.
- `Load older` pages **activity only**: the comment thread keeps its own single bounded read (newest 100), unchanged.
- The rail is continuous behind a comment card (the card is inset 24 px) rather than breaking above and below it — same read, one less layout rule.
