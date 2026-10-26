import type { KanbanCard } from "./kanban-types";
import type { SessionInfo } from "./types";

/** Lookup/open uses every session of the board, including worktree subagents. */
export function sessionsForKanbanBoard(sessions: readonly SessionInfo[], projectDir: string | null): SessionInfo[] {
  return projectDir ? sessions.filter((session) => (session.projectRoot ?? session.cwd) === projectDir) : [];
}

export interface KanbanSessionOption {
  id: string;
  title: string;
  running: boolean;
}

/**
 * Manual links stay top-level. Editing may also keep/reselect this card's
 * existing child link, even while the catalogue temporarily lacks its row.
 */
export function kanbanSessionOptions(
  sessions: readonly SessionInfo[],
  runningIds: ReadonlySet<string>,
  existing?: Pick<KanbanCard, "sessionId" | "sessionTitle" | "title"> | null,
): KanbanSessionOption[] {
  const options = sessions
    .filter((session) => session.relation?.kind !== "subagent" || session.id === existing?.sessionId)
    .map((session) => ({
      id: session.id,
      title: session.name || session.firstMessage || session.id,
      running: runningIds.has(session.id),
    }));
  if (existing?.sessionId && !options.some((option) => option.id === existing.sessionId)) {
    options.push({
      id: existing.sessionId,
      title: existing.sessionTitle || existing.title,
      running: runningIds.has(existing.sessionId),
    });
  }
  return options;
}
