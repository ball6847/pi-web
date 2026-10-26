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

for (const mobile of [false, true]) {
  for (const cwd of ["/board", "/other"]) {
    test(`child card opens only the read-only panel (${mobile ? "mobile" : "desktop"}, chat in ${cwd})`, () => {
      const selected = { id: "selected", cwd };
      const context = vm.createContext({
        sessionsForKanbanBoard,
        sessionsWithSelection: [selected, parent, child],
        boardProjectDir: "/board",
        selectedSession: selected,
        activeCwd: cwd,
        activeProjectKeyRef: { current: cwd },
        centerView: "board",
        agentTabs: [],
        activeFileTabId: "file:/notes.md",
        rightPanelOpen: false,
        sidebarOpen: true,
        isMobile: mobile,
        useMemo: (fn) => fn(),
        useCallback: (fn) => fn,
        handleSelectSession: () => assert.fail("viewing a child must not select a chat"),
        changeFileWorkspace: () => assert.fail("a workspace switch would drop the new viewer"),
        fetch: () => assert.fail("opening a tab must not start/reopen/prompt an agent"),
      });
      for (const key of ["agentTabs", "activeFileTabId", "rightPanelOpen", "sidebarOpen"]) {
        context[`set${key[0].toUpperCase()}${key.slice(1)}`] = (value) => {
          context[key] = typeof value === "function" ? value(context[key]) : value;
        };
      }
      context.boardSessions = evaluate("boardSessions", context);
      assert.ok(context.boardSessions.includes(child), "the shell passes children to the board");
      context.handleOpenSubagentTab = evaluate("handleOpenSubagentTab", context);
      const open = evaluate("handleKanbanOpenSession", context);
      open(child.id, "Old title");
      open(child.id, "Old title");
      assert.equal(context.agentTabs.length, 1, "reopening the viewer does not duplicate its tab");
      assert.equal(context.agentTabs[0].label, "Child");
      assert.equal(context.activeFileTabId, `agent:${child.id}`);
      assert.equal(context.rightPanelOpen, true);
      assert.equal(context.sidebarOpen, !mobile);
      assert.equal(context.selectedSession, selected);
      assert.equal(context.activeCwd, cwd);
      assert.equal(context.activeProjectKeyRef.current, cwd);
      assert.equal(context.centerView, "board");
      assert.equal(evaluate("activeAgentTab", context)?.sessionId, child.id, "the viewer still resolves on the next render, even for another project's board");
    });
  }
}

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
