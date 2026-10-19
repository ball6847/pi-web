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

1. **Tool**: `kanban_advance`, zero required parameters (the session itself
   is the argument the handler reads from its own context — the model never
   names a card id, so it cannot move someone else's card). Answer object:
   `{ moved: true, from, to }` on success; `{ moved: false, reason }` for
   `not-tracked` (no card / no board / read-only session), `last-lane`, and
   a store refusal (with the store's message).
2. **Registration**: new built-in in `lib/builtin-extensions.ts`, same
   shape as the mcp one; enabled by default (a no-op is cheap and the
   tool's description carries when to call it: "Call this when you have
   finished the stage the session's kanban card is in; it moves the card
   one lane. Nothing happens if this session has no card."). It joins no
   preset's required list; chat-only stays tool-less.
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
