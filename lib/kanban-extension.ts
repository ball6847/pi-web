import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { cardForSession } from "./kanban-shared";
import { executeKanbanToolRequest, readBoard } from "./kanban-store";
import { parseKanbanToolRequest, type KanbanToolResult } from "./kanban-tool-domain";
import { KanbanToolOutputSchema, KanbanToolParameters } from "./kanban-tool-schema";
import { isReadOnlySelection } from "./mcp-read-only-policy";
import { readSessionToolSelection } from "./session-tool-selection";
import { KANBAN_LANE_INSTRUCTIONS_MAX, KANBAN_NOTICE_LANE_LIMIT } from "./kanban-tool-limits";
import type { KanbanCard, KanbanLane } from "./kanban-types";
import type { SessionEntry } from "./types";

export const KANBAN_EXTENSION_NAME = "pi-web-kanban";

/**
 * The one line a run gets when this session's card or the board's lanes change.
 * `display: false` keeps it out of the chat: it is context for the model, not a
 * message the user sent. Never sent twice for the same state, so a session costs
 * a few dozen tokens per change instead of one line per turn.
 */
export const KANBAN_CARD_NOTICE_TYPE = "pi-web:kanban-card";

/** What "no card" hashes to, so a link coming and going is one comparison. */
export const KANBAN_NO_CARD = "none";

/** What "no lane instructions" hashes to: no card, no lane, or a lane without them. */
export const KANBAN_NO_LANE_INSTRUCTIONS = "none";

/** The dismiss line after the card leaves an instructed lane (or its instructions are cleared). */
export const KANBAN_LANE_INSTRUCTIONS_DROPPED = "Kanban: the lane instructions given earlier no longer apply.";

/**
 * The three halves of a notice's state, kept apart so a card change never
 * re-sends the lanes, and neither re-sends the lane instructions.
 */
