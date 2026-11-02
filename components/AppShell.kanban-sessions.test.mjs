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

test("the board and the session tab keep their actual shell bindings", async () => {
  assert.match(text, /<KanbanBoard[\s\S]*?sessions=\{boardSessions\}[\s\S]*?onOpenSession=\{handleKanbanOpenSession\}/);
  assert.match(text, /<SessionChatPanel[\s\S]*?sessionId=\{activeAgentTab.sessionId\}/);
  // The tab is a real chat scoped to that session (SessionChatPanel renders
  // ChatWindow in its panel mode), not a second copy of the page's chat.
  const panel = await readFile(new URL("./SessionChatPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /<ChatWindow[^>]*\bpanel\b/);
  assert.match(panel, /newSessionCwd=\{null\}/);
});


