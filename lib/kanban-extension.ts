import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { cardForSession, kanbanBoardNotice, KANBAN_DELEGATED_NOTICE_TEMPLATE, kanbanNoticeValues, renderKanbanNoticeTemplate } from "./kanban-shared";
import { executeKanbanToolRequest, readBoard } from "./kanban-store";
import { readSessionDelegatedFrom } from "./session-reader";
import { parseKanbanToolRequest, type KanbanToolResult } from "./kanban-tool-domain";
import { KanbanToolOutputSchema, KanbanToolParameters } from "./kanban-tool-schema";
import { isReadOnlySelection } from "./mcp-read-only-policy";
import { readSessionToolSelection } from "./session-tool-selection";
import { KANBAN_LANE_INSTRUCTIONS_MAX, KANBAN_LANE_INSTRUCTIONS_TOTAL_MAX, KANBAN_NOTICE_LANE_LIMIT } from "./kanban-tool-limits";
import { kanbanCardKey, type KanbanCard, type KanbanLane } from "./kanban-types";
import type { SessionEntry } from "./types";

export const KANBAN_EXTENSION_NAME = "pi-web-kanban";

/**
 * The one line a run gets when this session's card or the board's lanes change,
 * plus the board's own reminder every N turns (`set-notice`). `display: false`
 * keeps it out of the chat: it is context for the model, not a message the user
 * sent. Never sent twice for the same state, so a session costs a few dozen
 * tokens per change instead of one line per turn — unless the board's reminder
 * asks for that line again, which is one deliberate repeat per N turns.
 */
export const KANBAN_CARD_NOTICE_TYPE = "pi-web:kanban-card";

/** What "no card" hashes to, so a link coming and going is one comparison. */
export const KANBAN_NO_CARD = "none";

/** What "no lane instructions" hashes to: no card, or no instruction on the card's runway. */
export const KANBAN_NO_LANE_INSTRUCTIONS = "none";

/** What "the built-in card line" hashes to: a board that stored no template. */
export const KANBAN_NO_TEMPLATE = "none";

/** The dismiss line once no lane on the card's runway carries instructions. */
export const KANBAN_LANE_INSTRUCTIONS_DROPPED = "Kanban: the lane instructions given earlier no longer apply.";

/**
 * The three halves of a notice's state plus the wording, kept apart so a card
 * change never re-sends the lanes, and neither re-sends the lane instructions.
 */
export interface KanbanNoticeState {
  /** The session's card: id, lane and title; `KANBAN_NO_CARD` when it has none. */
  card: string;
  /** The board's lanes: id, name and the fixed flag, in board order. */
  lanes: string;
  /** The card's instructions: `position>laneId#hash(text)>…` over its runway; `KANBAN_NO_LANE_INSTRUCTIONS` when none applies. */
  laneInstr: string;
  /**
   * The board's notice template: `hash(text)`, or `KANBAN_NO_TEMPLATE` for the
   * built-in line. Editing the wording is a change the model must hear — it is
   * what the whole experimenting loop is for; a notice persisted before this
   * half existed reads as `KANBAN_NO_TEMPLATE`.
   */
  text: string;
}

/**
 * The lanes as bare ids in board order: enough to place a card or name a lane,
 * with names, descriptions, counts and the fixed flag left to `kanban read`.
 * Counts and timestamps must never join this line — they move with every card
 * edit and would turn a one-time note into a per-move announcement.
 */
export function kanbanBoardLanesText(lanes: KanbanLane[]): string {
  const shown = lanes.slice(0, KANBAN_NOTICE_LANE_LIMIT).map((lane) => lane.id);
  const rest = lanes.length - shown.length;
  return rest > 0 ? `${shown.join(",")} +${rest} more (kanban read lists them)` : shown.join(",");
}

/**
 * The card half's identity: the card and the lane it sits in. The lane is part of
 * it because another session can move the card between this session's runs — the
 * owner, or a session the owner delegated to — and that move is exactly what the
 * model has to hear before it acts again. A rename or a description edit stays
 * out: neither changes where the card is.
 */
