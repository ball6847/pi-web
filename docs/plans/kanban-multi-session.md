# Multiple agent sessions on one card

Status: proposal, awaiting sign-off. Nothing here is implemented.

The board enforces "one session, one card" three times over: in the reducers
(`linkCard`'s `dropOtherLinks`), in the agent tool (`resolveKanbanToolCard`
refuses a foreign link), and in the file
(`CREATE UNIQUE INDEX cards_session ON cards(session_id) WHERE session_id IS NOT NULL`).
The question is whether that rule still pays for itself now that a session's work
is usually done by a **family** of sessions (a parent plus its subagents).

## Verdict

1. **Yes to 1:N** — a card may carry **one owner plus a bounded list of helpers**.
2. **No to N:M** — a session still sits on **at most one card**; that side of the
   invariant is the one the prompt vocabulary depends on, and it stays.
3. **P0 first** — a subagent acting as its parent (a resolver, ~1 h, no schema
   change) removes the reported pain by itself. The list UI is P1–P2.

## Is it worth it? — measured answer

The verdict above is about the *shape*. Whether to **build the whole thing** is a
different question, and the measurements say no:

- **110** subagent sessions exist on this machine; **11** of them ran in a pi-web
  cwd. **34** distinct sessions have ever acted on this board. **Zero** of them
  were subagent sessions.
- **1** of 33 linked cards has activity from more than one session, and that one
  came from `link-session` stealing the card, not from a deliberate second owner.
- No card is linked to a subagent session — so the "subagents fork their own
  cards" workaround predicted in objection 6 has not actually happened here
  either. Subagents, in practice, do not attempt board work; they are given a
  report to produce and they return it.

So: **do P0, defer P1/P2.** P0 makes the family visible where it matters — the
activity journal already names the actor session, so a child's comment and lane
move appear under the child's name with no schema change and no UI work. That is
most of the perceived benefit of "multiple sessions on a card" for 1 h.

P1/P2 are a real feature with a real permanent cost — a role dimension, a
capability matrix, a schema migration, a `+N` pill, a "Working with" row, an
i18n set and a bounds cap — bought for a workflow that has not been observed
once. Worse, its failure mode (two agents racing one lane) is precisely what the
current rule protects against.

**The trigger to reconsider:** a person asks to put a session on a card that is
**not** its own child (a second terminal on the same work item, a handover
between unrelated sessions), or P0 lands and children still cannot do the work
they were delegated. Until then P1/P2 stay a plan, not code.

If a middle ground is wanted before the full model: **promote the journal, not
the link.** Today it already shows every actor; a grouped "who did what" line
under a card's header would put the family on screen for a few hours of work and
no migration. That is the cheap 80% while P0 ships.

## Why we should not do it — the objections, and which survive

### 1. The lane is the only coordination signal, and it becomes contested
**Survives, mitigated.**

The card notice says, once per run, "keep that lane matching what you are
actually doing" (`lib/kanban-extension.ts`, `cardNoticeForRun`). That sentence is
only coherent because exactly one session can be "doing" the card. With N
sessions, N agents hold that instruction for the same lane, and the board is
last-write-wins: parent still writing in Implement, reviewer subagent moves to
Review, parent's next write moves it back. The card's state stops being a fact
and becomes a race.

Mitigation: an **owner role** (only the owner moves the lane backwards, only the
owner edits text) + widening the notice's card signature from "the card id" to
"the card id and its lane" (`kanbanCardSignature` currently returns `card.id`
alone, so another session's lane move is invisible today and must not stay
invisible). That kills the oscillation but never makes it impossible — a helper
moving forward while the owner still works is still allowed, and still wrong.

### 2. "Your card" disappears from the prompt vocabulary
**Survives only because we keep session → card single-valued.**

`update { }` and `comment { }` with no `cardId` mean "your card"; the overview's
`currentCard`, the sidebar's tracked marker, the lane strip and the board chip
all read that one link. Allow a session to sit on two cards and every one of
those becomes a choice the model has to make — and models choose wrong. The
failure that class of bug produces (a description written to PIWEB-41 instead of
PIWEB-40) is silent and destructive, and today it cannot happen.

This is the decisive constraint on the shape: **card → many sessions, session →
one card.** Objections 1, 3 and 5 are all cheap once this holds.

### 3. The unique index is the only *enforced* form of the rule
**Survives as work, not as a blocker.**