export interface KanbanNoticeState {
  /** The session's card: id, lane and title; `KANBAN_NO_CARD` when it has none. */
  card: string;
  /** The board's lanes: id, name and the fixed flag, in board order. */
  lanes: string;
  /** The card's lane instructions: `laneId#hash(text)`; `KANBAN_NO_LANE_INSTRUCTIONS` when there are none. */
  laneInstr: string;
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

/** The link, not the card: an id, so a move or a rename is not a state transition worth a line. */
export function kanbanCardSignature(card: KanbanCard | null): string {
  return card ? card.id : KANBAN_NO_CARD;
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

/**
 * The lane-instructions identity of a card's position: the lane id plus a hash
 * of its instructions, so entering an instructed lane, and editing those
 * instructions, are each one transition — while a card move or a lane rename
 * that leaves the text alone is not.
 */
export function kanbanLaneInstructionSignature(lanes: KanbanLane[], card: KanbanCard | null): string {
  const lane = card ? lanes.find((entry) => entry.id === card.laneId) ?? null : null;
  const text = lane?.instructions?.trim() ?? "";
  return text ? `${lane!.id}#${hashText(text)}` : KANBAN_NO_LANE_INSTRUCTIONS;
}

/**
 * The injection block, bounded so one lane cannot blow the context; empty when
 * there is nothing to say. The lane's current name rides along with its id, so
 * a renamed default lane (id `lane-deploy`, now "Review") reads right in the
 * transcript — the id stays the stable handle the model updates with.
 */
export function kanbanLaneInstructionsText(lanes: KanbanLane[], card: KanbanCard | null): string {
  const lane = card ? lanes.find((entry) => entry.id === card.laneId) ?? null : null;
  const text = lane?.instructions?.trim() ?? "";
  if (!text) return "";
  const points = [...text];
  const bounded = points.length > KANBAN_LANE_INSTRUCTIONS_MAX
    ? `${points.slice(0, KANBAN_LANE_INSTRUCTIONS_MAX).join("")}\n…[truncated]`
    : text;
  const name = lane!.name.replace(/\s+/g, " ").trim() || lane!.id;
  return `Kanban lane instructions for ${name} (${lane!.id}):\n${bounded}`;
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
  options: { wasTracked?: boolean; cardChanged?: boolean; lanesChanged?: boolean; laneInstrChanged?: boolean; laneInstrDropped?: boolean } = {},
): { state: KanbanNoticeState; content: string } {
  const state: KanbanNoticeState = {
    card: kanbanCardSignature(card),
    lanes: kanbanLaneSignature(lanes),
    laneInstr: kanbanLaneInstructionSignature(lanes, card),
  };
  const lines: string[] = [];
  if (options.cardChanged !== false) {
    if (card) {
      lines.push(`Kanban: this session is on card ${card.id}. `
        + "Always keep its lane matching your actual status with kanban update (no cardId).");
    }
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
 * What this session last heard about its card, and how much context it had heard
 * it in. A compaction or a branch switch replaces that context with fewer
 * entries, so `seenAt` is the guard: a memory that predates the shrunken context
 * is stale, and the notice is repeated once for the model that lost it.
 */
type NoticeMemory = Map<string, { state: KanbanNoticeState; seenAt: number }>;

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
    // A notice persisted before lane instructions existed has no third half: it reads as "none".
    return { card: details.card, lanes: details.lanes, laneInstr: typeof details.laneInstr === "string" ? details.laneInstr : KANBAN_NO_LANE_INSTRUCTIONS };
  }
  return undefined;
}

const sameState = (a: KanbanNoticeState | undefined, b: KanbanNoticeState): boolean =>
  a !== undefined && a.card === b.card && a.lanes === b.lanes && a.laneInstr === b.laneInstr;

/**
 * A run's card notice, or undefined when there is nothing new to say. Reads are
 * non-creating and never throw into the run: a board that cannot be read (a
 * removed worktree, another build's schema) must not block the prompt.
 */
async function cardNoticeForRun(ctx: ExtensionContext, memory: NoticeMemory) {
  const snapshot = await readBoard(ctx.cwd, { create: false });
  if (!snapshot.ok) return undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  const context = contextEntries(ctx);
  const prior = priorState(ctx, memory, sessionId, context);
  const card = cardForSession(snapshot.board, sessionId) ?? null;
  const laneInstr = kanbanLaneInstructionSignature(snapshot.board.lanes, card);
  // Each half speaks for itself: a link change never re-sends the lanes, and
  // neither re-sends the lane instructions.
  const notice = kanbanCardNotice(snapshot.board.lanes, card, {
    wasTracked: prior !== undefined && prior.card !== KANBAN_NO_CARD,
    cardChanged: prior === undefined || prior.card !== kanbanCardSignature(card),
    lanesChanged: prior === undefined || prior.lanes !== kanbanLaneSignature(snapshot.board.lanes),
    laneInstrChanged: prior === undefined || prior.laneInstr !== laneInstr,
    // The card left an instructed lane, or its instructions were cleared while
    // the card sits there. An unlink is already the card half's own line.
    laneInstrDropped: prior !== undefined
      && prior.laneInstr !== KANBAN_NO_LANE_INSTRUCTIONS
      && laneInstr === KANBAN_NO_LANE_INSTRUCTIONS
      && card !== null,
  });
  memory.set(sessionId, { state: notice.state, seenAt: context.length });
  if (sameState(prior, notice.state)) return undefined;
  return { message: { customType: KANBAN_CARD_NOTICE_TYPE, content: notice.content, display: false, details: notice.state } };
}

/** Normal sessions use the live persisted pin; children supply their snapshot/profile policy. */
export function createKanbanExtension(options?: { isReadOnly?: (ctx: ExtensionContext) => boolean }): InlineExtension {
  const isReadOnly = options?.isReadOnly ?? normalSessionIsReadOnly;
  const notices: NoticeMemory = new Map();
  return {
    name: KANBAN_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", async (_event, ctx) => {
        try {
          return await cardNoticeForRun(ctx, notices);
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
          + "read with cardId returns that one card in full. "
          + "create requires title and defaults to an independent, sessionless Backlog card; an explicit work lane attaches it to this session. "
          + "update patches title/description/laneId; omitted fields stay unchanged, empty description clears it. Omit cardId to update your linked card. "
          + "An explicit work lane on a free card claims it. Never edit another session's card or claim a second card. Linked cards cannot enter Backlog. "
          + "Use explicit lane IDs from read; same-lane updates do not reorder. Read-only sessions may read and search only. "
          + "Create is not idempotent: do not blindly retry it. For delegation, create a Backlog task and pass its cardId in the existing Agent prompt; this tool launches nothing.",
        parameters: KanbanToolParameters,
        outputSchema: KanbanToolOutputSchema,
        async execute(_toolCallId, input, signal, _onUpdate, ctx) {
          const parsed = parseKanbanToolRequest(input);
          if (!parsed.ok) return toolResult(parsed);
          // This belongs INSIDE execute, not only a tool_call hook: every direct
          // or nested execution must be checked against the executing session.
          if ((parsed.request.action === "create" || parsed.request.action === "update") && isReadOnly(ctx)) {
            return toolResult({ ok: false, code: "read-only", error: "This session is read-only. Use kanban read or search; switch to a write-capable session or subagent profile to create or update tasks." });
          }
          const sessionId = ctx.sessionManager.getSessionId();
          const result = await executeKanbanToolRequest(ctx.cwd, {
            sessionId,
            sessionTitle: ctx.sessionManager.getSessionName() ?? sessionId,
          }, parsed.request, signal);
          // The model just saw this card in the result; do not repeat it next run.
          if (result.ok && (result.action === "create" || result.action === "update") && result.card.sessionId === sessionId) {
            // Only the card half is known here, and a card edit says nothing about the
            // board's lanes. Without an earlier notice there is no lane half to keep, so
            // leave the memory alone: the next run announces lanes and card together.
            const context = contextEntries(ctx);
            const prior = priorState(ctx, notices, sessionId, context);
            if (prior !== undefined) notices.set(sessionId, { state: { ...prior, card: kanbanCardSignature(result.card) }, seenAt: context.length });
          }
          return toolResult(result);
        },
      });
    },
  };
}
