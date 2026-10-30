"use client";

import { useEffect } from "react";

// ---------------------------------------------------------------------------
// Module-level registry — ChatWindow registers the abort handler here so that
// the global Esc listener in AppShell can call it without prop-drilling.
// ---------------------------------------------------------------------------
let globalAbortHandler: (() => void) | null = null;

/**
 * Register (or clear) the abort handler for the global Esc shortcut.
 * Call this from ChatWindow whenever agentRunning or handleAbort changes.
 */
export function registerAbortHandler(handler: (() => void) | null): void {
  globalAbortHandler = handler;
}

/**
 * The global Esc shortcut: stops the running agent, unless the key belongs to
 * something else. Typed into a textarea or input, it is that field's (ChatInput
 * has its own Esc logic). Marked handled already (`defaultPrevented`), it was
 * something nearer's: Settings, a menu or a viewer that closed on it. Those
 * listen on `document` or below and run before this one on `window`, and
 * closing them must not stop a run as well. Returns whether it stopped the
 * agent.
 */
export function handleGlobalEscape(event: KeyboardEvent): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || !globalAbortHandler) return false;

  const tag = (event.target as HTMLElement | null)?.tagName;
  // Let textarea/input handle Esc internally (ChatInput menus / stop).
  if (tag === "TEXTAREA" || tag === "INPUT") return false;

  event.preventDefault();
  globalAbortHandler();
  return true;
}

/**
 * Whether a keydown is the Ctrl+Alt+N "new session" shortcut.
 *
 * The letter decides (`event.key`), so the shortcut follows the layout. Two
 * platforms bend that:
 * - macOS treats Option as a character-input modifier: `Option+N` is a dead
 *   key (`˜`) in the U.S., ABC and British layouts, and Chrome reports
 *   `key === "Dead"` with `ctrlKey`/`altKey` intact (#1335). A dead key types
 *   nothing yet, so the physical key (`code === "KeyN"`) decides there.
 * - Windows reports AltGr as Ctrl+Alt. When the combination types a character
 *   (Polish AltGr+N is `ń`), that `key` is the user's text: matching `code`
 *   alone would swallow it and open a session instead.
 */
