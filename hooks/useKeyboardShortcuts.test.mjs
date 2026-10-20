import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// The hook is driven through the project's React stand-in (one component,
// effects after each render) and a stand-in for the window it listens on.
const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(shimPath);
const { handleGlobalEscape, registerAbortHandler, useGlobalKeyboardShortcuts } = await jiti.import(
  "./useKeyboardShortcuts.ts",
);

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