export function kanbanCardSignature(card: KanbanCard | null): string {
  return card ? `${card.id}#${card.laneId}` : KANBAN_NO_CARD;
}

/** The lanes' identity: ids in board order, so adding, removing or reordering one is a change. */
export function kanbanLaneSignature(lanes: KanbanLane[]): string {
  return JSON.stringify(lanes.map((lane) => lane.id));
}

/** A stable 32-bit FNV-1a hash, base36: the instruction text's half of a signature. */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** The template's identity: a blank template is the built-in line, so both are `none`. */
export function kanbanTemplateSignature(template = ""): string {
  const text = template.trim();
  return text ? hashText(text) : KANBAN_NO_TEMPLATE;
}

/**
 * The lanes whose instructions a card still has to meet, or `null`: its own lane,
 * then every instructed lane after it. A run cannot read a later lane's text until
 * it moves there, by which point the work that produces that lane is done.
 */
function laneInstructionRunway(lanes: KanbanLane[], card: KanbanCard | null) {
  if (!card) return null;
  const from = lanes.findIndex((lane) => lane.id === card.laneId);
  if (from < 0) return null;
  const runway = lanes.slice(from)
    .map((lane, index) => ({ lane, now: index === 0, text: (lane.instructions ?? "").trim() }))
    .filter((entry) => entry.text !== "");
  return runway.length > 0 ? { from, runway } : null;
}

/**
 * How far along the board the card sits, then each runway lane's id and a hash of
 * its text. The position is in it because the block marks the card's own lane
 * `[now]`: a card moving into an instructed lane changes "ahead of me" to "mine"
 * without any text changing. A lane rename alone is not a transition.
 */
export function kanbanLaneInstructionSignature(lanes: KanbanLane[], card: KanbanCard | null): string {
  const ahead = laneInstructionRunway(lanes, card);
  if (ahead === null) return KANBAN_NO_LANE_INSTRUCTIONS;
  return [String(ahead.from), ...ahead.runway.map((entry) => `${entry.lane.id}#${hashText(entry.text)}`)].join(">");
}

/** A lane's current name rides with its id: a renamed default lane (id `lane-deploy`, now "Review") reads right in the transcript. */
function laneLabel(lane: KanbanLane): string {
  return `${lane.name.replace(/\s+/g, " ").trim() || lane.id} (${lane.id})`;
}

/** One lane's text as injected: bounded, because a hand-edited file can hold more than the route's cap. */
function boundedLaneText(text: string): string {
  const points = [...text];
  return points.length > KANBAN_LANE_INSTRUCTIONS_MAX
    ? `${points.slice(0, KANBAN_LANE_INSTRUCTIONS_MAX).join("")}\n…[truncated]`
    : text;
}

/**
 * The card's lane marked `[now]`, then the instructed lanes after it, so a run
 * knows every step before it takes one. Bounded per lane and over the whole block;
 * a lane past the block's budget is named, not dropped, so the run knows its text
 * arrives with the card.
 */
export function kanbanLaneInstructionsText(lanes: KanbanLane[], card: KanbanCard | null): string {
  const ahead = laneInstructionRunway(lanes, card);
  if (ahead === null) return "";
  const { from, runway } = ahead;
  const lines = [
    `Kanban lane instructions — step ${from + 1} of ${lanes.length}, ${laneLabel(lanes[from])}; these apply in board order as the card moves:`,
  ];
  let used = lines[0].length;
  const omitted: string[] = [];
  for (const entry of runway) {
    const section = `${entry.now ? "[now] " : ""}${laneLabel(entry.lane)}:\n${boundedLaneText(entry.text)}`;
    // The card's own lane is never dropped: the per-lane cap already fits it in the total.
    if (!entry.now && used + section.length > KANBAN_LANE_INSTRUCTIONS_TOTAL_MAX) {
      omitted.push(laneLabel(entry.lane));
      continue;
    }
    lines.push(section);
    used += section.length + 1;
  }
  if (omitted.length > 0) lines.push(`[… ${omitted.join(", ")} — beyond what fits here; their instructions arrive when the card reaches them]`);
  return lines.join("\n");
}

