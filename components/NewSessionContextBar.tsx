"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { NewSessionContext, NewSessionTarget, ProjectChoice } from "@/lib/new-session-context";
import { focusIfLost } from "@/lib/stacked-dialog";
import type { KanbanCard, KanbanLane, KanbanNewSessionPending, KanbanNewSessionPick } from "@/lib/kanban-types";
import { ChevronIcon } from "./SidebarIcons";
import { ProjectWorktreePicker, type ProjectWorktreeControl, type ProjectWorktreePickerHandle } from "./ProjectWorktreePicker";

/** The bar's two controls. A move names the one it came from, which takes focus in the bar that replaces this one. */
export type NewSessionContextControl = ProjectWorktreeControl;

/**
 * The board choice of the fresh composer: what its session does on the
 * project's board once it exists — nothing, a new card in a lane, or a link
 * onto an existing sessionless card. The shell keeps the choice (pinned to
 * the board's project root) and applies it when pi answers with the session
 * id. The board card menu's "Start session" opens the composer with the
 * attach form pre-picked, so both directions meet in this one control.
 */
export interface NewSessionBoardChoice {
  lanes: KanbanLane[];
  /** The board's sessionless cards, for "Attach to card" (the shell filters). */
  cards: KanbanCard[];
  pending: KanbanNewSessionPending;
  onChange(pick: KanbanNewSessionPick): void;
}

interface Props {
  context: NewSessionContext;
  /** A phone: the menus open as bottom sheets. */
  mobile: boolean;
  /** The control the move that mounted this bar came from: it takes focus once, if focus fell to the page. */
  initialFocus: NewSessionContextControl | null;
  onInitialFocusDone: () => void;
  /** Start the fresh composer over in `target`; the shell ignores a move to where it already is. */
  onPick: (target: NewSessionTarget, from: NewSessionContextControl) => void;
  /** "Use default directory": today's folder, which goes to `onPick`. */
  onUseDefaultDirectory: () => void;
  /** "Open another project…": the folder picker, which hands its folder to `onPick`. */
  onOpenFolder: (opener: HTMLElement | null) => void;
  onRefreshWorktrees: () => void;
  onCreateWorktree: (project: ProjectChoice, branch: string) => Promise<{ path: string } | { error: string }>;
  /** The project's board and the composer's choice; absent when it has no board. */
  board?: NewSessionBoardChoice | null;
}

// The home folder the paths (the menus', a detached checkout's in the
// worktree button) show as ~, asked for once per page: the bar mounts again
// with every move of the fresh composer.
let homeDirCheck: Promise<string> | null = null;
let homeDirFound = "";
function loadHomeDir(): Promise<string> {
  homeDirCheck ??= fetch("/api/home")
    .then((response) => response.json())
    .then((data: { home?: string }) => {
      homeDirFound = data.home ?? "";
      return homeDirFound;
    })
    .catch(() => {
      homeDirCheck = null;
      return "";
    });
  return homeDirCheck;
}

/**
 * The project and worktree a fresh composer starts its session in: a row of
 * its own in the empty new-session page's header, under the brand and right
 * above the composer. The files tab's picker
 * (components/ProjectWorktreePicker.tsx) laid out inline: the project's name
 * and the worktree's branch as text, its group named by the label alone (no
 * visible one: the folder icon says it). Every pick starts the composer over
 * in the new folder (the shell remounts it, carrying the draft and its model
 * picks), so this bar only reports what was chosen; the sidebar keeps the cwd.
 */
