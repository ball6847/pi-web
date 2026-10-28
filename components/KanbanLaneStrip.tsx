"use client";

// The board strip: the thin bar at the top of a chat that always shows where
// this session's card sits in its project's lanes.
// Lanes read left to right; the card's lane is the only one highlighted. The
// user never moves the card — the strip's demo control stands in for the
// model's decision, and the menu unlinks the session from the board.

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { KanbanBoard as KanbanBoardData, KanbanCard, KanbanLane, KanbanNewSessionPending } from "@/lib/kanban-types";
import { laneIndex, sessionlessCardsByRecency } from "@/lib/kanban-shared";
import { kanbanCardKey } from "@/lib/kanban-types";
import { CardMenu, type MenuEntry } from "./KanbanBoard";

export interface KanbanLaneStripProps {
  /** The board of the session's project; null until it has loaded (the strip draws nothing till then). */
  board: KanbanBoardData | null;
  /** This session's card; null = untracked. */
  card: KanbanCard | null;
  /** A fresh composer: what its session will do on the board once it exists (off = not tracked). */
  pending?: KanbanNewSessionPending | null;
  isNewSession?: boolean;
  running?: boolean;
  onOpenBoard(): void;
  /** Track the session: a new card in `laneId` (or the first lane that takes sessions), or onto the existing card `cardId`. */
  onTrack(laneId: string | null, cardId?: string): void;
  onUnlink(): void;
  onDemoAdvance(): void;
}

function Chevron() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.55 }}>
      <polyline points="9 5 16 12 9 19" />
    </svg>
  );
}

