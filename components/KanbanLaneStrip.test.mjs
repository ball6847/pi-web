// The board strip's pending pill: where a fresh composer's session will land.
// A card picked out of the backlog is not attached where it sits — the attach
// advances it one lane first (the backlog never takes a session) — so the pill
// must mark the lane the card will be in, not the fixed lane it is leaving.
//
// The real component function runs against the shared hook harness; the card
// menu, the portal and the icons are other files' tests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";
import * as hooks from "../hooks/__fixtures__/react-hook-shim.mjs";

const { laneIndex, sessionlessCardsByRecency } = await createJiti(import.meta.url).import("../lib/kanban-shared.ts");

const text = await readFile(new URL("./KanbanLaneStrip.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("KanbanLaneStrip.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const code = source.statements
  .filter((node) => !ts.isImportDeclaration(node) && !ts.isInterfaceDeclaration(node))
  .map((node) => node.getText(source).replace(/^export /, ""))
  .join("\n");
const compiled = ts.transpileModule(`${code}\nglobalThis.components = { KanbanLaneStrip };`, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React },
}).outputText;

const noop = () => {};
const backlog = { id: "lane-backlog", name: "Backlog", description: "", fixed: true };
const todo = { id: "lane-todo", name: "Todo", description: "" };
const plan = { id: "lane-plan", name: "Plan", description: "" };
const waiting = {
  id: "card-1", title: "Waiting card", description: "", laneId: "lane-backlog",
  sessionId: null, sessionTitle: null, createdAt: 0, updatedAt: 0,
};
const inPlan = { ...waiting, id: "card-2", laneId: "lane-plan" };

function setup() {
  const context = vm.createContext({
    ...hooks,
    React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
    useI18n: () => ({ t: (key) => key }),
    useIsMobile: () => false,
    laneIndex,
    sessionlessCardsByRecency,
    CardMenu: "CardMenu",
    Chevon: "Chevron",
  });
  vm.runInContext(compiled, context);
  const mounted = [];
  return {
    render(props) {
      const view = hooks.renderHook(context.components.KanbanLaneStrip, {
        board: { projectDir: "/project", lanes: [backlog, todo, plan], cards: [waiting, inPlan] },
        card: null,
        isNewSession: true,
        running: false,
        onOpenBoard: noop,
        onTrack: noop,
        onUnlink: noop,
        onDemoAdvance: noop,
        ...props,
      });
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
/** The lane pill of `name`, and whether it is the dashed pending one. */
function pill(view, name) {
  const element = all(
    view.result,
    (node) => node.type === "span" && node.props.children?.includes(name) && node.props.style?.borderRadius === 999,
  )[0];
  assert.ok(element, `a ${name} pill`);
  return { pending: String(element.props.style.border).includes("dashed") };
}

test("a card picked out of the backlog is shown pending in the lane the attach moves it to", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const view = ui.render({ pending: { kind: "attach", projectDir: "/project", cardId: waiting.id, cardTitle: waiting.title } });

  assert.equal(pill(view, "Backlog").pending, false, "the backlog is not where the session lands");
  assert.equal(pill(view, "Todo").pending, true, "one lane right is where the card will be");
  assert.equal(pill(view, "Plan").pending, false);
});

test("a card already in a work lane is shown pending where it sits", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const view = ui.render({ pending: { kind: "attach", projectDir: "/project", cardId: inPlan.id, cardTitle: inPlan.title } });

  assert.equal(pill(view, "Backlog").pending, false);
  assert.equal(pill(view, "Todo").pending, false);
  assert.equal(pill(view, "Plan").pending, true, "a work-lane card is linked as it is: no advance");
});

test("a new card's pick marks its own lane", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const view = ui.render({ pending: { kind: "new-card", projectDir: "/project", laneId: plan.id } });

  assert.equal(pill(view, "Todo").pending, false);
  assert.equal(pill(view, "Plan").pending, true);
});

test("a board with only the backlog highlights nothing: the attach would be refused", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const view = ui.render({
    board: { projectDir: "/project", lanes: [backlog], cards: [waiting] },
    pending: { kind: "attach", projectDir: "/project", cardId: waiting.id, cardTitle: waiting.title },
  });

  assert.equal(pill(view, "Backlog").pending, false);
});