export function isNewSessionShortcut(event: {
  key: string;
  code?: string | null;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  if (!event.ctrlKey || !event.altKey) return false;
  if (event.key.toLowerCase() === "n") return true;
  return event.key === "Dead" && event.code === "KeyN";
}

// ---------------------------------------------------------------------------
// Panel toggles: sidebar, right panel, terminal
// ---------------------------------------------------------------------------

/** The parts of a keydown the panel toggles decide on. */
export interface PanelShortcutEvent {
  key: string;
  code?: string | null;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Whether the key is the letter `b`, whatever the layout says.
 *
 * The letter decides (`event.key`), so the shortcut follows the keyboard: a
 * Dvorak user presses the key that types `b`. The physical key (`code`) is the
 * fallback for the layouts that report a dead key (macOS `Option`+letter), as
 * `isNewSessionShortcut()` does for `Ctrl+Alt+N`. `code` alone is never
 * enough: Windows reports AltGr as Ctrl+Alt, and a character that combination
 * types is the user's text, not the shortcut.
 */
function isLetterB(event: PanelShortcutEvent): boolean {
  if (event.key.toLowerCase() === "b") return true;
  return event.key === "Dead" && event.code === "KeyB";
}

/**
 * Whether the key is the backquote (`code === "Backquote"`).
 *
 * The physical key decides, because the character it types differs per
 * layout (and a German layout types a dead key there). The character is the
 * fallback for a `KeyboardEvent` without a `code`.
 */
function isBackquote(event: PanelShortcutEvent): boolean {
  if (event.code) return event.code === "Backquote";
  return event.key === "`" || event.key === "˜";
}

/**
 * `Cmd+B` / `Ctrl+B`: toggle the sidebar.
 *
 * `Cmd` (macOS) and `Ctrl` (Windows, Linux) are both accepted on every
 * platform, so the shortcut works with the keyboard at hand. `Alt` is refused:
 * Windows reports AltGr as Ctrl+Alt, and an AltGr combination that types a
 * character is the user's text. `Shift` is refused too, because `Cmd+Shift+B`
 * is the right panel.
 */
export function isSidebarToggleShortcut(event: PanelShortcutEvent): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return isLetterB(event);
}

/**
 * `Cmd+Shift+B` / `Ctrl+Shift+B`: toggle the right panel.
 *
 * Chrome binds `Cmd+Shift+B` to its bookmarks bar and Firefox `Ctrl+Shift+B`
 * to its bookmarks toolbar, but neither is a reserved accelerator: the page
 * sees the key first and its `preventDefault()` stops the browser's own
 * action (the way Google Docs overrides `Cmd+S`). `Alt` is refused, because
 * Windows reports AltGr as Ctrl+Alt and an AltGr combination that types a
 * character is the user's text.
 */
export function isRightPanelToggleShortcut(event: PanelShortcutEvent): boolean {
  if (event.altKey || !event.shiftKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return isLetterB(event);
}

/**
 * `Ctrl+` `` ` ``: toggle the terminal.
 *
 * `Ctrl` on every platform, `Cmd` included on macOS only as `Cmd+`` is the
 * system's window switcher there. `Shift` is refused, because `Ctrl+Shift+``
 * is the "new terminal" chord in other editors.
 */
export function isTerminalToggleShortcut(event: PanelShortcutEvent): boolean {
  if (event.altKey || event.shiftKey || event.metaKey) return false;
  if (!event.ctrlKey) return false;
  return isBackquote(event);
}

/**
 * Whether the key was pressed inside a dialog that covers the page.
 *
 * A modal (Settings, the trust dialog, a card editor) owns the screen: the
 * panels behind it are not what the user is looking at, so a panel toggle
 * would change something they cannot see.
 */
function isInsideModal(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target || typeof target.closest !== "function") return false;
  return target.closest("[aria-modal='true']") !== null;
}

// ---------------------------------------------------------------------------
// Hook: global keyboard shortcuts
// ---------------------------------------------------------------------------

interface UseGlobalKeyboardShortcutsOptions {
  /** Called when Ctrl+Alt+N is pressed. Receives current cwd. */
  onNewSession?: (cwd: string) => void;
  /** Called when the sidebar toggle chord is pressed. */
  onToggleSidebar?: () => void;
  /** Called when the right panel toggle chord is pressed. */
  onToggleRightPanel?: () => void;
  /** Called when the terminal toggle chord is pressed. */
  onToggleTerminal?: () => void;
  /** The currently selected project directory (sidebar cwd). */
  activeCwd?: string | null;
  /**
   * Whether Esc may stop the running agent. False while another screen covers
   * the chat (the kanban board): the chat stays mounted under `display: none`,
   * so its registered abort handler would otherwise stop a run the user cannot
   * see and swallow the key the covering screen wants. Defaults to true.
   */
  escapeStopsAgent?: boolean;
}

/**
 * Register global keyboard shortcuts for the application.
 *
 * Shortcuts handled here:
 *   Esc          – stop the running agent (via module-level abort handler)
 *   Ctrl+Alt+N   – create a new session in the active project directory
 *                  (see `isNewSessionShortcut()` for macOS and AltGr)
 *   Cmd/Ctrl+B   – toggle the sidebar
 *   Cmd/Ctrl+Shift+B (or Ctrl+Alt+B) – toggle the right panel
 *   Ctrl+`       – toggle the terminal
 *
 * Note: Esc inside <textarea> or <input> is deliberately NOT handled here.
 * ChatInput manages its own Esc logic (closing slash / @ file menus, stopping
 * the agent when no menu is open) because it needs intimate knowledge of menu
 * state that is local to that component. Nor is an Esc something nearer
 * already handled (see `handleGlobalEscape()`).
 */
export function useGlobalKeyboardShortcuts(
  options: UseGlobalKeyboardShortcutsOptions,
): void {
  const {
    onNewSession,
    activeCwd,
    escapeStopsAgent = true,
    onToggleSidebar,
    onToggleRightPanel,
    onToggleTerminal,
  } = options;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // ---- Esc: stop agent, only while the chat is the screen on show ----
      if (e.key === "Escape") {
        if (escapeStopsAgent) handleGlobalEscape(e);
        return;
      }

      // ---- Ctrl+Alt+N: new session ----
      if (isNewSessionShortcut(e)) {
        if (!activeCwd || !onNewSession) return;
        e.preventDefault();
        onNewSession(activeCwd);
        return;
      }

      // ---- Panel toggles: sidebar, right panel, terminal ----
      // The terminal is checked first: it is the only chord that carries no
      // letter, so it cannot be mistaken for the other two.
      if (isTerminalToggleShortcut(e)) {
        if (!onToggleTerminal) return;
        if (isInsideModal(e)) return;
        e.preventDefault();
        onToggleTerminal();
        return;
      }
      if (isRightPanelToggleShortcut(e)) {
        if (!onToggleRightPanel) return;
        if (isInsideModal(e)) return;
        e.preventDefault();
        onToggleRightPanel();
        return;
      }
      if (isSidebarToggleShortcut(e)) {
        if (!onToggleSidebar) return;
        if (isInsideModal(e)) return;
        e.preventDefault();
        onToggleSidebar();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeCwd, escapeStopsAgent, onNewSession, onToggleRightPanel, onToggleSidebar, onToggleTerminal]);
}