/**
 * The line the card half of a notice speaks: the board's own template, or the
 * built-in one. `{cardKey}`, `{cardId}`, `{title}`, `{lane}` and `{laneId}` are
 * the placeholders; the lane is the one the card sits in NOW, which is the fact
 * a model has to compare against what it is doing.
 */
export function kanbanCardNoticeLine(
  lanes: KanbanLane[],
  card: KanbanCard,
  cardKey: string,
  template = "",
): string {
  return renderKanbanNoticeTemplate(template, kanbanNoticeValues(lanes, card, cardKey));
}

/**
 * The notice for a state change. Each half speaks only for itself: a link
 * change never re-sends the lanes, and neither re-sends the lane instructions.
 * The instructions are their own block, never part of the lanes line (ids
 * only). Pure: the same board and card yield the same state and the same text.
 */
export function kanbanCardNotice(
  lanes: KanbanLane[],
  card: KanbanCard | null,
  options: {
    wasTracked?: boolean;
    cardChanged?: boolean;
    lanesChanged?: boolean;
    laneInstrChanged?: boolean;
    laneInstrDropped?: boolean;
    /** The card's human key (`PIW-42`): what the model and the user both read. Falls back to the id. */
    cardKey?: string;
    /** The board's notice template (`set-notice`); blank means the built-in line. */
    template?: string;
  } = {},
): { state: KanbanNoticeState; content: string } {
  const state: KanbanNoticeState = {
    card: kanbanCardSignature(card),
    lanes: kanbanLaneSignature(lanes),
    laneInstr: kanbanLaneInstructionSignature(lanes, card),
    text: kanbanTemplateSignature(options.template ?? ""),
  };
  const lines: string[] = [];
  if (options.cardChanged !== false) {
    if (card) lines.push(kanbanCardNoticeLine(lanes, card, options.cardKey ?? card.id, options.template));
    else if (options.wasTracked) lines.push("Kanban: this session is no longer on a Kanban card.");
  }
  if (options.lanesChanged !== false) lines.push(`Kanban lanes in board order: ${kanbanBoardLanesText(lanes)}`);
  if (options.laneInstrChanged !== false) {
    const block = kanbanLaneInstructionsText(lanes, card);
    if (block) lines.push(block);
    else if (options.laneInstrDropped) lines.push(KANBAN_LANE_INSTRUCTIONS_DROPPED);
  }
  return { state, content: lines.join("\n") };
}

function normalSessionIsReadOnly(ctx: ExtensionContext): boolean {
  return isReadOnlySelection(readSessionToolSelection(ctx.sessionManager.getEntries() as unknown as SessionEntry[]));
}

function toolResult(result: KanbanToolResult) {
  return {
    content: [{ type: "text" as const, text: result.ok ? JSON.stringify(result, null, 2) : `kanban ${result.code}: ${result.error}` }],
    structuredContent: result,
    details: result,
    isError: !result.ok,
  };
}

/**
 * What this session last heard about its card, how much context it had heard it
 * in, and how many turns it has been quiet since. A compaction or a branch
 * switch replaces that context with fewer entries, so `seenAt` is the guard: a
 * memory that predates the shrunken context is stale, and the notice — and the
 * turn count — start again for the model that lost it.
 */
type NoticeMemory = Map<string, { state: KanbanNoticeState; seenAt: number; turns: number }>;
type NoticeMemoryValue = { state: KanbanNoticeState; seenAt: number; turns: number };

/**
 * The current context — what the model actually sees — not the whole append-only
 * file: an entry that compaction summarized away is not context any more.
 */
function contextEntries(ctx: ExtensionContext): SessionEntry[] {
  try {
    return ctx.sessionManager.buildContextEntries() as unknown as SessionEntry[];
  } catch {
    return ctx.sessionManager.getEntries() as unknown as SessionEntry[];
  }
}

