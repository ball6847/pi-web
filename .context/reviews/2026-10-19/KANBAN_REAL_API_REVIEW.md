---
createdAt: "2026-10-18T19:58:00Z"
planPath: "../../plans/2026-10-19/KANBAN_REAL_API_PLAN.md"
implementationReportPaths:
  - "../../implementation-reports/2026-10-19/KANBAN_REAL_API_SERVER_REPORT.md"
  - "../../implementation-reports/2026-10-19/KANBAN_REAL_API_CLIENT_REPORT.md"
---

# Review Report: Kanban real per-project API

## Verdict

**PASS-WITH-FIXES**

The architecture, reducers, store, route and optimistic client match the plan, and I found no race that loses data. One must-fix: merely selecting a session writes `.pi/kanban.json` into that project. One must-do before acceptance: the three browser test cases (TC-03, TC-04, TC-09) are unrun. Everything else is should-fix or nice-to-have.

Verified in this pass (read-only): `node --test lib/kanban-shared.test.mjs lib/kanban-store.test.mjs` gives 47/47 pass. `tsc --noEmit` is clean. `npm run lint` is clean. I did not rerun the full `npm test`. The two failures the builders report (models-route worktree test, rpc-manager #804) are unrelated to kanban, and I did not verify them as pre-existing on a clean tree.

## Focus 1 — Optimistic-write flow (`lib/kanban.ts`)

No clobber race found. Walk-through:

- **Rollback** (`runWrite`, :307-345). It drops only the failed `PendingWrite` and republishes `serverBoard ∘ remaining pending`. `serverBoard` is only ever replaced by adopted answers, so a rollback cannot overwrite newer adopted state. Writes are serialized per board through `writeChain`.
- **Adoption** (:311-318). `loadId++`, `adopt`, drop the write, `publish`. The next write's pending state is folded on top, so there is no flicker-back. A stale GET is discarded by `loadId` (:216). The POST revision equals the following `revOnly` (store `noteWrite`/`revisionOf`, `kanban-store.ts:131-146`), so there is no refetch after an own write.
- **Poll** (:234-243). It is skipped while `pending.length > 0` or while `fetching`, and re-checked after the await. If a write finishes mid-poll, the poll sees an older revision, `!==` triggers one redundant GET, and that GET reads post-write server state. This is harmless. Polling is visibility-aware, with one check on show. It is refcounted.
- **`session-missing`** (:323-328). The write is re-posted 3 times at 1.5 s while the optimistic state stays. The poll is suppressed during this window because `pending > 0`. After exhaustion the write is rolled back and the action is kept in `retryable` for Retry. This is correct.

Residual issues:

- **Double-apply window (should-fix, minor).** A GET that started before a write was enqueued and was served after the server applied that write gets adopted at :216. `loadId` has not moved yet, because the POST response is still pending. `publish` then re-applies the pending write on top of a board that already contains it. Every action is idempotent or refused when re-applied (duplicate ids, deletes) except `advance-card`. The card shows two lanes ahead for about one round-trip, until the POST response is adopted. Fix: `kanban.ts:216` — change the guard to `if ((loadId !== entry.loadId || entry.pending.length > 0) && entry.serverBoard) return;`. The next poll catches any real remote change.
- **Stuck load error (minor).** `acquire` (:286) never refetches while `error !== null`, and polling skips entries without a `serverBoard`. A failed first load or a failed blind create waits for the Retry click. The blind `kanbanCreateCardForSession` (:503) can also leave `status: error` with no board. This is acceptable for v1 and reachable only if the board is not loaded at that point.
- **Banner persistence (minor).** A write error banner persists until Retry or the next successful write. A later successful poll does not clear it.
- **No unit tests for `lib/kanban.ts`.** This is the highest-risk logic and it has no automated coverage. The plan required only manual TC-03/04/09, so this is not a plan violation, but it is a gap against TDD discipline. Treat it as a follow-up: export a `createKanbanStore({ fetch, now })` core that can be tested under node:test with a fake fetch.

## Focus 2 — Known deviations

**(a) Sidebar tracked marker only for boards loaded in this tab — acceptable for v1, with a prerequisite.**

- The marker still works for the project the user is working in, because `AppShell` watches `kanbanContextDir` for the selected session (`AppShell.tsx:1358`).
- It is missing for sessions in unvisited projects, and after a reload until each project is visited. That is a visible regression against the mock, but the marker is secondary and not a workflow blocker.
- The real fix (watching every sidebar project) is unsafe today because any GET creates `.pi/kanban.json` (see Must-fix 1). After Must-fix 1, the follow-up is a non-creating `peek` read per sidebar project, with polling limited to the visible project(s). Do not do it in this change.
- It is documented in `docs/agents/kanban.md`.

**(b) Lane-config dialog blocks Remove on a non-empty lane while the API relocates — KEEP the UI block; do not loosen it in this change.**

- `components/KanbanBoard.tsx:1107` (`removable = !lane.fixed && count === 0`) matches the mock's real behavior and the "all current UI interactions" criterion. The plan text was wrong about the mock.
- `deleteLane` unlinks the session of every relocated card (`kanban-shared.ts:259-270`). Allowing it from the UI would silently sever live session links, with no confirmation and no undo.
- The API relocation can also hit a card another tab added to the lane a moment earlier. That is acceptable server-side semantics, documented in `kanban.md`.
- `kanban.configureNote` ("A lane with cards can't be removed.") and `kanban.configureRemoveBlocked` stay true and need no change.
- The plan text should be corrected in a follow-up note. No code change is needed.
- If the owner later wants relocate-on-delete in the UI, it needs a confirm step. Use these strings (new keys `kanban.configureRemoveRelocates` and `kanban.configureNoteRelocates`, replacing the last sentence of `configureNote` and the `removable` gate):
  - en: `"Remove lane — its {count} cards move to the Backlog and unlink from their sessions"` and `"Removing a lane moves its cards to the Backlog and unlinks their sessions."`
  - zh-CN: `"删除泳道：其中 {count} 张卡片将移至待办区并取消会话关联"` and `"删除泳道会把其中的卡片移至待办区（Backlog）并取消其会话关联。"`
  - zh-TW: `"移除泳道：其中 {count} 張卡片將移至待辦區並解除工作階段關聯"` and `"移除泳道會把其中的卡片移至待辦區（Backlog），並解除其工作階段關聯。"`

## Focus 3 — Reducer parity (`lib/kanban-shared.ts` vs `git show HEAD:lib/kanban-mock.ts`)

Parity holds. Findings:

- **The plan was wrong about a mock guard.** The mock had no `moveCardToLane` and no "sessionless → work lane" guard. Its only transitions were `advanceCard` and `linkCard`. The shared module adds `moveCardToLane` with that guard plus the new linked-card → backlog refusal (`:129-139`). `advanceCard` stays unguarded (`:144-151`), which matches the mock and its ported test. No UI uses `move-card`. Reducer + route only is acceptable and tested (shared tests at :189-211).
- **One session, one card** is preserved. `linkCard` is stricter than the mock: it refuses before dropping the old link, so a refused link no longer strips another card (tested at :138). `createCardForSession` reuses the existing card exactly as the mock did.
- **Unlink keeps the snapshot title** per plan/A2. The mock cleared it, which is a deliberate change and is tested.
- **Backlog invariants.** Never renamed, moved or deleted, and no swap past it. Same as the mock.
- **`pruneDeadLinks`.** Clears `sessionId` only; the lane and title are kept. It returns the same object when nothing was dead.
- **Gap (nice-to-have).** `addCard` (`:75`) accepts a `sessionId` with `laneId = backlog`, as the mock did. The linked-in-backlog invariant that `moveCardToLane` and `linkCard` enforce is bypassable through `add-card`. Fix: in `addCard`, return null when `input.sessionId` is set and the target lane is `fixed`. Add one test line.

## Focus 4 — Server contract

- **Status codes** (`route.ts:45-54`): 400 `cwd-invalid`/`cwd-not-directory`/`refused`/`invalid-request`; 403 `cwd-denied`/`request-denied`; 404 `session-missing`; 415 content-type; 423 `locked`; 500 `internal`/`unsupported-schema`. This matches the plan and the `/api/mcp` style. The cwd check comes before payload parsing.
- **`revOnly` purity.** `getBoardRevision` is `validateKanbanCwd` plus one `statSync` (`kanban-store.ts:149-153`). It does no parse, no write and no prune.
- **Auto-create on first GET.** Done through `readBoard` → `editBoard` with `fresh = true` (`:405-424`). Concurrent first GETs are serialized and the second one is a no-op. The unlocked fast path is safe because the write is an atomic rename.
- **Envelope and `schemaVersion`.** The envelope is written correctly. `schemaVersion > 1` is refused (500) and the file is left alone, which is better than back-up-and-replace. Hand-edited files are read leniently. Corrupt files are backed up as `.corrupt-<ms>`.
- **Lock, queue and atomic write** follow the `session-ui-state.ts` pattern: `serializeByKey` plus `proper-lockfile` with the same options. The temp file is written with `wx` plus rename, with mode 0644 kept (committable), so the 0600 helper's divergence is justified. The revision is `max(counter, mtime)` and `noteWrite` forces strict forward movement.
- **Cost (nice-to-have).** Every read and every mutation validates every linked session (header read, plus `resolveProject` for non-matching cwds). Fine for now. Revisit if boards grow past dozens of linked sessions.
- **Concern (should-fix).** `GET` can write (create, prune) but has no `isApiRequestAllowed` check, while POST does (`route.ts:154` vs :171). A cross-site no-cors GET could create `.pi/kanban.json` in any allowed project. Fix: in `GET`, when `revOnly` is not `"1"`, call `isApiRequestAllowed(req)` and return 403 `request-denied` if it fails (same refusal helper as POST).

## Focus 5 — Client safety and repo discipline

- No `node:` imports in `kanban.ts`, `kanban-shared.ts` or `kanban-types.ts`. The only matches are comments.
- No `kanban-mock` reference remains. The mock and its test are deleted (staged `D`).
- AGENTS.md File Map has the route plus the four lib entries and they match reality.
- `docs/agents/kanban.md` matches the code. It also records the honest trap "Reading a board creates `.pi/kanban.json` … do not watch boards speculatively", which the shipped `AppShell` wiring itself violates (see Must-fix 1).
- i18n: the three new keys are present in all three locales. The existing keys are untouched.
- `ChatWindow.tsx` was in the plan's modify list but needed no change; it only takes a `kanbanStrip` node.

## Focus 6 — Plan success criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Board persists at `<projectDir>/.pi/kanban.json` | ✅ Store tests and curl smoke |
| 2 | All UI interactions work via the API, optimistically | ◐ Code complete, but browser TC-03/TC-09 not run |
| 3 | Two tabs converge without refresh | ◐ By design (revision poll, TC-04 in code), but not run in a browser |
| 4 | No consumer imports `kanban-mock`; files deleted | ✅ |
| 5 | `tsc`, `eslint`, `npm test` all green | ◐ `tsc` and lint green. The full run has 2 unrelated failures that the builders report as pre-existing (not verified by me). All kanban tests pass. |
| 6 | Unit tests cover every server reducer and the corrupt-file path | ✅ 30 shared + 17 store tests: every reducer, dispatch, corrupt, newer-schema, lenient read, prune, revision, lock, TC-06, TC-08 |

Acceptance criteria:

- **Empty board with six lanes is created on disk on first open:** ✅ in store tests.
- **Dead-session unlink with kept title:** ✅.
- **Server-down rollback plus Retry:** logic is correct, but it has not been exercised in a browser.
- **cwd validation:** ✅.

## Diagrams and test cases

- **Sequence diagram:** ✅. Load, auto-create, POST-adopt and `revOnly` → refetch match the code.
- **State diagram:** ✅. A pruned or unlinked card keeps its lane and title, and can be relinked.
- **TC-01, 02, 05, 06, 07, 08, 10, 11:** covered or verified.
- **TC-03, TC-04, TC-09:** manual browser cases, unrun.

## Ranked fix list

### Must-fix

1. **Selecting a session writes `.pi/kanban.json` into that project.** `AppShell.tsx:1358` calls `useKanbanBoard(kanbanContextDir)` for every selected session. That triggers the auto-creating GET. The acceptance criterion says the file is created "when the board is opened", and this dirties the git tree of every project a user merely browses. Minimal change:
   - `lib/kanban-store.ts`: give `readBoard(cwd, { create })` an option. With `create: false` and a missing file, return `{ ok: true, board: emptyBoard(cwd), revision: 0 }` with no write. The first mutation already creates the file through `editBoard`'s fresh path.
   - `app/api/kanban/route.ts`: accept `GET ?cwd=&create=0` and pass it through.
   - `lib/kanban.ts`: use `create=0` for watchers from `useKanbanBoard` (strip, composer). Use a creating GET only for `useKanbanBoardStatus`/board-view watchers; track which one an entry has via a counter next to `watchers`. Apply the Focus 4 `isApiRequestAllowed` gate to the creating branch.
   - `docs/agents/kanban.md`: update the "Traps" bullet.
   - Add a store test: a `create: false` read of a missing file writes nothing and returns revision 0.

2. **Run TC-03, TC-04 and TC-09 in a visible browser tab before accepting.** They are the only checks that cover the optimistic flow, cross-tab convergence and the error/retry banner. This is an acceptance step, not a code change.

### Should-fix

3. Double-apply window: the one-line guard change at `lib/kanban.ts:216` (Focus 1).
4. Add `isApiRequestAllowed` to the write-capable GET path (folded into Must-fix 1; Focus 4).
5. Extract a testable core from `lib/kanban.ts` and add tests for rollback, adoption, `session-missing` retry and the poll skip.

### Nice-to-have

6. `addCard` should refuse a sessioned card into the backlog (Focus 3).
7. Auto-clear the write-error banner after a successful revision-poll refetch, and let `acquire` retry a failed first load once.
8. Follow-up: a non-creating multi-project peek for the sidebar marker (Focus 2a).
9. Note in the plan that the "mock behavior" statements for `deleteLane` and the move guard were incorrect.

## Obstacles Resolution

| Obstacle (from reports) | Status | Resolution |
|---|---|---|
| New session file not yet on disk causes `session-missing` | ✅ Resolved | Client retries 3× at 1.5 s, then rollback plus a retryable action |
| Worktree sessions vs project-root board key | ✅ Resolved | Server matches `header.cwd` or `resolveProject().projectRoot` |
| `deleteLane` plan-vs-mock contradiction | ◐ Handled | The API relocates and the UI keeps the block (Focus 2b) |
| `git stash -u` incident in the server phase | ✅ No residue | Working tree consistent; new files all present |

## Related Links

- Plan: [KANBAN_REAL_API_PLAN.md](../../plans/2026-10-19/KANBAN_REAL_API_PLAN.md)
- Server report: [KANBAN_REAL_API_SERVER_REPORT.md](../../implementation-reports/2026-10-19/KANBAN_REAL_API_SERVER_REPORT.md)
- Client report: [KANBAN_REAL_API_CLIENT_REPORT.md](../../implementation-reports/2026-10-19/KANBAN_REAL_API_CLIENT_REPORT.md)

## Reviewer Notes

- Per instructions, `reviewedAt` in the plan was not set and no source file was modified.
- The builders' deviations, including the typed-result store API, reducer `null` returns, own atomic writer, lenient reads and `schemaVersion` refusal, are all justified and documented, and I accept them.
