import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { executeKanbanToolRequest } from "./kanban-store";
import { parseKanbanToolRequest, type KanbanToolResult } from "./kanban-tool-domain";
import { KanbanToolOutputSchema, KanbanToolParameters } from "./kanban-tool-schema";
import { isReadOnlySelection } from "./mcp-read-only-policy";
import { readSessionToolSelection } from "./session-tool-selection";
import type { SessionEntry } from "./types";

export const KANBAN_EXTENSION_NAME = "pi-web-kanban";

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

/** Normal sessions use the live persisted pin; children supply their snapshot/profile policy. */
export function createKanbanExtension(options?: { isReadOnly?: (ctx: ExtensionContext) => boolean }): InlineExtension {
  const isReadOnly = options?.isReadOnly ?? normalSessionIsReadOnly;
  return {
    name: KANBAN_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.registerTool({
        name: "kanban",
        label: "Kanban",
        exposure: "direct",
        description: "Read or manage tasks on this session's project Kanban board (shared by its worktrees). "
          + "read returns ordered lanes and cards, or one cardId, without creating files. "
          + "create requires title and defaults to an independent, sessionless Backlog card; an explicit work lane attaches it to this session. "
          + "update patches title/description/laneId; omitted fields stay unchanged, empty description clears it. Omit cardId to update your linked card. "
          + "An explicit work lane atomically claims a free card. Never edit another session's card or claim a second card. Linked cards cannot enter Backlog. "
          + "Use explicit lane IDs from read; same-lane updates do not reorder. Read-only sessions may only read. "
          + "Create is not idempotent: do not blindly retry it. For delegation, create a Backlog task and pass its cardId in the existing Agent prompt; this tool launches nothing.",
        parameters: KanbanToolParameters,
        outputSchema: KanbanToolOutputSchema,
        async execute(_toolCallId, input, signal, _onUpdate, ctx) {
          const parsed = parseKanbanToolRequest(input);
          if (!parsed.ok) return toolResult(parsed);
          // This belongs INSIDE execute, not only a tool_call hook: every direct
          // or nested execution must be checked against the executing session.
          if (parsed.request.action !== "read" && isReadOnly(ctx)) {
            return toolResult({ ok: false, code: "read-only", error: "This session is read-only. Use kanban read; switch to a write-capable session or subagent profile to create or update tasks." });
          }
          const sessionId = ctx.sessionManager.getSessionId();
          const result = await executeKanbanToolRequest(ctx.cwd, {
            sessionId,
            sessionTitle: ctx.sessionManager.getSessionName() ?? sessionId,
          }, parsed.request, signal);
          return toolResult(result);
        },
      });
    },
  };
}
