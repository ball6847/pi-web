import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("the global Esc shortcut stops a run only while the chat is the screen on show", () => {
  const start = source.indexOf("useGlobalKeyboardShortcuts({");
  assert.notEqual(start, -1, "AppShell wires the global shortcuts");
  const call = source.slice(start, source.indexOf("});", start));

  assert.match(
    call,
    /escapeStopsAgent:\s*centerView === "chat"/,
    "the board screen leaves Esc to itself instead of stopping the covered chat's run",
  );
});

test("the board view covers the chat without unmounting it", () => {
  // The gate exists because of exactly this: `centerView === "board"` hides the
  // chat layer (`display: none`) while ChatWindow keeps its abort handler
  // registered.
  assert.match(
    source,
    /display:\s*centerView === "board" \? "none" : "block"/,
    "the chat layer stays mounted under the board",
  );
});
