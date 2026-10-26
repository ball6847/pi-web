---
createdAt: "2026-10-26T03:33:21Z"
implementedAt: "2026-10-26T03:33:21Z"
planPath: "../plans/kanban-agent-tool.md"
---

# Kanban tool runtime — unit 2

[Plan](../plans/kanban-agent-tool.md). Unit 2 is implemented; the overall plan remains in progress. No commit was made.

## Changes

- `lib/rpc-manager.ts`: register the host extension for normal non-Chat-only sessions. Keep active `kanban` across tree navigation to branches recorded without it, alongside the other session-owned tools. On child reopen, register it only when the existing snapshot's tools name `kanban`.
- `lib/subagent-runtime.ts`: register Kanban for non-Chat-only children independently of `loadExtensions`, add it to resolved tools before the SDK allowlist and resource snapshot are built, and supply a read-only callback based on the resolved built-in tools only. Extension-only and skills-only profiles are not accidentally classified read-only.
- `lib/subagents.ts`: accept the explicit `kanban` snapshot tool with extensions disabled, without adding it to legacy snapshots or allowing reserved subagent controls.
- `lib/kanban-runtime.integration.test.mjs`: 13 real SDK/RPC/sandbox integration tests covering registration, persisted mutations, normal preset changes, pre-Kanban branch navigation, reload, live/cold resume, RPC reopen, restricted selectors, tools-only/extension-only/skills-only profiles, Chat-only absence, legacy snapshot isolation, and direct/nested read-only refusal (including codemode-only presentation).
- `lib/subagents.test.mjs`: snapshot validation and allowlist regression coverage. `lib/subagent-codemode-scope.integration.test.mjs`: precisely update the callable list to include the host tool while preserving exclusion assertions.
- Updated `docs/agents/tools.md` and `docs/agents/subagents.md`. No new settings, profile fields, dependencies, or changes to the other builder's extension/domain/store tests.

## Verification

Tests were written first: the initial runtime suite had 8 expected registration failures and 3 passing absence/legacy tests before implementation.

- `node --experimental-strip-types --test lib/kanban-runtime.integration.test.mjs lib/subagent-codemode-scope.integration.test.mjs lib/subagents.test.mjs` — **60/60 passed** (`/tmp/kanban-runtime-final.log`).
- `env -u KIMI_API_KEY -u XIAOMI_TOKEN_PLAN_SGP_API_KEY node --experimental-strip-types --test lib/subagent*.test.mjs lib/rpc-manager*.test.mjs lib/mcp-read-only-policy*.test.mjs lib/builtin-extensions*.test.mjs lib/kanban-runtime.integration.test.mjs` — **350/350 passed** (`/tmp/kanban-runtime-regressions-clean.log`).
- Parent reports the clean-environment full suite passes **3094 tests, 1 skip**, and typecheck passes.
- `node_modules/.bin/tsc --noEmit` — passed.
- Focused ESLint on all changed runtime/test files — passed.
- `git diff --check` — passed.

Tests use temporary agent/project directories, real session files and board persistence, and Pi's faux provider for deterministic model responses. No real model calls are required.

## Remaining integration caveats

- **Resolved environment issue:** the initial Chat-only provider failure also reproduced in a clean HEAD archive, and the parent's model-list failure had the same cause: inherited `KIMI_API_KEY` / `XIAOMI_TOKEN_PLAN_SGP_API_KEY`. Unsetting both makes the complete targeted runtime suite green; parent confirms the full suite is green as well. No unrelated source fixes were made. Future isolated runs should remove these credential environment variables.
- No known runtime integration blocker remains. Independent review is in progress; any findings still need parent disposition.
- Parent reports the isolated real Next smoke passes main create and Agent child claim/update/done. Browser checkbox setup, board polling/viewer behavior, screenshot inspection, complete review, and final plan completion remain parent/other-unit responsibilities, not verified by this runtime-only work.

## References reviewed

Project topic notes (`tools`, `subagents`, session lifecycle, Kanban), ADR 0002, SDK lifecycle/resource-loading and extension/tool/codemode docs, SDK inline-extension and codemode examples, and the existing real-SDK subagent scope/reload/reopen tests informed the implementation.
