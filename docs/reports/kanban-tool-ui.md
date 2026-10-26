# Kanban tool UI — unit 3

Plan: [Minimal agent Kanban tool](../plans/kanban-agent-tool.md#implementation-units)

implementedAt: 2026-10-26T03:32:48Z

## Changes

- `components/AppShell.tsx`: board projection includes every session of its project (including worktree children), retaining relation metadata. Card opening resolves against that same projection. Top-level sessions keep ordinary chat selection; children go through the existing `handleOpenSubagentTab`.
- `lib/kanban-sessions.ts`: client-safe projection and picker helpers, with type-only imports. Manual linking offers top-level sessions, including forks. Editing additionally offers the card's existing child, never other children. A temporarily absent existing row gets its saved title/card-title fallback only in the edit picker, not in existence/open lookup.
- `components/KanbanBoard.tsx`: card/chip/menu existence reads all projected ids, whereas manual Link and new-card pickers use top-level options. The edit form starts with the existing link, permits reselecting it, and saves text without a link/unlink mutation when that id is unchanged. The existing “session required” notice reflects eligible options instead of the unfiltered catalogue.
- No new labels, dependencies, runtime/domain/store edits, or commits.

## Cross-project opening

Opening project B's board while chatting in A changes neither the selected chat nor the active cwd/project. Opening B's child only adds/selects its `agent:<id>` tab and opens the panel (closing the drawer on mobile). There is no workspace switch to trigger `changeFileWorkspace()`'s agent-tab cleanup. `activeAgentTab` resolves independently of the selected family, and `SubagentViewer` loads by child id through session-info/context reads, not an agent runtime route. The board remains visible behind/beside the viewer. A later actual chat/workspace switch retains the existing transient-tab cleanup policy.

## Sidebar: deliberately unchanged

`SessionTree` renders only `row.family.root` session rows, not separate child rows. Its existing `sessionIndex.get(row.family.root.id)` therefore already reads the displayed row's **own** card. Adding an own-id-before-root fallback would repeat the identical lookup. A child's independent card must not replace its parent's lane marker or make an untracked parent appear tracked. Added a rendered model/component regression with both parent and child cards, child selected, then only the child card remaining. No production sidebar change was needed, per the clarified scope.

## Tests

Added:
- `lib/kanban-sessions.test.mjs`: project/worktree projection, retained child metadata, top-level/fork/manual options, uncapped options, title/running rules, existing-child exception, catalogue-lag fallback.
- `components/AppShell.kanban-sessions.test.mjs`: executes actual shell callbacks for same/cross-project opens on desktop/mobile; verifies no chat/workspace change, no fetch, deduplicated viewer tab, valid active tab, ordinary top-level route and missing-id no-op, actual board/viewer bindings.
- `components/KanbanBoard.sessions.test.mjs`: drives actual board/lane/card/form functions and event props using the repository hook harness. Pins card/chip/menu availability, true missing-session disabling, Link eligibility, untouched child-link preservation on text save, explicit reassignment, reselecting the original child, and new-card exclusions.
- `components/SessionTree.test.mjs`: family-row own-card regression above.

Passed:
```sh
node --experimental-strip-types --test lib/kanban-sessions.test.mjs components/AppShell.*.test.mjs components/KanbanBoard.*.test.mjs components/SessionTree.test.mjs components/SubagentViewer.test.mjs
# 80 passed, 0 failed
node_modules/.bin/tsc --noEmit
node_modules/.bin/eslint components/AppShell.tsx components/KanbanBoard.tsx lib/kanban-sessions.ts components/AppShell.kanban-sessions.test.mjs components/KanbanBoard.sessions.test.mjs components/SessionTree.test.mjs lib/kanban-sessions.test.mjs
git diff --check
```

The first focused test run exposed Node's inability to resolve extensionless runtime imports in `kanban-shared.ts`; the component test now imports that existing module through jiti, matching repository practice. Final tests pass. Full-suite, live tool smoke and browser screenshots are unit 4's work, not claimed here; these tests do not exercise real browser layout or network lifecycle. No browser connection/tools were available in this worker.

## Documentation handoff

Read `docs/agents/sessions.md` completely in chunks (including its truncated continuations), plus `kanban.md` and `subagents.md`, before editing. `sessions.md` needs no change: its family-row and actual project-switch semantics remain correct. Leave `kanban.md` to its owning builder. Suggested paragraph below should **replace** the obsolete claims that board lookup/open sees only top-level sessions and that the sidebar renders subagent rows; append to Surfaces as appropriate:

> Board session lookup includes all sessions whose `projectRoot ?? cwd` matches the board, including subagents in worktrees (`lib/kanban-sessions.ts`). A child-linked card is available to open; its card, chip and Open session menu use the existing read-only subagent viewer via `handleOpenSubagentTab`, never selecting/reopening the child or starting a run. Even when the board belongs to another project, viewing leaves the chat/workspace and board unchanged, so project-switch cleanup cannot drop the new viewer. Manual Link and new-card pickers remain top-level-only; an edit form also keeps the card's existing child as a choice (using the saved title if its catalogue row temporarily disappears). Saving only text preserves the session id and its saved title. Sidebar session rows are family roots only and their marker already reads the row's own root card; a child's independent card does not replace it.

## Process limitation

The requested `builder` skill was not present in the available local skill locations (searched pi/agent, common agent/config locations and project skill paths). Followed the supplied implementation plan and explicit ownership constraints, marked only unit 3 with `implementedAt`, and wrote this report/backlink. Other builders' concurrent runtime/domain/store/docs/E2E edits were not modified.
