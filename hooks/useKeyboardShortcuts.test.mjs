import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// The hook is driven through the project's React stand-in (one component,
// effects after each render) and a stand-in for the window it listens on.
const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(shimPath);
const {
  handleGlobalEscape,
  isCloseTabShortcut,
  isFocusComposerShortcut,
  isNewSessionShortcut,
  isPanelTabNavigationShortcut,
  isRightPanelFullscreenShortcut,
  isRightPanelToggleShortcut,
  isSidebarToggleShortcut,
  isTerminalToggleShortcut,
  registerAbortHandler,
  useGlobalKeyboardShortcuts,
} = await jiti.import("./useKeyboardShortcuts.ts");

function keydown(key, { tagName = "BUTTON", defaultPrevented = false } = {}) {
  return {
    key,
    target: { tagName },
    defaultPrevented,
    preventDefault() { this.defaultPrevented = true; },
  };
}

test("Escape stops a running agent when nothing else took the key", (t) => {
  let stopped = 0;
  registerAbortHandler(() => { stopped += 1; });
  t.after(() => registerAbortHandler(null));

  const event = keydown("Escape");
  assert.equal(handleGlobalEscape(event), true);
  assert.equal(stopped, 1);
  assert.equal(event.defaultPrevented, true);
  // Focus on the page itself, as after a click on nothing in particular.
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "BODY" })), true);
  assert.equal(stopped, 2);
  assert.equal(handleGlobalEscape(keydown("Enter")), false);
  assert.equal(stopped, 2);
});

test("an Escape something nearer already handled does not stop the agent too", (t) => {
  let stopped = 0;
  registerAbortHandler(() => { stopped += 1; });
  t.after(() => registerAbortHandler(null));

  // Settings, the Mermaid viewer or a menu closed on it and marked it handled.
  assert.equal(handleGlobalEscape(keydown("Escape", { defaultPrevented: true })), false);
  // ChatInput and other fields keep their own Escape.
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "TEXTAREA" })), false);
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "INPUT" })), false);
  assert.equal(stopped, 0);
});

test("with no run to stop, Escape is left alone", () => {
  registerAbortHandler(null);
  const event = keydown("Escape");
  assert.equal(handleGlobalEscape(event), false);
  assert.equal(event.defaultPrevented, false);
});

// The kanban board covers a chat that stays mounted under `display: none`
// (`AppShell`'s centerView). Its abort handler must not answer an Escape the
// board is meant to get: Esc on the board cancels a drag, closes a menu — and
// never stops the session running behind it.
test("Esc reaches only the screen on show, not the covered chat's run", (t) => {
  const target = emitter();
  globalThis.window = target;
  t.after(() => { registerAbortHandler(null); delete globalThis.window; });
  let stopped = 0;
  registerAbortHandler(() => { stopped += 1; });

  const hook = renderHook((props) => useGlobalKeyboardShortcuts(props), {
    onNewSession: () => {},
    activeCwd: "/tmp/project",
    escapeStopsAgent: false,
  });

  const covered = target.emit("keydown", keydown("Escape"));
  assert.equal(stopped, 0, "the board's Escape did not stop the session behind it");
  assert.equal(covered.defaultPrevented, false, "the key stays unmarked for the board");

  // Back on the chat: the same key is the run's again. The hook itself is
  // unmounted below, before the stand-in window and the handler go away.
  hook.rerender({ onNewSession: () => {}, activeCwd: "/tmp/project", escapeStopsAgent: true });
  assert.equal(target.emit("keydown", keydown("Escape")).defaultPrevented, true);
  assert.equal(stopped, 1);
  hook.unmount();
});

