import { NextResponse } from "next/server";
import { KANBAN_LANE_INSTRUCTIONS_MAX } from "@/lib/kanban-tool-limits";
import type { KanbanAction, KanbanBoardResponse } from "@/lib/kanban-types";
import {
  applyMutation,
  getBoardRevision,
  readBoard,
  validateKanbanCwd,
  type KanbanBoardResult,
  type KanbanFailure,
  type KanbanFailureCode,
} from "@/lib/kanban-store";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

// The project's kanban board, shared by every worktree of the repository
// (`<agentDir>/kanban/<encoded-project-root>/kanban.json`; `lib/kanban-store.ts`).
//
// GET  ?cwd=<absolute project folder>           → { board, revision }; a board
//      never written is created with the default lanes (the one write a GET makes),
//      importing the project's old `.pi/kanban.json` first, and cards whose
//      session is gone are unlinked. With ?create=0 a missing board reads as
//      empty (revision 0) and nothing is written or imported.
// GET  ?cwd=...&revOnly=1                       → { revision }, a pure stat: no
//      parse, no write, no pruning (the client's poll).
// POST { cwd, action, ...payload }              → { board, revision }
//      add-card { laneId, title, description?, sessionId?, sessionTitle?, cardId? }
//      edit-card { cardId, title?, description? }      delete-card { cardId }
//      move-card { cardId, laneId, beforeCardId? }   advance-card { cardId }
//      link-session { cardId, sessionId, sessionTitle } unlink-session { cardId }
//      create-card-for-session { sessionId, sessionTitle, laneId|null, cardId? }
//      add-lane { name, description?, laneId? }        rename-lane { laneId, name }
//      edit-lane { laneId, description?, instructions? }
//      move-lane { laneId, direction: -1|1 }           reorder-lane { laneId, toIndex }
//      delete-lane { laneId }
//
// Every answer that is not a board is a typed refusal `{ error, code }`, never
// a stack: 400 invalid (the request, the folder, a rule of the board), 403 for
// a folder outside the allowed roots, 404 for a session that does not exist in
// the project, 423 while another process holds the file, 500 otherwise. The
// folder is checked first, exactly as `/api/mcp` checks its project.

const STATUS: Record<KanbanFailureCode, number> = {
  "cwd-invalid": 400,
  "cwd-not-directory": 400,
  "cwd-denied": 403,
  "session-missing": 404,
  refused: 400,
  locked: 423,
  "unsupported-schema": 500,
  internal: 500,
};

const MAX_ID = 200;
const MAX_NAME = 500;
const MAX_TEXT = 20_000;
/** Lane instructions are injected into runs: capped where they are written. */
const MAX_LANE_INSTRUCTIONS = KANBAN_LANE_INSTRUCTIONS_MAX;

function refusal(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status });
}

function failureResponse(failure: KanbanFailure) {
  return refusal(STATUS[failure.code] ?? 500, failure.code, failure.error);
}