export function KanbanLaneStrip({
  board,
  card,
  pending,
  isNewSession,
  running,
  onOpenBoard,
  onTrack,
  onUnlink,
  onDemoAdvance,
}: KanbanLaneStripProps) {
  const { t } = useI18n();
  const mobile = useIsMobile();
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);

  if (!board) return null;

  const currentLane = card ? laneIndex(board, card.laneId) : -1;
  // An attached card lands where the attach puts it: a backlog card advances
  // one lane first (the backlog never takes a session), so the pill marks the
  // lane the card will be in, not the fixed lane it is leaving.
  const pendingLaneIndex = !card && pending && pending.kind !== "off"
    ? pending.kind === "new-card"
      ? board.lanes.findIndex((l) => l.id === pending.laneId)
      : (() => {
        const attached = board.cards.find((c) => c.id === pending.cardId);
        if (!attached) return -1;
        const index = laneIndex(board, attached.laneId);
        if (index < 0 || !board.lanes[index]?.fixed) return index;
        return index + 1 < board.lanes.length ? index + 1 : -1;
      })()
    : -1;
  // The pill only highlights when the lane resolves (a pending card deleted
  // on another device leaves just the label); the pending state itself shows.
  const showPending = isNewSession && !card && Boolean(pending && pending.kind !== "off");
  // A fresh composer with tracking off stays quiet: no strip at all.
  if (isNewSession && !card && !showPending) return null;

  const cardIndex = card ? laneIndex(board, card.laneId) : -1;
  const nextLane = card ? board.lanes[cardIndex + 1] ?? null : null;

  const statusLabel = card
    ? `${kanbanCardKey(board, card)} · ${card.title}`
    : pending?.kind === "attach"
      ? `${t("kanban.stripPending")} — ${t("kanban.stripPendingCard", { title: pending.cardTitle })}`
      : showPending
        ? `${t("kanban.stripPending")} — ${t("kanban.stripWillStart", { lane: board.lanes[pendingLaneIndex]?.name ?? "" })}`
        : t("kanban.stripNotTracked");

  const workLanes = board.lanes.filter((lane) => !lane.fixed);
  // Newest first, uncapped.
  const unlinkedCards = sessionlessCardsByRecency(board);
  const menuEntries: MenuEntry[] = [];
  if (card) {
    menuEntries.push({
      id: "board",
      label: t("kanban.stripViewBoard"),
      icon: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /><path d="M15 3v12" />
        </svg>
      ),
      onSelect: onOpenBoard,
    });
    if (nextLane) {
      menuEntries.push({
        id: "advance",
        label: t("kanban.menuAdvance", { lane: nextLane.name }),
        dim: true,
        onSelect: onDemoAdvance,
      });
    }
    menuEntries.push({
      id: "unlink",
      label: t("kanban.stripUnlink"),
      icon: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      ),
      onSelect: onUnlink,
    });
  } else if (!isNewSession) {
    menuEntries.push({
      id: "new",
      label: t("kanban.stripTrackNew", { lane: workLanes[0]?.name ?? "" }),
      onSelect: () => onTrack(workLanes[0]?.id ?? null),
    });
    for (const unlinked of unlinkedCards) {
      menuEntries.push({
        id: `attach-${unlinked.id}`,
        label: `${t("kanban.stripTrackAttach")}: ${unlinked.title}`,
        dim: true,
        onSelect: () => onTrack(null, unlinked.id),
      });
    }
  }

  const pill = (lane: KanbanLane, index: number) => {
    const isCurrent = card ? index === currentLane : false;
    const isPending = !card && index === pendingLaneIndex;
    const isPast = card ? index < currentLane : false;
    let background = "none";
    let color = "var(--text-dim)";
    let border = "1px solid transparent";
    let weight = 400 as 400 | 600;
    if (isCurrent) {
      background = "color-mix(in srgb, var(--accent) 14%, transparent)";
      color = "var(--text)";
      border = "1px solid color-mix(in srgb, var(--accent) 45%, transparent)";
      weight = 600;
    } else if (isPending) {
      background = "color-mix(in srgb, var(--accent) 8%, transparent)";
      color = "var(--text-muted)";
      border = "1px dashed color-mix(in srgb, var(--accent) 40%, transparent)";
    } else if (isPast) {
      background = "var(--bg-hover)";
    }
    return (
      <span
        key={lane.id}
        style={{
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 8px",
          borderRadius: 999,
          background,
          border,
          color,
          fontWeight: weight,
          fontSize: 10.5,
          whiteSpace: "nowrap",
          opacity: card && !isCurrent && !isPast ? 0.55 : 1,
        }}
      >
        {isCurrent && running && (
          <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: 3, background: "var(--accent)" }} />
        )}
        {lane.name}
      </span>
    );
  };

  return (
    <div
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 30,
        padding: "0 12px",
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        fontSize: 11,
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, color: "var(--text-muted)" }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--accent)" }}>
          <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /><path d="M15 3v12" />
        </svg>
        <span style={{ fontWeight: 600 }}>{t("kanban.stripBoard")}</span>
      </span>
      <span aria-hidden="true" style={{ color: "var(--border)" }}>|</span>
      <span
        title={card ? card.title : undefined}
        style={{
          flexShrink: 1,
          minWidth: 0,
          maxWidth: "26%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: card ? "var(--text)" : "var(--text-dim)",
        }}
      >
        {statusLabel}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 3, overflowX: "auto", scrollbarWidth: "none" }}>
        {board.lanes.map((lane, index) => (
          <span key={lane.id} style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
            {index > 0 && <Chevron />}
            {pill(lane, index)}
          </span>
        ))}
      </div>
      {card ? (
        <>
          <button
            type="button"
            onClick={onOpenBoard}
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              height: 22,
              padding: "0 9px",
              fontSize: 11,
              color: "var(--text-muted)",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 6,
              cursor: "pointer",
            }}
            title={t("kanban.stripViewBoard")}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "none"; }}
          >
            {mobile ? null : t("kanban.stripViewBoard")}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
          <button
            type="button"
            className="file-viewer-icon-button"
            style={{ width: 22, height: 22, flexShrink: 0, border: "none" }}
            aria-haspopup="menu"
            aria-expanded={menuAnchor !== null}
            aria-label={t("kanban.stripMenu")}
            title={t("kanban.stripMenu")}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenuAnchor((current) => (current ? null : rect));
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
            </svg>
          </button>
        </>
      ) : (
        !isNewSession && (
          <button
            type="button"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenuAnchor((current) => (current ? null : rect));
            }}
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              height: 22,
              padding: "0 9px",
              fontSize: 11,
              fontWeight: 500,
              color: "var(--text)",
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--accent) 40%, transparent)",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            {t("kanban.stripTrack")}
          </button>
        )
      )}
      {menuAnchor && (card || (!isNewSession && menuEntries.length > 0)) && (
        <CardMenu anchor={menuAnchor} entries={menuEntries} onClose={() => setMenuAnchor(null)} />
      )}
    </div>
  );
}