/** The smallest stand-in for `window`: one keydown listener list. */
function emitter() {
  const listeners = new Set();
  return {
    addEventListener(type, fn) { if (type === "keydown") listeners.add(fn); },
    removeEventListener(type, fn) { if (type === "keydown") listeners.delete(fn); },
    emit(type, event) {
      if (type === "keydown") for (const fn of [...listeners]) fn(event);
      return event;
    },
  };
}
function shortcut({ key = "n", code = "KeyN", ctrlKey = true, altKey = true } = {}) {
  return isNewSessionShortcut({ key, code, ctrlKey, altKey });
}

test("Ctrl+Alt+N starts a new session", () => {
  assert.equal(shortcut(), true);
  // Caps Lock and Shift still deliver the letter; code is unchanged.
  assert.equal(shortcut({ key: "N" }), true);
  assert.equal(shortcut({ key: "N", code: "KeyN" }), true);
});

test("macOS reports a dead key for Option+N, so the physical key decides", () => {
  // Option+N is `˜` in the U.S., ABC and British layouts. Chrome sends
  // key="Dead" with the modifiers intact, which the old key-only match missed.
  assert.equal(shortcut({ key: "Dead" }), true);
});

test("a character Ctrl+Alt types is the user's text, not the shortcut", () => {
  // Windows reports AltGr as Ctrl+Alt: Polish AltGr+N types `\u0144`, Czech `}`.
  assert.equal(shortcut({ key: "\u0144" }), false);
  assert.equal(shortcut({ key: "}" }), false);
  // Dvorak's physical N is `b`; its `n` (KeyL) still matches by the letter.
  assert.equal(shortcut({ key: "b" }), false);
  assert.equal(shortcut({ key: "n", code: "KeyL" }), true);
});

test("the shortcut needs both Ctrl and Alt", () => {
  assert.equal(shortcut({ ctrlKey: false }), false);
  assert.equal(shortcut({ altKey: false }), false);
  assert.equal(shortcut({ ctrlKey: false, altKey: false }), false);
});

test("another key with Ctrl and Alt is not the shortcut", () => {
  assert.equal(shortcut({ key: "m", code: "KeyM" }), false);
  assert.equal(shortcut({ key: "Dead", code: "KeyM" }), false);
});

test("a KeyboardEvent without a code still matches by key", () => {
  // Older Safari and events built by hand carry no `code`.
  assert.equal(isNewSessionShortcut({ key: "n", code: null, ctrlKey: true, altKey: true }), true);
  assert.equal(isNewSessionShortcut({ key: "Dead", code: null, ctrlKey: true, altKey: true }), false);
  assert.equal(shortcut({ key: "n", code: "" }), true);
  assert.equal(shortcut({ key: "Dead", code: "" }), false);
});

// ---------------------------------------------------------------------------
// Panel toggles: sidebar, right panel, terminal
// ---------------------------------------------------------------------------

