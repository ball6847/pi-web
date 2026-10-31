"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  groupQuickOpenHits,
  quickOpenCandidates,
  searchQuickOpen,
  type QuickOpenGroup,
  type QuickOpenHit,
  type QuickOpenScope,
} from "@/lib/quick-open";
import type { SessionInfo } from "@/lib/types";

/**
 * The Quick Open palette's state: what is typed, how wide the scope is, which
 * row is selected, and the hits that follow.
 *
 * The hits are computed on the client, from the catalogue the sidebar already
 * holds: a session's title and its opening message are in the catalogue row,
 * so a keystroke never waits for a server.
 */

export interface UseQuickOpenOptions {
  /** The whole catalogue: every session the sidebar knows. */
  sessions: readonly SessionInfo[];
  /** The project on show, for the "this project" scope. */
  projectKey: string | null;
}

export interface UseQuickOpenResult {
  open: boolean;
  query: string;
  scope: QuickOpenScope;
  hits: QuickOpenHit[];
  groups: QuickOpenGroup[];
  selectedIndex: number;
  setQuery: (query: string) => void;
  setScope: (scope: QuickOpenScope) => void;
  setSelectedIndex: (index: number) => void;
  openPalette: () => void;
  closePalette: () => void;
}

export function useQuickOpen({ sessions, projectKey }: UseQuickOpenOptions): UseQuickOpenResult {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  // Every project by default: the palette exists to find a session without
  // knowing which project it is in.
  const [scope, setScope] = useState<QuickOpenScope>("all");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const candidates = useMemo(() => quickOpenCandidates(sessions), [sessions]);
  const hits = useMemo(
    () => searchQuickOpen(candidates, query, { scope, projectKey }),
    [candidates, query, scope, projectKey],
  );
  const groups = useMemo(
    () => (query.trim() ? [] : groupQuickOpenHits(hits, new Date())),
    [hits, query],
  );

  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    // A new query means a new best row; the old selection would point at a
    // row that is not the first match any more.
    setSelectedIndex(0);
  }, []);

  const openPalette = useCallback(() => {
    setOpen(true);
    setQueryState("");
    setSelectedIndex(0);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    setQueryState("");
    setSelectedIndex(0);
  }, []);

  // A session that was deleted while the palette was open leaves the list
  // shorter than the selection: keep it inside.
  useEffect(() => {
    if (selectedIndex < hits.length) return;
    setSelectedIndex(Math.max(0, hits.length - 1));
  }, [hits.length, selectedIndex]);

  return {
    open,
    query,
    scope,
    hits,
    groups,
    selectedIndex,
    setQuery,
    setScope,
    setSelectedIndex,
    openPalette,
    closePalette,
  };
}
