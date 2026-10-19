---
createdAt: "2026-10-19T00:00:00Z"
implementedAt: null
reviewedAt: null
# SIGN-OFF: PENDING — GOAL.md requires the operator's sign-off in this header
# before any M4 coding starts. The continuous-improvement loop must not
# implement this plan until a line like `signoff: "<operator>, <date>"` is
# added below.
signoff: null
---

# Plan: Model-driven card advancement for the kanban board

> Postponed 2026-10-19: the operator inserted two card-UI milestones (M5 activity
> indicator, M6 manual drag-and-drop) ahead of this plan — see
> `KANBAN_CARD_UI_PLAN.md`. M6 retires the "Demo:" entries this plan was going to
> remove, so this plan lands as the tool alone; its sign-off gate still applies.

## Background & Context

- **Business Driver**: The board's rules say moving a card is the model's call
  ("the user never moves a card by hand"). Today that call is faked: the card
  and lane-strip menus offer a "Demo: advance to {lane}" entry that moves the
  card one lane. This plan makes it real: a built-in extension tool the model
  calls when it decides the stage a card is tracking is done, replacing the
  demo entry.
- **Technical Context**: pi-web registers built-in extensions in
  `lib/builtin-extensions.ts` (codemode, tool-search, mcp) with `-builtin:`
  switches; extensions run in-process in the agent session, so a tool handler
  can call `lib/kanban-store.ts` directly — no new HTTP surface (the
  `advance-card` action already exists on `/api/kanban`; the route's request
  gate makes it the wrong door for an in-process call). Session→board mapping
  already exists: the board lives at the project root
  (`resolveProject(session.cwd).projectRoot`), a session's card is found by
  `sessionId`, and the store's `readBoard(cwd, { create: false })` reads a
  board without creating it. (Storage delta 2026-10-19: the roadmap's M4 —
  shared storage under `~/.pi/agent` — lands before this plan; the store API
  and `sessionId` matching are storage-agnostic, so only the store's path
  resolution changes, not this tool's flow.)
  missing board as empty without writing.
- **Related Decisions**: the tool advances only the calling session's own
  card (one session drives one card — the board's existing invariant); it
  reuses the existing `advance-card` reducer (one lane right, the same rules
  a demo move obeys, including the unguarded backlog case). A session with no
  card gets a quiet no-op, not an error.

## Key Information

### Success Criteria

- [ ] A model that finishes the stage a card tracks calls the tool and the card
      moves one lane right on the project's board; the file is written and the
      revision bumps like any other mutation.
- [ ] The "Demo:" menu entries are gone from the card menu and the strip menu
      (the `kanban.menuAdvance` label loses its prefix and its advance action);
      a model-driven move keeps the 1.6 s card ring.
- [ ] A session with no card (or no board) gets a no-op answer naming that
      fact, and nothing is written — in particular no `kanban.json` is
      created by a no-op check.
- [ ] A card in the last lane gets a refusal answer, no write.
- [ ] The tool is absent from tool-less (chat-only) sessions; adding it changes
      no other preset's tool list.
- [ ] i18n parity holds across en / zh-CN / zh-TW for every label touched.
- [ ] `docs/agents/kanban.md` and the AGENTS.md topic notes describe the
  model-driven path; the "Not built" list no longer names it; check.sh M4
  passes.

### Design

SDK surface (verified against the installed pi 1.2.0 — `dist/core/extensions/types.d.ts`,
`pi-agent-core` types):
- `ExtensionAPI.registerTool(tool)` exists. The factory's `ExtensionContext`, and the
  per-call `ExtensionToolContext` that `execute` receives, both carry `cwd` and a
  read-only `sessionManager`, whose `ReadonlySessionManager` pick includes
  `getSessionId(): string` — the handler finds its own session id with no extra
  plumbing.
- `execute(toolCallId, params, signal, onUpdate, ctx)` resolves to an
  `AgentToolResult` (`{ content: [{ type: "text", text }], details }`): the model
  sees the text, `details` feeds the transcript UI.
- `parameters` is a TypeBox schema — and the repo pattern is plain imports,
  verified in `lib/subagent-extension.ts` (the template this tool will copy):
  `import { Type } from "@earendil-works/pi-ai"` (pi-ai 1.2.0, an existing
  declared dependency) and `import { defineTool } from
  "@earendil-works/pi-coding-agent"` (the public entry). No pi-sdk-internals
  loader and no new dependency needed.
- The subagent built-in fixes the exact field set M4 will use: `name`, `label`,
  `description`, `promptSnippet`, `promptGuidelines`, `exposure`,
  `executionMode`, `parameters: Type.Object({…})`, and
  `execute(toolCallId, params, signal, onUpdate, ctx)` — `ctx` is the
  `ExtensionContext` the handler needs (the subagent runtime reads the parent
  session the same way: `ctx` → session id).
- Caveat: the codemode self-test runs `definition.execute(…, undefined as never)`
  — a ctx-less probe. A tool that reads `ctx` (kanban_advance is one) cannot
  use that pattern; its coverage comes from the store tests and the route tests
  around the same `applyMutation` call.
- `promptSnippet` / `promptGuidelines` exist on `ToolDefinition` — the "when to
  call it" guidance belongs in `promptGuidelines`, not only the description.
- A registered tool is `direct` exposure, `defaultActive: true` — on the moment the
  built-in loads; chat-only sessions load no built-ins at all, so nothing changes
  for them.

```
 model (assistant)                built-in kanban extension            store
      |  tool call                  |                                    |
      |  advance-card { }  -------->| resolve session.cwd -------------->| resolveProject
      |                             | board = readBoard(root, create:false)
      |                             | card = board?.cards[sessionId]     |
      |                             |   none  -> { ok, moved:false,      |
      |                             |            reason:"not-tracked" }  | (no write, no file)
      |                             |   found -> applyMutation(root,     |
      |                             |            { advance-card }) ------>| one lane right
      |  { moved, from, to } <-----| answer from the store's typed       |
      |                             | result (refusals included)         |
```

1. **Tool**: `kanban_advance`, zero parameters (`Type.Object({})`) — the session
   itself is the argument the handler reads from `ctx` (session id via
   `sessionManager`, project from `ctx.cwd`); the model never names a card id, so it
   cannot move someone else's card. Answer object: `{ moved: true, from, to }` on
   success; `{ moved: false, reason }` for `not-tracked` (no card / no board /
   read-only session), `last-lane`, and a store refusal (with the store's message).
   The same object goes in `details`.
2. **Registration**: new built-in in `lib/builtin-extensions.ts`, same
   shape as the mcp one; enabled by default (a no-op is cheap). The model
   learns when to call it from a `promptSnippet` line and a `promptGuidelines`
   bullet ("call it when the stage the card tracks is done; nothing happens if
   this session has no card"). It joins no preset's required list; chat-only
   stays tool-less.
3. **Handler path**: `session.cwd` → `resolveProject().projectRoot` →
   `readBoard(root, { create: false })` → look up the card by the
   session's own id → `applyMutation(root, { action: "advance-card",
   cardId })` → map the typed result to the answer. Every branch is
   answer-shaped; nothing throws into the model.
4. **UI**: drop the demo advance entries (card menu, strip menu) and their
   `kanban.menuAdvance` label from the three locale files; keep Unlink and
   the rest. The move ring stays, now on the model's move.
5. **Docs**: `docs/agents/kanban.md` (Board rules, Traps, Not built),
   `docs/agents/tools.md` (the built-ins list), AGENTS.md (file map + a
   kanban topic entry pointing at the note).

### Test Cases

| # | Case | Expectation |
|---|------|-------------|
| 1 | Session with a card in `lane-todo` calls the tool | card in `lane-plan`; file written; revision bumped; answer `{ moved: true, from: "todo", to: "plan" }` |
| 2 | Session with no card (board loaded) | `{ moved: false, reason: "not-tracked" }`; file byte-identical; no new file |
| 3 | No board file exists for the project | same no-op; `kanban.json` is **not** created (create:false) |
| 4 | Card in `lane-done` | `{ moved: false, reason: "last-lane" }`; no write |
| 5 | Sessionless card in the backlog that the session now owns via a later link | the tool still only acts on the caller's linked card; backlog→todo advance allowed (the unguarded rule) |
| 6 | Tool registration | present in the default preset's session; absent from a chat-only session; no change to the other built-ins' lists |
| 7 | UI | no `Demo:` string anywhere in `lib/i18n/messages/*.ts`; card menu and strip menu render without the advance entry; a model-driven move rings the card |
| 8 | i18n parity | same key count in en / zh-CN / zh-TW after the label removals |
| 9 | Refusal propagation | a store refusal (e.g. lock) surfaces as `{ moved: false, reason, error }`, never an exception in the transcript |

### Rollout

One step: the tool and the menu removals land together (the menu entry is
the demo stand-in; keeping it after the tool exists would reintroduce a
manual move, which the rules forbid). No migration: boards, lanes and
cards are untouched; only the way a card gets advanced changes.

## Appendix: typechecked draft (pi 1.2.0)


Drafted and `tsc --noEmit`-clean against the installed pi 1.2.0; merges into
`lib/builtin-extensions.ts` (built-in switch + registration, as the mcp built-in does) on
sign-off. The per-call `ExtensionContext` carries `cwd` and `sessionManager.getSessionId()`;
the store is called in-process, so a no-op never creates `kanban.json` and a refusal never
throws into the transcript.

```ts
// M4 DRAFT — not wired in; typechecked against pi 1.2.0 to de-risk the plan.
// Merges into lib/builtin-extensions.ts when the plan is signed off.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyMutation, readBoard, type KanbanBoardResult } from "./kanban-store";
import { resolveProject } from "./worktree";

export const KANBAN_ADVANCE_TOOL_NAME = "kanban_advance";

/** The one object the model sees and the transcript stores (`details`). */
type KanbanAdvanceAnswer =
  | { moved: true; from: string; to: string }
  | { moved: false; reason: "not-tracked" | "last-lane" | string; error?: string };

function answerText(a: KanbanAdvanceAnswer): string {
  if (a.moved) return `Moved the card from ${a.from} to ${a.to}.`;
  if (a.reason === "not-tracked") return "This session has no card on the board; nothing moved.";
  if (a.reason === "last-lane") return "The card is already in the last lane; nothing moved.";
  return `Could not advance the card: ${a.error ?? a.reason}`;
}

export function buildKanbanAdvanceTool(ctx: ExtensionContext) {
  return defineTool({
    name: KANBAN_ADVANCE_TOOL_NAME,
    label: "Kanban: advance my card",
    description:
      "Advance this session's kanban card one lane to the right when the stage it tracks is done. " +
      "Takes no parameters: it always moves the calling session's own card, if it has one.",
    promptSnippet: "Advance this session's kanban card one lane when its stage is done",
    promptGuidelines: [
      "Call kanban_advance when you finish the stage the session's board card tracks.",
      "Nothing happens if this session has no card on the board; it is never an error.",
      "Do not call it to move another session's card; that is not possible.",
    ],
    executionMode: "sequential",
    exposure: "direct",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, callCtx: ExtensionContext) {
      void ctx; // the built-in factory's context; per-call context carries cwd + sessionManager
      let boardResult: KanbanBoardResult;
      let root: string;
      try {
        root = (await resolveProject(callCtx.cwd)).projectRoot;
        boardResult = await readBoard(root, { create: false });
      } catch {
        // A project that cannot be resolved is treated like "no board": a no-op, not an error.
        return { content: [{ type: "text" as const, text: answerText({ moved: false, reason: "not-tracked" }) }], details: { moved: false, reason: "not-tracked" } };
      }
      if (!boardResult.ok) {
        // The store already refused (cwd-denied, locked, unsupported-schema…): surface it, write nothing.
        const answer: KanbanAdvanceAnswer = { moved: false, reason: boardResult.code, error: boardResult.error };
        return { content: [{ type: "text" as const, text: answerText(answer) }], details: answer };
      }
      // create:false: a missing board answers as an empty board (no cards), so a
      // no-op check can never create kanban.json; the card lookup below simply finds nothing.
      const board = boardResult.board;
      const sessionId = callCtx.sessionManager.getSessionId();
      const card = board.cards.find((c) => c.sessionId === sessionId);
      if (!card) {
        const answer: KanbanAdvanceAnswer = { moved: false, reason: "not-tracked" };
        return { content: [{ type: "text" as const, text: answerText(answer) }], details: answer };
      }
      const next = board.lanes[board.lanes.findIndex((l) => l.id === card.laneId) + 1] ?? null;
      if (!next) {
        const answer: KanbanAdvanceAnswer = { moved: false, reason: "last-lane" };
        return { content: [{ type: "text" as const, text: answerText(answer) }], details: answer };
      }
      const mutation = await applyMutation(root, { action: "advance-card", cardId: card.id });
      if (!mutation.ok) {
        const answer: KanbanAdvanceAnswer = { moved: false, reason: mutation.code, error: mutation.error };
        return { content: [{ type: "text" as const, text: answerText(answer) }], details: answer };
      }
      const answer: KanbanAdvanceAnswer = { moved: true, from: card.laneId, to: next.id };
      return { content: [{ type: "text" as const, text: answerText(answer) }], details: answer };
    },
  });
}
```

## Registration (verified against lib/builtin-extensions.ts)

Three insertion points, all verified at `tsc`-time against the current file:

1. `BUILTIN_EXTENSION_NAMES` (line 229) gains the new name (e.g.
   `kanban-advance`). The switch reader already loops that list, so the
   `-builtin:kanban-advance` / `!builtin:kanban-advance` settings switches
   work with no further plumbing; a disabled entry stays as
   `unavailableExtension` (an empty factory), which is exactly the
   opt-out semantics.
2. Inside `createPiWebBuiltinExtensions`, the `extensions` array (tool-search
   and mcp, from line 370 on) gains
   `builtin("kanban-advance", gate("kanban-advance", createKanbanAdvanceExtension()))`
   — gated like the other two, so it is on by default and switchable off.
3. `createKanbanAdvanceExtension(): InlineExtension` is a `setup(pi)` that
   calls `pi.registerTool(defineTool(...))` once with the draft's tool (the
   draft's factory-`ctx` parameter is unused: the per-call `ctx` in
   `execute` already carries `cwd` and `sessionManager`). Model: the
   subagent built-in's `setup` (line 183 of lib/subagent-extension.ts).

The returned `extensions` array is consumed at line 474 in the CLI's order;
the new entry appends last. Chat-only sessions load no built-ins at all, so
they stay tool-less with zero changes.

## Demo-entry removals (verified census)

Exactly these, and nothing else, leaves the UI:

- `components/KanbanBoard.tsx` card menu: the `if (next)` block pushing
  `{ id: "advance", label: t("kanban.menuAdvance", …), dim, icon,
  onSelect: kanbanAdvanceCard + setHighlightFlash }` (around line 1363).
  The `next` lane variable exists only for this block.
- `components/KanbanLaneStrip.tsx`: the `onDemoAdvance` prop (interface
  line 29, destructuring line 49), the `nextLane` computation (line 64),
  and the `if (nextLane)` menu block (lines 86–92).
- `components/AppShell.tsx` line 1403: the `onDemoAdvance={() => …}` prop
  passed to the strip.
- One label line per locale, all at line 1510:
  `lib/i18n/messages/en.ts` (`"Demo: advance to {lane}"` — the only literal
  `Demo:` string in i18n; the zh values are 示範/演示),
  `lib/i18n/messages/zh-CN.ts`, `lib/i18n/messages/zh-TW.ts`.

Test case 7's "no `Demo:` string anywhere in lib/i18n" is therefore a
single-line census after the removal, and the key-count parity (53 keys
each) keeps i18n test 8 green.
