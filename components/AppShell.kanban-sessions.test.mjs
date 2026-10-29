import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { sessionsForKanbanBoard } from "../lib/kanban-sessions.ts";

const text = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("AppShell.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  ts.forEachChild(node, visit);
}
visit(source);
function evaluate(name, context) {
  const declaration = declarations.get(name);
  assert.ok(declaration?.initializer, `${name} declaration exists`);
  const code = ts.transpileModule(`(${declaration.initializer.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText;
  return vm.runInContext(code, context);
}

const parent = { id: "parent", cwd: "/board", name: "Parent" };
const child = { id: "child", cwd: "/board-worktree", projectRoot: "/board", name: "Child", relation: { kind: "subagent" } };

test("a child's card opens the child's chat, never the read-only panel", () => {
  for (const mobile of [false, true]) {
    for (const cwd of ["/board", "/other"]) {
      const selected = { id: "selected", cwd };
      const picked = [];
      const context = vm.createContext({
        sessionsForKanbanBoard,
        sessionsWithSelection: [selected, parent, child],
        boardProjectDir: "/board",
        selectedSession: selected,
        useMemo: (fn) => fn(),
        useCallback: (fn) => fn,
        handleSelectSession: (session) => picked.push(session.id),
        handleOpenSubagentTab: () => assert.fail("a session link must not open the read-only panel"),
        isMobile: mobile,
      });
      context.boardSessions = evaluate("boardSessions", context);
      assert.ok(context.boardSessions.includes(child), "the shell passes children to the board");
      evaluate("handleKanbanOpenSession", context)(child.id, "Old title");
      assert.deepEqual(picked, [child.id], "the title argument is unused; the card's session wins");
    }
  }
});

test("a top-level card uses ordinary selection; missing and foreign ids do nothing", () => {
  const selected = [];
  const context = vm.createContext({
    boardSessions: [parent, child],
    useCallback: (fn) => fn,
    handleSelectSession: (session) => selected.push(session),
    handleOpenSubagentTab: () => assert.fail("not a child card"),
  });
  const open = evaluate("handleKanbanOpenSession", context);
  open(parent.id, "Parent");
  open("missing", "Missing");
  open("foreign", "Other project");
  assert.deepEqual(selected, [parent]);
});

test("the board and viewer keep their actual shell bindings", async () => {
  assert.match(text, /<KanbanBoard[\s\S]*?sessions=\{boardSessions\}[\s\S]*?onOpenSession=\{handleKanbanOpenSession\}/);
  assert.match(text, /<SubagentViewer[\s\S]*?sessionId=\{activeAgentTab.sessionId\}/);
  const viewer = await readFile(new URL("./SubagentViewer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(viewer, /["'`]\/api\/agent\//, "the viewer has no runtime route");
  assert.match(viewer, /fetch\(`\/api\/sessions\//);
  assert.match(viewer, /fetch\(contextUrl\(sessionId\)/);
});

test("the read-only viewer hands over to the parent's chat with the child's row focused", () => {
  const log = [];
  const selected = { id: "selected", cwd: "/other" };
  const context = vm.createContext({
    sessionsWithSelection: [selected, parent, child],
    selectedSession: selected,
    useCallback: (fn) => fn,
    handleSelectSession: (session) => log.push(["select", session.id]),
    setActiveTopPanel: (panel) => log.push(["panel", panel]),
    setAgentPanelFocus: (value) => log.push(["focus", value.sessionId]),
  });
  evaluate("handleOpenSubagentParentChat", context)(parent.id, child.id);
  // The panel opens after the selection: handleSelectSession() closes it when
  // the project changes, so the reverse order would lose the panel.
  assert.deepEqual(log.map(([kind]) => kind), ["select", "focus", "panel"]);
  assert.deepEqual(log[0], ["select", parent.id]);
  assert.deepEqual(log[1], ["focus", child.id]);
  assert.deepEqual(log[2], ["panel", "agents"]);
});

test("a hand-over selects the already-open parent too (it leaves the board for the chat) and skips a gone parent", () => {
  const log = [];
  const context = vm.createContext({
    sessionsWithSelection: [parent, child],
    selectedSession: parent,
    useCallback: (fn) => fn,
    handleSelectSession: (session) => log.push(["select", session.id]),
    setActiveTopPanel: (panel) => log.push(["panel", panel]),
    setAgentPanelFocus: (value) => log.push(["focus", value.sessionId]),
  });
  evaluate("handleOpenSubagentParentChat", context)(parent.id, child.id);
  // handleSelectSession() does not remount an already-open chat (it skips that
  // work), but it is what closes a `?board=` view, so the hand-over calls it.
  assert.deepEqual(log.map(([kind]) => kind), ["select", "focus", "panel"]);
  assert.deepEqual(log[0], ["select", parent.id]);
  log.length = 0;
  evaluate("handleOpenSubagentParentChat", context)("gone", child.id);
  assert.deepEqual(log, [], "a parent that left the catalogue opens nothing");
});
