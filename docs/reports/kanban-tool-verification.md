# Kanban tool verification

Date: 2026-10-26
Plan: [Minimal agent Kanban tool](../plans/kanban-agent-tool.md)

## Automated checks

- `env -u KIMI_API_KEY -u XIAOMI_TOKEN_PLAN_SGP_API_KEY npm test`: 3,094 passed, 0 failed, 1 skipped (3,095 total). Log: `/tmp/pi-kanban-tests-clean.log`.
- `node_modules/.bin/tsc --noEmit`: passed.
- `npm run lint`: passed with the pre-existing unused `method` warning at `lib/kanban-client.test.mjs:620`; no errors.
- `git diff --check`: passed.
- `node e2e/kanban-agent-smoke.mjs`: passed twice, including after all three implementation units landed. Log: `/tmp/pi-kanban-final-smoke.log`; API state evidence: `test-results/kanban-agent-smoke/result.json`; server log beside it.

Plain `npm test` initially failed two unrelated model/auth assumptions because inherited Kimi/Xiaomi credentials made extra providers available. Removing only those environment variables resolved both without changing unrelated source. One legitimate existing subagent tool-list assertion was updated to include the newly admitted host tool while preserving all exclusions. The skipped test is existing, not disabled by this feature.

## Live smoke method and observations

The smoke script uses an isolated temporary `PI_CODING_AGENT_DIR`, a temporary project, and this checkout's own Turbopack dev server on an available loopback port. The healthy server on port 30141 belongs to another checkout and was left untouched. There is no `.next/dev/lock` contention. No `next build` was run, and generated `tsconfig.json` additions were removed from the change.

A deterministic local Pi faux provider issues real tool calls through the production routes and AgentSession runtime; no paid model, API credentials or user boards are used. It:

1. Reads the empty board and creates the parent's linked Plan card.
2. Creates an independent, sessionless Backlog card.
3. Calls the real `Agent` tool with the new card ID in a child prompt.
4. The real child calls `kanban read`, claims into Implement, updates description only, and moves to Done.
5. Asserts that the child is linked to a different session, its partial-update text persists, the parent's entire card remains unchanged, revision advances, and the child transcript contains real Kanban tool results.

Fixture data and the smoke server are removed on exit. Logs/results are ignored local artifacts. Reproduce with `node e2e/kanban-agent-smoke.mjs`; run `--serve` to keep the fixture open before delegation for browser inspection.

## Visual verification — not completed

`browser_setup` repeatedly refused the connection because Chrome remote debugging is disabled. The tool's required action is to enable it at `chrome://inspect/#remote-debugging`. No other browser/profile was launched or controlled to bypass that boundary.

**No screenshots were captured or read.** Therefore desktop/mobile rendered layout, live browser revision polling, and clicking the child card into its read-only viewer are not claimed as visually verified. Unit/component tests cover the corresponding projection, callbacks, link preservation and viewer-only API behavior, but do not substitute for screenshot inspection.

Once Chrome is enabled: run the smoke script with `--serve`, open `boardUrl` in `test-results/kanban-agent-smoke/fixture.json`, POST its `delegateCommand` to `base + delegatePath`, observe Backlog → Done without a reload, open the child chip, and capture/read screenshots at desktop and phone widths.
