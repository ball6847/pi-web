"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { NewSessionContext, NewSessionTarget, ProjectChoice } from "@/lib/new-session-context";
import { focusIfLost } from "@/lib/stacked-dialog";
import type { KanbanLane } from "@/lib/kanban-mock";
import { ChevronIcon } from "./SidebarIcons";
import { ProjectWorktreePicker, type ProjectWorktreeControl, type ProjectWorktreePickerHandle } from "./ProjectWorktreePicker";

/** The bar's two controls. A move names the one it came from, which takes focus in the bar that replaces this one. */
export type NewSessionContextControl = ProjectWorktreeControl;

/**
 * The board choice of the fresh composer (UI design phase): whether the new
 * session starts tracked on the project's kanban board, and in which lane.
 * `null` = off. The shell keeps the choice and applies it when the session
 * gets its id.
 */
export interface NewSessionBoardChoice {
  lanes: KanbanLane[];
  laneId: string | null;
  onLaneChange(laneId: string | null): void;
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
        const lane = board.lanes.find((l) => l.id === board.laneId) ?? null;
        const label = lane ? lane.name : t("kanban.composerOff");
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
              const top = boardMenu.anchor.bottom + 6 + (board.lanes.length + 1) * 28 + 12 > window.innerHeight
                ? Math.max(8, boardMenu.anchor.top - (board.lanes.length + 1) * 28 - 12)
                : boardMenu.anchor.bottom + 6;
              return createPortal(
                <div
                  data-kanban-board-choice
                  role="menu"
                  style={{
                    position: "fixed",
                    left,
                    top,
                    zIndex: 650,
                    width: 196,
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    boxShadow: "0 10px 28px rgba(0,0,0,0.14)",
                    padding: 4,
                  }}
                >
                  {[
                    { id: null as string | null, name: t("kanban.composerOff"), fixed: false, title: t("kanban.composerOffTitle") },
                    // The backlog option is disabled, and its tooltip says why; other lanes are user data.
                    ...board.lanes.map((l) => ({ id: l.id, name: l.name, fixed: Boolean(l.fixed), title: l.fixed ? t("kanban.backlogNoSessions") : l.description || l.name })),
                  ].map((option) => {
                    // The backlog never takes a session, so a tracked start there is refused.
                    const disabled = option.fixed;
                    const selected = board.laneId === option.id;
                    return (
                      <button
                        key={option.id ?? "off"}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        disabled={disabled}
                        title={disabled ? option.title : option.name}
                        onClick={() => {
                          if (disabled) return;
                          board.onLaneChange(option.id);
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
                          color: disabled ? "var(--text-dim)" : "var(--text)",
                          opacity: disabled ? 0.55 : 1,
                          cursor: disabled ? "default" : "pointer",
                          fontSize: 12,
                          textAlign: "left",
                        }}
                        onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                      >
                        <span style={{ width: 10, display: "inline-flex", flexShrink: 0, color: selected ? "var(--accent)" : "transparent" }} aria-hidden="true">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                        </span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{option.name}</span>
                      </button>
                    );
                  })}
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
