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

## Visual verification — completed

The browser harness (`browser_setup`) refused: Chrome's remote debugging pipe is off. Rather than waiving the gate, the check ran through Playwright's Chromium against the same `--serve` fixture. Screenshots were captured **and read** (each inspected as an image).

| Evidence | Observed |
| --- | --- |
| [1 — Backlog before](../reports/screenshots/kanban-agent-tool/1-backlog-before-delegation.png) | Lanes Backlog/Todo/Plan/Implement/Deploy/Done in board order; “Fix unrelated flaky test” in **Backlog** with “No session”; “Ship minimal Kanban tools” in **Plan** carrying its own session chip; sidebar marked “2 tasks”. |
| [2 — Done after the subagent](../reports/screenshots/kanban-agent-tool/2-done-after-subagent.png) | Same page, **no reload**: the card is now in **Done** with the done mark, its description reads “Regression test added. Verification passed…”, and its chip is the child session “Fix the unrelated flaky test”. The parent card is untouched in Plan, still linked to the parent session. Backlog returns to 0. |
| [3 — Child card menu](../reports/screenshots/kanban-agent-tool/3-child-card-menu.png) | The child card's actions offer “Open session”, “Unlink from session”, Edit, Move entries and Delete — a child-linked card behaves like any linked card. |
| [4 — Child transcript viewer](../reports/screenshots/kanban-agent-tool/4-child-transcript-viewer.png) | “Open session” opens the read-only side panel (header Completed) listing the child's real `kanban read` / three `kanban update` calls and “Delegated card verified and completed.” The URL and the Chat tab are unchanged, the board stays visible, and nothing started a run. |
| [5 — Phone board](../reports/screenshots/kanban-agent-tool/5-phone-board.png) | 390×844: lane strip with counts (Done 1 visible), the one-lane board showing Plan's card and its linked session chip; no layout overflow. |

Live revision polling is confirmed: the DOM moved the card from Backlog to Done while the page stayed open, driven only by the child's tool calls. Console: no errors at either width. The delegation path was the PR's documented one — `POST /api/agent/<parent>` with the parent's prompt, the real `Agent` tool spawning the fixture child, whose real `kanban` calls did the work.

Reproduce: `node e2e/kanban-agent-smoke.mjs --serve`, then open `boardUrl` from `test-results/kanban-agent-smoke/fixture.json`, `POST` its `delegateCommand` to `base + delegatePath`, and watch the card reach Done without reloading.

## Follow-up: the sub-agent chip and the read-only hand-over

Requested after the review: a card must say when a sub-agent does the work, and the read-only viewer must explain why it takes no input and where input happens. Both were captured and read against the same `--serve` fixture.

| Evidence | Observed |
| --- | --- |
| [6 — sub-agent chip](screenshots/kanban-agent-tool/6-subagent-chip.png) | The child's card in Done carries the agent-switcher glyph in its chip and the hover text "Fix the unrelated flaky test — Handled by a sub-agent — open it from the board to read, from the main agent's chat to interact." An ordinary linked card keeps the plain chip ("chips before": the parent's chip has no `data-kanban-subagent`, the unlinked card keeps its link chip). |
| [7 — read-only notice](screenshots/kanban-agent-tool/7-viewer-readonly-notice.png) | A banner under the viewer's header: "Read-only transcript. To interact with this sub-agent, open the main agent's chat." with an "Open the main agent's chat" button. |
| [8 — hand-over](screenshots/kanban-agent-tool/8-handover-parent-chat.png) | The button selects the parent (the board view gives way to Chat: composer present, `[data-kanban-lane]` gone) and opens the agents panel with the child's row focused (`document.activeElement` is the `role="option"` row "Fix the unrelated flaky test · board-worker"). Console: no errors. |

The viewer itself gained no input and no agent route: the hand-over is the only action, and it lands on the parent's chat, where the child is prompted.
