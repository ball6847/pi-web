---
createdAt: "2026-10-18T19:06:12Z"
implementedAt: "2026-10-18T19:49:51Z"
reviewedAt: "2026-10-19T01:56:01Z"
---

# Plan: Replace the Kanban mock store with a real per-project API

## Background & Context

- **Business Driver**: The Kanban board ships today as pure UI on
  `lib/kanban-mock.ts` (in-memory + `localStorage`, seeded sample cards). Real
  users lose boards on browser reset, boards are per-browser not per-project,
  and nothing survives a pi-web server restart. This plan replaces the mock
  with server-side persistence.
- **Technical Context**: pi-web is a light web wrapper around pi. Server
  state already follows a known pattern (`lib/session-ui-state.ts`: locked
  read-modify-write, atomic write, corrupt backup, in-memory revision).
  Client state follows `hooks/useSessionUiState.ts` (optimistic writes +
  refetch on revision change). The mock store exports typed boards and ~15
  mutation functions plus two hooks; consumers are `components/KanbanBoard.tsx`,
  `components/KanbanLaneStrip.tsx`, and wiring in `components/AppShell.tsx`,
  `components/ChatWindow.tsx`, `components/NewSessionContextBar.tsx`,
  `components/SessionTree.tsx`, `components/SessionSidebar.tsx`.
- **Related Decisions**: Storage backend chosen by the user:
  `<projectDir>/.pi/kanban.json` (option 1 — travels with the project,
  git-committable, matches the existing `.pi/mcp.json` project-scoped
  precedent). Rejected: `~/.pi/agent/kanban/<encoded-cwd>.json` (project
  boards would not move with the project) and embedding in pi session
  `.jsonl` files (writes into pi-owned files).
- **User Impact**: A board per project, shared across browsers and devices
  on the same pi-web server, surviving restarts and browser resets.

## Key Information

### Success Criteria

- [ ] Board data persists server-side at `<projectDir>/.pi/kanban.json`
- [ ] All current UI interactions (add/edit/delete card, lane move, link/unlink
      session, lane configure) work through the API with optimistic updates
- [ ] Two browser tabs on the same server converge without refresh
- [ ] No consumer imports `kanban-mock` anymore; mock file and its test deleted
- [ ] `tsc --noEmit`, `eslint .`, and `npm test` all green
- [ ] Unit tests cover every server reducer and the corrupt-file path

### Acceptance Criteria

- Given a project with no `.pi/kanban.json`, when the board is opened, then an
  empty board with the default six lanes is created on disk and rendered.
- Given two open tabs on the board, when tab A moves a card, then tab B shows
  the move within its next poll tick without reload.
- Given a card linked to a session whose file was deleted, when the board is
  fetched, then the card is unlinked (title kept for display) and still sits in
  its lane.
- Given the server is down, when the user acts on a card, then the optimistic
  change is rolled back and an error/retry affordance appears.
- Given a `cwd` outside readable/non-existent, when any kanban route is hit,
  then a typed refusal (same style as `/api/cwd/validate` / `/api/mcp`) is
  returned and nothing is written.

### Assumptions

- **A1 — Lane movement stays manual**: linking a session to a card does NOT
  auto-move the card. Live status shown on the card comes from the existing
  running/awaiting ids, exactly as the mock renders it today. (User veto-able;
  not asked.)
- **A2 — Dead-session rule**: a linked session whose file no longer exists is
  pruned (unlinked) lazily on board read; the card keeps its lane and the
  snapshot title. (User veto-able; not asked.)
- **A3 — No seed**: real boards start with default lanes and zero cards.
  `seedCards`, `seedSynced`, `kanbanSyncSeedLinks`, and the sample-card
  offering flow are deleted, not replaced.
- **A4 — No localStorage import**: boards from the mock era are not migrated.
- **A5 — No trust gate**: `kanban.json` is pure data (no commands, no code);
  project-trust does not apply. It must never be executed or treated as config
  that spawns processes.

### Constraints

- Dev server discipline from AGENTS.md: port 30141, `npm run dev`, never
  `next build`; tests via `npm test`.
