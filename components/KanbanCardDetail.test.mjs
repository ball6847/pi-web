// The card detail tab's session controls: a card's only way into a session,
// and the one place the backlog's "no session" rule has to show its way out.
// A backlog card CAN start a session — the attach advances it one lane first
// (kanban-shared's attachSessionCard) — so the tab offers the button, with the
// lane it will move to as its consequence ("Start session → Todo", the rule in
// the arrow's tooltip); with no work lane to move it into the button is not
// offered, because the attach would be refused.
//
// The real component function runs against the shared hook harness; the board
// cache and the comment thread are stubs (they are other files' tests).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";
import * as hooks from "../hooks/__fixtures__/react-hook-shim.mjs";
import { isPlainActivation, sessionDeepLink } from "../lib/session-links.ts";

const { canRestInLane } = await createJiti(import.meta.url).import("../lib/kanban-shared.ts");
const { kanbanSessionOptions } = await createJiti(import.meta.url).import("../lib/kanban-sessions.ts");
// The key a card is drawn by (PIW-7): the real one, so a fixture's shape must be real too.
const { kanbanCardKey } = await createJiti(import.meta.url).import("../lib/kanban-types.ts");

const text = await readFile(new URL("./KanbanCardDetail.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("KanbanCardDetail.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
// Everything but the imports and the props interface: the tab's labels, helpers
// and the component itself, so the render runs the file's own code.
const code = source.statements
  .filter((node) => !ts.isImportDeclaration(node) && !ts.isInterfaceDeclaration(node))
  .map((node) => node.getText(source).replace(/^export /, ""))
  .join("\n");
const compiled = ts.transpileModule(`${code}\nglobalThis.components = { KanbanCardDetail, CommentEntry };`, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React },
}).outputText;

const noop = () => {};
const backlog = { id: "lane-backlog", name: "Backlog", description: "", fixed: true };
const todo = { id: "lane-todo", name: "Todo", description: "" };
const session = { id: "session-1", cwd: "/project", name: "A session" };
function card(laneId, extra = {}) {
  return { id: "card-1", number: 7, title: "A card", description: "Details", laneId, sessionId: null, sessionTitle: null, createdAt: 0, updatedAt: 0, ...extra };
}

