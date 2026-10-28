import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";
import * as hooks from "../hooks/__fixtures__/react-hook-shim.mjs";
import { kanbanSessionOptions } from "../lib/kanban-sessions.ts";
const { cardsOfLane, canRestInLane } = await createJiti(import.meta.url).import("../lib/kanban-shared.ts");
const { kanbanCardKey } = await createJiti(import.meta.url).import("../lib/kanban-types.ts");
// The board's text search came with the search feature; the card and the view
// both read it, so the harness runs the real module (a stub would hide a
// broken highlight or filter).
const { kanbanDescriptionExcerpt, normalizeKanbanQuery, searchKanbanBoard } = await createJiti(import.meta.url).import("../lib/kanban-search.ts");

// Drive the actual component functions and their event props with the shared
// hook harness. Child elements stay opaque: layout/portals/drag are not under
// test, while the board -> lane -> card/form data flow is.
const text = await readFile(new URL("./KanbanBoard.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("KanbanBoard.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["KanbanBoardView", "LaneColumn", "CardView", "CardForm"];
const code = source.statements
  .filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
  .map((node) => node.getText(source).replace(/^export /, ""))
  .join("\n");
const compiled = ts.transpileModule(`${code}\nglobalThis.components = { ${names.join(", ")} };`, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React },
}).outputText;
const noop = () => {};
const parent = { id: "parent", cwd: "/project", name: "Parent" };
const child = { id: "child", cwd: "/project-wt", projectRoot: "/project", name: "Child", relation: { kind: "subagent" } };
const sibling = { ...child, id: "sibling", name: "Sibling" };
const lane = { id: "work", name: "Work", description: "" };
const card = { id: "task", title: "Task", description: "Details", laneId: lane.id, sessionId: child.id, sessionTitle: "Snapshot", createdAt: 0, updatedAt: 0 };
const anchor = { left: 0, top: 0, width: 10, height: 10 };

function setup() {
  const calls = [];
  const context = vm.createContext({
    ...hooks,
    React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
    useI18n: () => ({ t: (key) => key }),
    useIsMobile: () => false,
    kanbanSessionOptions, cardsOfLane, canRestInLane, kanbanCardKey,
    kanbanDescriptionExcerpt, normalizeKanbanQuery, searchKanbanBoard,
    window: { addEventListener: noop, removeEventListener: noop },
    document: { addEventListener: noop, removeEventListener: noop },
    readViewport: () => ({ width: 1000, height: 800 }),
    useKanbanLaneDrag: () => ({ view: { draggingLaneId: null, dropIndex: null }, beginDrag: noop }),
    useKanbanCardDrag: () => ({ view: null, handlers: { onPointerDown: noop, onTouchMove: noop } }),
  });
  for (const name of ["kanbanUpdateCard", "kanbanLinkCard", "kanbanUnlinkCard", "kanbanAddCard"]) {
    context[name] = (...args) => calls.push([name, ...args]);
  }
  for (const name of ["Fragment", "KanbanIcon", "ChatIcon", "MoreIcon", "LinkIcon", "ChevronIcon", "SpinnerIcon", "GhostButton", "DropLine", "ColumnDropLine", "LaneDragGhost", "LaneConfig", "CardMenu", "SessionPicker", "KanbanSearchField", "KanbanSearchText", "KanbanSearchStyles"]) context[name] = name;
  vm.runInContext(compiled, context);
  const mounted = [];
  return {
    calls,
    components: context.components,
    render(name, props) {
      const view = hooks.renderHook(context.components[name], props);
      mounted.push(view);
      return view;
    },
    cleanup() { mounted.reverse().forEach((view) => view.unmount()); },
  };
}
function all(element, predicate) {
  if (!element || typeof element !== "object") return [];
  if (Array.isArray(element)) return element.flatMap((node) => all(node, predicate));
  return [...(predicate(element) ? [element] : []), ...all(element.props?.children, predicate)];
}
function one(view, predicate) {
  const matches = all(view.result, predicate);
  assert.equal(matches.length, 1, "one matching element");
  return matches[0];
}
function label(view, key) {
  return one(view, (node) => node.type === "button" && node.props.children.includes(key));
}
function boardProps(sessions, cards = [card]) {
  return {
    board: { projectDir: "/project", lanes: [lane], cards },
    projectDir: "/project", projectName: "project", sessions,
    query: "", onQueryChange: noop,
    runningSessionIds: new Set([child.id]), awaitingInputSessionIds: new Set(), unreadSessionIds: new Set(),
    onOpenSession: noop, onStartSession: noop,
  };
}
function openFormPicker(view) {
  const button = one(view, (node) => node.type === "button" && node.props.ref);
  button.props.ref.current = { getBoundingClientRect: () => anchor };
  button.props.onClick();
  view.flush();
  return one(view, (node) => node.type === "SessionPicker");
}

