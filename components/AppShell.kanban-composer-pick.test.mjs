import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";
import { renderHook, useEffect, useRef, useState } from "../hooks/__fixtures__/react-hook-shim.mjs";

// The composer's "track on board" pick is AppShell state, pinned to the board
// dir the composer shows and cleared when that dir moves to another project.
// This runs AppShell's actual derivation and effect, not a copy of the rule
// (the hook shim keeps state and re-renders like React), and pins the bug:
// a worktree cwd is its own project root until the sidebar's worktree listing
// arrives, so the composer's dir goes worktree path → project root a beat after
// it mounts. Comparing the raw strings dropped a card picked in that beat and
// the session started untracked, intermittently.
const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const composerStart = source.indexOf("  const composerBoardDir =");
const composerEnd = source.indexOf("  // Promotion supplies only cwd", composerStart);
assert.ok(composerStart >= 0 && composerEnd > composerStart, "AppShell's composer board dir is present");
const effectStart = source.indexOf("  // Moving the fresh composer to another project parks");
// The effect's closing `}, [composerBoardDir...]);` line: the anchor stays
// valid whichever spelling of the dependency list the effect carries, so this
// file can be run against the pre-fix effect to watch it fail for the bug.
const effectDeps = source.indexOf("\n  }, [composerBoardDir", effectStart);
const effectEnd = effectDeps < 0 ? -1 : source.indexOf("\n", effectDeps + 1);
assert.ok(effectStart >= 0 && effectEnd > effectStart, "AppShell's pending-pick reset effect is present");
const composerSlice = source.slice(composerStart, composerEnd);
const effectSlice = source.slice(effectStart, effectEnd);

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { contextForCwd } = await jiti.import("@/lib/new-session-context");
const { KANBAN_OFF_PENDING } = await jiti.import("@/lib/kanban-types");

const shell = vm.runInNewContext(stripTypeScriptTypes(`(props => {
  const { selectedSession, effectiveNewSessionCwd, sidebarNewSessionContext, newSessionMoveRef } = props;
  const [newSessionKanbanPending, setNewSessionKanbanPending] = useState(props.initialPending);
  ${composerSlice}
  ${effectSlice}
  return { composerBoardDir, pending: newSessionKanbanPending };
})`), { contextForCwd, useEffect, useRef, useState, KANBAN_OFF_PENDING });

const project = { key: "repo-key", root: "/repo" };
const checkout = { path: "/repo-worktree", branch: "feature", isMain: false };
/** The sidebar's context once its worktree listing for `/repo-worktree` has arrived. */
const hydrated = {
  cwd: "/repo-worktree",
  project,
  worktrees: [{ path: "/repo", branch: "main", isMain: true }, checkout],
  currentWorktreePath: "/repo-worktree",
  projects: [project],
};
/** The same composer at mount: `contextForCwd` cannot resolve the checkout yet. */
const unresolved = { ...hydrated, cwd: "/repo", worktrees: null, currentWorktreePath: null };