function setup(options = {}) {
  const calls = [];
  let board = null;
  const context = vm.createContext({
    ...hooks,
    React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: "Fragment" },
    // The key plus the interpolation, so a test can name either.
    useI18n: () => ({ t: (key, params) => (params && params.lane !== undefined ? `${key}:${params.lane}` : key) }),
    useKanbanBoard: () => board,
    useKanbanCardComments: () => ({ status: "ready", comments: options.comments ?? [], total: (options.comments ?? []).length }),
    // The activity journal (another feature's route): an empty, ready page.
    useKanbanCardActivity: () => ({ activity: [], total: 0, status: "ready", hasMore: false, loadingOlder: false, loadOlder: noop }),
    kanbanCardKey,
    canRestInLane,
    kanbanSessionOptions,
    isPlainActivation,
    sessionDeepLink,
    // The card's key chip (its own file: one click copies the reference).
    KanbanCardKeyChip: "KanbanCardKeyChip",
    MarkdownBody: "MarkdownBody",
    SpinnerIcon: "SpinnerIcon",
    CardMenu: "CardMenu",
  });
  for (const name of [
    "kanbanAddCard",
    "kanbanAddCardComment",
    "kanbanDeleteCard",
    "kanbanDeleteCardComment",
    "kanbanLinkCard",
    "kanbanMoveCard",
    "kanbanUnlinkCard",
    "kanbanUpdateCard",
  ]) {
    context[name] = (...args) => calls.push([name, ...args]);
  }
  vm.runInContext(compiled, context);
  const mounted = [];
  return {
    calls,
    context,
    render(nextBoard, props = {}) {
      board = nextBoard;
      const view = hooks.renderHook(context.components.KanbanCardDetail, {
        projectDir: "/project",
        projectName: "project",
        cardId: "card-1",
        draftLaneId: null,
        sessions: [session],
        runningSessionIds: new Set(),
        awaitingInputSessionIds: new Set(),
        unreadSessionIds: new Set(),
        onOpenSession: noop,
        onStartSession: (started) => calls.push(["start", started.id]),
        onCardCreated: noop,
        onCardDeleted: noop,
        onTitleChange: noop,
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
function startButton(view) {
  return all(view.result, (node) => node.type === "button" && node.props.children?.includes("kanban.detailStartSession"))[0] ?? null;
}
function hint(view) {
  return all(
    view.result,
    (node) => node.type === "span"
      && typeof node.props.children?.[0] === "string"
      && node.props.children[0].startsWith("kanban.detailBacklogHint"),
  )[0] ?? null;
}
/** The "→ Todo" beside a backlog card's start button: where the attach puts it. */
function moveLabel(view) {
  return all(
    view.result,
    (node) => node.type === "span"
      && typeof node.props.children?.[0] === "string"
      && node.props.children[0].startsWith("kanban.detailStartMovesTo"),
  )[0] ?? null;
}
function sessionPicker(view) {
  return all(view.result, (node) => node.type === "button" && node.props["data-kanban-detail-session"] === true)[0] ?? null;
}
function lanePicker(view) {
  return all(view.result, (node) => node.type === "button" && node.props["data-kanban-detail-lane"] === true)[0] ?? null;
}
function menu(view) {
  return all(view.result, (node) => node.type === "CardMenu")[0] ?? null;
}

function agentComment(overrides = {}) {
  return {
    id: "comment-1",
    cardId: "card-1",
    author: "agent",
    sessionId: "session-1",
    sessionTitle: "A session",
    body: "Handoff note",
    createdAt: 0,
    ...overrides,
  };
}

function byline(ui, comment, options = {}) {
  return hooks.renderHook(ui.context.components.CommentEntry, {
    comment,
    sessions: options.sessions ?? [session],
    onOpenSession: options.onOpenSession ?? noop,
    onDelete: noop,
  });
}

function sessionLink(view) {
  return all(view.result, (node) => node.type === "a")[0] ?? null;
}
/** A press on a chip picker: the menu opens over the control's box. */
const press = { currentTarget: { getBoundingClientRect: () => ({ x: 10, y: 10, width: 80, height: 20, top: 10, left: 10, right: 90, bottom: 30 }) } };
function boardOf(cards) {
  return { projectDir: "/project", cardPrefix: "PIW", lanes: [backlog, todo], cards };
}

test("a backlog card starts a session from the detail tab, and says which lane it moves to", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const view = ui.render(boardOf([card("lane-backlog")]));

  const button = startButton(view);
  assert.ok(button, "the backlog card offers Start session");
  assert.equal(button.disabled, undefined, "always enabled while a work lane can take it");
  const arrow = moveLabel(view);
  assert.ok(arrow, "the start button carries its consequence: the lane it moves the card to");
  assert.equal(arrow.props.children[0], "kanban.detailStartMovesTo:Todo");
  assert.equal(arrow.props.title, "kanban.detailBacklogStartHint:Todo", "the tooltip says why: the backlog takes no session");
  assert.equal(hint(view), null, "no long sentence beside it: the button and the arrow are the whole row");
  assert.equal(sessionPicker(view), null, "the backlog still offers no session picker");

  button.props.onClick();
  assert.deepEqual(ui.calls, [["start", "card-1"]], "starting writes nothing: the attach lands with the session");
});

test("with no work lane to advance into, the backlog card keeps the plain hint and no start button", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  // The attach advances the card one lane first; with only the fixed backlog
  // left it would be refused, so the tab does not offer it.
  const view = ui.render({ projectDir: "/project", cardPrefix: "PIW", lanes: [backlog], cards: [card("lane-backlog")] });

  assert.equal(startButton(view), null);
  assert.equal(moveLabel(view), null, "nothing to promise: the attach would be refused");
  assert.equal(hint(view).props.children[0], "kanban.detailBacklogHint");
  assert.equal(hint(view).props.title, "kanban.backlogNoSessions");
});

test("a card in a work lane keeps its picker and its start button", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const view = ui.render(boardOf([card("lane-todo")]));

  assert.ok(sessionPicker(view), "a work lane offers the link picker");
  assert.equal(all(view.result, (node) => node.type === "select").length, 0, "no native select anywhere: its option list cannot be themed");
  const button = startButton(view);
  assert.ok(button);
  assert.equal(moveLabel(view), null, "a work-lane card is linked where it sits: no lane to name");
  button.props.onClick();
  assert.deepEqual(ui.calls, [["start", "card-1"]]);
});

test("a linked card offers open and unlink, never a second start", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const view = ui.render(boardOf([card("lane-todo", { sessionId: session.id, sessionTitle: session.name })]));

  assert.equal(startButton(view), null, "one session, one card: a linked card starts nothing");
  assert.ok(all(view.result, (node) => node.type === "button" && node.props.title === "kanban.detailOpenSession")[0]);
});

test("the lane picker is a themed menu: every lane, the refused ones disabled with the rule", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  // A linked card cannot go back to the backlog; the refusal names the rule.
  const view = ui.render(boardOf([card("lane-todo", { sessionId: session.id, sessionTitle: session.name })]));

  lanePicker(view).props.onClick(press);
  view.flush();
  const entries = [...menu(view).props.entries];
  assert.deepEqual(entries.map((entry) => entry.label), ["Backlog", "Todo"]);
  const backlogEntry = entries[0];
  assert.equal(backlogEntry.disabled, true, "a linked card cannot rest in the backlog");
  assert.equal(backlogEntry.disabledTitle, "kanban.backlogNoSessions");
  assert.equal(entries[1].disabled, false, "the lane it already sits in stays a choice");
  entries[1].onSelect();
  assert.deepEqual(ui.calls, [["kanbanMoveCard", "/project", "card-1", "lane-todo"]], "a pick is the board's own move");
});

