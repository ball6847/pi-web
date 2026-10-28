import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { KanbanBoard, KanbanBoardView, LaneColumn, ConfigLaneRow } = await jiti.import("./KanbanBoard.tsx");
const { KanbanSearchField } = await jiti.import("./KanbanSearch.tsx");
const { searchKanbanBoard } = await jiti.import("@/lib/kanban-search");
const h = React.createElement;
const noop = () => {};
const card = (id, laneId, title, description = "") => ({ id, laneId, title, description, sessionId: null, sessionTitle: null, createdAt: 0, updatedAt: 0 });
const board = { projectDir: "/project", lanes: [{ id: "a", name: "Backlog", fixed: true }, { id: "b", name: "Plan" }, { id: "empty", name: "Empty" }], cards: [card("1", "a", "Fix AUTH"), card("2", "b", "Late match", "prefix ".repeat(60) + "auth suffix"), card("3", "a", "Other")] };
const render = (component, props) => renderToStaticMarkup(h(I18nProvider, null, h(component, props)));
const props = { board, projectDir: board.projectDir, projectName: "Project", sessions: [], runningSessionIds: new Set(), awaitingInputSessionIds: new Set(), unreadSessionIds: new Set(), query: "auth", onQueryChange: noop, onOpenSession: noop, onStartSession: noop, notice: null };

