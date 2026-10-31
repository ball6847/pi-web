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
 * Whether the key is the letter `w`, whatever the layout says.
 *
 * The letter decides (`event.key`), so the shortcut follows the keyboard. The
 * physical key (`code`) is the fallback for the layouts that report a
 * character instead of the letter: macOS's `Option+W` types `∑`, not `w`.
 */
function isLetterW(event: PanelShortcutEvent): boolean {
  if (event.key.toLowerCase() === "w") return true;
  return event.code === "KeyW";
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
 * `Cmd+B` on macOS, `Ctrl+B` on Windows and Linux: toggle the sidebar.
 *
 * The modifier is the platform's *primary* one — `Cmd` on macOS, `Ctrl`
 * elsewhere — the way the DeepSeek Harness spells it (`primary`, resolved per
 * platform profile). Only that one counts: on macOS `Ctrl+B` is the caret's
 * "back one character" in a text field, and the Windows key is not a
 * shortcut modifier at all.
 *
 * `Alt` is refused: Windows reports AltGr as Ctrl+Alt, and an AltGr
 * combination that types a character is the user's text. `Shift` is refused
 * too, because the primary modifier with `Shift` is the right panel.
 */
export function isSidebarToggleShortcut(event: PanelShortcutEvent, isMac: boolean): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (!hasPrimaryModifier(event, isMac)) return false;
  return isLetterB(event);
}

/**
 * `Cmd+Shift+B` on macOS, `Ctrl+Shift+B` elsewhere: toggle the right panel.
 *
 * Chrome binds `Cmd+Shift+B` to its bookmarks bar and Firefox `Ctrl+Shift+B`
 * to its bookmarks toolbar, but neither is a reserved accelerator: the page
 * sees the key first and its `preventDefault()` stops the browser's own
 * action (the way Google Docs overrides `Cmd+S`). `Alt` is refused, because
 * Windows reports AltGr as Ctrl+Alt and an AltGr combination that types a
 * character is the user's text.
 */
export function isRightPanelToggleShortcut(event: PanelShortcutEvent, isMac: boolean): boolean {
  if (event.altKey || !event.shiftKey) return false;
  if (!hasPrimaryModifier(event, isMac)) return false;
  return isLetterB(event);
}

/**
 * Whether the key is the letter `l`, whatever the layout says.
 *
 * The letter decides (`event.key`), so the shortcut follows the keyboard. The
 * physical key (`code`) is the fallback for the layouts that report a dead
 * key (macOS's `Option`+letter), as `isNewSessionShortcut()` does for
 * `Ctrl+Alt+N`.
 */
function isLetterL(event: PanelShortcutEvent): boolean {
  if (event.key.toLowerCase() === "l") return true;
  return event.key === "Dead" && event.code === "KeyL";
}

/**
 * `Cmd/Ctrl+L`: focus the chat composer.
 *
 * The composer is the one field the user reaches for most, so one chord
 * brings it back from wherever the focus is: the sidebar, the transcript, a
 * file tab, the board. VSCode binds the same chord to the chat input.
 *
 * The browser owns `Ctrl+L` (the address bar), so the chord is taken from it
 * the way `Cmd/Ctrl+P` is taken from the browser's print dialog: the default
 * is stopped on every press and the composer takes the caret instead.
 * `Alt` and `Shift` are refused (`Shift` belongs to the right panel, `Alt` to
 * AltGr).
 */
export function isFocusComposerShortcut(event: PanelShortcutEvent, isMac: boolean): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (!hasPrimaryModifier(event, isMac)) return false;
  return isLetterL(event);
}

/**
 * `Cmd/Ctrl+P`: open the Quick Open palette.
 *
 * One chord, VSCode's muscle memory for "go to file". The browser owns
 * `Ctrl+P` for printing, and a page can take that chord back: the handler
 * stops the default on every press, so the browser never prints.
 *
 * `Alt` is refused, because Windows reports AltGr as Ctrl+Alt and an AltGr
 * combination that types a character is the user's text. `Shift` is refused
 * too: `Cmd/Ctrl+Shift+P` belongs to the browser (the developer tools).
 */
