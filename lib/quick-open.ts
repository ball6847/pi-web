/**
 * The Quick Open palette's index and ranking: every session of the catalogue
 * as a candidate, a query's hits over them, and the day groups the recent
 * list shows.
 *
 * The palette searches **titles**, not transcripts. A session's title is its
 * stored name, else its first message (the rule the sidebar's rows use), and
 * the opening message itself is a second, weaker field: a query may land
 * there ("fix drag" in a session named "kanban work"), and the row then says
 * where it matched.
 *
 * The scope defaults to every project: the point of the palette is to find a
 * session without knowing which project it is in. "This project" narrows it
 * to the one on show.
 *
 * Pure and client-safe: no DOM, no server. The clock is a parameter.
 */

import { fuzzyMatchTerm, fuzzyTierRank, type FuzzyTier } from "./fuzzy";
import { getFileName } from "./file-paths";
import { sessionDisplayTitle } from "./session-fork-name";
import type { SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

/** Which sessions the palette looks at. */
export type QuickOpenScope = "all" | "project";

/** A session the palette can offer. */
export interface QuickOpenCandidate {
  session: SessionInfo;
  /** The title the sidebar's row shows for it. */
  title: string;
  /** Its opening message: the second field a query may land in. */
  message: string;
  /** The project it belongs to (its worktree's project, not its folder). */
  projectKey: string;
  /** The project's name, for the row's second line. */
  projectName: string;
  /** Its last activity, in milliseconds; 0 when the time is unreadable. */
  modifiedMs: number;
}

/** One session a query matched. */
export interface QuickOpenHit {
  candidate: QuickOpenCandidate;
  /** The match's quality; only meaningful inside its tier. */
  score: number;
  /** The tier the weakest term landed in. */
  tier: FuzzyTier;
  /** The title's matched indices. */
  titlePositions: number[];
  /** The opening message's matched indices. */
  messagePositions: number[];
}

/**
 * How much a match in the opening message counts against a match in the
 * title: a title hit is what the user meant, a message hit is a fallback.
 */
export const QUICK_OPEN_MESSAGE_WEIGHT = 0.6;

/** How many rows the palette shows at most. */
export const QUICK_OPEN_RESULT_LIMIT = 50;

/** How much of a title a row shows: the sidebar's own cut (50 units). */
export const QUICK_OPEN_TITLE_WIDTH = 50;

/** The title as a row shows it, and the matched characters inside it. */
export interface QuickOpenTitleWindow {
  text: string;
  /** The matched indices, moved into `text`. */
  positions: number[];
}

/**
 * The part of a title a row shows.
 *
 * A title is the session's name, else its whole first message (up to 500
 * characters), so it is cut like the sidebar's row cuts it. A match beyond
 * that cut would be invisible, so the window moves to the match: the text
 * around it, with an ellipsis on either side.
 */
export function quickOpenTitleWindow(
  title: string,
  positions: readonly number[],
  width: number = QUICK_OPEN_TITLE_WIDTH,
): QuickOpenTitleWindow {
  if (title.length <= width) return { text: title, positions: [...positions] };
  // A match that falls outside the cut would be invisible. As long as one
  // match is inside, the title keeps its start (the part that names the
  // session); only when none is does the window move to the match.
  const inside = positions.filter((position) => position < width);
  if (inside.length) {
    return { text: `${title.slice(0, width)}…`, positions: inside };
  }
  const outside = positions.find((position) => position >= width - 12);
  if (outside === undefined) {
    return { text: `${title.slice(0, width)}…`, positions: inside };
  }
  const start = Math.max(0, outside - 12);
  const end = Math.min(title.length, start + width);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < title.length ? "…" : "";
  const offset = prefix.length;
  return {
    text: prefix + title.slice(start, end) + suffix,
    positions: positions
      .filter((position) => position >= start && position < end)
      .map((position) => position - start + offset),
  };
}

/** The day groups the recent list (an empty query) is cut into. */
export type QuickOpenGroupKey = "today" | "yesterday" | "week" | "earlier";

export interface QuickOpenGroup {
  key: QuickOpenGroupKey;
  hits: QuickOpenHit[];
}

/** The catalogue as the palette's candidates. */
export function quickOpenCandidates(sessions: readonly SessionInfo[]): QuickOpenCandidate[] {
  return sessions.map((session) => {
    const projectKey = workspaceKeyOf(session);
    const modifiedMs = Date.parse(session.modified);
    return {
      session,
      title: sessionDisplayTitle(session),
      message: session.firstMessage ?? "",
      projectKey,
      projectName: getFileName(session.projectRoot ?? session.cwd) || projectKey,
      modifiedMs: Number.isNaN(modifiedMs) ? 0 : modifiedMs,
    };
  });
}

function worstTier(current: FuzzyTier, next: FuzzyTier): FuzzyTier {
  return fuzzyTierRank(next) > fuzzyTierRank(current) ? next : current;
}

function uniqueSorted(positions: number[]): number[] {
  return [...new Set(positions)].sort((a, b) => a - b);
}

/**
 * The hits for a query, best first.
 *
 * Every term of the query must land somewhere: in the title, else in the
 * opening message (the weaker field). The order is the tier first (a title
 * that starts with the query beats one that merely contains it), then the
 * score, then the last activity: two sessions of the same quality are
 * ordered by how recently they were touched.
 *
 * An empty query is the recent list: every session in scope, newest first.
 */
export function searchQuickOpen(
  candidates: readonly QuickOpenCandidate[],
  query: string,
  options: { scope: QuickOpenScope; projectKey?: string | null; limit?: number },
): QuickOpenHit[] {
  const limit = options.limit ?? QUICK_OPEN_RESULT_LIMIT;
  const inScope = candidates.filter((candidate) => {
    if (options.scope === "project") {
      if (!options.projectKey) return false;
      return candidate.projectKey === options.projectKey;
    }
    return true;
  });
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) {
    return [...inScope]
      .sort((a, b) => b.modifiedMs - a.modifiedMs)
      .slice(0, limit)
      .map((candidate) => ({
        candidate,
        score: 0,
        tier: "exact" as FuzzyTier,
        titlePositions: [],
        messagePositions: [],
      }));
  }

  const hits: QuickOpenHit[] = [];
  for (const candidate of inScope) {
    let score = 0;
    let tier: FuzzyTier = "exact";
    const titlePositions: number[] = [];
    const messagePositions: number[] = [];
    let matchedEveryTerm = true;
    for (const term of terms) {
      const titleMatch = fuzzyMatchTerm(term, candidate.title);
      if (titleMatch) {
        score += titleMatch.score;
        tier = worstTier(tier, titleMatch.tier);
        titlePositions.push(...titleMatch.positions);
        continue;
      }
      const messageMatch = fuzzyMatchTerm(term, candidate.message);
      if (!messageMatch) {
        matchedEveryTerm = false;
        break;
      }
      score += messageMatch.score * QUICK_OPEN_MESSAGE_WEIGHT;
      tier = worstTier(tier, messageMatch.tier);
      messagePositions.push(...messageMatch.positions);
    }
    if (!matchedEveryTerm) continue;
    hits.push({
      candidate,
      score,
      tier,
      titlePositions: uniqueSorted(titlePositions),
      messagePositions: uniqueSorted(messagePositions),
    });
  }
  hits.sort((a, b) => (
    fuzzyTierRank(a.tier) - fuzzyTierRank(b.tier)
    || b.score - a.score
    || b.candidate.modifiedMs - a.candidate.modifiedMs
  ));
  return hits.slice(0, limit);
}

/** The start of the day `date` falls in, in the browser's own time zone. */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * The day group a hit belongs to: today, yesterday, this week, earlier.
 * Only the recent list (an empty query) is grouped; a ranked list of hits
 * is one list, since its order is the ranking.
 */
export function quickOpenGroupKey(modifiedMs: number, now: Date): QuickOpenGroupKey {
  if (!modifiedMs) return "earlier";
  const today = startOfDay(now);
  if (modifiedMs >= today) return "today";
  if (modifiedMs >= today - 24 * 60 * 60 * 1000) return "yesterday";
  if (modifiedMs >= today - 7 * 24 * 60 * 60 * 1000) return "week";
  return "earlier";
}

/** The recent list cut into its day groups, newest first. */
export function groupQuickOpenHits(hits: readonly QuickOpenHit[], now: Date): QuickOpenGroup[] {
  const groups: QuickOpenGroup[] = [];
  for (const key of ["today", "yesterday", "week", "earlier"] as const) {
    const groupHits = hits.filter((hit) => quickOpenGroupKey(hit.candidate.modifiedMs, now) === key);
    if (groupHits.length) groups.push({ key, hits: groupHits });
  }
  return groups;
}