Everything else is a reducer that can drift. Replacing the index needs a shape
that keeps *some* file-level guarantee. A link table with `session_id` as its
PRIMARY KEY does exactly that: the row is keyed by the session, so "a session
sits on at most one card" is enforced by SQLite while `card_id` may repeat —
1:N with the right invariant, no reducer required. A partial unique index
(`card_sessions_owner ON card_sessions(card_id) WHERE role = 'owner'`) then
enforces "exactly one owner per card". See §Design.

### 4. The context cost multiplies
**Does not survive.** At the realistic N (2–4) it is one extra notice line per
session per state change plus the lane-instructions block each session already
gets. Tens of tokens. This was never the reason.

### 5. Unlink / prune / snapshot semantics get subtler
**Survives as UI complexity.**

Today one link dies one way: the session file is gone → unlink, keep
`sessionTitle` as the snapshot (`pruneDeadLinks`). With N links: whose title is
the card's chip, what does the board show with 2 of 3 links dead, and does a
*helper's* death re-open anything? Handled by making the **owner link the
promoted one**: the card row keeps `session_id`/`session_title` as the owner's
mirror (so every existing reader — chip, notice, marker, prune — is untouched),
and helper links are rows that can die individually without the card changing
shape.

### 6. The cheap fix may already be enough
**Survives, and this is why P0 goes first.**

The real complaint is not "a card needs many owners". It is "a card's work is
done by a session family, and the board can only see one member of it". A
subagent spawned with `Agent` already **gets the `kanban` tool**
(`lib/subagent-runtime.ts` registers the host extension for every non-chat-only
child) and can already `read { cardId }` on its parent's card. What it cannot do
is `comment` or `update` it — `resolveKanbanToolCard` refuses with *"belongs to
another session; links cannot be stolen"*.

So the current workaround is the bad one: the subagent creates **its own** card,
the board shows it with the subagent glyph, and one unit of work becomes two
cards. `KanbanBoard.tsx` already carries a `subagent` prop for exactly that
case. If "participants" only ever means "the parent's children", a ~150-line
ownership resolver fixes it with no schema change and no UI.

### 7. Two agents editing the same description
**Survives, cheaply ruled out.** Title/description are last-write-wins strings.
Give helpers lane moves + comments and nothing else, and the class is gone.

### What NOT to conclude
- Not "one session per card is obsolete". The **owner** is the thing that makes
  the lane, the chip and "your card" well defined. Keep it.
- Not "every session should see every card". Participants are opt-in, and
  bounded.

## Evidence from this board

`~/.pi/agent/kanban/--Users-ball6847-Projects-personal-pi-web--/kanban.sqlite`:
33 cards carry a session link, 27 comments, 58 activity rows, 10 distinct actor
sessions — and exactly **one** card has activity written by more than one
session. Today that is only reachable by **stealing** the card through the
browser's `link-session` action, which `dropOtherLinks` implements by unlinking
the previous owner. So multi-session already exists in the file, in its worst
form: unannounced, and destructive to the previous owner's link.

## Design

### Data model — schema v6

```sql
-- One session, one card: the PRIMARY KEY is the session, and it keeps the
-- invariant in the file the way the old unique index did. A card holds many.
CREATE TABLE card_sessions (
  session_id    TEXT PRIMARY KEY,
  card_id       TEXT NOT NULL,
  role          TEXT NOT NULL,           -- 'owner' | 'helper'
  session_title TEXT NOT NULL,
  added_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX card_sessions_card ON card_sessions(card_id, added_at);
-- Exactly one owner per card.
CREATE UNIQUE INDEX card_sessions_owner ON card_sessions(card_id) WHERE role = 'owner';
```

- `cards.session_id` / `cards.session_title` **stay**, as a derived mirror of
  the owner link. `writeBoardRows` writes them from the link table, nobody
  authors them. This is what keeps `cardForSession`, `pruneDeadLinks`, the board
  chip, the lane strip, the notice and the sidebar marker unchanged.
- Migration v5 → v6 (additive, lossless): create the table and indexes, then
  `INSERT INTO card_sessions SELECT session_id, id, 'owner', session_title, updated_at FROM cards WHERE session_id IS NOT NULL`,
  then `DROP INDEX cards_session`. Bump the revision, as the v5 step does.