function boardResponse(result: KanbanBoardResult) {
  if (!result.ok) return failureResponse(result);
  return NextResponse.json({ board: result.board, revision: result.revision } satisfies KanbanBoardResponse);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Invalid extends Error {}

/** A required string: non-blank, at most `max` characters. */
function required(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Invalid(`${key} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

/** An optional string (absent or null reads as undefined). */
function optional(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) throw new Invalid(`${key} must be a string of at most ${max} characters`);
  return value;
}

/** The action a POST body names, shape-checked; the board's rules judge it afterwards. */
function readAction(body: Record<string, unknown>): KanbanAction {
  switch (body.action) {
    case "add-card":
      return {
        action: "add-card",
        laneId: required(body, "laneId", MAX_ID),
        title: required(body, "title", MAX_NAME),
        description: optional(body, "description", MAX_TEXT),
        sessionId: optional(body, "sessionId", MAX_ID) ?? null,
        sessionTitle: optional(body, "sessionTitle", MAX_NAME) ?? null,
        cardId: optional(body, "cardId", MAX_ID),
      };
    case "edit-card": {
      const title = optional(body, "title", MAX_NAME);
      const description = optional(body, "description", MAX_TEXT);
      if (title === undefined && description === undefined) throw new Invalid("edit-card needs a title or a description");
      return { action: "edit-card", cardId: required(body, "cardId", MAX_ID), title, description };
    }
    case "delete-card":
      return { action: "delete-card", cardId: required(body, "cardId", MAX_ID) };
    case "move-card":
      return {
        action: "move-card",
        cardId: required(body, "cardId", MAX_ID),
        laneId: required(body, "laneId", MAX_ID),
        beforeCardId: optional(body, "beforeCardId", MAX_ID) ?? null,
      };
    case "advance-card":
      return { action: "advance-card", cardId: required(body, "cardId", MAX_ID) };
    case "link-session":
      return {
        action: "link-session",
        cardId: required(body, "cardId", MAX_ID),
        sessionId: required(body, "sessionId", MAX_ID),
        sessionTitle: optional(body, "sessionTitle", MAX_NAME) ?? "",
      };
    case "unlink-session":
      return { action: "unlink-session", cardId: required(body, "cardId", MAX_ID) };
    case "create-card-for-session": {
      const laneId = body.laneId;
      if (laneId !== null && laneId !== undefined && (typeof laneId !== "string" || laneId.length > MAX_ID)) {
        throw new Invalid("laneId must be a lane id or null");
      }
      return {
        action: "create-card-for-session",
        sessionId: required(body, "sessionId", MAX_ID),
        sessionTitle: optional(body, "sessionTitle", MAX_NAME) ?? "",
        laneId: typeof laneId === "string" ? laneId : null,
        cardId: optional(body, "cardId", MAX_ID),
      };
    }
    case "add-lane":
      return {
        action: "add-lane",
        name: required(body, "name", MAX_NAME),
        description: optional(body, "description", MAX_NAME),
        laneId: optional(body, "laneId", MAX_ID),
      };
    case "rename-lane":
      return { action: "rename-lane", laneId: required(body, "laneId", MAX_ID), name: required(body, "name", MAX_NAME) };
    case "edit-lane": {
      const description = optional(body, "description", MAX_NAME);
      const instructions = optional(body, "instructions", MAX_LANE_INSTRUCTIONS);
      if (description === undefined && instructions === undefined) throw new Invalid("edit-lane needs a description or instructions");
      return { action: "edit-lane", laneId: required(body, "laneId", MAX_ID), description, instructions };
    }
    case "move-lane": {
      if (body.direction !== -1 && body.direction !== 1) throw new Invalid("direction must be -1 or 1");
      return { action: "move-lane", laneId: required(body, "laneId", MAX_ID), direction: body.direction };
    }
    case "reorder-lane": {
      if (typeof body.toIndex !== "number" || !Number.isInteger(body.toIndex) || body.toIndex < 0) {
        throw new Invalid("toIndex must be a non-negative integer");
      }
      return { action: "reorder-lane", laneId: required(body, "laneId", MAX_ID), toIndex: body.toIndex };
    }
    case "delete-lane":
      return { action: "delete-lane", laneId: required(body, "laneId", MAX_ID) };
    default:
      throw new Invalid("Unknown action");
  }
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const valid = await validateKanbanCwd(params.get("cwd"));
  if (!valid.ok) return failureResponse(valid);
  if (params.get("revOnly") === "1") {
    const result = await getBoardRevision(valid.cwd);
    return result.ok ? NextResponse.json({ revision: result.revision }) : failureResponse(result);
  }
  // Only the creating read can write (first-read auto-create, pruning), and a
  // cross-site no-cors GET cannot read the body anyway — so the request gate is
  // needed exactly there. `create=0` never writes (the strip and composer
  // watchers use it): a missing board reads as empty, revision 0.
  const creating = params.get("create") !== "0";
  if (creating && !isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  return boardResponse(await readBoard(valid.cwd, { create: creating }));
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "content-type", "Content-Type must be application/json");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "invalid-request", "Invalid JSON body");
  }
  if (!isRecord(body)) return refusal(400, "invalid-request", "Expected a JSON object");

  const valid = await validateKanbanCwd(body.cwd);
  if (!valid.ok) return failureResponse(valid);

  let action: KanbanAction;
  try {
    action = readAction(body);
  } catch (error) {
    if (error instanceof Invalid) return refusal(400, "invalid-request", error.message);
    throw error;
  }
  // The store re-checks the folder and, for an action that links a session,
  // that the session exists (404), then prunes dead links from the result.
  return boardResponse(await applyMutation(valid.cwd, action));
}