export function isQuickOpenShortcut(event: PanelShortcutEvent, isMac: boolean): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (!hasPrimaryModifier(event, isMac)) return false;
  return event.key.toLowerCase() === "p";
}

/**
 * `Cmd+Alt+Enter` on macOS, `Ctrl+Alt+Enter` elsewhere: the right panel's
 * full-width mode.
 *
 * The DeepSeek Harness toggles its right pane's fullscreen with the primary
 * modifier, `Alt` and `Enter` (its `pane.fullscreen.toggle`). The `Alt` is
 * what makes the chord safe: a bare `Enter` belongs to the composer (send),
 * and the harness reserves `Enter` without `Alt` for exactly that reason.
 */
export function isRightPanelFullscreenShortcut(event: PanelShortcutEvent, isMac: boolean): boolean {
  if (!event.altKey || event.shiftKey) return false;
  if (!hasPrimaryModifier(event, isMac)) return false;
  return event.key === "Enter";
}

/**
 * `Ctrl+` `` ` ``: toggle the terminal.
 *
 * `Ctrl` on every platform, `Cmd` included on macOS only as `Cmd+`` is the
 * system's window switcher there — and the Harness spells this one `control`
 * rather than `primary` too. `Shift` is refused, because `Ctrl+Shift+``
 * is the "new terminal" chord in other editors.
 */
export function isTerminalToggleShortcut(event: PanelShortcutEvent): boolean {
  if (event.altKey || event.shiftKey || event.metaKey) return false;
  if (!event.ctrlKey) return false;
  return isBackquote(event);
}

/**
 * `Alt+W`: close the right panel's tab on show.
 *
 * `Alt` is the modifier, not the platform's primary one, so the chord reads
 * the same everywhere. `Ctrl` and `Cmd` are refused: Windows reports AltGr
 * as Ctrl+Alt, and an AltGr combination that types a character is the user's
 * text.
 */
export function isCloseTabShortcut(event: PanelShortcutEvent): boolean {
  if (!event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return false;
  return isLetterW(event);
}

/** Which way along the right panel's tab strip a chord moves. */
export type PanelTabDirection = "previous" | "next";

/**
 * `Alt+Shift+[` and `Alt+Shift+]`: the right panel's previous and next tab.
 *
 * The physical key decides (`code === "BracketLeft"` / `"BracketRight"`),
 * because `Shift` turns the bracket into another character (`{`, `}`) and the
 * letter of the layout's own bracket key is not the bracket.
 */
export function isPanelTabNavigationShortcut(event: PanelShortcutEvent): PanelTabDirection | null {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return null;
  if (event.code) {
    if (event.code === "BracketLeft") return "previous";
    if (event.code === "BracketRight") return "next";
    return null;
  }
  if (event.key === "[") return "previous";
  if (event.key === "]") return "next";
  return null;
}

/**
 * Whether the event carries the platform's primary modifier: `Cmd` on macOS,
 * `Ctrl` on Windows and Linux.
 */
function hasPrimaryModifier(event: PanelShortcutEvent, isMac: boolean): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
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

/**
 * Whether the key was pressed inside the Quick Open palette.
 *
 * The palette is a modal of its own, so `isInsideModal()` cannot tell it
 * apart from Settings or the trust dialog: the palette answers its own chord
 * (it takes the key again and focuses its field), the other modals do not.
 */
function isInsideQuickOpen(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target || typeof target.closest !== "function") return false;
  return target.closest("[data-quick-open]") !== null;
}

/**
 * Whether the key was typed into a text field (the composer, a settings
 * input), where the panel's own chords must not swallow the text: `Alt+W`
 * types `∑` on macOS and `Alt+Shift+[` types `{`.
 *
 * The terminal's hidden textarea is not one of those fields: xterm keeps the
 * panel's chords from the shell (see `TerminalPanel`), so they are ours
 * there.
 */
