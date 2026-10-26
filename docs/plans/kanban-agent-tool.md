---
reviewedAt: "2026-10-26T03:40:05Z"
---

# Minimal agent Kanban tool

Created: 2026-10-26
Target: `feat-harness-tool` → `origin/kanban`
Status: implemented (review APPROVE; PR open)

## Agreed scope
One tool, `kanban`, with `read`, `create`, and `update`. Board identity comes from the executing session's cwd (worktrees share their project board). A task is an existing card and status is its lane. Keep one linked card per session. Independent tasks are created in Backlog and delegated via the existing Agent prompt carrying cardId; no new dispatch API or automatic continuation.

- `read { cardId? }`: noncreating read; ordered lane IDs/names/descriptions, board cards (or selected card), currentCardId, revision. No writes merely for discovery.
- `create { title, description?, laneId? }`: Backlog by default, sessionless. Explicit work lane creates and attaches to the actor only if it has no other card.
- `update { cardId?, title?, description?, laneId? }`: omitted ID resolves the actor's linked card under the lock. Omitted patch fields remain unchanged; empty description clears it; blank title, unknown keys/action fields, empty patch and unknown IDs are errors. An explicit work-lane update on a free card claims it and moves atomically. Refuse a card owned by another session, or claiming while the actor owns another. Text-only edits of unlinked Backlog cards are allowed. Linked cards cannot enter Backlog. Same lane does not reorder. Never use link reducers that silently steal links without guards.
- Mutation result: updated card, lane, nextLaneId (null at last lane), currentCardId, revision. Explicit lane moves are retry-safe; no relative advance flag. Creation is not idempotent: do not blindly retry it.
- Use standard Pi extension registration, flat TypeBox parameters, model-readable content plus structuredContent/outputSchema. Stable, actionable errors. No injected full-board prompt.
- Read-only sessions may read but cannot mutate, including nested tool calls. Chat-only gets no tool. Subagents receive the host tool explicitly and save eligibility in their existing resource snapshot; legacy snapshots must not widen on reopen. Never allow nested Agent delegation.
- No SQL/schema changes, new dependencies, lane administration, deletion, subtasks, scheduling or automatic run launch.

## Implementation units
1. Domain/extension: pure guarded agent reducer, store API applying patch/claim/move in one locked transaction, extension wrapper and tests. Prefer a dedicated module over widening browser action semantics. `createKanbanExtension(options?: { isReadOnly?: (ctx: ExtensionContext) => boolean }): InlineExtension` defaults to the normal session's persisted read-only selection, queried per execute. New modules may use `lib/kanban-tool-*.ts` and `lib/kanban-extension.ts`. Store failures keep existing codes; action-specific explanations must survive. Respect cancellation before mutation after lock acquisition.
2. Runtime: register extension for normal non-chat sessions; add it to non-chat subagents' resolved active tools and persisted snapshot; restore only when snapshot tools include kanban. Read-only subagent determination comes from the profile/snapshot built-in tool set, not the host kanban tool. Cover spawn, reload, resume/reopen, restricted and Chat-only profiles. **Unit implementedAt: 2026-10-26T03:33:21Z** ([runtime report](../reports/kanban-tool-runtime.md)); overall plan remains in progress.
3. UI: include subagent sessions for board link lookup/opening. Prefer read-only subagent viewer on card open; do not launch a run by viewing. Keep manual linking choices top-level if possible. Make sidebar marker use own card before root fallback.
   - implementedAt: 2026-10-26T03:32:48Z — [UI report](../reports/kanban-tool-ui.md). Family-only sidebar rows already read their own root card; no redundant fallback added (per clarified scope).
4. Verification: domain concurrency/refusal/partial/no-op tests, real SDK extension/runtime tests, component tests, typecheck/lint/full suite. Smoke with isolated fixtures; actual tool calls mutate board, revision poll reflects changes, child card opens transcript, desktop and mobile screenshots captured AND read. **implementedAt: 2026-10-26T03:52:00Z** ([verification report](../reports/kanban-tool-verification.md))
5. Review, fix actionable findings, commit/push and open PR targeting `kanban`. PR records exact tests, screenshot evidence and limitations.

## Required cases
Atomic claim races (one winner), two simultaneous claims by one session (one winner), foreign-linked refusal with no text edits, actor-already-linked refusal, implicit target resolved under lock, custom/reordered lanes and last-lane nextLaneId, same-lane retry preserves order/revision, missing/invalid session, unrelated worktree/project, read-only direct/nested call, Chat-only absence, reopen retains child eligibility without widening legacy children, no board files on read, subagent session is not treated as missing in UI.

## Integration references
- docs/agents/kanban.md, tools.md, subagents.md, sessions.md
- docs/adr/0002-chat-only-tool-selection.md
- Pi SDK docs/extensions.md and examples/extensions/hello.ts, todo.ts

## Reports
- [Unit 2 — runtime implementation](../reports/kanban-tool-runtime.md): changes, test evidence, and unresolved integration caveats.
Implementation and review reports will link back here.