/** The shim's state lives in another realm: compare values, not prototypes. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const attach = (projectDir, cardId = "card-1") => ({ kind: "attach", projectDir, cardId, cardTitle: "A card" });
const newCard = (projectDir) => ({ kind: "new-card", projectDir, laneId: "lane-todo" });

const render = (props) => renderHook(shell, {
  selectedSession: null,
  effectiveNewSessionCwd: "/repo-worktree",
  sidebarNewSessionContext: unresolved,
  newSessionMoveRef: { current: null },
  ...props,
});

test("a card picked before the worktree resolves is re-pinned to the project root, not dropped", () => {
  const hook = render({ initialPending: attach("/repo-worktree") });
  assert.equal(hook.result.composerBoardDir, "/repo-worktree", "unresolved checkout is its own dir at mount");
  assert.deepEqual(plain(hook.result.pending), plain(attach("/repo-worktree")), "the pick survives its own composer");

  hook.rerender({
    selectedSession: null,
    effectiveNewSessionCwd: "/repo-worktree",
    sidebarNewSessionContext: hydrated,
    newSessionMoveRef: { current: null },
    initialPending: attach("/repo-worktree"),
  });
  assert.equal(hook.result.composerBoardDir, "/repo");
  assert.deepEqual(plain(hook.result.pending), plain(attach("/repo")), "the same board, re-pinned to the resolved dir");
  hook.unmount();
});

test("a new-card pick is re-pinned the same way", () => {
  const hook = render({ initialPending: newCard("/repo-worktree") });
  hook.rerender({
    selectedSession: null,
    effectiveNewSessionCwd: "/repo-worktree",
    sidebarNewSessionContext: hydrated,
    newSessionMoveRef: { current: null },
    initialPending: newCard("/repo-worktree"),
  });
  assert.deepEqual(plain(hook.result.pending), plain(newCard("/repo")));
  hook.unmount();
});

test("moving the composer to another worktree of the project keeps the pick", () => {
  const other = { path: "/repo-second", branch: "second", isMain: false };
  const withSecond = { ...hydrated, worktrees: [...hydrated.worktrees, other] };
  const hook = render({ initialPending: attach("/repo"), sidebarNewSessionContext: withSecond });
  hook.rerender({
    selectedSession: null,
    effectiveNewSessionCwd: "/repo-second",
    sidebarNewSessionContext: withSecond,
    newSessionMoveRef: { current: null },
    initialPending: attach("/repo"),
  });
  assert.equal(hook.result.composerBoardDir, "/repo");
  assert.deepEqual(plain(hook.result.pending), plain(attach("/repo")));
  hook.unmount();
});

test("a composer moved to another project drops the pick", () => {
  const otherProject = { key: "other-key", root: "/other" };
  const withOther = { ...hydrated, projects: [project, otherProject] };
  const hook = render({ initialPending: attach("/repo"), sidebarNewSessionContext: withOther });
  hook.rerender({
    selectedSession: null,
    effectiveNewSessionCwd: "/other",
    sidebarNewSessionContext: withOther,
    newSessionMoveRef: { current: null },
    initialPending: attach("/repo"),
  });
  assert.equal(hook.result.composerBoardDir, "/other");
  assert.deepEqual(plain(hook.result.pending), plain(KANBAN_OFF_PENDING), "another board: the choice is parked");
  hook.unmount();
});

test("a fresh folder that is not a known project drops the pick", () => {
  const hook = render({ initialPending: attach("/repo") });
  hook.rerender({
    selectedSession: null,
    effectiveNewSessionCwd: "/tmp/today",
    sidebarNewSessionContext: { ...hydrated, projects: [project] },
    newSessionMoveRef: { current: null },
    initialPending: attach("/repo"),
  });
  assert.equal(hook.result.composerBoardDir, "/tmp/today");
  assert.deepEqual(plain(hook.result.pending), plain(KANBAN_OFF_PENDING));
  hook.unmount();
});

test("a selected session (no composer) clears the pick, and 'off' is left alone", () => {
  const hook = render({ initialPending: attach("/repo") });
  hook.rerender({
    selectedSession: { id: "s1", cwd: "/repo-worktree" },
    effectiveNewSessionCwd: null,
    sidebarNewSessionContext: hydrated,
    newSessionMoveRef: { current: null },
    initialPending: attach("/repo"),
  });
  assert.equal(hook.result.composerBoardDir, null);
  assert.deepEqual(plain(hook.result.pending), plain(KANBAN_OFF_PENDING));
  hook.unmount();

  const off = render({ initialPending: KANBAN_OFF_PENDING });
  off.rerender({
    selectedSession: null,
    effectiveNewSessionCwd: "/repo-worktree",
    sidebarNewSessionContext: hydrated,
    newSessionMoveRef: { current: null },
    initialPending: KANBAN_OFF_PENDING,
  });
  assert.deepEqual(plain(off.result.pending), plain(KANBAN_OFF_PENDING), "an off choice never turns into a pick");
  off.unmount();
});