function isTextEditingField(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName;
  if (tag !== "TEXTAREA" && tag !== "INPUT") return false;
  return !target.classList?.contains("xterm-helper-textarea");
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
  /** Called when the right panel's full-width chord is pressed. */
  onToggleRightPanelFullscreen?: () => void;
  /** Called when the right panel's tab on show should close. */
  onClosePanelTab?: () => void;
  /** Called when the right panel should show its next or previous tab. */
  onSelectAdjacentPanelTab?: (direction: PanelTabDirection) => void;
  /** Called when the Quick Open palette's chord is pressed. */
  onOpenQuickOpen?: () => void;
  /** Called when the composer-focus chord is pressed. */
  onFocusComposer?: () => void;
  /**
   * Whether the platform's primary modifier is `Cmd` (macOS) rather than
   * `Ctrl` (Windows, Linux). The platform toggles follow it, so a chord
   * written once reads as `Cmd+B` on a Mac and `Ctrl+B` elsewhere.
   */
  isMac?: boolean;
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
 *   Cmd/Ctrl+B   – toggle the sidebar (the platform's primary modifier)
 *   Cmd/Ctrl+Shift+B – toggle the right panel
 *   Cmd/Ctrl+Alt+Enter – the right panel's full-width mode
 *   Ctrl+`       – toggle the terminal
 *   Cmd/Ctrl+P   – open the Quick Open palette
 *   Cmd/Ctrl+L   – focus the chat composer
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
    onToggleRightPanelFullscreen,
    onClosePanelTab,
    onSelectAdjacentPanelTab,
    onOpenQuickOpen,
    onFocusComposer,
    isMac = false,
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

      // ---- The right panel's tab strip ----
      // These chords are the panel's own, and they type characters: they are
      // refused inside a text field, where the text is the user's.
      if (isCloseTabShortcut(e)) {
        if (!onClosePanelTab) return;
        if (isInsideModal(e) || isTextEditingField(e)) return;
        e.preventDefault();
        onClosePanelTab();
        return;
      }
      const direction = isPanelTabNavigationShortcut(e);
      if (direction) {
        if (!onSelectAdjacentPanelTab) return;
        if (isInsideModal(e) || isTextEditingField(e)) return;
        e.preventDefault();
        onSelectAdjacentPanelTab(direction);
        return;
      }

      // ---- Quick Open: the palette over the whole page ----
      if (isQuickOpenShortcut(e, isMac)) {
        if (!onOpenQuickOpen) return;
        // The chord is ours, and it is taken from the browser: `Cmd/Ctrl+P`
        // prints and `Cmd/Ctrl+K` opens the browser's own search, and both
        // must not happen while the palette has them. So the default is
        // stopped first, every time — including a second press with the
        // palette already open, which is where the browser used to get them.
        e.preventDefault();
        // Another modal (Settings, the trust dialog) owns the screen: the
        // palette would open over it. The key is still ours, so it stays
        // swallowed.
        if (isInsideModal(e) && !isInsideQuickOpen(e)) return;
        // The palette is already open: this takes the key again and puts the
        // caret back in its field, without losing what was typed.
        onOpenQuickOpen();
        return;
      }

      // ---- Cmd/Ctrl+L: focus the composer ----
      if (isFocusComposerShortcut(e, isMac)) {
        if (!onFocusComposer) return;
        // The chord is ours, and it is taken from the browser (the address
        // bar): the default is stopped first, every time.
        e.preventDefault();
        // A modal (Settings, the trust dialog, the palette) owns the screen:
        // the composer is not what the user is looking at. The key stays
        // swallowed.
        if (isInsideModal(e)) return;
        onFocusComposer();
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
      if (isRightPanelFullscreenShortcut(e, isMac)) {
        if (!onToggleRightPanelFullscreen) return;
        if (isInsideModal(e)) return;
        e.preventDefault();
        onToggleRightPanelFullscreen();
        return;
      }
      if (isRightPanelToggleShortcut(e, isMac)) {
        if (!onToggleRightPanel) return;
        if (isInsideModal(e)) return;
        e.preventDefault();
        onToggleRightPanel();
        return;
      }
      if (isSidebarToggleShortcut(e, isMac)) {
        if (!onToggleSidebar) return;
        if (isInsideModal(e)) return;
        e.preventDefault();
        onToggleSidebar();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeCwd, escapeStopsAgent, isMac, onClosePanelTab, onFocusComposer, onNewSession, onOpenQuickOpen, onSelectAdjacentPanelTab, onToggleRightPanel, onToggleRightPanelFullscreen, onToggleSidebar, onToggleTerminal]);
}