function panelEvent({ key = "b", code = "KeyB", ctrlKey = false, metaKey = false, altKey = false, shiftKey = false } = {}) {
  return {
    key, code, ctrlKey, metaKey, altKey, shiftKey,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
}

test("Cmd/Ctrl+B toggles the sidebar, the Shift variant the right panel", () => {
  assert.equal(isSidebarToggleShortcut(panelEvent({ metaKey: true }), true), true);
  assert.equal(isSidebarToggleShortcut(panelEvent({ key: "B", shiftKey: true }), true), false);
  assert.equal(isRightPanelToggleShortcut(panelEvent({ metaKey: true, shiftKey: true }), true), true);
  assert.equal(isRightPanelToggleShortcut(panelEvent({ metaKey: true }), true), false);
});

test("the modifier is the platform's primary one: Cmd on macOS, Ctrl elsewhere", () => {
  // macOS: the primary modifier is Cmd, and only Cmd.
  assert.equal(isSidebarToggleShortcut(panelEvent({ metaKey: true }), true), true);
  assert.equal(isSidebarToggleShortcut(panelEvent({ ctrlKey: true }), true), false);
  assert.equal(isRightPanelToggleShortcut(panelEvent({ metaKey: true, shiftKey: true }), true), true);
  assert.equal(isRightPanelToggleShortcut(panelEvent({ ctrlKey: true, shiftKey: true }), true), false);
  // Windows and Linux: the primary modifier is Ctrl, and only Ctrl.
  assert.equal(isSidebarToggleShortcut(panelEvent({ ctrlKey: true }), false), true);
  assert.equal(isSidebarToggleShortcut(panelEvent({ metaKey: true }), false), false);
  assert.equal(isRightPanelToggleShortcut(panelEvent({ ctrlKey: true, shiftKey: true }), false), true);
  assert.equal(isRightPanelToggleShortcut(panelEvent({ metaKey: true, shiftKey: true }), false), false);
});

test("Cmd/Ctrl+Alt+Enter is the right panel's full-width mode", () => {
  const enter = { key: "Enter", code: "Enter" };
  assert.equal(isRightPanelFullscreenShortcut({ ...enter, metaKey: true, altKey: true }, true), true);
  assert.equal(isRightPanelFullscreenShortcut({ ...enter, ctrlKey: true, altKey: true }, false), true);
  // A bare Enter belongs to the composer, and the other modifier is not the
  // platform's primary one.
  assert.equal(isRightPanelFullscreenShortcut({ ...enter, metaKey: true, altKey: true }, false), false);
  assert.equal(isRightPanelFullscreenShortcut({ ...enter, ctrlKey: true, altKey: true }, true), false);
  assert.equal(isRightPanelFullscreenShortcut({ ...enter, metaKey: true }, true), false);
  assert.equal(isRightPanelFullscreenShortcut({ ...enter, metaKey: true, altKey: true, shiftKey: true }, true), false);
});

test("the right panel's chord never carries Alt (AltGr types the user's text)", () => {
  assert.equal(isRightPanelToggleShortcut(panelEvent({ ctrlKey: true, altKey: true, shiftKey: true }), false), false);
  // The sidebar's chord never carries Alt either.
  assert.equal(isSidebarToggleShortcut(panelEvent({ ctrlKey: true, altKey: true }), false), false);
});

test("the sidebar and the right panel need a modifier", () => {
  assert.equal(isSidebarToggleShortcut(panelEvent(), true), false);
  assert.equal(isRightPanelToggleShortcut(panelEvent({ shiftKey: true }), true), false);
  assert.equal(isSidebarToggleShortcut(panelEvent({ ctrlKey: true, shiftKey: true }), true), false);
});

test("a dead key is matched by its physical key", () => {
  assert.equal(isSidebarToggleShortcut(panelEvent({ key: "Dead", metaKey: true }), true), true);
  assert.equal(isRightPanelToggleShortcut(panelEvent({ key: "Dead", metaKey: true, shiftKey: true }), true), true);
  // Another letter's dead key is not the shortcut.
  assert.equal(isSidebarToggleShortcut(panelEvent({ key: "Dead", code: "KeyM", metaKey: true }), true), false);
});

test("Ctrl+` toggles the terminal", () => {
  const backquote = { key: "`", code: "Backquote" };
  assert.equal(isTerminalToggleShortcut({ ...backquote, ctrlKey: true }), true);
  // The physical key decides: a layout whose backquote types a dead key.
  assert.equal(isTerminalToggleShortcut({ key: "Dead", code: "Backquote", ctrlKey: true }), true);
  // A KeyboardEvent without a code still matches by the character.
  assert.equal(isTerminalToggleShortcut({ key: "`", code: null, ctrlKey: true }), true);
  // Cmd+` is the system's window switcher, and Shift+` is another chord.
  assert.equal(isTerminalToggleShortcut({ ...backquote, metaKey: true }), false);
  assert.equal(isTerminalToggleShortcut({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true }), false);
  assert.equal(isTerminalToggleShortcut({ ...backquote, ctrlKey: true, altKey: true }), false);
  assert.equal(isTerminalToggleShortcut({ ...backquote }), false);
});

test("the hook routes each toggle to its own callback", () => {
  const target = emitter();
  globalThis.window = target;
  const calls = { sidebar: 0, right: 0, terminal: 0, fullscreen: 0 };
  const hook = renderHook((props) => useGlobalKeyboardShortcuts(props), {
    onToggleSidebar: () => { calls.sidebar += 1; },
    onToggleRightPanel: () => { calls.right += 1; },
    onToggleTerminal: () => { calls.terminal += 1; },
    onToggleRightPanelFullscreen: () => { calls.fullscreen += 1; },
    isMac: true,
  });

  target.emit("keydown", panelEvent({ metaKey: true }));
  assert.equal(calls.sidebar, 1);
  assert.equal(calls.right, 0);

  target.emit("keydown", panelEvent({ metaKey: true, shiftKey: true }));
  assert.equal(calls.right, 1);

  target.emit("keydown", panelEvent({ key: "`", code: "Backquote", ctrlKey: true }));
  assert.equal(calls.terminal, 1);

  target.emit("keydown", panelEvent({ key: "Enter", code: "Enter", metaKey: true, altKey: true }));
  assert.equal(calls.fullscreen, 1);

  // On a platform whose primary modifier is Ctrl, the same chords arrive with
  // Ctrl instead of Cmd.
  const other = emitter();
  globalThis.window = other;
  const others = { sidebar: 0, right: 0 };
  const otherHook = renderHook((props) => useGlobalKeyboardShortcuts(props), {
    onToggleSidebar: () => { others.sidebar += 1; },
    onToggleRightPanel: () => { others.right += 1; },
    isMac: false,
  });
  other.emit("keydown", panelEvent({ ctrlKey: true }));
  assert.equal(others.sidebar, 1);
  other.emit("keydown", panelEvent({ ctrlKey: true, shiftKey: true }));
  assert.equal(others.right, 1);
  // The macOS spelling is not a shortcut there.
  other.emit("keydown", panelEvent({ metaKey: true }));
  assert.equal(others.sidebar, 1);
  otherHook.unmount();

  hook.unmount();
  delete globalThis.window;
});

test("a toggle inside a modal does not move the panels behind it", () => {
  const target = emitter();
  globalThis.window = target;
  let sidebar = 0;
  const hook = renderHook((props) => useGlobalKeyboardShortcuts(props), {
    onToggleSidebar: () => { sidebar += 1; },
    isMac: true,
  });

  const modalTarget = { closest: (selector) => (selector === "[aria-modal='true']" ? {} : null) };
  const event = panelEvent({ metaKey: true });
  event.target = modalTarget;
  target.emit("keydown", event);
  assert.equal(sidebar, 0);

  // The same key outside a modal toggles the sidebar.
  const outside = panelEvent({ metaKey: true });
  outside.target = { closest: () => null };
  target.emit("keydown", outside);
  assert.equal(sidebar, 1);

  hook.unmount();
  delete globalThis.window;
});

// ---------------------------------------------------------------------------
// The right panel's tab strip: Alt+W closes the tab, Alt+Shift+[ / ] move
// ---------------------------------------------------------------------------

test("Alt+W closes the tab on show", () => {
  assert.equal(isCloseTabShortcut(panelEvent({ key: "w", code: "KeyW", altKey: true })), true);
  // macOS's Option+W types `∑`, not `w`: the physical key decides.
  assert.equal(isCloseTabShortcut(panelEvent({ key: "\u2211", code: "KeyW", altKey: true })), true);
  // Shift is the strip's navigation, and the other modifiers are not ours.
  assert.equal(isCloseTabShortcut(panelEvent({ key: "w", code: "KeyW", altKey: true, shiftKey: true })), false);
  assert.equal(isCloseTabShortcut(panelEvent({ key: "w", code: "KeyW", altKey: true, ctrlKey: true })), false);
  assert.equal(isCloseTabShortcut(panelEvent({ key: "w", code: "KeyW", altKey: true, metaKey: true })), false);
  assert.equal(isCloseTabShortcut(panelEvent({ key: "w", code: "KeyW" })), false);
  assert.equal(isCloseTabShortcut(panelEvent({ key: "q", code: "KeyQ", altKey: true })), false);
});

test("Alt+Shift+[ and Alt+Shift+] move along the strip", () => {
  // Shift turns the bracket into another character: the physical key decides.
  assert.equal(isPanelTabNavigationShortcut(panelEvent({ key: "{", code: "BracketLeft", altKey: true, shiftKey: true })), "previous");
  assert.equal(isPanelTabNavigationShortcut(panelEvent({ key: "}", code: "BracketRight", altKey: true, shiftKey: true })), "next");
  // A KeyboardEvent without a code still matches by the bracket.
  assert.equal(isPanelTabNavigationShortcut(panelEvent({ key: "[", code: null, altKey: true, shiftKey: true })), "previous");
  assert.equal(isPanelTabNavigationShortcut(panelEvent({ key: "]", code: null, altKey: true, shiftKey: true })), "next");
  // Alt alone, Shift alone and the other modifiers are not the chord.
  assert.equal(isPanelTabNavigationShortcut(panelEvent({ key: "[", code: "BracketLeft", altKey: true })), null);
  assert.equal(isPanelTabNavigationShortcut(panelEvent({ key: "[", code: "BracketLeft", shiftKey: true })), null);
  assert.equal(isPanelTabNavigationShortcut(panelEvent({ key: "[", code: "BracketLeft", altKey: true, shiftKey: true, ctrlKey: true })), null);
  assert.equal(isPanelTabNavigationShortcut(panelEvent({ key: "[", code: "BracketLeft", altKey: true, shiftKey: true, metaKey: true })), null);
  assert.equal(isPanelTabNavigationShortcut(panelEvent({ key: "x", code: "KeyX", altKey: true, shiftKey: true })), null);
});

test("the strip's chords are routed to their own callbacks", () => {
  const target = emitter();
  globalThis.window = target;
  const calls = { closed: 0, direction: [] };
  const hook = renderHook((props) => useGlobalKeyboardShortcuts(props), {
    onClosePanelTab: () => { calls.closed += 1; },
    onSelectAdjacentPanelTab: (direction) => { calls.direction.push(direction); },
  });

  target.emit("keydown", panelEvent({ key: "w", code: "KeyW", altKey: true }));
  assert.equal(calls.closed, 1);

  target.emit("keydown", panelEvent({ key: "{", code: "BracketLeft", altKey: true, shiftKey: true }));
  target.emit("keydown", panelEvent({ key: "}", code: "BracketRight", altKey: true, shiftKey: true }));
  assert.deepEqual(calls.direction, ["previous", "next"]);

  hook.unmount();
  delete globalThis.window;
});

test("the strip's chords never swallow the text of a field", () => {
  const target = emitter();
  globalThis.window = target;
  let closed = 0;
  const hook = renderHook((props) => useGlobalKeyboardShortcuts(props), {
    onClosePanelTab: () => { closed += 1; },
  });

  // The composer: `Alt+W` types `∑` there, and `Alt+Shift+[` types `{`.
  const composer = panelEvent({ key: "\u2211", code: "KeyW", altKey: true });
  composer.target = { tagName: "TEXTAREA", classList: { contains: () => false } };
  target.emit("keydown", composer);
  assert.equal(closed, 0);
  assert.equal(composer.defaultPrevented, false, "the character is the user's");

  // The terminal's own textarea is not a text field: xterm keeps the chord
  // from the shell, so the strip's chord is ours there.
  const terminal = panelEvent({ key: "\u2211", code: "KeyW", altKey: true });
  terminal.target = { tagName: "TEXTAREA", classList: { contains: (name) => name === "xterm-helper-textarea" } };
  target.emit("keydown", terminal);
  assert.equal(closed, 1);
  assert.equal(terminal.defaultPrevented, true);

  hook.unmount();
  delete globalThis.window;
});

test("the strip's chords do not move the tabs behind a modal", () => {
  const target = emitter();
  globalThis.window = target;
  let closed = 0;
  const hook = renderHook((props) => useGlobalKeyboardShortcuts(props), {
    onClosePanelTab: () => { closed += 1; },
  });

  const event = panelEvent({ key: "w", code: "KeyW", altKey: true });
  event.target = { closest: (selector) => (selector === "[aria-modal='true']" ? {} : null) };
  target.emit("keydown", event);
  assert.equal(closed, 0);

  hook.unmount();
  delete globalThis.window;
});

// ---------------------------------------------------------------------------
// The composer chord: Cmd/Ctrl+L
// ---------------------------------------------------------------------------

test("Cmd/Ctrl+L focuses the composer, the platform's primary modifier", () => {
  assert.equal(isFocusComposerShortcut(panelEvent({ key: "l", code: "KeyL", metaKey: true }), true), true);
  assert.equal(isFocusComposerShortcut(panelEvent({ key: "l", code: "KeyL", ctrlKey: true }), false), true);
  // The other platform's modifier is not the chord.
  assert.equal(isFocusComposerShortcut(panelEvent({ key: "l", code: "KeyL", ctrlKey: true }), true), false);
  assert.equal(isFocusComposerShortcut(panelEvent({ key: "l", code: "KeyL", metaKey: true }), false), false);
  // Caps Lock still delivers the letter.
  assert.equal(isFocusComposerShortcut(panelEvent({ key: "L", code: "KeyL", metaKey: true }), true), true);
  // A dead key (macOS's Option+letter) is matched by its physical key.
  assert.equal(isFocusComposerShortcut(panelEvent({ key: "Dead", code: "KeyL", metaKey: true }), true), true);
  // Another letter is not the chord.
  assert.equal(isFocusComposerShortcut(panelEvent({ key: "k", code: "KeyK", metaKey: true }), true), false);
});

test("the composer chord refuses Alt and Shift", () => {
  // Alt is the AltGr modifier (a character the user typed), Shift belongs to
  // the right panel.
  assert.equal(isFocusComposerShortcut(panelEvent({ key: "l", code: "KeyL", metaKey: true, altKey: true }), true), false);
  assert.equal(isFocusComposerShortcut(panelEvent({ key: "l", code: "KeyL", metaKey: true, shiftKey: true }), true), false);
  // Without a modifier it is a plain letter.
  assert.equal(isFocusComposerShortcut(panelEvent({ key: "l", code: "KeyL" }), true), false);
});

test("the composer chord focuses the composer and takes the key from the browser", () => {
  const target = emitter();
  globalThis.window = target;
  let focused = 0;
  const hook = renderHook((props) => useGlobalKeyboardShortcuts(props), {
    onFocusComposer: () => { focused += 1; },
    isMac: true,
  });

  const event = panelEvent({ key: "l", code: "KeyL", metaKey: true });
  target.emit("keydown", event);
  assert.equal(focused, 1);
  assert.equal(event.defaultPrevented, true, "the browser does not get its address bar");

  hook.unmount();
  delete globalThis.window;
});

test("the composer chord does nothing behind a modal", () => {
  const target = emitter();
  globalThis.window = target;
  let focused = 0;
  const hook = renderHook((props) => useGlobalKeyboardShortcuts(props), {
    onFocusComposer: () => { focused += 1; },
    isMac: true,
  });

  const event = panelEvent({ key: "l", code: "KeyL", metaKey: true });
  event.target = { closest: (selector) => (selector === "[aria-modal='true']" ? {} : null) };
  target.emit("keydown", event);
  assert.equal(focused, 0);
  assert.equal(event.defaultPrevented, true, "the key stays swallowed");

  hook.unmount();
  delete globalThis.window;
});
