---
plan: ../../plans/2026-10-19/KANBAN_REAL_API_PLAN.md
scope: server-side only (kanban-core + kanban-store-route)
status: partial — server phase complete; client / consumers / cleanup NOT started
reportedAt: "2026-10-18T19:40:32Z"
---

# Kanban real API — server-side implementation report

Plan: [KANBAN_REAL_API_PLAN.md](../../plans/2026-10-19/KANBAN_REAL_API_PLAN.md).
`implementedAt` in the plan is **not** set (partial implementation).

## Progress state

| Deliverable | State |
|---|---|
| `lib/kanban-types.ts` | done |
| `lib/kanban-shared.ts` | done |
| `lib/kanban-shared.test.mjs` | done — 30 tests, all pass |
| `lib/kanban-store.ts` | done |
| `app/api/kanban/route.ts` | done (curl-smoked: bad cwd → typed 400, `revOnly` → `{revision:0}`, nothing written) |
| `lib/kanban-store.test.mjs` | done — 17 tests, all pass |

Not touched (later phase): `lib/kanban.ts` (client), `components/*`, `lib/i18n/**`, `docs/**`, `lib/kanban-mock.ts` + its test (mock still builds; untouched).

## Gates

- `node_modules/.bin/tsc --noEmit`: green
- `npm run lint` (eslint .): green
- `npm test`: 2852 tests, 2849 pass, **2 fail — pre-existing, unrelated** (neither touches kanban; not fixed):
  - `app/api/models/route.test.mjs` "a removed worktree is listed from the repo it branched from"
  - `lib/rpc-manager-chat-only.integration.test.mjs` "Chat only names a model only an extension provides … (#804)"
- `next build` never run; dev server on 30141 untouched.

## Contract the client can rely on

- `GET /api/kanban?cwd=` → `{ board, revision }`; `&revOnly=1` → `{ revision }` (pure stat; 0 when no board written yet).
- `POST { cwd, action, ... }` → `{ board, revision }` or `{ error, code }`.
- Types for the actions (`KanbanAction`, `KANBAN_ACTION_NAMES`, `KanbanBoardResponse`) are in `lib/kanban-types.ts`; `applyKanbanAction(board, action, now)` in `lib/kanban-shared.ts` lets the client apply the same reducer optimistically.
- `add-card` / `create-card-for-session` / `add-lane` accept an optional client-chosen `cardId` / `laneId`, so an optimistic card and the server's card share an id (a duplicate id is refused).
- Status mapping: 400 `cwd-invalid` / `cwd-not-directory` / `refused` (a board rule) / `invalid-request`; 403 `cwd-denied` (and `request-denied`); 404 `session-missing`; 415 content-type; 423 `locked`; 500 `internal` / `unsupported-schema`.
- Revision is a float (`max(counter, mtimeMs)`); compare with `!==`, never as an integer.

## Deviations / interpretations (read these)

1. **Store functions return typed results, not bare boards.** `readBoard(cwd)` → `{ok:true, board, revision} | {ok:false, code, error}` (plan had `Promise<KanbanBoard>`); `getBoardRevision(cwd)` → `{ok:true, revision} | failure`. This follows the "never throw at callers" instruction.
2. **Session validation lives in `applyMutation`, not the route**, so the store is self-contained and TC-06 is testable at store level. It also runs for `add-card` when a `sessionId` is given. A refusal happens *before* any lock/mkdir: nothing is written.
3. **Pruning runs inside the same lock as the mutation** (and on every read); a read only writes when something was actually dead.
4. **Reducers return `KanbanBoard | null`** where the plan interface said `KanbanBoard` (`addCard`, `updateCard`): the mock refused blank titles / unknown lanes / unknown cards, which needs a refusal channel. No-op edits return the *same object* (identity = "nothing changed", used by the store to skip writes).
5. **`unlink` keeps `sessionTitle`** (per the brief / A2); the mock cleared both. The "relinking moves the link" drop on the *old* card also keeps its snapshot title for the same reason.
6. **`deleteLane` relocates cards to backlog** (brief + plan text) — this is **not** the mock's actual behavior: the mock *refused* deleting a lane holding cards. Plan-vs-mock contradiction; I followed the brief. Because the backlog holds no session, a relocated card that carried one is **unlinked (title kept)**.
7. **"Sessionless card → work lane refused" applies to `moveCardToLane` only.** The mock has no such guard on advance, and its test "advanceCard moves a backlog card one lane right" requires `advanceCard` to keep working on sessionless backlog cards, so `advanceCard` is unguarded (null only at last lane / unknown card). Also added (my call, keeps the backlog invariant): a card **with** a session cannot be moved *into* the backlog (null). Both are easy to loosen.
8. **`cwd` statuses follow `/api/mcp`**, not a blanket 404: invalid/not-directory 400, denied 403. A non-existent folder reports `cwd-denied` (403), same as `/api/mcp`, because the allowed-roots check precedes the directory check ("same answer whether or not it exists"). `cwd` validation reuses `validateMcpProject()` verbatim.
9. **Session ↔ cwd match**: a session belongs to the board if its header `cwd` equals the board folder **or** its `resolveProject(header.cwd).projectRoot` does. The client keys boards by `session.projectRoot ?? session.cwd`, so a worktree session would otherwise be refused/pruned wrongly. Existence = cached path re-verified with `existsSync` (stale path cache after deletion is invalidated and re-resolved).
10. **Own atomic writer** (temp sibling + rename, mode 0644 preserved) instead of `writePrivateFileAtomicSync` (0600): `kanban.json` is meant to be committable project data. Lock = `proper-lockfile` + `serializeByKey`, exactly as `session-ui-state`.
11. Lenient read of hand-edited files: invalid cards skipped, cards in a vanished lane → backlog (unlinked), a session carried twice stays on its first card, `projectDir` always overwritten with the folder read (board travels with the project). Bad shape/first lane not fixed → treated as corrupt (backup + fresh). **`schemaVersion > 1` is refused (`unsupported-schema`, 500) and the file left untouched** rather than backed up and replaced.
12. Mock-only tests not ported (A3/no localStorage): `boardExists`, seeding determinism, 3× `syncSeedLinks`, subscriber-tick. The remaining mock rules are ported against the pure reducers; 30 shared tests cover them plus the four requested additions and more (immutability, action dispatch, lookups, move-to-lane guards).

## Risks / things for the next phase

- **A new session's file may not exist yet** (pi flushes the session file lazily). `create-card-for-session` / `link-session` 404 and dead-link pruning would hit a session in that window. The AppShell calls these after the session gets its real id (after the first message), so it should be fine, but the client should treat `session-missing` as retryable/ignorable, not fatal.
- Pruning of a *dead* session costs a directory scan (`resolveSessionPath` fallback to `listAllSessions`, 30 s cached) — paid once, since the link is removed afterwards.
- `npm test` file discovery is `lib/**/*.test.mjs`; both new test files are picked up. The lock test waits ~3.3 s (real retry window).
- I accidentally ran `git stash -u` once at the end and popped it immediately; all files verified restored (git status shows only the new files).
