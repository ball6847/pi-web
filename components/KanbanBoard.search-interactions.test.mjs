import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { renderHook } from "../hooks/__fixtures__/react-hook-shim.mjs";
import { dragOptions, laneBegins, setMobile } from "./__fixtures__/kanban-search-interactions.mjs";

const path = (url) => fileURLToPath(new URL(url, import.meta.url)).replaceAll("\\", "/");
const fixture = path("./__fixtures__/kanban-search-interactions.mjs");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true, alias: {
  "react/jsx-runtime": path("../node_modules/react/jsx-runtime.js"),
  react: path("../hooks/__fixtures__/react-hook-shim.mjs"),
  [path("../hooks/useI18n")]: path("./__fixtures__/kanban-i18n.mjs"),
  [path("../hooks/useIsMobile")]: fixture,
  [path("../hooks/useKanbanCardDrag")]: fixture,
  [path("../hooks/useKanbanLaneDrag")]: fixture,
  [path("./SidebarMenu")]: fixture,
} });
const { KanbanBoardView } = await jiti.import("./KanbanBoard.tsx");
const noop = () => {};
globalThis.window = { innerWidth: 1200, innerHeight: 800, addEventListener: noop, removeEventListener: noop, setTimeout: () => 1 };
const card = (id, laneId, title) => ({ id, laneId, title, description: "", sessionId: `s-${id}`, sessionTitle: "secret", createdAt: 0, updatedAt: 0 });
const board = { projectDir: "/p", lanes: [{ id: "a", name: "Backlog", fixed: true }, { id: "b", name: "Plan" }, { id: "c", name: "Done" }], cards: [card("1", "b", "auth"), card("2", "b", "other"), card("3", "c", "third")] };
const props = { board, projectDir: "/p", projectName: "P", sessions: [], runningSessionIds: new Set(), awaitingInputSessionIds: new Set(), unreadSessionIds: new Set(), query: "auth", onQueryChange: noop, onOpenSession: noop, onStartSession: noop, notice: null };
function nodes(node) {
  if (!node || typeof node !== "object") return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}
const component = (hook, name) => nodes(hook.result).find(node => node.type?.name === name);

test("filtering disables card drag/menu reorder but preserves lane drag and Move to lane", () => {
  setMobile(false);
  const hook = renderHook(KanbanBoardView, props);
  assert.equal(dragOptions.card.enabled, false);
  assert.equal(dragOptions.card.cards, board.cards);
  assert.notEqual(dragOptions.lane.enabled, false);
  assert.deepEqual(dragOptions.lane.laneIds, ["a", "b", "c"]);
  const before = laneBegins.length;
  component(hook, "LaneColumn").props.onLaneHeaderPointerDown({}, board.lanes[1]);
  assert.deepEqual(laneBegins.slice(before), ["b"]);
  nodes(hook.result).find(node => node.props?.className === "kanban-board-configure").props.onClick();
  hook.flush();
  assert.equal(component(hook, "LaneConfig").props.board, board, "configuration sees hidden cards too");
  assert.equal(component(hook, "LaneConfig").props.filtering, undefined, "lane configuration has no card-filter restriction");
  component(hook, "LaneConfig").props.onClose();
  hook.flush();
  component(hook, "LaneColumn").props.onOpenMenu({}, board.cards[0]);
  hook.flush();
  const entries = component(hook, "CardMenu").props.entries;
  for (const id of ["move-up", "move-down"]) {
    const entry = entries.find(e => e.id === id);
    assert.equal(entry.disabled, true);
    assert.equal(entry.disabledTitle, "kanban.searchReorderDisabled");
  }
  assert.equal(Boolean(entries.find(e => e.id === "move-c").disabled), false);
  hook.rerender({ ...props, query: "" });
  assert.equal(dragOptions.card.enabled, true);
  assert.notEqual(dragOptions.lane.enabled, false);
  assert.deepEqual(dragOptions.lane.laneIds, ["a", "b", "c"]);
  assert.equal(component(hook, "CardMenu").props.entries.find(e => e.id === "move-down").disabled, false);
  hook.unmount();
});

test("the board-level no-results clear returns focus to the search field", () => {
  setMobile(false);
  let query = "missing";
  let focused = false;
  const hook = renderHook(KanbanBoardView, { ...props, query, onQueryChange: value => { query = value; } });
  component(hook, "KanbanSearchField").props.inputRef.current = { focus() { focused = true; } };
  const empty = nodes(hook.result).find(node => node.props?.["data-kanban-no-results"]);
  nodes(empty).find(node => node.type === "button").props.onClick();
  assert.equal(query, "");
  assert.equal(focused, true);
  hook.unmount();
});

test("filter changes keep an open edit/add and the mobile lane; long-press and matching-lane navigation work", () => {
  setMobile(true);
  const hook = renderHook(KanbanBoardView, { ...props, query: "" });
  let lane = component(hook, "LaneColumn");
  assert.equal(lane.props.lane.id, "b");
  lane.props.onOpenForm("b", board.cards[1]);
  hook.flush();
  hook.rerender(props);
  lane = component(hook, "LaneColumn");
  assert.equal(lane.props.lane.id, "b");
  assert.deepEqual(lane.props.form, { laneId: "b", cardId: "2" });
  assert.deepEqual(lane.props.search.renderedCards.map(c => c.id), ["1", "2"]);
  assert.equal(lane.props.search.cards.length, 1);
  assert.equal(dragOptions.card.mode, "menu");
  assert.equal(dragOptions.card.enabled, true);
  dragOptions.card.onLongPress("1", {});
  hook.flush();
  assert.ok(component(hook, "CardMenu"));
  component(hook, "CardMenu").props.onClose();
  lane.props.onOpenForm("b", board.cards[1]);
  hook.flush();
  assert.equal(component(hook, "LaneColumn").props.form, null);
  assert.deepEqual(component(hook, "LaneColumn").props.search.renderedCards.map(c => c.id), ["1"]);
  component(hook, "LaneColumn").props.onOpenForm("b", null);
  hook.flush();
  hook.rerender({ ...props, query: "third" });
  lane = component(hook, "LaneColumn");
  assert.deepEqual(lane.props.form, { laneId: "b", cardId: null });
  assert.equal(lane.props.lane.id, "b");
  assert.equal(lane.props.matchingLane.id, "c");
  lane.props.onShowMatchingLane();
  hook.flush();
  assert.equal(component(hook, "LaneColumn").props.lane.id, "c");
  hook.unmount();
});
