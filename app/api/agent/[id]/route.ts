import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession, setRpcSessionTools } from "@/lib/rpc-manager";
import { attachNewSessionCard } from "@/lib/kanban-store";
import type { KanbanAttachOutcome } from "@/lib/kanban-types";
import type { KanbanSessionCardPick } from "@/lib/kanban-shared";

/** The board's own title for a session: its first message, as the composer shows it. */
const SESSION_TITLE_MAX = 200;

function parseKanbanPick(value: unknown): KanbanSessionCardPick | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("kanban must be an object with cardId or laneId");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "cardId" && key !== "laneId") throw new Error(`kanban: unknown field "${key}"`);
  }
  const cardId = typeof raw.cardId === "string" && raw.cardId.trim() ? raw.cardId : null;
  const laneId = typeof raw.laneId === "string" && raw.laneId.trim() ? raw.laneId : null;
  if ((cardId === null) === (laneId === null)) throw new Error("kanban needs exactly one of cardId or laneId");
  return cardId !== null ? { cardId } : { laneId: laneId as string };
}

function firstMessageTitle(message: unknown, fallback: string): string {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return fallback;
  return text.length > SESSION_TITLE_MAX ? `${text.slice(0, SESSION_TITLE_MAX)}…` : text;
}

/**
 * The card a fresh composer's pick attaches, written **before** the prompt goes
 * out: pi runs `before_agent_start` (and so the board notice) while handling the
 * prompt, so a link applied afterwards — what the browser used to do once it
 * learned the session id — always reached the model one turn late. Best effort:
 * a board refusal is reported in the answer and never fails the prompt.
 */
async function attachPickedCard(cwd: string, sessionId: string, title: string, pick: KanbanSessionCardPick): Promise<KanbanAttachOutcome> {
  try {
    const attached = await attachNewSessionCard(cwd, { sessionId, sessionTitle: title }, pick);
    return attached.ok
      ? { ok: true, board: attached.board, revision: attached.revision }
      : { ok: false, error: attached.error, code: attached.code };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
import { cwdMissingBody, missingCwdFromBody } from "@/lib/missing-cwd";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    // A composer's first prompt carries its "Track on board" pick. It belongs to
    // this route, not to pi's command handler.
    const kanbanPick = commandType === "prompt" ? parseKanbanPick(body.kanban) : undefined;
    delete body.kanban;
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined
      && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }
    const toolNames = requestedToolNames as string[] | undefined;

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (body.type === "set_tools") {
      const filePath = existing?.sessionFile || await resolveSessionPath(id) || undefined;
      if (!existing?.isAlive() && !filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const changed = await setRpcSessionTools(id, filePath, toolNames);
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }
    if (existing?.isAlive()) {
      const kanban = kanbanPick
        ? await attachPickedCard(existing.cwd, id, firstMessageTitle(body.message, id), kanbanPick)
        : undefined;
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: result, ...(kanban ? { kanban } : {}) });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
    const kanban = kanbanPick
      ? await attachPickedCard(session.cwd, id, firstMessageTitle(body.message, id), kanbanPick)
      : undefined;
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    return NextResponse.json({ success: true, data: result, ...(kanban ? { kanban } : {}) });
  } catch (error) {
    // Read by its fields: the wrapper that threw may come from another route's bundle.
    const missingCwd = missingCwdFromBody(error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(missingCwd ? cwdMissingBody(missingCwd) : {}),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" }) as Record<string, unknown>;
    // Status reads leave out the system prompt, most of the reply (agentStatusUrl()).
    if (new URL(req.url).searchParams.get("systemPrompt") === "0") delete state.systemPrompt;
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