- Every consumer keeps its current function signatures (`kanbanAddCard(...)`
  etc.) — only the import path changes where possible, to keep the diff small.
- `components/*` stay client-safe: no `fs` imports; server logic lives in
  `lib/kanban-store.ts` (server-only) and the route.
- i18n parity across `en`, `zh-CN`, `zh-TW` for every new string.
- No new pi-web-only extension API surface (product principle).

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Optimistic write + poll race overwrites fresh data | Med | Med | Server returns the full board + revision on every mutation; client adopts the response, poll only refetches on revision change |
| `.pi/kanban.json` corrupted while user edits by hand | Med | Med | Same corrupt-backup flow as `lib/session-ui-state.ts` (`backUpCorruptFile`) |
| cwd outside allowed paths used to write elsewhere | Low | High | Validate cwd exactly like `app/api/mcp/route.ts` does before any read/write |
| Two pi-web processes write concurrently | Low | Med | Lock + atomic write pattern (`editState` reference) |
| UI consumers drift from new hook semantics | Med | Low | Hook names/signatures kept; loading/error surfaced via a new status hook only |

### Dependencies

- `lib/session-ui-state.ts` (lock/atomic-backup pattern to clone)
- `lib/session-ui-state-shared.ts` (client-safe request/apply types to mirror)
- `lib/session-reader.ts` (session-exists validation + path resolution)
- `lib/regular-file.ts` (`readRegularFileText`)
- `hooks/useSessionUiState.ts` (optimistic-write client pattern)
- `app/api/mcp/route.ts` (cwd validation + action-based POST style)

### Out of Scope

- Auto-advance lanes from session status (A1), undo, SSE push channel for the
  board, multi-board per project, localStorage import, dragging cards by mouse,
  commit-template `.gitignore` changes for `.pi/kanban.json`.

## Overview

Introduce a client-safe pure reducer module (`lib/kanban-shared.ts`) that owns
all board mutation rules (cards, lanes, links, pruning). The server wraps it
in a locked, atomic, per-project file store at `<cwd>/.pi/kanban.json` behind
one action-based route (`app/api/kanban/route.ts`). The client replaces the
mock's sync external store with an async-backed cache exposing the same
`useKanbanBoard(projectDir)` / mutation-function interface, refreshes via
`revision` polling, and rolls back on errors. Components keep their calls and
gain a small loading/error affordance.

## Target Structure

```
lib/
  kanban-types.ts            client-safe: KanbanLane/Card/Board, ids, defaultLanes
  kanban-shared.ts           client-safe: pure board reducers (no I/O)
  kanban-store.ts            server-only: path, lock, atomic write, backup, revision, session pruning
  kanban.ts                  client: board cache + hooks + fetch mutations
app/api/kanban/route.ts      GET ?cwd= (&revOnly=1) | POST { cwd, action, ... }
lib/kanban-shared.test.mjs   reducer unit tests (node:test, like kanban-mock.test.mjs)
lib/kanban-store.test.mjs    store round-trip + corrupt-file tests (tmp dirs)
components/
  KanbanBoard.tsx            modified: import path, loading/error states
  KanbanLaneStrip.tsx        modified: import path
docs/agents/kanban.md        rewritten for the real backend
```

## Reference Patterns

### Pattern: Locked read-modify-write of one JSON file

**Reference**: `lib/session-ui-state.ts` (whole file; also
`lib/session-ui-state-shared.ts` for the client-safe request types).

The new store copies this almost verbatim: `parseStateText` with a size cap,
`readRegularFileText`, an in-process edit queue with a typed `LockedError`,
atomic write through a temp sibling + rename, corrupt-file backup, and an
in-memory revision counter exported alongside `getRevision()`.

### Pattern: Optimistic client writes

**Reference**: `hooks/useSessionUiState.ts`

Apply locally, POST, adopt the server's returned value, refetch on error, and
refetch when the polled revision changes. Error rolls state back and exposes
a status the UI renders.

### Pattern: Action-based POST route with cwd validation

