"use client";

// The project's kanban board as a main-area view.
// One board per project: the fixed backlog lane (cards with a title and a
// description only, never a session) and the lanes the work flows through.
// The model — not the user — moves a card to the next lane; the board's own
// controls add, edit, link, unlink and remove cards, and configure lanes.
// The board lives on the server (lib/kanban.ts caches it and applies the
// board's own controls optimistically); this view shows it, with a placeholder
// while it loads and a retry banner when a load or a write failed.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { listenForStackedDialogEscape } from "@/lib/stacked-dialog";
import type { SessionInfo } from "@/lib/types";
import {
  type KanbanBoard as KanbanBoardData,
  type KanbanCard,
  type KanbanLane,
} from "@/lib/kanban-types";
import { cardsOfLane, laneIndex } from "@/lib/kanban-shared";
import {
  kanbanAddCard,
  kanbanAddLane,
  kanbanAdvanceCard,
  kanbanDeleteCard,
  kanbanDeleteLane,
  kanbanLinkCard,
  kanbanMoveLane,
  kanbanRenameLane,
  kanbanUnlinkCard,
  kanbanUpdateCard,
  useKanbanBoardStatus,
} from "@/lib/kanban";

export interface KanbanBoardProps {
  /** The project's board; null while it loads (or when its load failed). */
  board: KanbanBoardData | null;
  projectDir: string;
  /** Display name of the project the board belongs to. */
  projectName: string;
  /** The project's top-level pi sessions, for the link pickers and "Open session". */
  sessions: SessionInfo[];
  runningSessionIds: Set<string>;
  /** The card to scroll to and ring, set when the user jumped here from the chat strip. */
  highlightCardId?: string | null;
  onOpenSession(sessionId: string, title: string): void;
}

// -- shared chrome -----------------------------------------------------------

function KanbanIcon({ size = 14, className, style }: { size?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="M15 3v12" />
    </svg>
  );
}

function ChatIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function LinkIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function MoreIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

function GhostButton({
  children,
  onClick,
  disabled,
  title,
  ariaLabel,
  width = 24,
  size = 13,
  icon,
}: {
  children?: React.ReactNode;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  title: string;
  ariaLabel: string;
  width?: number;
  size?: number;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="file-viewer-icon-button"
      style={{ width, height: width, fontSize: 12 }}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
    >
      {icon ?? children ?? (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      )}
    </button>
  );
}

// -- menu --------------------------------------------------------------------

export interface MenuEntry {
  id: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  dim?: boolean;
  disabled?: boolean;
  disabledTitle?: string;
  onSelect: () => void;
}