test("child card is available via card, chip and menu; a truly missing session stays disabled", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const opened = [];
  const props = boardProps([parent, child, sibling]);
  props.onOpenSession = (...args) => opened.push(args);
  const board = ui.render("KanbanBoardView", props);
  const column = one(board, (node) => node.type === ui.components.LaneColumn);
  const laneView = ui.render("LaneColumn", column.props);
  const cardElement = one(laneView, (node) => node.type === ui.components.CardView);
  assert.equal(cardElement.props.sessionGone, false);
  assert.equal(cardElement.props.running, true);
  const cardView = ui.render("CardView", cardElement.props);
  cardView.result.props.onClick();
  const chip = one(cardView, (node) => node.type === "button" && node.props.title === "Snapshot — kanban.cardSubagent");
  assert.equal(chip.props.disabled, false);
  assert.equal(chip.props["data-kanban-subagent"], "true", "a sub-agent's card says who does the work");
  chip.props.onClick({ stopPropagation: noop });
  column.props.onOpenMenu(anchor, card);
  board.flush();
  const menu = one(board, (node) => node.type === "CardMenu");
  const open = menu.props.entries.find((entry) => entry.id === "open");
  assert.equal(open.disabled, false);
  open.onSelect();
  assert.equal(opened.length, 3);
  assert.ok(opened.every(([id]) => id === child.id));
  assert.equal(ui.calls.length, 0, "opening never mutates the board");

  board.rerender({ ...props, sessions: [parent] });
  assert.equal(one(board, (node) => node.type === "CardMenu").props.entries.find((entry) => entry.id === "open").disabled, true);
  laneView.rerender(one(board, (node) => node.type === ui.components.LaneColumn).props);
  cardView.rerender(one(laneView, (node) => node.type === ui.components.CardView).props);
  assert.equal(one(cardView, (node) => node.type === "button" && node.props.title === "kanban.menuSessionGone").props.disabled, true);
  cardView.result.props.onClick();
  assert.equal(opened.length, 3);
});

test("only a sub-agent's chip carries the sub-agent mark; an ordinary session keeps its plain title", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const topLevel = { id: "top", cwd: "/project", name: "Top level" };
  const byParent = {
    ...card,
    sessionId: topLevel.id,
    sessionTitle: "Parent work",
  };
  const board = ui.render("KanbanBoardView", boardProps([parent, child, topLevel], [byParent]));
  const column = one(board, (node) => node.type === ui.components.LaneColumn);
  const laneView = ui.render("LaneColumn", column.props);
  assert.deepEqual([...column.props.subagents.keys()], [child.id]);
  const cardView = ui.render("CardView", one(laneView, (node) => node.type === ui.components.CardView).props);
  const chip = one(cardView, (node) => node.type === "button" && node.props.title === "Parent work");
  assert.equal(chip.props["data-kanban-subagent"], undefined);
  assert.equal(chip.props["aria-label"], undefined);
  // The sub-agent profile rides along for the chip's hint (null when the relation has none).
  assert.equal(column.props.subagents.get(child.id), null);
});

