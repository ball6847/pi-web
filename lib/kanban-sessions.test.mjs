import assert from "node:assert/strict";
import test from "node:test";
import { sessionsForKanbanBoard, kanbanSessionOptions } from "./kanban-sessions.ts";

const parent = { id: "parent", cwd: "/project", name: "Parent" };
const fork = { id: "fork", cwd: "/worktree", projectRoot: "/project", firstMessage: "Fork", relation: { kind: "fork" } };
const child = { id: "child", cwd: "/worktree", projectRoot: "/project", name: "Child", relation: { kind: "subagent" } };
const sibling = { ...child, id: "sibling", name: "Sibling" };
const foreign = { ...child, id: "foreign", projectRoot: "/other" };
const sessions = [parent, fork, child, sibling, foreign];
const existing = { sessionId: child.id, sessionTitle: "Snapshot", title: "Task" };
const ids = (rows) => rows.map((row) => row.id);

test("board lookup includes children and worktrees, never other projects or a null board", () => {
  const projected = sessionsForKanbanBoard(sessions, "/project");
  assert.deepEqual(ids(projected), ["parent", "fork", "child", "sibling"]);
  assert.equal(projected[2], child, "keep relation metadata and row identity for opening");
  assert.deepEqual(sessionsForKanbanBoard(sessions, null), []);
  assert.deepEqual(sessionsForKanbanBoard(sessions, "/worktree"), [], "a resolved projectRoot takes precedence over cwd");
});

test("manual links offer top-level sessions (including forks), without capping or changing title/running rules", () => {
  const boardSessions = sessionsForKanbanBoard(sessions, "/project");
  assert.deepEqual(kanbanSessionOptions(boardSessions, new Set(["fork", "child"])), [
    { id: "parent", title: "Parent", running: false },
    { id: "fork", title: "Fork", running: true },
  ]);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, cwd: "/project" }));
  assert.equal(kanbanSessionOptions(many, new Set()).length, 30);
  assert.equal(kanbanSessionOptions(many, new Set())[29].title, "s29");
  assert.deepEqual(kanbanSessionOptions([child, sibling], new Set()), []);
});

test("editing includes only the existing child, without duplicating a top-level link", () => {
  const boardSessions = sessionsForKanbanBoard(sessions, "/project");
  const choices = kanbanSessionOptions(boardSessions, new Set(["child"]), existing);
  assert.deepEqual(ids(choices), ["parent", "fork", "child"]);
  assert.deepEqual(choices[2], { id: "child", title: "Child", running: true });
  assert.deepEqual(ids(kanbanSessionOptions(boardSessions, new Set(), { ...existing, sessionId: parent.id })), ["parent", "fork"]);
});

test("an existing link survives catalogue lag without enabling missing-session opening", () => {
  assert.deepEqual(kanbanSessionOptions([], new Set(["child"]), existing), [
    { id: "child", title: "Snapshot", running: true },
  ]);
  assert.equal(kanbanSessionOptions([], new Set(), { ...existing, sessionTitle: null })[0].title, "Task");
  assert.deepEqual(sessionsForKanbanBoard([], "/project"), [], "fallback belongs to the edit picker only");
});
