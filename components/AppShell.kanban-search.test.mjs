import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";
import { renderHook, useEffect, useRef, useState } from "../hooks/__fixtures__/react-hook-shim.mjs";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const composerBoardDir =");
const end = source.indexOf("  const boardTabAvailable =", start);
assert.ok(start >= 0 && end > start, "AppShell's board context and search effects are present");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { contextForCwd } = await jiti.import("@/lib/new-session-context");
const { kanbanSearchForProject } = await jiti.import("@/lib/kanban-search");
// Execute AppShell's actual context derivation and effects, not a duplicate of
// the intended identity rule. The hook shim retains refs/state across renders.
const renderContext = vm.runInNewContext(stripTypeScriptTypes(`(props => {
  const { selectedSession, effectiveNewSessionCwd, sidebarNewSessionContext, newSessionMoveRef } = props;
  const boardProjectDir = "/repo";
  const centerView = "chat";
  const [boardSearch, setBoardSearch] = useState({ projectDir: "/repo", query: "auth" });
  ${source.slice(start, end)}
  return { kanbanContextDir, boardSearch };
})`), { contextForCwd, kanbanSearchForProject, useEffect, useRef, useState, useKanbanBoard: () => null });

const project = { key: "repo-key", root: "/repo" };
const context = {
  cwd: "/repo-worktree", project,
  worktrees: [{ path: "/repo", isMain: true, branch: "main" }, { path: "/repo-worktree", isMain: false, branch: "feature" }],
  currentWorktreePath: "/repo-worktree", projects: [project],
};

for (const [label, sidebarContext, move] of [
  ["reported checkout", context, null],
  ["sidebar still reports the main checkout", { ...context, cwd: "/repo", currentWorktreePath: "/repo" }, null],
  ["new checkout before its sidebar report", { ...context, cwd: "/repo", worktrees: null }, { cwd: "/repo-worktree", project, branch: "feature" }],
]) {
  test(`query survives composer root → transient worktree → hydrated root: ${label}`, () => {
    const props = { selectedSession: null, effectiveNewSessionCwd: "/repo-worktree", sidebarNewSessionContext: sidebarContext, newSessionMoveRef: { current: move } };
    const hook = renderHook(renderContext, props);
    assert.equal(hook.result.kanbanContextDir, "/repo");
    assert.equal(hook.result.boardSearch.query, "auth");
    // useAgentSession's promoteNewSession payload has a cwd but no projectRoot.
    const transient = { id: "new-session", cwd: "/repo-worktree", transient: true };
    hook.rerender({ ...props, selectedSession: transient, effectiveNewSessionCwd: null });
    assert.equal(hook.result.kanbanContextDir, "/repo", "promotion must use the known project, not the raw worktree path");
    assert.equal(hook.result.boardSearch.query, "auth");
    hook.rerender({ ...props, selectedSession: { ...transient, projectRoot: "/repo", projectKey: "repo-key", transient: false }, effectiveNewSessionCwd: null });
    assert.equal(hook.result.kanbanContextDir, "/repo");
    assert.equal(hook.result.boardSearch.query, "auth");
    hook.unmount();
  });
}

for (const session of [{ id: "other", cwd: "/other", projectRoot: "/other" }, { id: "other-transient", cwd: "/other", transient: true }]) {
  test(`a genuine project switch clears, even with the previous sidebar context: ${session.id}`, () => {
    const props = { selectedSession: null, effectiveNewSessionCwd: "/repo-worktree", sidebarNewSessionContext: context, newSessionMoveRef: { current: null } };
    const hook = renderHook(renderContext, props);
    hook.rerender({ ...props, selectedSession: session, effectiveNewSessionCwd: null });
    assert.equal(hook.result.kanbanContextDir, "/other");
    assert.equal(hook.result.boardSearch.query, "");
    hook.rerender(props);
    assert.equal(hook.result.boardSearch.query, "", "returning to the old project does not restore a saved search");
    hook.unmount();
  });
}