function priorState(ctx: ExtensionContext, memory: NoticeMemory, sessionId: string, context: SessionEntry[]): KanbanNoticeState | undefined {
  // This process saw the state itself (a notice, or its own card mutation): trust
  // it while the context it was recorded in is still there.
  const remembered = memory.get(sessionId);
  if (remembered !== undefined && remembered.seenAt <= context.length) return remembered.state;
  for (let index = context.length - 1; index >= 0; index--) {
    const entry = context[index];
    if (entry.type !== "custom_message" || entry.customType !== KANBAN_CARD_NOTICE_TYPE) continue;
    const details = entry.details as Partial<KanbanNoticeState> | undefined;
    if (typeof details?.card !== "string" || typeof details.lanes !== "string") return undefined;
    // A notice persisted before lane instructions, or before the template, has a
    // half less: it reads as "none", which is the state the built-in defaults are.
    return {
      card: details.card,
      lanes: details.lanes,
      laneInstr: typeof details.laneInstr === "string" ? details.laneInstr : KANBAN_NO_LANE_INSTRUCTIONS,
      text: typeof details.text === "string" ? details.text : KANBAN_NO_TEMPLATE,
    };
  }
  return undefined;
}

const sameState = (a: KanbanNoticeState | undefined, b: KanbanNoticeState): boolean =>
  a !== undefined && a.card === b.card && a.lanes === b.lanes && a.laneInstr === b.laneInstr && a.text === b.text;

/**
 * A run's card notice, or a reminder when none is due but the board asks for
 * one. Reads are non-creating and never throw into the run: a board that cannot
 * be read (a removed worktree, another build's schema) must not block the prompt.
 *
 * `before_agent_start` fires once per turn, which is what the reminder counts: a
 * session's first turn is turn 1, and a notice that was actually sent (a change)
 * puts the count back to zero. Nothing is stored for it, so a restarted server
 * starts counting again — the transcript still holds the last notice, and the
 * reminder is a nudge, not a rule.
 */
async function cardNoticeForRun(ctx: ExtensionContext, memory: NoticeMemory, delegatedCard: boolean) {
  return noticeForSession(ctx, memory, delegatedCard);
}

/**
 * The session's own card, or one this session was explicitly delegated: never
 * the caller's card by inheritance. The store checks that `delegatedFrom` is
 * the real caller before a child can act on a card it does not own.
 */
async function noticeCard(snapshot: Awaited<ReturnType<typeof readBoard>>, sessionId: string): Promise<{ card: KanbanCard | null; delegated: boolean }> {
  if (!snapshot.ok) return { card: null, delegated: false };
  const own = cardForSession(snapshot.board, sessionId);
  if (own) return { card: own, delegated: false };
  const delegatedFrom = await readSessionDelegatedFrom(sessionId);
  if (!delegatedFrom) return { card: null, delegated: false };
  const delegated = cardForSession(snapshot.board, delegatedFrom);
  return { card: delegated, delegated: delegated !== null };
}