test("the session picker is a themed menu: the project's sessions, and the way back to none", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const view = ui.render(boardOf([card("lane-todo")]));

  sessionPicker(view).props.onClick(press);
  view.flush();
  // Nothing linked yet, so there is nothing to clear.
  assert.deepEqual([...menu(view).props.entries].map((entry) => entry.label), ["A session"]);
  menu(view).props.entries[0].onSelect();
  assert.deepEqual(ui.calls, [["kanbanLinkCard", "/project", "card-1", "session-1", "A session"]]);
});

test("a project with no sessions says so in the session menu instead of opening empty", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const view = ui.render(boardOf([card("lane-todo")]), { sessions: [] });

  sessionPicker(view).props.onClick(press);
  view.flush();
  const entries = [...menu(view).props.entries];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, "kanban.cardFormSessionRequired");
  assert.equal(entries[0].disabled, true);
});

test("the preview keeps the card's own line breaks, as the writer laid them out", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  // Agents write a card one point per line; a soft ending is a new line on
  // screen, not a space (the editor's and the preview's text stay identical).
  const description = "- bullet one\n- bullet two\nParagraph line\nnext line";
  const view = ui.render(boardOf([card("lane-todo", { description })]));

  const preview = all(view.result, (node) => node.type === "MarkdownBody")[0];
  assert.ok(preview, "a card with a description opens in Preview");
  assert.equal(preview.props.keepLineBreaks, true, "a typed note is not typeset: every line ending stays a line");
  assert.deepEqual(preview.props.children, [description], "and the editor's text is what is rendered");
  assert.equal(preview.props.cwd, "/project", "local file links still resolve against the project");
});

test("an agent note links its visible source session and opens it on plain activation", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const opened = [];
  const view = byline(ui, agentComment(), { onOpenSession: (...args) => opened.push(args) });
  t.after(() => view.unmount());

  const link = sessionLink(view);
  assert.ok(link, "an agent note's byline is a real link");
  assert.equal(link.props.href, "?session=session-1", "the href carries only the session id");
  assert.equal(link.props.title, "kanban.detailOpenSession");
  assert.equal(link.props["aria-label"], "kanban.detailOpenSession A session", "the accessible name names the session the link opens");
  assert.deepEqual(link.props.children, ["A session"], "the stored session title is the link text");

  link.props.onClick({ button: 1, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false });
  assert.deepEqual(opened, [], "a middle click stays the browser's");
  link.props.onClick({ button: 0, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false });
  assert.deepEqual(opened, [], "a modified click stays the browser's");

  let prevented = false;
  link.props.onClick({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, "a plain click stays in this page");
  assert.deepEqual(opened, [["session-1", "A session"]]);
});

test("a missing source session is plain muted text with the stored id", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const view = byline(ui, agentComment({ sessionId: "gone", sessionTitle: "Old session" }), { sessions: [] });
  t.after(() => view.unmount());

  assert.equal(sessionLink(view), null, "no link to a session that is gone");
  const bylineText = all(view.result, (node) => node.type === "span" && Array.isArray(node.props.children) && node.props.children[0]?.includes("Old session"));
  assert.equal(bylineText.length, 1);
  assert.deepEqual(bylineText[0].props.children, ["Old session · gone · kanban.detailCommentAgent"]);
  assert.equal(bylineText[0].props.style.color, "var(--text-muted)");
  view.unmount();

  const noTitle = byline(ui, agentComment({ sessionTitle: null }), { sessions: [] });
  const noTitleText = all(noTitle.result, (node) => node.type === "span" && Array.isArray(node.props.children) && node.props.children[0]?.includes("session-1"))[0];
  assert.deepEqual(noTitleText.props.children, ["session-1 · kanban.detailCommentAgent"], "with no stored name the id still names the writer");
  noTitle.unmount();
});

test("a browser note stays plain You with no session link", (t) => {
  const ui = setup();
  t.after(() => ui.cleanup());
  const view = byline(ui, agentComment({ author: "user", sessionId: null, sessionTitle: null }), { sessions: [] });
  t.after(() => view.unmount());

  assert.equal(sessionLink(view), null);
  assert.ok(all(view.result, (node) => node.type === "span" && node.props.children?.[0] === "kanban.detailCommentYou")[0]);
  assert.equal(all(view.result, (node) => node.type === "button" && node.props.title === "kanban.detailCommentDelete").length, 1, "a browser note keeps its delete button");
});

test("every authored body in the tab keeps its line breaks, notes included", () => {
  // The note component is reachable in the VM now; this still checks the source
  // so every preview in the file stays consistent.
  const bodies = text.match(/<MarkdownBody[^>]*>/g) ?? [];
  assert.ok(bodies.length >= 2, "the description preview and a note's body");
  for (const body of bodies) assert.match(body, /keepLineBreaks/, `typeset rendering in a detail tab: ${body}`);
});
