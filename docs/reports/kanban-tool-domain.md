---
createdAt: "2026-10-26T03:33:30Z"
planPath: "../plans/kanban-agent-tool.md"
---

# Kanban agent tool: unit 1 implementation

Date: 2026-10-26

Plan: [Minimal agent Kanban tool](../plans/kanban-agent-tool.md)

## Status

Unit 1 implemented and verified. The overall plan remains in progress; runtime, UI, broader verification and review belong to the other units. No plan completion timestamp or commit was made.

## Delivered

- `lib/kanban-tool-domain.ts`: dedicated pure request validation, guarded create/partial-update/claim/move reducer, and read/mutation projections. No browser link-stealing reducers or action expansion.
- `lib/kanban-tool-schema.ts`: flat TypeBox parameters and typed output schema, including structured failures.
- `lib/kanban-extension.ts`: ordinary Pi registration; matching model-readable content, structured content and transcript details; read-only enforcement inside execution for direct and nested callers.
- `lib/kanban-store.ts`: session/project validation and one locked agent mutation path using the existing queue/file lock. Implicit target resolution, ownership checks and write occur under that lock. Cancellation is checked after acquiring the lock and after awaited work before writing. Existing store failure codes and action-specific explanations survive.
- Agent reads remain noncreating/nonpruning; refusals never initialize/migrate/repair a board. Same-lane retries preserve order and revision. SQL/schema remain unchanged.
- Domain, store and extension tests, including real SDK execution with a faux provider. Added the tool section to `docs/agents/kanban.md`.

### Runtime integration contract

```ts
createKanbanExtension(options?: {
  isReadOnly?: (ctx: ExtensionContext) => boolean;
}): InlineExtension
```

Without a callback, each mutation reads the normal session's latest persisted tool selection. Child callers provide their profile/snapshot policy. Runtime owns Chat-only omission, child eligibility persistence and preventing nested Agent delegation; none of those runtime files were modified by this unit.

## Verification

Tests were written first; the initial run failed on the absent domain/extension modules and store API. Final targeted run: **145 passed, 0 failed/skipped** (56 new tests plus 89 existing regressions).

```sh
node --experimental-strip-types --test \
  lib/kanban-tool-domain.test.mjs lib/kanban-tool-store.test.mjs \
  lib/kanban-extension.test.mjs lib/kanban-extension.integration.test.mjs \
  lib/kanban-store.test.mjs lib/kanban-data.test.mjs \
  lib/kanban-shared.test.mjs lib/kanban-client.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
node_modules/.bin/eslint lib/kanban-extension.ts lib/kanban-tool-*.ts \
  lib/kanban-store.ts lib/kanban-tool-*.test.mjs lib/kanban-extension*.test.mjs
```

Typecheck and targeted lint both exited 0.

Coverage includes competing claims, two claims by one actor, queued implicit resolution, foreign-owner refusal without partial text edits, absent/invalid/unrelated sessions, shared worktree board identity, custom/reordered lanes, last-lane output, partial updates/clearing, no-op bytes/order/revision, noncreating reads, lock/newer-schema failures, cancellation against missing and existing boards, and an injected SQLite trigger failure rolling back claim/text/move/revision together. Real SDK tests cover registration/declarations, actual read/create/update persistence, nested structured output, direct/nested read-only refusal, live pin changes, child callback authority and invalid arguments.

The coordinating agent separately reported the real Next smoke `e2e/kanban-agent-smoke.mjs` passing main read/create plus a real Agent child's claim/update/done, followed by a clean full suite (**3094 passed, 1 skipped**) and typecheck. Those broader checks were not run by this unit. Review is underway; screenshot verification remains blocked on the Chrome checkbox reported by the coordinator. Runtime/UI verification evidence remains owned by the other units.

## Implementation notes / deviations

- Pi 1.2 omits `structuredContent` from persisted tool-result messages and `outputSchema` from `getAllTools()` metadata. Tests therefore inspect active tool definitions and execution events/nested outcomes, and separately verify transcript content/details. No SDK workaround or patch was added.
- Agent mutations deliberately do not prune unrelated dead links: a retry/no-op must not change unrelated cards, and a stale foreign link must not become a silently claimable card. Existing browser pruning is unchanged.
- The first successful mutation initializes seed plus resulting board in one SQLite transaction rather than committing a seed first. Browser refused-mutation materialization remains the default; agent refusals opt out.
- The touched lock helper now closes newly opened connections and the newer-schema inspection connection; removed the obsolete identity helper and restored each API's own documentation comment.

No outstanding blocker or additional dependency. No changes to runtime/subagent implementation files, UI, package manifests or other existing documentation by this unit.