export function CardMenu({
  anchor,
  entries,
  onClose,
}: {
  /** The card's ⋯ button, so the menu opens against it. */
  anchor: DOMRect;
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const { t } = useI18n();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Keyboard entry: land on the filter (when shown) or the first item, so
  // arrow keys and Enter work from the moment the menu opens.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target =
      surface.querySelector<HTMLElement>("input") ??
      surface.querySelector<HTMLElement>("button[role='menuitem']:not(:disabled)");
    target?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const close = () => onCloseRef.current();
    const isTextEntry = (el: Element | null) =>
      el !== null &&
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable));
    const onKeyDown = (event: KeyboardEvent) => {
      const surface = surfaceRef.current;
      if (!surface || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        // A filter with text in it is cleared first; the next Escape closes.
        const field = surface.querySelector<HTMLInputElement>("input");
        if (field && field.value) {
          setFilter("");
          field.focus({ preventScroll: true });
          return;
        }
        close();
        // setTimeout, not rAF: a hidden tab defers rAF indefinitely, and the
        // commit is synchronous either way, so the timeout always sees the
        // post-close state.
        setTimeout(() => {
          const opener = openerRef.current;
          if (!opener || !opener.isConnected) return;
          const active = document.activeElement;
          const stranded = active === document.body || (active instanceof Element && surfaceRef.current !== null && surfaceRef.current.contains(active));
          if (stranded) opener.focus({ preventScroll: true });
        }, 0);
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const inside = target !== null && surface.contains(target);
      if (!inside) return;
      if (event.key === "Tab") {
        // No focus trap: Tabbing away from the menu closes it and focus goes
        // back to the opener, on from there.
        close();
        setTimeout(() => {
          const opener = openerRef.current;
          if (!opener || !opener.isConnected) return;
          const active = document.activeElement;
          const stranded = active === document.body || (active instanceof Element && surfaceRef.current !== null && surfaceRef.current.contains(active));
          if (stranded) opener.focus({ preventScroll: true });
        }, 0);
        return;
      }
      // The filter field keeps its letters and caret keys; Up and Down go on to the items.
      const leavesFilter = (event.key === "ArrowDown" || event.key === "ArrowUp") && isTextEntry(target);
      if (isTextEntry(target) && !leavesFilter) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
        const list = [...surface.querySelectorAll<HTMLButtonElement>("button[role='menuitem']:not(:disabled)")];
        if (list.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const index = target ? list.indexOf(target as HTMLButtonElement) : -1;
        let next: number;
        if (event.key === "Home") next = 0;
        else if (event.key === "End") next = list.length - 1;
        else if (event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % list.length;
        else next = index < 0 ? list.length - 1 : (index - 1 + list.length) % list.length;
        list[next].focus();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target && target.closest?.("[data-kanban-card-menu]") === null) close();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onPointerDown, true);
    };
  }, []);

  const visible = entries.filter((entry) => !filter || entry.label.toLowerCase().includes(filter.toLowerCase()));
  const left = Math.min(Math.max(anchor.left, 8), Math.max(8, window.innerWidth - 232));
  const top = anchor.bottom + 6 + visible.length * 30 + 34 > window.innerHeight ? Math.max(8, anchor.top - 6 - visible.length * 30 - 34) : anchor.bottom + 6;

  return createPortal(
    <div
      ref={surfaceRef}
      data-kanban-card-menu
      role="menu"
      style={{
        position: "fixed",
        left,
        top: Math.max(8, top),
        zIndex: 650,
        width: 224,
        maxHeight: "min(70dvh, 460px)",
        overflowY: "auto",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 10px 28px rgba(0,0,0,0.14)",
        padding: 4,
        fontSize: 12,
      }}
    >
      {visible.length > 6 && (
        <input
          autoFocus
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="…"
          aria-label={t("kanban.menuFilter")}
          style={{
            display: "block",
            width: "100%",
            boxSizing: "border-box",
            marginBottom: 4,
            padding: "5px 8px",
            fontSize: 12,
            color: "var(--text)",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            outline: "none",
          }}
        />
      )}
      {visible.map((entry) => {
        const dim = entry.dim || (entry.disabled && !entry.danger);
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            title={entry.disabled ? entry.disabledTitle ?? entry.label : entry.label}
            onClick={() => {
              if (entry.disabled) return;
              entry.onSelect();
              onClose();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              width: "100%",
              padding: "6px 8px",
              border: "none",
              borderRadius: 5,
              background: "none",
              color: entry.danger ? "#dc2626" : dim ? "var(--text-dim)" : "var(--text)",
              opacity: entry.disabled && !entry.danger ? 0.55 : 1,
              cursor: entry.disabled ? "default" : "pointer",
              fontSize: 12,
              textAlign: "left",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            onMouseEnter={(e) => { if (!entry.disabled) e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
          >
            <span style={{ flexShrink: 0, display: "inline-flex" }}>{entry.icon}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{entry.label}</span>
          </button>
        );
      })}
      {visible.length === 0 && (
        <div style={{ padding: "6px 8px", color: "var(--text-dim)", fontSize: 11 }}>{filter ? "—" : ""}</div>
      )}
    </div>,
    document.body,
  );
}

// -- session picker (portal) ---------------------------------------------------

interface SessionOption {
  id: string;
  title: string;
  running: boolean;
}

function SessionPicker({
  anchor,
  options,
  placeholder,
  onPick,
  onClose,
}: {
  anchor: DOMRect;
  options: SessionOption[];
  placeholder: string;
  onPick(session: SessionOption): void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const { t } = useI18n();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const close = () => onCloseRef.current();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target && target.closest?.("[data-kanban-picker]") === null) close();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onPointerDown, true);
    };
  }, []);

  const visible = options.filter((option) => !filter || option.title.toLowerCase().includes(filter.toLowerCase()));
  const left = Math.min(Math.max(anchor.left, 8), Math.max(8, window.innerWidth - 288));
  const top = anchor.bottom + 6 + 232 > window.innerHeight ? Math.max(8, anchor.top - 6 - 232) : anchor.bottom + 6;

  return createPortal(
    <div
      data-kanban-picker
      role="listbox"
      aria-label={placeholder}
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 660,
        width: 280,
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "0 10px 28px rgba(0,0,0,0.14)",
        padding: 6,
      }}
    >
      <input
        autoFocus
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={placeholder}
        style={{
          display: "block",
          width: "100%",
          boxSizing: "border-box",
          marginBottom: 6,
          padding: "5px 8px",
          fontSize: 12,
          color: "var(--text)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          outline: "none",
        }}
      />
      <div style={{ maxHeight: 220, overflowY: "auto" }}>
        {visible.map((option) => (
          <button
            key={option.id}
            type="button"
            role="option"
            aria-selected="false"
            onClick={() => {
              onPick(option);
              onClose();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              width: "100%",
              padding: "6px 8px",
              border: "none",
              borderRadius: 5,
              background: "none",
              color: "var(--text)",
              cursor: "pointer",
              fontSize: 12,
              textAlign: "left",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
          >
            {option.running && (
              <span style={{ flexShrink: 0, width: 6, height: 6, borderRadius: 3, background: "var(--accent)" }} title={t("kanban.stripRunning")} />
            )}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{option.title}</span>
          </button>
        ))}
        {visible.length === 0 && (
          <div style={{ padding: "6px 8px", color: "var(--text-dim)", fontSize: 11 }}>{filter ? "—" : placeholder}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// -- card ----------------------------------------------------------------------

function CardView({
  lane,
  card,
  isLastLane,
  running,
  sessionGone,
  highlighted,
  onOpenSession,
  onOpenMenu,
  onEdit,
  onOpenLinkPicker,
}: {
  lane: KanbanLane;
  card: KanbanCard;
  isLastLane: boolean;
  running: boolean;
  sessionGone: boolean;
  highlighted: boolean;
  onOpenSession(sessionId: string, title: string): void;
  onOpenMenu(anchor: DOMRect, card: KanbanCard): void;
  onEdit(card: KanbanCard): void;
  onOpenLinkPicker(anchor: DOMRect, card: KanbanCard): void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlighted]);

  const done = isLastLane;
  const linked = card.sessionId !== null;

  return (
    <article
      ref={ref as React.RefObject<HTMLElement>}
      data-kanban-card={card.id}
      onClick={() => {
        if (linked && !sessionGone && card.sessionId) onOpenSession(card.sessionId, card.sessionTitle ?? card.title);
        else if (!linked) onEdit(card);
      }}
      style={{
        position: "relative",
        flexShrink: 0,
        background: "var(--bg-panel)",
        border: `1px solid ${highlighted ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 8,
        padding: "8px 10px",
        cursor: linked || !lane.fixed ? "pointer" : "default",
        opacity: done && !running ? 0.72 : 1,
        boxShadow: highlighted ? "0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent)" : undefined,
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            {done && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text)", overflowWrap: "anywhere" }}>{card.title}</span>
          </div>
          {card.description && (
            <div
              style={{
                marginTop: 3,
                fontSize: 11,
                lineHeight: 1.45,
                color: "var(--text-muted)",
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                overflowWrap: "anywhere",
              }}
            >
              {card.description}
            </div>
          )}
        </div>
        <button
          type="button"
          className="file-viewer-icon-button"
          style={{ width: 20, height: 20, flexShrink: 0, borderRadius: 4 }}
          aria-label={t("kanban.menuLabel")}
          onClick={(event) => {
            event.stopPropagation();
            onOpenMenu(event.currentTarget.getBoundingClientRect(), card);
          }}
        >
          <MoreIcon size={12} />
        </button>
      </div>
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
        {linked && card.sessionId ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (sessionGone) return;
              onOpenSession(card.sessionId!, card.sessionTitle ?? card.title);
            }}
            title={sessionGone ? t("kanban.menuSessionGone") : `${card.sessionTitle ?? card.title}`}
            disabled={sessionGone}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              maxWidth: "100%",
              padding: "2px 8px",
              border: "1px solid color-mix(in srgb, var(--accent) 35%, transparent)",
              borderRadius: 999,
              background: "color-mix(in srgb, var(--accent) 10%, transparent)",
              color: sessionGone ? "var(--text-dim)" : "var(--text-muted)",
              fontSize: 10.5,
              cursor: sessionGone ? "default" : "pointer",
              opacity: sessionGone ? 0.6 : 1,
            }}
          >
            <ChatIcon size={10} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.sessionTitle ?? "…"}</span>
          </button>
        ) : (
          <button
            type="button"
            disabled={lane.fixed}
            onClick={(event) => {
              event.stopPropagation();
              if (lane.fixed) return;
              onOpenLinkPicker(event.currentTarget.getBoundingClientRect(), card);
            }}
            title={lane.fixed ? t("kanban.backlogNoSessions") : t("kanban.menuLink")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 8px",
              border: "1px dashed var(--border)",
              borderRadius: 999,
              background: "none",
              color: "var(--text-dim)",
              fontSize: 10.5,
              cursor: lane.fixed ? "default" : "pointer",
            }}
          >
            <LinkIcon size={10} />
            <span>{t("kanban.cardUnlinked")}</span>
          </button>
        )}
        {running && (
          <span
            role="img"
            aria-label={t("kanban.stripRunning")}
            title={t("kanban.stripRunning")}
            style={{ flexShrink: 0, width: 6, height: 6, borderRadius: 3, background: "var(--accent)" }}
          />
        )}
      </div>
    </article>
  );
}

// -- card form (add / edit) ------------------------------------------------------

function CardForm({
  projectDir,
  lane,
  initial,
  sessions,
  runningIds,
  onDone,
}: {
  projectDir: string;
  lane: KanbanLane;
  initial: KanbanCard | null;
  sessions: SessionInfo[];
  runningIds: Set<string>;
  onDone(): void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [session, setSession] = useState<SessionOption | null>(
    initial?.sessionId ? { id: initial.sessionId, title: initial.sessionTitle ?? "", running: false } : null,
  );
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const sessionBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const needsSession = !lane.fixed;
  const canSave = title.trim().length > 0 && (!needsSession || session !== null);
  const sessionOptions = useMemo(
    () => sessions.map((s) => ({ id: s.id, title: s.name || s.firstMessage || s.id, running: runningIds.has(s.id) })),
    [sessions, runningIds],
  );

  return (
    <div
      style={{
        flexShrink: 0,
        background: "var(--bg-panel)",
        border: "1px solid var(--accent)",
        borderRadius: 8,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <input
        ref={titleRef}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={t("kanban.cardFormTitle")}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "5px 8px",
          fontSize: 12,
          color: "var(--text)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          outline: "none",
        }}
      />
      <textarea
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder={t("kanban.cardFormDescription")}
        rows={2}
        style={{
          width: "100%",
          boxSizing: "border-box",
          resize: "vertical",
          padding: "5px 8px",
          fontSize: 11,
          lineHeight: 1.4,
          color: "var(--text)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          outline: "none",
        }}
      />
      {needsSession && (
        <div>
          <button
            ref={sessionBtnRef}
            type="button"
            onClick={() => setPickerAnchor(sessionBtnRef.current?.getBoundingClientRect() ?? null)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              width: "100%",
              padding: "5px 8px",
              fontSize: 11,
              color: session ? "var(--text)" : "var(--text-dim)",
              background: "var(--bg)",
              border: `1px solid ${session ? "var(--border)" : "color-mix(in srgb, var(--accent) 40%, transparent)"}`,
              borderRadius: 6,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <ChatIcon size={10} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {session ? session.title : t("kanban.cardFormSessionPlaceholder")}
            </span>
          </button>
          {pickerAnchor && (
            <SessionPicker
              anchor={pickerAnchor}
              options={sessionOptions}
              placeholder={t("kanban.cardFormSessionPlaceholder")}
              onPick={(option) => setSession(option)}
              onClose={() => setPickerAnchor(null)}
            />
          )}
          {sessions.length === 0 && <div style={{ marginTop: 4, fontSize: 10.5, color: "var(--text-dim)" }}>{t("kanban.cardFormSessionRequired")}</div>}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onDone}
          style={{
            padding: "5px 12px",
            fontSize: 12,
            color: "var(--text-muted)",
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          {t("kanban.cardFormCancel")}
        </button>
        <button
          type="button"
          disabled={!canSave}
          onClick={() => {
            const trimmedTitle = title.trim();
            if (!trimmedTitle) return;
            if (initial) {
              kanbanUpdateCard(projectDir, initial.id, { title: trimmedTitle, description });
              if (needsSession && session && session.id !== initial.sessionId) {
                kanbanLinkCard(projectDir, initial.id, session.id, session.title);
              }
            } else {
              kanbanAddCard(projectDir, lane.id, {
                title: trimmedTitle,
                description,
                sessionId: session?.id ?? null,
                sessionTitle: session?.title ?? null,
              });
            }
            onDone();
          }}
          style={{
            padding: "5px 12px",
            fontSize: 12,
            fontWeight: 600,
            color: canSave ? "var(--accent-contrast)" : "var(--text-dim)",
            background: canSave ? "var(--accent)" : "var(--bg-hover)",
            border: "none",
            borderRadius: 6,
            cursor: canSave ? "pointer" : "default",
          }}
        >
          {initial ? t("kanban.cardFormSave") : t("kanban.cardFormAdd")}
        </button>
      </div>
    </div>
  );
}

// -- lane ----------------------------------------------------------------------

function LaneColumn({
  board,
  projectDir,
  lane,
  isLast,
  sessions,
  runningIds,
  sessionIds,
  highlightCardId,
  form,
  onOpenForm,
  onOpenMenu,
  onOpenLinkPicker,
  onOpenSession,
  mobile,
}: {
  board: KanbanBoardData;
  projectDir: string;
  lane: KanbanLane;
  isLast: boolean;
  sessions: SessionInfo[];
  runningIds: Set<string>;
  sessionIds: Set<string>;
  highlightCardId: string | null;
  /** The single card form, when it is in this lane. */
  form: { laneId: string; cardId: string | null } | null;
  onOpenForm(laneId: string, card: KanbanCard | null): void;
  onOpenMenu(anchor: DOMRect, card: KanbanCard): void;
  onOpenLinkPicker(anchor: DOMRect, card: KanbanCard): void;
  onOpenSession(sessionId: string, title: string): void;
  mobile: boolean;
}) {
  const { t } = useI18n();
  const cards = cardsOfLane(board, lane.id);
  const formHere = form?.laneId === lane.id ? form : null;
  const editing = formHere?.cardId ? cards.find((c) => c.id === formHere.cardId) ?? null : null;
  // One lane fills the phone screen in the single-lane mobile mode.
  const width = mobile ? "100%" : 250;

  return (
    <section
      aria-label={lane.name}
      style={{
        flex: "0 0 auto",
        width,
        maxWidth: mobile ? "100%" : "80vw",
        maxHeight: "100%",
        display: "flex",
        flexDirection: "column",
        background: "color-mix(in srgb, var(--bg-panel) 55%, var(--bg))",
        border: "1px solid var(--border)",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <header style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 10px",
        height: 34,
        borderBottom: "1px solid var(--border)",
      }}>
        {lane.fixed && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        )}
        <span style={{ fontSize: 11.5, fontWeight: 700, color: lane.fixed ? "var(--text-muted)" : "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "55%" }} title={lane.name}>
          {lane.name}
        </span>
        <span style={{
          minWidth: 16,
          height: 15,
          padding: "0 4px",
          display: "grid",
          placeItems: "center",
          borderRadius: 7,
          background: "var(--bg-selected)",
          color: "var(--text-muted)",
          fontSize: 10,
          fontVariantNumeric: "tabular-nums",
          flexShrink: 0,
        }}>
          {cards.length}
        </span>
        <span style={{ flex: 1 }} />
        <GhostButton
          title={t("kanban.laneAdd")}
          ariaLabel={`${t("kanban.laneAdd")} — ${lane.name}`}
          width={20}
          size={12}
          onClick={(event) => {
            event.stopPropagation();
            onOpenForm(lane.id, null);
          }}
        />
      </header>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, padding: 8 }}>
        {formHere && (
          <CardForm
            projectDir={projectDir}
            lane={lane}
            initial={editing}
            sessions={sessions}
            runningIds={runningIds}
            onDone={() => onOpenForm(lane.id, editing)}
          />
        )}
        {cards.filter((card) => card.id !== editing?.id).map((card) => {
          const sessionGone = card.sessionId !== null && !sessionIds.has(card.sessionId);
          return (
            <CardView
              key={card.id}
              lane={lane}
              card={card}
              isLastLane={isLast}
              running={card.sessionId !== null && runningIds.has(card.sessionId)}
              sessionGone={sessionGone}
              highlighted={highlightCardId === card.id}
              onOpenSession={onOpenSession}
              onOpenMenu={onOpenMenu}
              onEdit={(target) => onOpenForm(lane.id, target)}
              onOpenLinkPicker={onOpenLinkPicker}
            />
          );
        })}
        {cards.length === 0 && !formHere && (
          <div style={{ padding: "10px 8px", textAlign: "center", fontSize: 11, color: "var(--text-dim)" }}>
            {t("kanban.laneEmpty")}
          </div>
        )}
      </div>
    </section>
  );
}

// -- lane configuration ----------------------------------------------------------

function LaneConfig({
  board,
  projectDir,
  projectName,
  onClose,
}: {
  board: KanbanBoardData;
  projectDir: string;
  projectName: string;
  onClose(): void;
}) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    const stop = listenForStackedDialogEscape(document, onClose);
    closeRef.current?.focus();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cardCount = (laneId: string) => cardsOfLane(board, laneId).length;

  return createPortal(
    <div
      style={{ position: "fixed", inset: 0, zIndex: 600, background: "rgba(0,0,0,0.4)", display: "grid", placeItems: "center", padding: 16 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("kanban.configureTitle", { name: projectName })}
        style={{
          width: "min(520px, 100%)",
          maxHeight: "80dvh",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "0 18px 44px rgba(0,0,0,0.22)",
          overflow: "hidden",
        }}
      >
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <KanbanIcon size={14} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("kanban.configureTitle", { name: projectName })}</span>
          <span style={{ flex: 1 }} />
          <button
            ref={closeRef}
            type="button"
            className="file-viewer-icon-button"
            style={{ border: "none" }}
            aria-label={t("kanban.configureClose")}
            onClick={onClose}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {board.lanes.map((lane, index) => (
            <ConfigLaneRow
              key={lane.id}
              lane={lane}
              index={index}
              count={cardCount(lane.id)}
              onMoveUp={() => kanbanMoveLane(projectDir, lane.id, -1)}
              onMoveDown={() => kanbanMoveLane(projectDir, lane.id, 1)}
              onRename={(name) => kanbanRenameLane(projectDir, lane.id, name)}
              onDelete={() => kanbanDeleteLane(projectDir, lane.id)}
            />
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && newName.trim()) {
                  kanbanAddLane(projectDir, newName);
                  setNewName("");
                }
              }}
              placeholder={t("kanban.configureNamePlaceholder")}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "5px 8px",
                fontSize: 12,
                color: "var(--text)",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                outline: "none",
              }}
            />
            <button
              type="button"
              disabled={!newName.trim()}
              onClick={() => {
                kanbanAddLane(projectDir, newName);
                setNewName("");
              }}
              style={{
                padding: "5px 12px",
                fontSize: 12,
                fontWeight: 600,
                color: newName.trim() ? "var(--accent-contrast)" : "var(--text-dim)",
                background: newName.trim() ? "var(--accent)" : "var(--bg-hover)",
                border: "none",
                borderRadius: 6,
                cursor: newName.trim() ? "pointer" : "default",
              }}
            >
              {t("kanban.configureAdd")}
            </button>
          </div>
          <p style={{ margin: "10px 0 0", fontSize: 11, lineHeight: 1.6, color: "var(--text-dim)" }}>{t("kanban.configureNote")}</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ConfigLaneRow({
  lane,
  index,
  count,
  onMoveUp,
  onMoveDown,
  onRename,
  onDelete,
}: {
  lane: KanbanLane;
  index: number;
  count: number;
  onMoveUp(): void;
  onMoveDown(): void;
  onRename(name: string): void;
  onDelete(): void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(lane.name);
  const removable = !lane.fixed && count === 0;
  const upDisabled = index === 0 || lane.fixed;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)" }}>
      <GhostButton width={20} size={11} disabled={upDisabled} title={t("kanban.configureMoveUp")} ariaLabel={`${t("kanban.configureMoveUp")} — ${lane.name}`} onClick={(e) => { e.stopPropagation(); onMoveUp(); }} icon={
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15" /></svg>
      } />
      <GhostButton width={20} size={11} disabled={lane.fixed} title={t("kanban.configureMoveDown")} ariaLabel={`${t("kanban.configureMoveDown")} — ${lane.name}`} onClick={(e) => { e.stopPropagation(); onMoveDown(); }} icon={
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
      } />
      {lane.fixed ? (
        <>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", flex: 1 }}>{lane.name}</span>
        </>
      ) : (
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft.trim() && draft !== lane.name) onRename(draft);
            else setDraft(lane.name);
          }}
          onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
          aria-label={t("kanban.configureNamePlaceholder")}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "4px 8px",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--text)",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            outline: "none",
          }}
        />
      )}
      <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
        {t("kanban.configureLaneCount", { count })}
      </span>
      <span style={{ flex: 1 }} />
      <GhostButton
        width={20}
        size={12}
        disabled={!removable}
        title={removable ? t("kanban.configureRemove") : t("kanban.configureRemoveBlocked", { count })}
        ariaLabel={`${t("kanban.configureRemove")} — ${lane.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        icon={
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          </svg>
        }
      />
    </div>
  );
}

// -- board -----------------------------------------------------------------------

function BoardNotice({ error, onRetry }: { error: string; onRetry(): void }) {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      title={error}
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 30,
        padding: "0 12px",
        fontSize: 11.5,
        color: "#dc2626",
        background: "color-mix(in srgb, #dc2626 8%, var(--bg))",
        borderBottom: "1px solid color-mix(in srgb, #dc2626 30%, var(--border))",
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("kanban.loadFailed")}</span>
      <button
        type="button"
        onClick={onRetry}
        style={{
          flexShrink: 0,
          height: 22,
          padding: "0 10px",
          fontSize: 11,
          color: "var(--text)",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        {t("kanban.retry")}
      </button>
    </div>
  );
}

/** The frame of the board (header, content area) while there is no board to draw: the lanes arrive into the same box. */
function BoardShell({ projectName, taskCount, children }: { projectName: string; taskCount: number | null; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)", minWidth: 0 }}>
      <header style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 40,
        padding: "0 12px",
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
      }}>
        <KanbanIcon size={15} style={{ color: "var(--accent)" }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "50%" }} title={projectName}>
          {projectName}
        </span>
        {taskCount !== null && (
          <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>{t("kanban.boardTasks", { count: taskCount })}</span>
        )}
      </header>
      {children}
    </div>
  );
}

export function KanbanBoard(props: KanbanBoardProps) {
  const { board, projectDir, projectName } = props;
  const { t } = useI18n();
  const { status, error, retry } = useKanbanBoardStatus(projectDir);
  const notice = status === "error" ? <BoardNotice error={error ?? ""} onRetry={retry} /> : null;
  if (board) return <KanbanBoardView {...props} board={board} notice={notice} />;
  return (
    <BoardShell projectName={projectName} taskCount={null}>
      {notice}
      {status === "error" ? null : (
        <div role="status" style={{ padding: "14px 16px", fontSize: 12, color: "var(--text-dim)" }}>
          {t("kanban.loadingBoard")}
        </div>
      )}
    </BoardShell>
  );
}

function KanbanBoardView(props: KanbanBoardProps & { board: KanbanBoardData; notice: React.ReactNode }) {
  const { board, projectDir, projectName, sessions, runningSessionIds, highlightCardId, onOpenSession, notice } = props;
  const { t } = useI18n();
  const mobile = useIsMobile();
  const [configOpen, setConfigOpen] = useState(false);
  // One lane at a time on phones: the column row is 240px-wide columns, and a
  // half-visible neighbour reads as a broken board. A tab strip switches lanes.
  const [mobileLaneId, setMobileLaneId] = useState<string | null>(null);
  const [formFor, setFormFor] = useState<{ laneId: string; cardId: string | null } | null>(null);
  const [menuFor, setMenuFor] = useState<{ cardId: string; anchor: DOMRect } | null>(null);
  const [linkFor, setLinkFor] = useState<{ cardId: string; anchor: DOMRect } | null>(null);
  // A brief accent ring on the card right after it moves (the menu's demo advance for now).
  const [flashId, setFlashId] = useState<string | null>(null);
  const setHighlightFlash = useCallback((cardId: string) => {
    setFlashId(cardId);
    window.setTimeout(() => setFlashId((current) => (current === cardId ? null : current)), 1600);
  }, []);

  const sessionIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions]);
  const activeMobileLane = useMemo(() => {
    if (!mobile) return null;
    if (mobileLaneId && board.lanes.some((l) => l.id === mobileLaneId)) return mobileLaneId;
    // Arrival with a card (the strip's View board, the sidebar ring): open its lane.
    const jump = board.cards.find((c) => c.id === highlightCardId);
    if (jump && board.lanes.some((l) => l.id === jump.laneId)) return jump.laneId;
    return board.lanes.find((l) => cardsOfLane(board, l.id).length > 0)?.id ?? board.lanes[0]?.id ?? null;
  }, [mobile, mobileLaneId, board, highlightCardId]);
  const sessionOptions = useMemo(
    () => sessions.map((s) => ({ id: s.id, title: s.name || s.firstMessage || s.id, running: runningSessionIds.has(s.id) })),
    [sessions, runningSessionIds],
  );

  const menuCard = menuFor ? board.cards.find((c) => c.id === menuFor.cardId) ?? null : null;
  const linkCard = linkFor ? board.cards.find((c) => c.id === linkFor.cardId) ?? null : null;

  useEffect(() => {
    if (!menuFor && !linkFor) return;
    const close = () => {
      setMenuFor(null);
      setLinkFor(null);
    };
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [menuFor, linkFor]);

  const openMenu = useCallback((anchor: DOMRect, card: KanbanCard) => {
    setLinkFor(null);
    setMenuFor({ cardId: card.id, anchor });
  }, []);
  const openLink = useCallback((anchor: DOMRect, card: KanbanCard) => {
    setMenuFor(null);
    setLinkFor({ cardId: card.id, anchor });
  }, []);
  const openForm = useCallback((laneId: string, card: KanbanCard | null) => {
    setFormFor((current) => {
      // Clicking the same "+" (or card) again closes the open form.
      if (current?.laneId === laneId && (current.cardId ?? null) === (card?.id ?? null)) return null;
      return { laneId, cardId: card?.id ?? null };
    });
  }, []);

  const menuEntries: MenuEntry[] = useMemo(() => {
    if (!menuCard) return [];
    const index = laneIndex(board, menuCard.laneId);
    const next = board.lanes[index + 1] ?? null;
    const sessionGone = menuCard.sessionId !== null && !sessionIds.has(menuCard.sessionId);
    const entries: MenuEntry[] = [];
    if (menuCard.sessionId) {
      entries.push({
        id: "open",
        label: t("kanban.menuOpenSession"),
        icon: <ChatIcon />,
        disabled: sessionGone,
        disabledTitle: t("kanban.menuSessionGone"),
        onSelect: () => onOpenSession(menuCard.sessionId!, menuCard.sessionTitle ?? menuCard.title),
      });
      entries.push({
        id: "unlink",
        label: t("kanban.menuUnlink"),
        icon: <LinkIcon />,
        onSelect: () => kanbanUnlinkCard(projectDir, menuCard.id),
      });
    } else {
      const backlogLane = board.lanes.find((l) => l.id === menuCard.laneId)?.fixed;
      entries.push({
        id: "link",
        label: t("kanban.menuLink"),
        icon: <LinkIcon />,
        disabled: Boolean(backlogLane) || sessionOptions.length === 0,
        disabledTitle: backlogLane ? t("kanban.backlogNoSessions") : t("kanban.cardFormSessionRequired"),
        onSelect: () => {
          if (menuFor) setLinkFor({ cardId: menuCard.id, anchor: menuFor.anchor });
        },
      });
    }
    entries.push({
      id: "edit",
      label: t("kanban.menuEdit"),
      onSelect: () => openForm(menuCard.laneId, menuCard),
    });
    if (next) {
      entries.push({
        id: "advance",
        label: t("kanban.menuAdvance", { lane: next.name }),
        dim: true,
        icon: (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
          </svg>
        ),
        onSelect: () => {
          const moved = kanbanAdvanceCard(projectDir, menuCard.id);
          if (moved) setHighlightFlash(menuCard.id);
        },
      });
    }
    entries.push({
      id: "delete",
      label: t("kanban.menuDelete"),
      danger: true,
      onSelect: () => {
        kanbanDeleteCard(projectDir, menuCard.id);
        setFormFor((current) => (current?.cardId === menuCard.id ? null : current));
      },
    });
    return entries;
  }, [menuCard, board, sessionIds, sessionOptions, menuFor, projectDir, t, onOpenSession, openForm, setHighlightFlash]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)", minWidth: 0 }}>
      <style>{`
        @keyframes kanban-card-in {
          from { opacity: 0; transform: translateY(3px); }
          to { opacity: 1; transform: translateY(0); }
        }
        [data-kanban-card] { animation: kanban-card-in 140ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          [data-kanban-card] { animation: none; }
        }
      `}</style>
      <header style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 40,
        padding: "0 12px",
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
      }}>
        <KanbanIcon size={15} style={{ color: "var(--accent)" }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "50%" }} title={projectName}>
          {projectName}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
          {t("kanban.boardTasks", { count: board.cards.length })}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setConfigOpen(true)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: 28,
            padding: "0 10px",
            fontSize: 11.5,
            color: "var(--text-muted)",
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: 7,
            cursor: "pointer",
            flexShrink: 0,
            transition: "color 0.12s, background 0.12s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          {!mobile && t("kanban.boardConfigure")}
        </button>
      </header>
      {notice}
      {mobile && activeMobileLane && (
        <div style={{ flexShrink: 0, display: "flex", gap: 6, padding: "8px 12px 0", overflowX: "auto", scrollbarWidth: "none" }}>
          {board.lanes.map((lane) => {
            const count = cardsOfLane(board, lane.id).length;
            const active = lane.id === activeMobileLane;
            return (
              <button
                key={lane.id}
                type="button"
                aria-pressed={active}
                onClick={() => setMobileLaneId(lane.id)}
                style={{
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  height: 26,
                  padding: "0 10px",
                  fontSize: 11,
                  fontWeight: 600,
                  borderRadius: 999,
                  border: `1px solid ${active ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--border)"}`,
                  background: active ? "color-mix(in srgb, var(--accent) 14%, transparent)" : "none",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                {lane.name}
                {count > 0 && <span style={{ fontSize: 10, color: active ? "var(--accent)" : "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{count}</span>}
              </button>
            );
          })}
        </div>
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowX: "auto",
          overflowY: "hidden",
          display: "flex",
          alignItems: "stretch",
          gap: 10,
          padding: "12px 12px 12px",
        }}
      >
        {board.lanes.filter((lane) => !mobile || lane.id === activeMobileLane).map((lane) => {
          const laneIndex = board.lanes.findIndex((l) => l.id === lane.id);
          return (
          <LaneColumn
            key={lane.id}
            board={board}
            projectDir={projectDir}
            lane={lane}
            isLast={laneIndex === board.lanes.length - 1}
            sessions={sessions}
            runningIds={runningSessionIds}
            sessionIds={sessionIds}
            highlightCardId={flashId ?? highlightCardId ?? null}
            form={formFor}
            onOpenForm={openForm}
            onOpenMenu={openMenu}
            onOpenLinkPicker={openLink}
            onOpenSession={onOpenSession}
            mobile={mobile}
          />
          );
        })}
        {!(mobile && activeMobileLane) && (
          <button
            type="button"
            onClick={() => setConfigOpen(true)}
            style={{
              flex: "0 0 auto",
              width: mobile ? "min(120px, 34vw)" : 150,
              maxHeight: "100%",
              padding: 12,
              background: "none",
              border: "1px dashed var(--border)",
              borderRadius: 10,
              color: "var(--text-dim)",
              fontSize: 11.5,
              cursor: "pointer",
            }}
          >
            {t("kanban.laneAddGhost")}
          </button>
        )}
      </div>
      {configOpen && <LaneConfig board={board} projectDir={projectDir} projectName={projectName} onClose={() => setConfigOpen(false)} />}
      {menuFor && menuCard && (
        <CardMenu anchor={menuFor.anchor} entries={menuEntries} onClose={() => setMenuFor(null)} />
      )}
      {linkFor && linkCard && (
        <SessionPicker
          anchor={linkFor.anchor}
          options={sessionOptions}
          placeholder={t("kanban.cardFormSessionPlaceholder")}
          onPick={(option) => kanbanLinkCard(projectDir, linkCard.id, option.id, option.title)}
          onClose={() => setLinkFor(null)}
        />
      )}
    </div>
  );
}