**Reference**: `app/api/mcp/route.ts` and `app/api/cwd/validate/route.ts`

One route file, `{ cwd, action, ...payload }` body, action dispatch with typed
refusals (`{ error, code }`), never a thrown stack to the browser. GET reads
are idempotent and side-effect-free apart from the documented board
auto-create on first read.

## Files to Create

### `lib/kanban-types.ts`

**Purpose**: Client-safe type + constant home for the kanban domain.

**Responsibilities**:
- `KanbanLane`, `KanbanCard`, `KanbanBoard` moved from the mock as-is (minus
  `seeded`/`seedSynced` fields)
- `makeKanbanId()`, `defaultLanes()`
- `KANBAN_SCHEMA_VERSION = 1` and the on-disk envelope:
  `{ schemaVersion, board }`

**Interface**:
```ts
export interface KanbanBoard { projectDir: string; lanes: KanbanLane[]; cards: KanbanCard[]; }
export function makeKanbanId(): string;
export function defaultLanes(): KanbanLane[];
```

**See Also**: `lib/kanban-mock.ts` (source of the shapes)

### `lib/kanban-shared.ts`

**Purpose**: Pure board reducers shared by the server route (authority) and
the client cache (optimistic application). No I/O, no `Date.now` at import
time; callers pass timestamps.

**Responsibilities**:
- One function per mutation, each `(board, ...args) => KanbanBoard` returning
  a new board (immutable), preserving lane order and card order within lanes