async function noticeForSession(
  ctx: ExtensionContext,
  memory: NoticeMemory,
  delegatedCard: boolean,
) {
  const snapshot = await readBoard(ctx.cwd, { create: false });
  if (!snapshot.ok) return undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  const context = contextEntries(ctx);
  const prior = priorState(ctx, memory, sessionId, context);
  const resolved = delegatedCard
    ? await noticeCard(snapshot, sessionId)
    : { card: snapshot.ok ? cardForSession(snapshot.board, sessionId) : null, delegated: false };
  const card = resolved.card;
  const boardNotice = kanbanBoardNotice(snapshot.board);
  // An owner-facing line is wrong for a delegated child: it names the wrong
  // owner and tells the child to move a card by a cardId-less update.
  const lineTemplate = resolved.delegated ? KANBAN_DELEGATED_NOTICE_TEMPLATE : boardNotice.template;
  const textSignature = kanbanTemplateSignature(lineTemplate);
  // A session with no card does not care about the board: nothing is injected
  // for it — not even the lane ids — so a plain session runs kanban-free until
  // it claims or is handed a card. The one exception is the turn a link is
  // LOST: the model was working to a card a run ago, so it hears that once.
  if (card === null) {
    if (prior === undefined || prior.card === KANBAN_NO_CARD) return undefined;
    const state: KanbanNoticeState = {
      card: KANBAN_NO_CARD,
      lanes: kanbanLaneSignature(snapshot.board.lanes),
      laneInstr: KANBAN_NO_LANE_INSTRUCTIONS,
      text: textSignature,
    };
    memory.set(sessionId, { state, seenAt: context.length, turns: 0 });
    return {
      message: {
        customType: KANBAN_CARD_NOTICE_TYPE,
        content: "Kanban: this session is no longer on a Kanban card.",
        display: false,
        details: state,
      },
    };
  }
  const cardKey = kanbanCardKey(snapshot.board, card);
  const laneInstr = kanbanLaneInstructionSignature(snapshot.board.lanes, card);
  // Attach parity: the card attached mid-session hears the SAME full prompt a
  // session started with its card gets — card line, lanes line, whole runway.
  // (A cardless session never injected, so `prior` is usually undefined here;
  // the dismissal state after an unlink is the other way it can be no-card.)
  const attached = prior === undefined || prior.card === KANBAN_NO_CARD;
  // Each half speaks for itself: a link change never re-sends the lanes, and
  // neither re-sends the lane instructions.
  const notice = kanbanCardNotice(snapshot.board.lanes, card, {
    cardKey,
    template: lineTemplate,
    wasTracked: prior !== undefined && prior.card !== KANBAN_NO_CARD,
    // The wording is part of the card half: an edited template is exactly the
    // experiment the board's own setting exists for, so the next turn hears it.
    cardChanged: prior === undefined || prior.card !== kanbanCardSignature(card) || prior.text !== textSignature,
    lanesChanged: attached || prior.lanes !== kanbanLaneSignature(snapshot.board.lanes),
    laneInstrChanged: prior === undefined || prior.laneInstr !== laneInstr,
    // The card left an instructed lane, or its instructions were cleared while
    // the card sits there. An unlink is already the card half's own line.
    laneInstrDropped: prior !== undefined
      && prior.laneInstr !== KANBAN_NO_LANE_INSTRUCTIONS
      && laneInstr === KANBAN_NO_LANE_INSTRUCTIONS
      && card !== null,
  });
  const changed = !sameState(prior, notice.state);
  const remembered = memory.get(sessionId);
  const turns = 1 + (remembered !== undefined && remembered.seenAt <= context.length ? remembered.turns : 0);
  const every = boardNotice.reminderTurns;
  // A reminder is the card line once more, re-rendered: the lane it names is the
  // current one, so the model can compare it against what it is doing. A session
  // with no card is never reminded — there is no lane to keep in sync.
  const reminder = !changed && every > 0 && turns >= every && card !== null
    ? kanbanCardNoticeLine(snapshot.board.lanes, card, cardKey ?? card.id, lineTemplate)
    : null;
  memory.set(sessionId, { state: notice.state, seenAt: context.length, turns: changed || reminder !== null ? 0 : turns });
  if (changed) {
    return { message: { customType: KANBAN_CARD_NOTICE_TYPE, content: notice.content, display: false, details: notice.state } };
  }
  if (reminder !== null) {
    return { message: { customType: KANBAN_CARD_NOTICE_TYPE, content: reminder, display: false, details: notice.state } };
  }
  return undefined;
}

export interface KanbanNoticeOptions {
  /**
   * Decides per turn whether this session may be injected into at all. Card
   * resolution still never inherits a caller's card by accident.
   */
  enabled?: (ctx: ExtensionContext) => boolean | Promise<boolean>;
  /**
   * Whether a delegated session may hear the runway of the card it was told to
   * work on. The store still verifies the actual delegation before allowing it
   * to act; this only chooses what the notice resolves.
   */
  delegatedCard?: boolean;
  /** Normal sessions use the live persisted pin; children supply their snapshot/profile policy. */
  isReadOnly?: (ctx: ExtensionContext) => boolean;
}

