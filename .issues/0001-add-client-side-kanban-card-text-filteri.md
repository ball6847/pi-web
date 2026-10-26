---
id: 1
title: Add client-side kanban card text filtering
status: closed
priority: medium
labels:
    - feature
created: "2026-10-26"
updated: "2026-10-26"
closed: "2026-10-26"
---

## Context
The user approved a quiet always-visible card filter in the board header, then requested UI implementation first with desktop/mobile screenshots inspected by the assistant. Filtering uses the already-loaded board; no new API or storage changes. Search titles and descriptions only (no linked session names or transcripts).

## Success Criteria
- [x] Always-visible accessible search field before Configure, wrapping into a full-width second row for narrow board panels; 16px mobile input, no autofocus, theme tokens only.
- [x] Instant case-insensitive trimmed literal substring filtering, stable lanes/order, overall matched/total count and lane matched/total counts, safe highlights and match-centered description snippets.
- [x] Clear button keeps input focus; input Escape clears without consuming dialog Escape; whitespace-only input remains clearable.
- [x] Board-level no-results text and clear action; lane-level no-matches distinct from empty lanes; mobile retains lane with a link to a matching lane.
- [x] Active forms survive filtering until Save/Cancel; card reorder/drag disabled during filtering with an explanation, but lane reordering, Move to lane and mobile long-press menus still work.
- [x] Query survives chat round-trip, clears on project change/reload, explicit jump to a hidden card clears query. No localStorage persistence.
- [x] Focused tests, typecheck, lint and desktop/mobile visual checks pass; no API changes.

Criteria verified by code/unit tests and isolated Chromium runtime checks. Desktop/mobile-responsive screenshots captured and inspected; physical iOS touch/IME is not claimed.

## Implementation
1. Add pure search/matching/excerpt helpers and tests using existing node test conventions; tests first.
2. Wire client-only filter state into board and its lifetime owner (AppShell if necessary), keeping the canonical board intact for forms, lane configuration and mutations. Store query scoped to project, not in backend/cache. Derive visible cards and counts separately.
3. Add responsive filter controls, counts, highlights, clear/empty states, mobile matching-lane navigation and reorder safeguards. Search must match title OR description, never across their boundary. Literal Unicode-safe text rendering, no HTML injection and no regexp lookbehind.
4. Translate all new labels in en/zh-CN/zh-TW and update docs/agents/kanban.md with behavior/traps. Avoid unrelated refactors, dependencies, API changes and build commands.
5. Verify focused tests/typecheck/lint. Parent session handles dev server and screenshots with fixture data, never modifying the user's actual board.

## Affected Files
- `components/KanbanBoard.tsx` and optionally a small component stylesheet/search component — filter UI and card/lane display.
- `lib/kanban-search.ts` and tests — pure filtering/highlight/excerpt helpers.
- `components/AppShell.tsx` — query lifetime if needed; read sessions topic note first.
- `lib/i18n/messages/{en,zh-CN,zh-TW}.ts` — translated UI text.
- `docs/agents/kanban.md` — filtering rules.
- `components/*kanban*.test.mjs` / `e2e/kanban-search.mjs` as appropriate — regression coverage.

## Code verification (builder)
- [x] Pure helpers and R1/R2 regressions followed red/green TDD; 207 focused kanban/search/AppShell/navigation/keyboard/route tests pass after review corrections.
- [x] `node_modules/.bin/tsc --noEmit` passes.
- [x] `npm run lint` passes with the existing `lib/kanban-client.test.mjs:620` unused-variable warning only.
- [x] No API, persistence, dependency, staging or commit changes; no browser/server startup by builder.
- [x] Parent's desktop/mobile screenshots and runtime integration using agent-browser; [visual report](../.context/reviews/2026-10-26/KANBAN_SEARCH_VISUAL.md).

Review R1/R2 corrections: AppShell resolves transient session cwd through the known sidebar/composer project context before comparing board identity; regressions execute the actual derivation/effects across worktree promotion, hydration and genuine project switches. Only card drag/reorder is gated: all lanes remain visible, so lane reordering is available. The extra lane-drag hook guard was reverted and its guard-only test archived at `.context/retired-tests/useKanbanLaneDrag.test.mjs.txt`. AppShell owns query lifetime and both kanban/sessions notes document it. Parent's pre-change full suite reported 3005 pass, 2 unrelated failures (models catalog expectations and chat-only integration rejection), 1 skip; those were left out of scope. Review regression log: `/tmp/kanban-search-review-tests.log`; typecheck log: `/tmp/kanban-search-review-typecheck.log`; lint log: `/tmp/kanban-search-review-lint.log`. [R1/R2 review](../.context/reviews/2026-10-26/KANBAN_SEARCH_REVIEW.md) addressed in code/tests; parent completed browser verification with agent-browser.

## Parent verification / remaining gate
- Independent re-review: PASS for code; R1/R2 resolved. Parent reran 24 feature tests and typecheck successfully; 207 broader focused tests passed in builder verification.
- Preview: `http://127.0.0.1:30142` uses isolated temporary agent data, 18 sample cards, no writes to the user's real board. Fixture metadata: `.context/kanban-ui-fixture.json`; server log: `/tmp/pi-web-search-card-dev.log`.
- Screenshot gate PASSED using agent-browser at user request. Captured and read desktop, mobile, narrow-panel, global-empty, and mobile-no-match screenshots in `test-results/kanban-search/`.
- Runtime PASSED: matching/counts, narrow panel/mobile wrap, clear/Escape/focus, whitespace, unsaved form DOM/draft continuity, Save/Cancel, actual card-to-chat round-trip, hidden-card jump, reload reset and simulated keyboard-height resize. No page errors or query-triggered network requests. Local check helper `.context/kanban-search-e2e.mjs` remains unexecuted as a script; checks were executed via agent-browser CLI.
- No API changes: filtering the already-loaded canonical board requires none. [Visual/runtime report](../.context/reviews/2026-10-26/KANBAN_SEARCH_VISUAL.md) records evidence and physical-device limits.

## Mobile typography follow-up (2026-10-26)
User found the mobile input text too large. `components/KanbanSearch.tsx` now renders it visually at 14px (16px computed font × 0.875 scale to retain Safari's no-focus-zoom threshold). A clipped, full-height input slot with inverse width/height preserves hit area; the icon and 32px clear target are unchanged. Desktop remains 12px, unscaled.

Regression test written red before implementation; 13 field/board tests pass, typecheck and targeted lint pass. Verified with agent-browser at 390×844: visual font 14px, full-width input rect, long query scrolls without covering Clear, Clear restores focus, no page overflow/errors. Captured and read `test-results/kanban-search/mobile-smaller-text.png`. Physical iOS zoom remains unverified, but the 16px computed font safeguard is retained.

## Final pre-PR checks
User confirmed the smaller mobile text works on their device. Final typecheck passed; lint has the same pre-existing unused-variable warning. Full suite: 3030 passed, 2 pre-existing failures, 1 skipped (25 additional tests versus baseline). The failures remain `app/api/models/route.test.mjs` (remote provider catalog entries) and `lib/rpc-manager-chat-only.integration.test.mjs` (expected extension-model rejection).

## Verification
Run focused kanban/search tests, `node_modules/.bin/tsc --noEmit`, and `npm run lint`. Never run next build. Parent must view screenshots of desktop matches, narrow/mobile, and empty state. Intercept board data in a test-only owned tab or use isolated fixtures; don't mutate the user's board.