test("Link picker offers only top-level sessions and disables the menu choice when only children exist", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const unlinked = { ...card, sessionId: null, sessionTitle: null };
  const props = boardProps([parent, child, sibling], [unlinked]);
  const board = ui.render("KanbanBoardView", props);
  const column = one(board, (node) => node.type === ui.components.LaneColumn);
  column.props.onOpenLinkPicker(anchor, unlinked);
  board.flush();
  const picker = one(board, (node) => node.type === "SessionPicker");
  assert.deepEqual(picker.props.options.map((option) => option.id), [parent.id]);
  picker.props.onPick(picker.props.options[0]);
  assert.deepEqual(ui.calls, [["kanbanLinkCard", "/project", card.id, parent.id, parent.name]]);
  column.props.onOpenMenu(anchor, unlinked);
  board.rerender({ ...props, sessions: [child, sibling] });
  assert.equal(one(board, (node) => node.type === "CardMenu").props.entries.find((entry) => entry.id === "link").disabled, true);
});

for (const sessions of [[parent, child, sibling], [child], []]) {
  test(`editing a child-linked card preserves its link (${sessions.length} catalogue rows)`, (t) => {
    const ui = setup();
    t.after(() => ui.cleanup());
    const view = ui.render("CardForm", { projectDir: "/project", lane, initial: card, sessions, runningIds: new Set([child.id]), onDone: noop });
    assert.equal(label(view, "kanban.cardFormSave").props.disabled, false);
    assert.equal(all(view.result, (node) => node.props?.children?.includes("kanban.cardFormSessionRequired")).length, 0);
    const picker = openFormPicker(view);
    assert.deepEqual(picker.props.options.map((option) => option.id), sessions.includes(parent) ? [parent.id, child.id] : [child.id]);
    // Leave the initial session field untouched: editing text must not require
    // reselecting the child to avoid silently changing its link.
    one(view, (node) => node.type === "input").props.onChange({ target: { value: "Edited" } });
    view.flush();
    label(view, "kanban.cardFormSave").props.onClick();
    assert.deepEqual(JSON.parse(JSON.stringify(ui.calls)), [["kanbanUpdateCard", "/project", card.id, { title: "Edited", description: card.description }]], "text save does not link/unlink or change the snapshot title");
  });
}

test("changing the link requires an explicit pick; the original child remains available until save", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const view = ui.render("CardForm", { projectDir: "/project", lane, initial: card, sessions: [parent, child, sibling], runningIds: new Set(), onDone: noop });
  const picker = openFormPicker(view);
  picker.props.onPick(picker.props.options[0]);
  view.flush();
  const options = one(view, (node) => node.type === "SessionPicker").props.options;
  assert.ok(options.some((option) => option.id === child.id), "the original child remains a choice until save");
  label(view, "kanban.cardFormSave").props.onClick();
  assert.equal(ui.calls[1][0], "kanbanLinkCard");
  assert.equal(ui.calls[1][3], parent.id);
});

test("reselecting the original child after another choice saves only text", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const view = ui.render("CardForm", { projectDir: "/project", lane, initial: card, sessions: [parent, child, sibling], runningIds: new Set(), onDone: noop });
  let picker = openFormPicker(view);
  picker.props.onPick(picker.props.options[0]);
  view.flush();
  picker = one(view, (node) => node.type === "SessionPicker");
  picker.props.onPick(picker.props.options.find((option) => option.id === child.id));
  view.flush();
  label(view, "kanban.cardFormSave").props.onClick();
  assert.deepEqual(ui.calls.map(([name]) => name), ["kanbanUpdateCard"]);
});

test("a new card form never selects a child implicitly or offers one manually", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const view = ui.render("CardForm", { projectDir: "/project", lane, initial: null, sessions: [child, sibling], runningIds: new Set(), onDone: noop });
  one(view, (node) => node.type === "input").props.onChange({ target: { value: "New" } });
  view.flush();
  assert.equal(label(view, "kanban.cardFormAdd").props.disabled, true);
  assert.equal(openFormPicker(view).props.options.length, 0);
  assert.ok(all(view.result, (node) => node.props?.children?.includes("kanban.cardFormSessionRequired")).length > 0);
  assert.deepEqual(ui.calls, []);
});