test("board projects matches/counts with all lanes and safe highlighted late descriptions", () => {
  const html = render(KanbanBoardView, props);
  assert.match(html, /data-kanban-search/);
  assert.match(html, /aria-label="Filter cards"/);
  assert.ok(html.indexOf("data-kanban-search") < html.indexOf('aria-label="Configure lanes"'));
  assert.match(html, /data-kanban-board-summary[^>]*>2 of 3 cards/);
  assert.deepEqual([...html.matchAll(/data-kanban-lane="([^"]+)"/g)].map(m => m[1]), ["a", "b", "empty"]);
  assert.deepEqual([...html.matchAll(/data-kanban-card="([^"]+)"/g)].map(m => m[1]), ["1", "2"]);
  assert.match(html, /data-kanban-lane-count="a"[^>]*>1\/2/);
  assert.match(html, /<mark[^>]*>AUTH<\/mark>/);
  assert.match(html, /<mark[^>]*>auth<\/mark>/);
  assert.doesNotMatch(html, /prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix prefix/);
  assert.match(html, /Clear the filter to drag or reorder cards/);
});

test("board and lane empty states differ; whitespace keeps clear action without filtering", () => {
  const none = render(KanbanBoardView, { ...props, query: "missing" });
  assert.match(none, /data-kanban-no-results/);
  assert.match(none, /No cards match this filter/);
  assert.match(none, /No matches in this lane/);
  assert.match(none, /No cards<\/div>/);
  const whitespace = render(KanbanBoardView, { ...props, query: "  " });
  assert.equal([...whitespace.matchAll(/data-kanban-card="/g)].length, 3);
  assert.match(whitespace, /aria-label="Clear card filter"/);
  assert.doesNotMatch(whitespace, /data-kanban-no-results|Clear the filter to drag or reorder/);
  assert.doesNotMatch(render(KanbanSearchField, { query: "", onQueryChange: noop }), /autofocus/i);
});

test("an active edit remains in its lane without counting as a match; mobile offers matching-lane navigation", () => {
  const search = searchKanbanBoard(board, "auth", "3");
  const html = render(LaneColumn, { board, projectDir: board.projectDir, lane: board.lanes[0], isLast: false, sessions: [], runningIds: new Set(), awaitingIds: new Set(), unreadIds: new Set(), sessionIds: new Set(), form: { laneId: "a", cardId: "3" }, search: search.lanes[0], query: "auth", onOpenForm: noop, onOpenMenu: noop, onOpenLinkPicker: noop, onOpenSession: noop, onCardPointerDown: noop, onCardTouchMove: noop, onLaneHeaderPointerDown: noop, mobile: true });
  assert.match(html, /value="Other"/);
  assert.match(html, /data-kanban-lane-count="a"[^>]*>1\/2/);
  const empty = render(LaneColumn, { board, projectDir: board.projectDir, lane: board.lanes[1], sessions: [], sessionIds: new Set(), form: null, search: searchKanbanBoard(board, "Other").lanes[1], query: "Other", mobile: true, matchingLane: board.lanes[0], onShowMatchingLane: noop });
  assert.match(empty, /Show matches in Backlog/);
});

test("filtering leaves configuration reorder available but hidden cards still prevent lane removal", () => {
  for (const lane of [board.lanes[1], board.lanes[0]]) {
    const html = render(ConfigLaneRow, { lane, index: lane.fixed ? 0 : 1, count: 2, filtering: true, dragged: false, onGripPointerDown: noop, onMoveUp: noop, onMoveDown: noop, onRename: noop, onDelete: noop });
    assert.doesNotMatch(html, /aria-disabled="true"|Clear the filter/);
    for (const label of ["Move up", "Move down", "Remove lane"]) {
      const button = [...html.matchAll(/<button\b[^>]*>/g)].find(([tag]) => tag.includes(`aria-label="${label}`));
      assert.ok(button, label);
      if (lane.fixed || label === "Remove lane") assert.match(button[0], /disabled=""/);
      else assert.doesNotMatch(button[0], /disabled=""/);
    }
  }
});

test("loading retains the search/header frame without inviting typing into an about-to-remount field", () => {
  const html = render(KanbanBoard, { ...props, board: null });
  assert.match(html, /class="kanban-board-header"/);
  assert.match(html, /data-kanban-search[^>]*disabled=""/);
  assert.match(html, /aria-label="Configure lanes"/);
});

test("HTML-looking title and description remain escaped text, never live elements", () => {
  const html = render(KanbanBoardView, { ...props, board: { ...board, cards: [card("x", "a", "<script>AUTH</script>", "<img onerror=auth>")] } });
  assert.doesNotMatch(html, /<script>|<img onerror/);
  assert.match(html, /&lt;script&gt;<mark/);
});

test("a card's key is rendered and finds the card, like any other field", () => {
  const keyed = { ...board, cardPrefix: "PRJ", nextCardNumber: 4, cards: board.cards.map((entry, index) => ({ ...entry, number: index + 1 })) };
  const all = render(KanbanBoardView, { ...props, board: keyed, query: "" });
  assert.deepEqual([...all.matchAll(/data-kanban-card-key="([^"]+)"/g)].map((m) => m[1]).sort(), ["PRJ-1", "PRJ-2", "PRJ-3"]);
  // Typing the reference a commit message carries is the fastest way in.
  const byKey = render(KanbanBoardView, { ...props, board: keyed, query: "prj-2" });
  assert.deepEqual([...byKey.matchAll(/data-kanban-card="([^"]+)"/g)].map((m) => m[1]), ["2"]);
  assert.match(byKey, /<mark[^>]*>PRJ-2<\/mark>/i);
  // A board with no prefix yet renders no chips (an unloaded or legacy board).
  assert.doesNotMatch(all.replace(/data-kanban-card-key="[^"]*"/g, ""), /data-kanban-card-key/);
});

test("new labels exist in all locales", async () => {
  const keys = ["searchLabel", "searchPlaceholder", "searchClear", "searchCount", "searchLaneCount", "searchNoResults", "searchLaneNoMatches", "searchMatchingLane", "searchReorderDisabled"];
  const keyLabels = ["cardKeyTitle", "menuCopyKey", "configureCards", "configurePrefix", "configurePrefixInvalid", "configurePrefixHint", "configurePrefixAliases"];
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const source = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of [...keys, ...keyLabels]) assert.ok(source.includes(`"kanban.${key}":`), `${locale}: ${key}`);
  }
});