- Rules moved unchanged from the mock store:
  - add/update/delete card; one session = one card (relink moves the link);
    card cannot exist twice
  - move card: same-lane reorder constraint NOT required — moves are lane
    transitions only (`advanceCard` → next lane; direct `moveCardToLane`)
  - link/unlink keeps snapshot `sessionTitle`; unlink clears `sessionId` only
  - lane add/rename/move/delete with the fixed-lane invariants (first lane
    "backlog": never renamed/moved/deleted; deleting a lane relocates its
    cards to backlog, mock's current behavior)
  - `pruneDeadLinks(board, alive: Set<string>)`: unlinks cards whose
    `sessionId` is not in `alive`
  - backlog is the only lane allowed to hold sessionless cards at REST (the
    mock's guard: moving a sessionless card to a work lane is refused) —
    carries over unchanged
- Lookup helpers moved as-is: `laneById`, `laneIndex`, `cardsOfLane`,
  `cardForSession`, `firstWorkLane`, `cardLaneOf`

**Interface**:
```ts
export function addCard(board: KanbanBoard, laneId: string, input: {...}, now: number): KanbanBoard;
export function updateCard(board: KanbanBoard, cardId: string, patch: {...}, now: number): KanbanBoard;
export function deleteCard(board: KanbanBoard, cardId: string): KanbanBoard;
export function moveCardToLane(board: KanbanBoard, cardId: string, laneId: string, now: number): KanbanBoard | null;
export function advanceCard(board: KanbanBoard, cardId: string, now: number): KanbanBoard | null;
export function linkCard(board, cardId, sessionId, sessionTitle, now): KanbanBoard | null;
export function unlinkCard(board, cardId, now): KanbanBoard;
export function addLane/renameLane/moveLane/deleteLane(...): KanbanBoard | null;
export function pruneDeadLinks(board, aliveSessionIds: Set<string>, now): KanbanBoard;
export function createCardForSession(board, sessionId, sessionTitle, laneId | null, now): KanbanBoard;
```

`null` returns mean "refused" (guard violated); callers surface the refusal.

**See Also**: mutation methods in `lib/kanban-mock.ts`

### `lib/kanban-store.ts`

**Purpose**: Server-only per-project store at `<projectDir>/.pi/kanban.json`.

**Responsibilities**:
- Path: `join(cwd, ".pi", "kanban.json")`; cwd resolution + readability/trust
  checks identical to `app/api/mcp/route.ts`'s project handling
- `readBoard(cwd)`: read + parse envelope; missing file → auto-create empty
  board with default lanes and persist; corrupt file → backup (mirror
  `backUpCorruptFile`) and auto-create
- Write path: `editBoard(cwd, request)` = lock → read → apply
  `kanban-shared` reducer → validate invariants → write atomically (temp +
  rename) → bump in-memory revision → return the new board
- `getBoardRevision(cwd)`: `max(inMemCounter, fileMtimeMs)` — mtime part makes
  edits from another process or another pi-web server visible
- `applyDeadLinkPruning(board, cwd, aliveSessionIds)`: called on every read;
  if pruning changes the board the new board is written through `editBoard`
- `validateSession(cwd, sessionId)`: the session file exists for that cwd
  (use `lib/session-reader.ts` path resolution), refuse otherwise
- Refusals returned as typed results (never throw a stack to the route)

**Interface**:
```ts
export async function readBoard(cwd: string): Promise<KanbanBoard>;
export async function getBoardRevision(cwd: string): Promise<number>;
export async function applyMutation(cwd: string, action: KanbanAction): Promise<
  { ok: true; board: KanbanBoard; revision: number } | { ok: false; code: string; error: string }>;
```

**See Also**: `lib/session-ui-state.ts` (pattern), `lib/mcp-config-file.ts`
(atomic write precedent)

### `app/api/kanban/route.ts`

**Purpose**: Single action-based route for the board.

**Actions** (POST body `{ cwd, action, ...payload }`):
`add-card`, `edit-card`, `delete-card`, `move-card`, `advance-card`,
`link-session`, `unlink-session`, `create-card-for-session`,
`add-lane`, `rename-lane`, `move-lane`, `delete-lane`

**Behavior**:
- `GET ?cwd=` → `{ board, revision }` (auto-create on first read)
- `GET ?cwd=&revOnly=1` → `{ revision }` only (client poll; no file write,
  no pruning — pure stat)
- POST: validate cwd (readable existing directory, as `/api/mcp` does);
  validate payload shapes; call `applyMutation`; return `{ board, revision }`
  or `{ error, code }` with appropriate status (400 invalid, 404 session
  missing, 423 locked, 500 otherwise)
- `link-session` verifies the session exists (`validateSession`)
- After every successful mutation the route runs dead-link pruning on the
  resulting board so self-inflicted dangling links disappear immediately

### `lib/kanban.ts`

**Purpose**: Client store + hooks replacing the mock's public surface with
the same signatures.

**Responsibilities**:
- Module-level board cache keyed by `projectDir` + subscriber set (external
  store shape like the mock); `useKanbanBoard(projectDir)` returns the cached
  board or `null` while loading
- `useKanbanBoardStatus(projectDir)` (new): `'loading' | 'ready' | 'error'`
  for the small UX affordance (banner + retry in `KanbanBoard`, nothing at
  all in the strip — strip renders nothing until ready)
- Fetch-on-mount; poll `revOnly` on the same visibility-aware cadence the app
  already uses for running-state polling; refetch board when revision changes
- Mutation wrappers renamed-intact (`kanbanAddCard`, …): optimistic local
  apply via `kanban-shared`, POST, adopt response `{ board, revision }`,
  refetch+status `error` on failure
- `useKanbanSessionIndex()` unchanged in contract: `Map<sessionId,
  KanbanSessionInfo>` derived from the cached board
- Retry: status hook's `retry()` clears error and refetches

### `lib/kanban-shared.test.mjs`

**Purpose**: Port of the 22 existing rule tests + new cases, now against pure
reducers (no localStorage, no subscriber timing).

### `lib/kanban-store.test.mjs`

**Purpose**: Store behavior against temp project dirs: auto-create, envelope
round-trip, corrupt-file backup, revision via mtime, refusal on locked
concurrent edit if practical, session validation+pruning using a fabricated
`~/.pi/agent/sessions/<encoded>` layout in a temp `PI_AGENT_DIR`-style
override (follow how existing store tests fake paths).

## Files to Modify

### `components/KanbanBoard.tsx`

1. **Modify imports** — from `kanban-mock` to `kanban-types` + `kanban`.
2. **Add loading/error affordance** — `useKanbanBoardStatus`; loading shows a
   slim inline placeholder in place of lanes; error shows a one-line banner
   with retry (reuse Settings/notice styling; new i18n keys
   `kanban.loadingBoard`, `kanban.loadFailed`, `kanban.retry`).
3. **Keep every call site** — mutation functions have identical signatures;
   they are now async but existing call sites fire-and-forget.

### `components/KanbanLaneStrip.tsx`

**Modify imports** only; renders nothing until board ready (status not
needed — a strip flash is worse than momentary absence).

### `components/AppShell.tsx`, `components/ChatWindow.tsx`, `components/NewSessionContextBar.tsx`, `components/SessionTree.tsx`, `components/SessionSidebar.tsx`

**Modify imports** from `kanban-mock` to the new modules. **Remove**
`kanbanSyncSeedLinks` usage from the `handleSelectSession`/board-sync path
(Assumption A3).

### `lib/i18n/messages/{en,zh-CN,zh-TW}.ts`

**Add** the three new keys in all three locales; keep the existing 52 kanban
keys untouched.

### `docs/agents/kanban.md`

**Rewrite**: real backend architecture, file location and envelope, route
contract, pruning rule, the session-status badge source of truth. Keep the
UI-section notes that are still true.

## Files to Delete

| File | Reason | Migration Notes |
|------|--------|-----------------|
| `lib/kanban-mock.ts` | Superseded by real store + shared reducers | Check zero imports remain first |
| `lib/kanban-mock.test.mjs` | Superseded by the two new test files | Keep until new tests pass in the same run |

## Diagrams

### Sequence Diagram (load + optimistic mutation + cross-tab sync)

```
Tab A            pi-web server            <cwd>/.pi/kanban.json       Tab B
  |  GET ?cwd= ->|                            |                         |
  |<- board,rev -|  [auto-create if missing]  |                         |
  |  POST move   ->|  lock/read/reducer/write |                         |
  |<- board,rev2 -|                           |   GET ?cwd=revOnly <-  -|
  |                                             (rev2 > rev) -> refetch-|
  |                                        <- board,rev2 --------------|
```

### State Transition Diagram (card link lifecycle)

```
[Sessionless (backlog only)]
   | create / edit                                            
   v link a session (must be an existing session of cwd)
[Linked] --advance/move--> [Linked, other lane]
   |        ^      (lane move never touches the link)
   | session deleted outside
   v
[Unlinked + keeps snapshot title] --user links again--> [Linked]
```

## Test Cases

### TC-01: First open creates an empty real board

**Priority:** P0 **Type:** Integration

#### Objective
Auto-create must write `<cwd>/.pi/kanban.json` with default lanes, zero
cards, schema envelope.

#### Preconditions
- Temp project dir without `.pi/`

#### Test Steps
1. `readBoard(tmp)` and inspect file bytes.
   **Expected:** file exists, `schemaVersion=1`, 6 default lanes, 0 cards.

#### Post-conditions
- Second `readBoard` does not rewrite timestamps or lanes.

### TC-02: All reducers preserve mock rules

**Priority:** P0 **Type:** Functional (port of the existing 22)

#### Objective
One session = one card, backlog-only sessionless guard, fixed-lane invariants,
unlink snapshot, advance boundary at last lane.

#### Test Steps
1. Run `lib/kanban-shared.test.mjs`.
   **Expected:** all pass.

### TC-03: Optimistic move + server adoption

**Priority:** P0 **Type:** UI

#### Test Steps
1. In a visible browser tab, move a linked card one lane via its menu.
   **Expected:** lane moves immediately; after the POST resolves the board is
   unchanged (server adopted the same result, no flicker back).
2. Reload the page.
   **Expected:** move persisted.

### TC-04: Cross-tab convergence

**Priority:** P0 **Type:** Integration (manual in browser)

#### Test Steps
1. Open the same project board in two tabs.
2. In A: rename a lane.
   **Expected:** B shows the new name within one poll interval (≤ the running
   polling cadence, currently ~2 s) without interaction.

### TC-05: Dead session pruned on read

**Priority:** P0 **Type:** Functional

#### Test Steps
1. Link a card to a real session; delete that session file on disk.
2. `readBoard(cwd)`.
   **Expected:** card unlinked, `sessionTitle` kept, lane unchanged, new
   revision written.

### TC-06: Link refuses unknown session

**Priority:** P1 **Type:** Negative

#### Test Steps
1. POST `link-session` with a sessionId that does not exist in cwd.
   **Expected:** 404-style typed refusal; board and revision unchanged.

### TC-07: Corrupt kanban.json recovers

**Priority:** P1 **Type:** Regression

#### Test Steps
1. Write garbage bytes into `.pi/kanban.json`.
2. `readBoard(cwd)`.
   **Expected:** a backup sibling file created (same scheme as
   session-ui-state), fresh default board returned and persisted; no throw.

### TC-08: cwd validation

**Priority:** P1 **Type:** Security

#### Test Steps
1. POST with `cwd=/definitely/not/a/pi-web/project` and with a file (not dir).
   **Expected:** typed refusal; nothing on disk.

### TC-09: Loading and error affordance

**Priority:** P1 **Type:** UI

#### Test Steps
1. Throttle route (or point client at `?cwd=bad`) — board area shows the
   loading placeholder then the error banner with retry.
   **Expected:** Retry recovers; no layout jump of the lane columns when
   ready.

### TC-10: Revision sees external edit

**Priority:** P2 **Type:** Integration

#### Test Steps
1. Edit `.pi/kanban.json` by hand (bump card lane, valid file).
2. Wait one poll in the client.
   **Expected:** board reflects the file (mtime beats in-memory revision).

### TC-11: i18n + type safety

**Priority:** P2 **Type:** Regression

#### Test Steps
1. `tsc --noEmit`, `eslint .`, grep each new key in all three locales.
   **Expected:** green; keys present in en, zh-CN, zh-TW.

## Verification Commands

```bash
node_modules/.bin/tsc --noEmit
npm run lint
npm test
# Manual (visible tab, dev server on 30141): TC-03, TC-04, TC-09
```

## Expected Outcome

The Kanban board persists per project on disk, shared across browsers and
devices hitting the same server; UI behavior otherwise identical to today.
No mock code remains. Rollback is one git revert.

## Rollback Plan

1. `git revert` the implementation commits (mock returns intact on the branch
   history).
2. Any created `.pi/kanban.json` files are inert for the mock build; delete
   when convenient.

## Related Links

- Pattern source: `lib/session-ui-state.ts`, `lib/session-ui-state-shared.ts`
- Route style source: `app/api/mcp/route.ts`
- Design note being updated: `docs/agents/kanban.md`

## Post-Implementation Notes (2026-10-19, review)

- Two "mock behavior" claims in this plan were wrong: the mock never had `moveCardToLane` (only `advanceCard`) and had no sessionless→work-lane guard; `kanban-shared` adds both. The mock's `deleteLane` refused non-empty lanes (it did not relocate); the API now relocates, while the UI keeps the refusal to avoid silently unlinking live sessions.
- `GET ?cwd=&create=0` (non-creating read) was added after review: the strip and composer watchers use it, so merely selecting a session never creates `.pi/kanban.json`; only the board view creates.
- The final revision-poll cadence is 2.5 s (`KANBAN_POLL_MS`); TC-04's "~2 s" predates the final value.
- **Superseded storage decision**: the Related-Decision above (option 1, `git-committable`,
  "Rejected: `~/.pi/agent/kanban/…`") was overridden by the operator's 2026-10-19
  milestone (GOAL.md M4): per-project storage forks per worktree and drags task
  data through version control, so the board moves to `~/.pi/agent/kanban/` and
  the committable property is dropped by design. See
  `KANBAN_SHARED_STORAGE_PLAN.md` in this folder (pending sign-off); when it
  lands, this plan's file-location references describe history, not current
  behavior. `docs/agents/kanban.md` remains the current source of truth.