- Prune: `pruneDeadLinks` drops dead **helper** rows individually; a dead owner
  row is already handled by the existing `cards.session_id` path (unlink, keep
  the snapshot title). A card whose owner link dies keeps its helpers.
- `KanbanBoard` gains `cardSessions: KanbanCardSession[]` (flat, like comments
  are read separately — decide in P1; the flat list is cheaper for the board's
  one payload than nesting per card).

### Rules — who may do what

| Action | Owner | Helper | Browser (no session) |
| --- | --- | --- | --- |
| read / search | ✓ | ✓ | ✓ |
| comment | ✓ | ✓ | ✓ |
| move lane forward (next lane) | ✓ | ✓ | ✓ |
| move lane backward, reorder | ✓ | ✗ (comment instead) | ✓ |
| edit title / description | ✓ | ✗ | ✓ |
| link / unlink self | ✓ | ✓ (leave) | ✓ |
| link another session / detach it | ✓ | ✗ | ✓ |
| claim, create, advance, delete | ✓ | ✗ | ✓ |
| enter Backlog | ✗ while linked | ✗ | ✗ |

Helper lane moves carry one guard: **forward only, never into the fixed
backlog.** That is a two-line rule in `applyKanbanToolMutation` and it is what
makes objection 1 tractable rather than a policy nobody remembers.

### Agent tool surface (`lib/kanban-tool-domain.ts`)

- `read` overview: `currentCard` keeps meaning "the card *you own*". A helper
  gets `currentCard` + `role: "helper"` + `owner: { title }` instead of a second
  card — still one card per session, so the prompt vocabulary holds.
- `read { cardId }`: adds `sessions: [{ title, role, live }]`, bounded.
- No new action. **Linking stays a human/shell action**: a parent that wants a
  subagent on its card passes the key in the existing `Agent` prompt, and P0's
  family resolver already lets the child act on it. A model-facing `link` verb
  would be a second way to do something the prompt already does.
- Description: replace *"Never edit another session's card or claim a second
  card"* with *"You may act on your own card and on cards owned by the session
  that delegated to you; never claim a second card."*
- `resolveKanbanToolCard` gains the family resolver: the actor may act on a
  card whose owner is its **parent chain** (bounded, one `readSessionHeader` of
  `parentSession`, cached per call).

### UX / UI

Six surfaces, four of them existing components. Nothing is added to the board's
card body: no avatars stack, no new chrome.

**1. The board card's session chip** (`components/KanbanBoard.tsx`, the linked
row). The owner's glyph and title stay; when helpers exist, one `+2` pill
follows it (mono, dim, `aria-label="2 more sessions"`). Clicking the pill opens
the existing `CardMenu` popup (portaled, outside-close, Escape, phone bottom
sheet) with one row per helper — click a row, that chat opens. The activity slot
keeps its existing precedence (awaiting > running > unread); when a *helper*
runs, the spinner shows and the `+N` pill turns accent. No layout shift: the
pill lives inside the chip's existing row.

**2. The card detail tab, header** (`components/KanbanCardDetail.tsx`).
Unchanged owner chip and popup (`sessionMenuEntries`: the project's sessions,
"No session yet", "Start session → Todo"). Under it, one **"Working with"** row
— only when it has content, so the 95% single-session case renders exactly as
today:

```
[ owner chip ▾ ]                          Updated 2h ago
Working with:  [● reviewer  ×] [planner  ×] [+ link]
```

Each chip carries the subagent glyph when the session is a subagent (the board's
`subagents` map already knows) and `●` while running (the existing convention).
`×` detaches that session (`unlink-session` scoped to it); `+ link` opens the
same popup, filtered to sessions not already on the card. A helper opening the
tab sees the same row, but only `×` on itself.

**3. The chat's lane strip** (`components/KanbanLaneStrip.tsx`). Owner: byte for
byte today. Helper: the same `PIW-40 · Todo · title`, with a dim `helper` tag
before the control, and the menu's "Unlink from card" reads **"Leave card"** and
removes only that session's link.

**4. The activity journal.** Nothing to build: comments already carry
`sessionTitle` and activity rows carry `actorSessionId`/`actorSessionTitle`. The
value of the whole feature lands here — the card's history becomes the family's
history instead of the owner's retelling of it. Add one test asserting a
helper's comment and lane move both show the helper's name.

