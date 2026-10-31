import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function callbackBody(name, nextName) {
  const start = source.indexOf(`const ${name} = useCallback`);
  const end = source.indexOf(`\n  const ${nextName}`, start);
  assert.notEqual(start, -1, `${name} callback not found`);
  assert.notEqual(end, -1, `${nextName} callback not found after ${name}`);
  return source.slice(start, end);
}

test("a session pick puts the caret in the composer", () => {
  // Every pick of a session — the sidebar, the palette, the agent switcher,
  // the board's session link — goes through this one callback.
  const body = callbackBody("handleSelectSession", "handleNewSession");
  assert.match(
    body,
    /focusComposerWhenReady\(\)/,
    "the chat is the screen the session was picked for: the composer takes the caret",
  );
});

test("a new session puts the caret in the fresh composer", () => {
  const body = callbackBody("handleNewSession", "hydrateSelectedSession");
  assert.match(
    body,
    /if \(!newSessionBarFocusRef\.current\) focusComposerWhenReady\(\)/,
    "the fresh composer takes the caret, unless the bar's move keeps its own control",
  );
});

test("leaving the board for the chat puts the caret in the composer", () => {
  assert.match(
    source,
    /const handleShowChatView = useCallback\(\(\) => \{\s*setCenterView\("chat"\);\s*focusComposerWhenReady\(\);/,
    "the board's chat toggle brings the composer back",
  );
});

test("the composer chord is wired to the caret request", () => {
  assert.match(source, /onFocusComposer: handleFocusComposer/, "the chord focuses the composer");
  assert.match(
    source,
    /const handleFocusComposer = useCallback\(\(\) => \{\s*if \(centerView !== "chat"\) setCenterView\("chat"\);\s*focusComposerForced\(\);/,
    "the chord brings the chat back when the board covers it, and takes the caret wherever it is",
  );
});
