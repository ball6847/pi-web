# Kanban delegation — live verification

What P0 changed: a **delegated** session (a subagent the owner started) may act
on its caller's card, as a helper — comment, and move one lane forward. The
"one session, one card" rule stays; the helper is not an owner, and the card
still names exactly one owner.

This is the evidence from a **live run** against the real SDK, not a fixture.

## The run

A fresh session (model `xiaomi-token-plan-sgp:mimo-v2.6-flash`) was given one
instruction, and nothing else:

1. `kanban create` a card in Todo, and note its key.
2. Spawn one `general-purpose` subagent, told to comment on that card and move
   it to Plan.
3. Report the outcome.

The parent created the card and delegated; the child wrote to the board.

## The board afterwards

| # | Evidence | What it shows |
|---|---|---|
| [1 — the card in Plan](../reports/screenshots/kanban-delegation/1-board-card-in-plan-lane.png) | The board with the card **PIWEB-41** "P0 delegation smoke" in **Plan** (the parent's card, still owned by the parent `01a18563-…`), and the card's detail panel open on the right. | The child moved the parent's card forward one lane. The owner chip on the card is still the parent's — the move did not steal the card. |
| [2 — the card's activity trail](../reports/screenshots/kanban-delegation/2-card-detail-activity-trail.png) | `ACTIVITY 3` on that card: "Created in Todo · via `01a18563-…`", then the comment **"Board delegation smoke" — "Delegated subagent reporting in."**, then "Moved to Plan from Todo · via Board delegation smoke". | The comment and the move carry the **child's own session title**, not the parent's. The history reads as the family's work instead of the parent's retelling of it. |

## What the run does not show

One card, one child, one move forward. The refusals are covered by unit tests
(`lib/kanban-tool-domain.test.mjs`), not by this run: a helper editing the
title or description, a helper moving backward, a stranger touching the card,
and a **fork** — a fork copies `parentSession` but carries no dispatch entry, so
it is not a delegation and gains nothing.

The smoke card was deleted afterwards; the board was back to its 39 cards.

## Reproducing

`npm run dev` (port 30141), then a session in the project whose board is
`~/.pi/agent/kanban/<encoded-project-root>/kanban.sqlite`:

```
kanban create → note the key → Agent(subagent) with "kanban comment cardId <key>"
and "kanban update cardId <key> laneId <next lane>" → look at the card's activity
```

The child's session file must carry the `pi-web:subagent` dispatch entry — a
real subagent run writes it; a hand-made file without it is not a delegation.