export function NewSessionContextBar({
  context,
  mobile,
  initialFocus,
  onInitialFocusDone,
  onPick,
  onUseDefaultDirectory,
  onOpenFolder,
  onRefreshWorktrees,
  onCreateWorktree,
  board,
}: Props) {
  const { t } = useI18n();
  const [homeDir, setHomeDir] = useState(() => homeDirFound);
  const pickerRef = useRef<ProjectWorktreePickerHandle>(null);
  const initialFocusRef = useRef(initialFocus);
  const onInitialFocusDoneRef = useRef(onInitialFocusDone);
  onInitialFocusDoneRef.current = onInitialFocusDone;

  useEffect(() => {
    if (homeDirFound) return;
    let cancelled = false;
    void loadHomeDir().then((home) => {
      if (!cancelled && home) setHomeDir(home);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The control that moved the composer went away with it: its counterpart
  // here takes focus, so a keyboard user goes on from where they were.
  useEffect(() => {
    const from = initialFocusRef.current;
    if (!from) return;
    initialFocusRef.current = null;
    onInitialFocusDoneRef.current();
    const picker = pickerRef.current;
    focusIfLost(document, (from === "worktree" ? picker?.button("worktree") : null) ?? picker?.button("project") ?? null);
  }, []);

  const [boardMenu, setBoardMenu] = useState<{ anchor: DOMRect } | null>(null);
  const boardBtnRef = useRef<HTMLButtonElement | null>(null);

  // Close the board menu on outside press or Escape.
  useEffect(() => {
    if (!boardMenu) return;
    const close = () => setBoardMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target && target.closest?.("[data-kanban-board-choice]") === null) close();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onPointerDown, true);
    };
  }, [boardMenu]);

  return (
    <div className="new-session-context">
      <ProjectWorktreePicker
        handleRef={pickerRef}
        layout="inline"
        context={context}
        mobile={mobile}
        label={t("workspace.newSessionContext")}
        homeDir={homeDir}
        newWorktreeTitle={t("sidebar.newWorktreeForSession")}
        onPick={onPick}
        onUseDefaultDirectory={onUseDefaultDirectory}
        onOpenFolder={onOpenFolder}
        onRefreshWorktrees={onRefreshWorktrees}
        onCreateWorktree={onCreateWorktree}
      />
      {board && (() => {
        const pending = board.pending;
        const label = pending.kind === "off"
          ? t("kanban.composerOff")
          : pending.kind === "new-card"
            ? board.lanes.find((l) => l.id === pending.laneId)?.name ?? t("kanban.composerOff")
            : pending.cardTitle;
        return (
          <div className="project-picker is-inline" role="group" aria-label={t("kanban.composerTrack")}>
            <button
              ref={boardBtnRef}
              type="button"
              className="project-picker-button"
              title={t("kanban.composerTrackTitle", { lane: label })}
              aria-haspopup="menu"
              aria-expanded={boardMenu !== null}
              onClick={() => {
                const rect = boardBtnRef.current?.getBoundingClientRect();
                setBoardMenu((current) => (current ? null : rect ? { anchor: rect } : null));
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="project-picker-icon" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /><path d="M15 3v12" />
              </svg>
              <span className="project-picker-label">{label}</span>
              <ChevronIcon size={9} className="project-picker-chevron sidebar-icon-down" />
            </button>
            {boardMenu && (() => {
              const left = Math.min(Math.max(boardMenu.anchor.left, 8), Math.max(8, window.innerWidth - 208));
              // Rows: the off choice, the "New card in" lanes, and the
              // "Attach to card" list (capped like the strip's attach menu;
              // with no cards, its one disabled line stands in).
              const attachCards = board.cards.slice(0, 8);
              const menuHeight = (1 + board.lanes.length + (board.cards.length > 0 ? attachCards.length : 1)) * 28 + 44 + 16;
              const top = boardMenu.anchor.bottom + 6 + menuHeight > window.innerHeight
                ? Math.max(8, boardMenu.anchor.top - menuHeight)
                : boardMenu.anchor.bottom + 6;
              const maxHeight = Math.max(120, window.innerHeight - top - 8);
              const menuItem = (key: string, opts: {
                label: string;
                selected: boolean;
                disabled?: boolean;
                disabledTitle?: string;
                title?: string;
                trailing?: React.ReactNode;
                onSelect?: () => void;
              }) => (
                <button
                  key={key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={opts.selected}
                  disabled={opts.disabled}
                  title={opts.disabled ? opts.disabledTitle : opts.title ?? opts.label}
                  onClick={() => {
                    if (opts.disabled) return;
                    opts.onSelect?.();
                    setBoardMenu(null);
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
                    color: opts.disabled ? "var(--text-dim)" : "var(--text)",
                    opacity: opts.disabled ? 0.55 : 1,
                    cursor: opts.disabled ? "default" : "pointer",
                    fontSize: 12,
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) => { if (!opts.disabled) e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                >
                  <span style={{ width: 10, display: "inline-flex", flexShrink: 0, color: opts.selected ? "var(--accent)" : "transparent" }} aria-hidden="true">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{opts.label}</span>
                  {opts.trailing}
                </button>
              );
              const sectionLabel = (key: string, sectionLabel: string) => (
                <div
                  key={key}
                  style={{
                    padding: "7px 8px 2px",
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: "var(--text-dim)",
                    textTransform: "uppercase" as const,
                    letterSpacing: 0.4,
                  }}
                >
                  {sectionLabel}
                </div>
              );
              return createPortal(
                <div
                  data-kanban-board-choice
                  role="menu"
                  style={{
                    position: "fixed",
                    left,
                    top,
                    maxHeight,
                    overflowY: "auto" as const,
                    zIndex: 650,
                    width: 196,
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    boxShadow: "0 10px 28px rgba(0,0,0,0.14)",
                    padding: 4,
                  }}
                >
                  {menuItem("off", {
                    label: t("kanban.composerOff"),
                    selected: pending.kind === "off",
                    title: t("kanban.composerOffTitle"),
                    onSelect: () => board.onChange({ kind: "off" }),
                  })}
                  {sectionLabel("new-card", t("kanban.composerNewCardSection"))}
                  {/* The backlog option is disabled, and its tooltip says why; other lanes are user data. */}
                  {board.lanes.map((l) =>
                    menuItem(l.id, {
                      label: l.name,
                      selected: pending.kind === "new-card" && pending.laneId === l.id,
                      disabled: Boolean(l.fixed),
                      disabledTitle: l.fixed ? t("kanban.backlogNoSessions") : undefined,
                      title: l.description || l.name,
                      onSelect: () => board.onChange({ kind: "new-card", laneId: l.id }),
                    }))}
                  {sectionLabel("attach", t("kanban.composerAttachSection"))}
                  {board.cards.length === 0
                    ? menuItem("no-cards", { label: t("kanban.composerNoCards"), selected: false, disabled: true })
                    : attachCards.map((c) =>
                      menuItem(c.id, {
                        label: c.title,
                        selected: pending.kind === "attach" && pending.cardId === c.id,
                        trailing: (() => {
                          const laneName = board.lanes.find((l) => l.id === c.laneId)?.name;
                          return laneName ? (
                            <span style={{ flexShrink: 0, maxWidth: 64, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10.5, color: "var(--text-dim)" }}>{laneName}</span>
                          ) : null;
                        })(),
                        onSelect: () => board.onChange({ kind: "attach", cardId: c.id, cardTitle: c.title }),
                      }))}
                </div>,
                document.body,
              );
            })()}
          </div>
        );
      })()}
    </div>
  );
}
