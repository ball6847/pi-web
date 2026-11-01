/**
 * The day buckets a recent list is cut into: today, yesterday, this week and
 * earlier.
 *
 * One rule, two callers: the Quick Open palette's recent list (an empty
 * query) and the sidebar's flat "All sessions" view. They must cut the same
 * sessions the same way, so the rule lives here and both read it.
 *
 * The buckets are the browser's own time zone: "today" is the user's today.
 * Pure and client-safe: no DOM, no server. The clock is a parameter.
 */

/** The buckets a recent list is cut into. */
export type SessionRecencySection = "today" | "yesterday" | "week" | "earlier";

/** The start of the day `date` falls in, in the browser's own time zone. */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * The bucket a session belongs to, by its last activity.
 *
 * A time of 0 (an unreadable date) counts as "earlier": an unknown date is
 * not today's.
 */
export function sessionRecencySection(modifiedMs: number, now: Date): SessionRecencySection {
  if (!modifiedMs) return "earlier";
  const today = startOfDay(now);
  if (modifiedMs >= today) return "today";
  if (modifiedMs >= today - 24 * 60 * 60 * 1000) return "yesterday";
  if (modifiedMs >= today - 7 * 24 * 60 * 60 * 1000) return "week";
  return "earlier";
}

/** The buckets, newest first. */
export const SESSION_RECENCY_SECTIONS: readonly SessionRecencySection[] = ["today", "yesterday", "week", "earlier"];
