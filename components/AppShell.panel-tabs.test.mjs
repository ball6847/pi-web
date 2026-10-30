import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const terminalSource = await readFile(new URL("./TerminalPanel.tsx", import.meta.url), "utf8");

function callbackBody(name, nextName) {
  const start = source.indexOf(`const ${name} = useCallback`);
  const end = source.indexOf(`\n  const ${nextName}`, start);
  assert.notEqual(start, -1, `${name} callback not found`);
  assert.notEqual(end, -1, `${nextName} callback not found after ${name}`);
  return source.slice(start, end);
}

/** The strip's own handlers, with the state they read as the test's own. */
function stripHandlers({ activeTabId = null, panelOpen = true, tabs = [] } = {}) {
  const closed = [];
  const selected = [];
  const context = vm.createContext({
    useCallback: (callback) => callback,
    activeFileTabId: activeTabId,
    rightPanelOpen: panelOpen,
    panelTabs: tabs,
    handleCloseFileTab: (id) => { closed.push(id); },
    setActiveFileTabId: (id) => { selected.push(id); context.activeFileTabId = id; },
    setRightPanelOpen: (open) => { context.panelOpened = open; },
  });
  vm.runInContext(stripTypeScriptTypes(`${[
    callbackBody("handleCloseActivePanelTab", "handleSelectAdjacentPanelTab"),
    callbackBody("handleSelectAdjacentPanelTab", "handleViewFullHistory"),
  ].join("\n")}
    globalThis.strip = { handleCloseActivePanelTab, handleSelectAdjacentPanelTab };
  `), context);
  return { closed, selected, context };
}

test("the tab on show closes, but only while the panel is open", () => {
  const open = stripHandlers({ activeTabId: "file:/repo/notes.md", panelOpen: true });
  open.context.strip.handleCloseActivePanelTab();
  assert.deepEqual(open.closed, ["file:/repo/notes.md"]);

  // The panel can be closed with its tabs still open: a tab the user cannot
  // see is not one to close.
  const hidden = stripHandlers({ activeTabId: "file:/repo/notes.md", panelOpen: false });
  hidden.context.strip.handleCloseActivePanelTab();
  assert.deepEqual(hidden.closed, []);

  // No tab on show: nothing to close.
  const none = stripHandlers({ panelOpen: true });
  none.context.strip.handleCloseActivePanelTab();
  assert.deepEqual(none.closed, []);
});

test("the navigation moves along the strip and shows the tab it lands on", () => {
  const tabs = [
    { id: "file:/repo/notes.md" },
    { id: "terminal:1" },
    { id: "agent:child" },
    { id: "card:42" },
  ];
  const strip = stripHandlers({ activeTabId: "terminal:1", panelOpen: true, tabs });

  // Each move is relative to the tab on show, as the state follows it.
  strip.context.strip.handleSelectAdjacentPanelTab("next");
  assert.deepEqual(strip.selected, ["agent:child"]);
  strip.context.strip.handleSelectAdjacentPanelTab("previous");
  assert.deepEqual(strip.selected, ["agent:child", "terminal:1"]);
  strip.context.strip.handleSelectAdjacentPanelTab("previous");
  assert.equal(strip.selected.at(-1), "file:/repo/notes.md");

  // The strip wraps around at both ends.
  strip.context.strip.handleSelectAdjacentPanelTab("previous");
  assert.equal(strip.selected.at(-1), "card:42");
  strip.context.strip.handleSelectAdjacentPanelTab("next");
  assert.equal(strip.selected.at(-1), "file:/repo/notes.md");
  assert.equal(strip.context.panelOpened, true, "the tab it lands on is shown");

  // No tabs: the navigation does nothing.
  const empty = stripHandlers({ panelOpen: true, tabs: [] });
  empty.context.strip.handleSelectAdjacentPanelTab("next");
  assert.deepEqual(empty.selected, []);
});

test("a terminal tab closes with the process that is gone", () => {
  // The shell exits: the panel's stream says so, and the tab goes with it.
  assert.match(terminalSource, /setStatus\("exited"\);\s*\n\s*\/\/ The shell is gone[\s\S]*?callbacksRef\.current\.onProcessExit\?\.\(\);/);
  // The panel's tab close is what the exit leads to.
  assert.match(source, /onProcessExit=\{\(\) => handleCloseFileTab\(tab\.id\)\}/);
});
