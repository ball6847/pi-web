import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { CardView } = await jiti.import("./KanbanBoard.tsx");
const boardSource = await readFile(new URL("./KanbanBoard.tsx", import.meta.url), "utf8");
const treeSource = await readFile(new URL("./SessionTree.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/sidebar.css", import.meta.url), "utf8");

const h = React.createElement;

function decode(html) {
  return html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

const noop = () => {};
const lane = { id: "lane-plan", name: "Plan", description: "" };
const card = {
  id: "card-1",
  title: "Card activity indicator",
  description: "",
  laneId: "lane-plan",
  sessionId: "sess-1",
  sessionTitle: "feat: card activity indicator",
  createdAt: 0,
  updatedAt: 0,
};

function render(props = {}) {
  return decode(renderToStaticMarkup(h(I18nProvider, null, h(CardView, {
    lane,
    card,
    isLastLane: false,
    running: false,
    awaiting: false,
    unread: false,
    sessionGone: false,
    highlighted: false,
    onOpenSession: noop,
    onOpenMenu: noop,
    onEdit: noop,
    onOpenLinkPicker: noop,
    ...props,
  }))));
}

const RUNNING_LABEL = "Agent running…";
const AWAITING_LABEL = "Agent waiting for your input";
const UNREAD_ARIA_LABEL = "New session activity";
const UNREAD_TITLE = "New activity";

/** The linked-session chip: the button that renders the session title. */
function chipButton(html) {
  const at = html.indexOf("feat: card activity indicator</span>");
  assert.ok(at > 0, "the chip title rendered");
  return html.slice(html.lastIndexOf("<button", at), html.indexOf("</button>", at));
}

test("a running linked session gets the spinner, with the sidebar row's label", () => {
  const html = render({ running: true });
  const chip = chipButton(html);
  assert.match(chip, /sidebar-spin/);
  assert.ok(chip.includes(`aria-label="${RUNNING_LABEL}"`), "spinner carries the sidebar row's running label");
  assert.ok(chip.includes(`title="${RUNNING_LABEL}"`), "its tooltip matches the row's meta title");
  assert.doesNotMatch(html, /session-tree-awaiting/);
});

test("a session awaiting input gets the amber dot, with the sidebar row's label", () => {
  const html = render({ running: true, awaiting: true });
  const chip = chipButton(html);
  assert.match(chip, /session-tree-awaiting/);
  assert.ok(chip.includes(`aria-label="${AWAITING_LABEL}"`), "dot carries the sidebar row's awaiting label");
  assert.ok(chip.includes(`title="${AWAITING_LABEL}"`));
  assert.doesNotMatch(html, /sidebar-spin/);
});

test("new activity gets the sidebar row's blue dot and labels", () => {
  const chip = chipButton(render({ unread: true }));
  assert.match(chip, /session-tree-unread/);
  assert.ok(chip.includes(`aria-label="${UNREAD_ARIA_LABEL}"`), "dot carries the sidebar row's unread aria-label");
  assert.ok(chip.includes(`title="${UNREAD_TITLE}"`), "its tooltip matches the row's meta title");
  assert.doesNotMatch(chip, /sidebar-spin|session-tree-awaiting/);
});

test("awaiting beats running beats new activity, exactly as the sidebar row orders them", () => {
  // The poll's awaiting set is a subset of its running set: both flags can be
  // true at once, and the dot is what shows.
  const both = render({ running: true, awaiting: true, unread: true });
  assert.match(both, /session-tree-awaiting/);
  assert.doesNotMatch(both, /sidebar-spin|session-tree-unread/);
  // Running hides the new-activity dot the row would also put away.
  const busy = render({ running: true, unread: true });
  assert.match(busy, /sidebar-spin/);
  assert.doesNotMatch(busy, /session-tree-awaiting|session-tree-unread/);
});

test("the indicator lives in the chip's leading slot, never outside the card", () => {
  const states = [render({ running: true }), render({ running: true, awaiting: true }), render({ unread: true })];
  for (const html of states) {
    const chip = chipButton(html);
    // The state element appears once in the whole card, inside the chip: the
    // old sibling slot overflowed the card's padding on a narrow card.
    assert.doesNotMatch(html.replace(chip, ""), /sidebar-spin|session-tree-awaiting|session-tree-unread/);
  }
  // Idle keeps the session glyph in the same slot, so the title never shifts.
  assert.doesNotMatch(chipButton(render()), /sidebar-spin|session-tree-awaiting/);
});

test("an idle or unlinked card shows no indicator", () => {
  assert.doesNotMatch(render(), /sidebar-spin|session-tree-awaiting|session-tree-unread/);
  const sessionless = render({
    card: { ...card, sessionId: null, sessionTitle: null },
    running: true,
    awaiting: true,
    unread: true,
  });
  assert.doesNotMatch(sessionless, /sidebar-spin|session-tree-awaiting|session-tree-unread/);
});

test("the card's states and labels stay identical to the sidebar row's", () => {
  for (const key of ["sidebar.agentRunning", "sidebar.agentAwaitingInput", "sidebar.newActivity", "sidebar.newSessionActivity"]) {
    assert.ok(boardSource.includes(`"${key}"`), `the card uses ${key}`);
    assert.ok(treeSource.includes(`"${key}"`), `the sidebar row uses ${key}`);
  }
  // The dots are the row's own elements, so the two can never drift apart.
  assert.match(css, /\.session-tree-awaiting \{/);
  assert.match(css, /\.session-tree-unread \{/);
});