**5. The sidebar's tracked marker.** Free: `useKanbanSessionIndex()` maps
`sessionId → card`, so a helper's row gets the same marker, pointing at the card
it helps.

**6. i18n.** Four new keys × 3 locales (`en`, `zh-CN`, `zh-TW`):
`kanban.detailWorkingWith`, `kanban.detailLinkSession`, `kanban.detailDetach`,
`kanban.cardMoreSessions`.

**Deliberately not built:** per-session lane or per-session status (one card,
one lane — that is the point of a board); an assignee editor on the board card;
avatars; notification per participant; multi-card sessions; and any styling
that changes the board card's height when helpers appear.

## Phasing

- **P0 — subagents act as their parent. ~1 h.** Family resolver in
  `resolveKanbanToolCard` (`lib/kanban-tool-domain.ts`), one
  `readSessionHeader` + cache in `lib/kanban-store.ts`, a `delegated` marker in
  the child's notice line, the tool description. No schema, no UI. Tests:
  `lib/kanban-tool*.test.mjs` — a child may comment/move on its parent's card, a
  stranger still cannot.
- **P1 — the 1:N model. ~half a day.** Schema v6 + migration + `writeBoardRows`
  + prune; `KanbanAction` gains `link-helper` / `unlink-helper` (typed refusals
  for owner-only callers); shared reducers in `lib/kanban-shared.ts`; the rules
  matrix guards in `applyKanbanToolMutation`; the owner-mirror write; activity
  kinds `helper-added` / `helper-removed`.
- **P2 — the surfaces. ~half a day.** The `+N` pill and its popup, the "Working
  with" row, the strip's helper tag, i18n ×3.
- **P3 — docs. ~30 min.** `docs/agents/kanban.md` (schema paragraph, the rules
  matrix, the notice's widened card signature), the file map line in
  `AGENTS.md`, the tool description.

Total: **about a day and a half** with tests, if the migration and prune edges
don't bite; two days if they do.

## Tests to pin

`lib/kanban-client.test.mjs` (pure reducers): link-helper keeps the owner;
detaching the owner promotes the oldest helper; helper rows die with their
session; the lane-forward-only guard refuses a backward helper move; the same
session cannot be on two cards.

`lib/kanban-store*.test.mjs`: migration v5 → v6 keeps every card, every owner
and every revision; prune drops one helper and keeps the card; the file still
refuses a session on two cards (`PRIMARY KEY`), which is the invariant the old
`cards_session` index carried.

`lib/kanban-runtime.integration.test.mjs`: a real subagent run comments on and
moves its parent's card.

## Open questions — with the recommendation

Each is marked with what it is worth **now**: P0 is the only phase shipping, so a
P1/P2 question is a decision to record, not to build.

1. **Should the composer's "Track on board" offer joining as a helper** when the
   chosen card is already owned? **No — keep it owner-only.** *(P1/P2, record now.)*
   That picker lists cards without saying who owns them, and the attach happens
   before the session has a first message, so a helper would be created by
   accident. A deliberate join belongs on the card detail's `+ link`, never in the
   composer.
2. **Is a helper cap needed?** **Yes — 8, refused with a typed error.**
   *(P1/P2, record now.)* It bounds the popup, the notice line and the board
   payload, and it is the same shape as the existing search `max` limit. P0 needs
   **no cap**: nobody can add a helper there, and a session has exactly one
   parent.
3. **Should a helper's lane move comment automatically?** **No.** *(P1/P2, record
   now.)* The activity row already names the actor, and P0 makes that the child's
   own name — an auto-comment would duplicate what the trail says, double the
   write and break "comments are content, events are the frame".

Two decisions P0 does force, settled here so the implementation has no open
tab:

4. **Parent-chain depth is 1.** A child cannot spawn a grandchild: profile tool
   options always exclude `Agent`, `get_subagent_result` and `steer_subagent`
   (`subagentToolOptions()` in `lib/subagents.ts`). So exactly one
   `readSessionHeader` of `parentSession`, cached per tool call, no tuning
   constant and no chain walk.
5. **The card notice's signature must include the lane.** `kanbanCardSignature()`
   returns `card.id` alone today, so a lane move is deliberately not
   re-announced. Once a helper can move it, the owner must hear about it on its
   next turn: widen the signature to `id#laneId`. The price is one notice line per
   lane move per session instead of none — and that is the entire cost of P0's
   correctness.
