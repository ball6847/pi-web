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
  isNewSessionShortcut,
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
  assert.equal(isSidebarToggleShortcut(panelEvent({ metaKey: true })), true);
  assert.equal(isSidebarToggleShortcut(panelEvent({ ctrlKey: true })), true);
  assert.equal(isSidebarToggleShortcut(panelEvent({ key: "B", shiftKey: true })), false);
  assert.equal(isRightPanelToggleShortcut(panelEvent({ metaKey: true, shiftKey: true })), true);
  assert.equal(isRightPanelToggleShortcut(panelEvent({ ctrlKey: true, shiftKey: true })), true);
  assert.equal(isRightPanelToggleShortcut(panelEvent({ ctrlKey: true })), false);
});

test("the right panel's chord never carries Alt (AltGr types the user's text)", () => {
  assert.equal(isRightPanelToggleShortcut(panelEvent({ ctrlKey: true, altKey: true, shiftKey: true })), false);
  // The sidebar's chord never carries Alt either.
  assert.equal(isSidebarToggleShortcut(panelEvent({ ctrlKey: true, altKey: true })), false);
});

test("the sidebar and the right panel need a modifier", () => {
  assert.equal(isSidebarToggleShortcut(panelEvent()), false);
  assert.equal(isRightPanelToggleShortcut(panelEvent({ shiftKey: true })), false);
  assert.equal(isSidebarToggleShortcut(panelEvent({ ctrlKey: true, shiftKey: true })), false);
});

test("a dead key is matched by its physical key", () => {
  assert.equal(isSidebarToggleShortcut(panelEvent({ key: "Dead", metaKey: true })), true);
  assert.equal(isRightPanelToggleShortcut(panelEvent({ key: "Dead", metaKey: true, shiftKey: true })), true);
  // Another letter's dead key is not the shortcut.
  assert.equal(isSidebarToggleShortcut(panelEvent({ key: "Dead", code: "KeyM", metaKey: true })), false);
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
  const calls = { sidebar: 0, right: 0, terminal: 0 };
  const hook = renderHook((props) => useGlobalKeyboardShortcuts(props), {
    onToggleSidebar: () => { calls.sidebar += 1; },
    onToggleRightPanel: () => { calls.right += 1; },
    onToggleTerminal: () => { calls.terminal += 1; },
  });

  target.emit("keydown", panelEvent({ metaKey: true }));
  assert.equal(calls.sidebar, 1);
  assert.equal(calls.right, 0);

  target.emit("keydown", panelEvent({ metaKey: true, shiftKey: true }));
  assert.equal(calls.right, 1);

  target.emit("keydown", panelEvent({ key: "`", code: "Backquote", ctrlKey: true }));
  assert.equal(calls.terminal, 1);

  hook.unmount();
  delete globalThis.window;
});

test("a toggle inside a modal does not move the panels behind it", () => {
  const target = emitter();
  globalThis.window = target;
  let sidebar = 0;
  const hook = renderHook((props) => useGlobalKeyboardShortcuts(props), {
    onToggleSidebar: () => { sidebar += 1; },
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
