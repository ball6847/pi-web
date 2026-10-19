---
plan: ../../plans/2026-10-19/KANBAN_REAL_API_PLAN.md
scope: client + consumers + cleanup (kanban-client, kanban-consumers, kanban-cleanup-verify minus browser tests)
status: complete (browser TC-03/04/09 left to the orchestrator)
reportedAt: "2026-10-18T19:50:30Z"
---

# Kanban real API — client / consumers / cleanup report

Plan: [KANBAN_REAL_API_PLAN.md](../../plans/2026-10-19/KANBAN_REAL_API_PLAN.md) — `implementedAt` is now set (2026-10-18T19:49:51Z). Server phase: [KANBAN_REAL_API_SERVER_REPORT.md](KANBAN_REAL_API_SERVER_REPORT.md).

## Files
- **Created**: `lib/kanban.ts` (client cache, hooks, mutations).
- **Modified**: `components/KanbanBoard.tsx`, `components/KanbanLaneStrip.tsx`, `components/AppShell.tsx`, `components/SessionTree.tsx`, `components/SessionSidebar.tsx`, `components/NewSessionContextBar.tsx`, `lib/i18n/messages/{en,zh-CN,zh-TW}.ts` (+3 keys each: `kanban.loadingBoard`, `kanban.loadFailed`, `kanban.retry`; existing keys untouched), `docs/agents/kanban.md` (rewritten), `AGENTS.md` (File Map: route + 4 lib files; no generated block present/touched), plan frontmatter.
- **Deleted**: `lib/kanban-mock.ts`, `lib/kanban-mock.test.mjs` (no `kanban-mock` reference left in source).

## What was built (`lib/kanban.ts`)
- Module-level `Map` of entries keyed by the project root the caller passes (`projectRoot ?? cwd`); entry = `serverBoard` + `pending` writes folded into the shown `board` (useSessionUiState pattern), `revision`, status/error, in-flight guard, `loadId` (drops a GET that predates an adopted write).
- Hooks: `useKanbanBoard(dir)` (board | null), new `useKanbanBoardStatus(dir)` (`{status, error?, retry()}`), `useKanbanSessionIndex()` (same derivation / in-place `lastIndex` map as the mock, from loaded boards).
- Mutations keep exact names/signatures/sync return values: reducer via `applyKanbanAction` first (null → no post, nothing changes; same-board → no post), optimistic apply, POST one at a time per board, adopt `{board, revision}`; failure drops the pending write (rollback), status → `error`, quiet refetch. Client-chosen `cardId`/`laneId` used for add-card / add-lane / create-card-for-session.
- `session-missing` (404) is transient: write re-posted 3× (1.5 s apart) with the optimistic state kept; if still failing → rollback, error banner, the action is kept and **Retry** re-posts it.
- Polling: fetch on mount; `revOnly` every 2.5 s (= `RUNNING_SESSIONS_POLL_MS` in SessionSidebar; `AGENT_STATE_RECONCILE_MS` is 15 s and only runs while an agent runs, so I matched the sidebar's running-state poll, which is the plan's "~2 s"), skipped while hidden, one check when shown; refetch on `!==` revision. Polling runs only while a component watches the board (refcounted).
- Removed: `seedBoard`, `boardExists` (AppShell uses `kanbanContextDir !== null`), `kanbanSyncSeedLinks` (+ its AppShell effect), `kanbanEnsure`.

## Consumers
- `KanbanBoard`: `board` prop is now `KanbanBoardData | null`; the exported wrapper reads `useKanbanBoardStatus`; no board → `BoardShell` (same frame + header) with a slim `kanban.loadingBoard` placeholder or the error banner; board present → `KanbanBoardView` (the old body, unchanged) with the `BoardNotice` banner (one line + Retry) under the header when status is `error`. AppShell now renders `KanbanBoard` whenever the board view is open (it used to wait for a non-null board).
- `KanbanLaneStrip`: imports only (already returns null for a null board; no status UI).
- `ChatWindow.tsx`: does not import kanban-mock (only a `kanbanStrip` ReactNode prop) — untouched.

## Gates
- `node_modules/.bin/tsc --noEmit`: green. `npm run lint`: green.
- `npm test`: 2830 tests, 2827 pass, 2 fail — both the known pre-existing ones (models route removed-worktree; rpc-manager-chat-only #804). Count is 22 below the server report's 2852: the deleted mock tests (their rules live on in the 30 `kanban-shared` + 17 store tests).
- Curl smoke on 30141 (temp dir under $HOME): GET auto-creates `.pi/kanban.json`; `revOnly` returns a float; add-card POST ok; the POST response revision equals the following `revOnly` and full-GET revision (the poll will not refetch after an own write); link-session to an unknown session → 404 `session-missing`. Temp dir removed. `next build` never run; dev server not restarted.

## Deviations / notes
1. **Worktree keying**: the client keys by exactly the dir passed in. All call sites already pass `projectRoot ?? cwd` (`kanbanContextDir`, `handleSessionCreated`), so no resolution helper was added client-side (`lib/worktree.ts` is server-only, shells out to git); the server also matches worktree sessions to the project root (server report #9).
2. **Sidebar tracked marker scope**: `useKanbanSessionIndex` only sees boards loaded in this tab (current project, plus any board view opened). The mock saw every project's board. Watching every sidebar project would create `.pi/kanban.json` in each (GET auto-creates), so not done. Documented in `docs/agents/kanban.md`.
3. **Lane delete UI**: the config dialog still disables Remove for a lane with cards (`removable = count === 0`, existing key `kanban.configureRemoveBlocked` kept byte-identical) although the API now relocates cards to the backlog. Loosening it needs new copy; left as is.
4. `kanbanCreateCardForSession` with no loaded board posts blind (board adopted from the response); every other mutation is a no-op without a loaded board (`kanbanAddCard` returns null).
5. One banner string for load and write failures ("Couldn't load or save the board."); the server message is in the banner's `title`.
6. No unit tests for `lib/kanban.ts` (React/fetch module); left to the orchestrator's browser tests TC-03/04/09.