/** Normal sessions use the live persisted pin; children supply their snapshot/profile policy. */
export function createKanbanExtension(options?: KanbanNoticeOptions): InlineExtension {
  const isReadOnly = options?.isReadOnly ?? normalSessionIsReadOnly;
  const notices: NoticeMemory = new Map();
  const delegatedCard = options?.delegatedCard === true;
  return {
    name: KANBAN_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      const sendNotice = (ctx: ExtensionContext, message: { message: { content: string; details: KanbanNoticeState } }) => {
        if (!message.message.content) return;
        pi.sendMessage({
          customType: KANBAN_CARD_NOTICE_TYPE,
          content: message.message.content,
          display: false,
          details: message.message.details,
        }, ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" });
      };
      pi.on("before_agent_start", async (_event, ctx) => {
        try {
          // Never for a session with no card of its own: the notices are about
          // the card THIS session owns, and its lane's way of working.
          if (options?.enabled && !(await options.enabled(ctx))) return undefined;
          return await cardNoticeForRun(ctx, notices, delegatedCard);
        } catch {
          // Never let the notice grow into a failed prompt.
          return undefined;
        }
      });
      pi.registerTool({
        name: "kanban",
        label: "Kanban",
        exposure: "direct",
        description: "Read or manage tasks on this session's project Kanban board (shared by its worktrees). "
          + "read with no cardId lists the lanes with their card counts and your own linked card; it never sends every card body. "
          + "search finds cards by literal text (title or description) and/or one laneId, returning at most `limit` compact rows (id, title, laneId, excerpt); narrow with query instead of raising limit. "
          + "read with cardId returns that one card in full, with its newest comments (bounded). "
          + "A card is named by its key (like PIW-42, shown in every read and on the board) or its id; both work as cardId. "
          + "create requires title and defaults to an independent, sessionless Backlog card; an explicit work lane attaches it to this session. "
          + "update patches title/description/laneId; omitted fields stay unchanged, empty description clears it. Omit cardId to update your linked card. "
          + "An explicit work lane on a free card claims it. Never edit another session's card or claim a second card. Linked cards cannot enter Backlog. "
          + "A card owned by the session that delegated work to you is the one exception: pass its cardId (read prints its key) to comment on it or move it one lane forward; leave its title and description to its owner. "
          + "comment writes one note to a card's thread (your linked card when cardId is omitted): record the handoff, the decision and what is left, as the work moves. Any session may comment on any card; each note names its source session. "
          + "Use explicit lane IDs from read; same-lane updates do not reorder. Read-only sessions may read and search only. "
          + "Create is not idempotent: do not blindly retry it. For delegation, create a Backlog task and pass its cardId in the existing Agent prompt; this tool launches nothing.",
        parameters: KanbanToolParameters,
        outputSchema: KanbanToolOutputSchema,
        async execute(_toolCallId, input, signal, _onUpdate, ctx) {
          const parsed = parseKanbanToolRequest(input);
          if (!parsed.ok) return toolResult(parsed);
          // This belongs INSIDE execute, not only a tool_call hook: every direct
          // or nested execution must be checked against the executing session.
          if ((parsed.request.action === "create" || parsed.request.action === "update" || parsed.request.action === "comment") && isReadOnly(ctx)) {
            return toolResult({ ok: false, code: "read-only", error: "This session is read-only. Use kanban read or search; switch to a write-capable session or subagent profile to create, update or comment on tasks." });
          }
          const sessionId = ctx.sessionManager.getSessionId();
          const result = await executeKanbanToolRequest(ctx.cwd, {
            sessionId,
            sessionTitle: ctx.sessionManager.getSessionName() ?? sessionId,
          }, parsed.request, signal);
          // A claim or lane change is news now, not at the next user turn: a long
          // autonomous run must hear its runway before it keeps working.
          if (result.ok && (result.action === "create" || result.action === "update") && result.card.sessionId === sessionId) {
            const context = contextEntries(ctx);
            const prior = priorState(ctx, notices, sessionId, context);
            const next: NoticeMemoryValue | undefined = prior === undefined
              ? undefined
              : { state: { ...prior, card: kanbanCardSignature(result.card) }, seenAt: context.length, turns: 0 };
            if (next) notices.set(sessionId, next);
            const message = await noticeForSession(ctx, notices, delegatedCard);
            if (message?.message.content) sendNotice(ctx, message);
            else if (next) notices.set(sessionId, next);
          }
          return toolResult(result);
        },
      });
    },
  };
}
