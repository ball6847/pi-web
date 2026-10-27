import { NextResponse } from "next/server";
import { KANBAN_COMMENT_PAGE_LIMIT } from "@/lib/kanban-tool-limits";
import type { KanbanCommentsResponse } from "@/lib/kanban-types";
import { readCardCommentsFor, validateKanbanCwd, type KanbanFailure, type KanbanFailureCode } from "@/lib/kanban-store";
import { isApiRequestAllowed } from "@/lib/request-security";

// One card's comments — the detail tab's read. Deliberately NOT part of
// `GET /api/kanban`: a board payload stays small and its 2.5 s poll costs one
// `meta` row, while a thread is read only when its card is open.
//
// GET ?cwd=<project folder>&cardId=<card> → { cardId, comments, total, revision }
//     — oldest first, the newest KANBAN_COMMENT_PAGE_LIMIT rows, `total`
//     counting them all. A board that has none answers empty, revision 0, and
//     is not created by reading. Writing goes through POST /api/kanban
//     (add-comment / delete-comment), so every board write shares one lock,
//     one queue and one revision.
//
// The typed refusals are the board's own (400/403/423/500, `{ error, code }`).

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

function failureResponse(failure: KanbanFailure) {
  return NextResponse.json({ error: failure.error, code: failure.code }, { status: STATUS[failure.code] ?? 500 });
}

export async function GET(req: Request) {
  // The read can migrate an older board file (a write), so it takes the same
  // gate as the board view's creating read.
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request", code: "request-denied" }, { status: 403 });
  }
  const params = new URL(req.url).searchParams;
  const valid = await validateKanbanCwd(params.get("cwd"));
  if (!valid.ok) return failureResponse(valid);
  const cardId = params.get("cardId");
  if (typeof cardId !== "string" || !cardId || cardId.length > MAX_ID) {
    return NextResponse.json(
      { error: `cardId must be a non-empty string of at most ${MAX_ID} characters`, code: "invalid-request" },
      { status: 400 },
    );
  }
  const result = await readCardCommentsFor(valid.cwd, cardId, KANBAN_COMMENT_PAGE_LIMIT);
  if (!result.ok) return failureResponse(result);
  return NextResponse.json({
    cardId,
    comments: result.comments,
    total: result.total,
    revision: result.revision,
  } satisfies KanbanCommentsResponse);
}
