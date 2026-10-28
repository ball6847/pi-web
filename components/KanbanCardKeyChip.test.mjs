// The card's key chip: one press puts the reference on the clipboard and says
// so, and the press never reaches the card underneath (a board card opens or
// starts a drag from a press — copying the key must do neither).
//
// The chip is driven through the hook shim, so the state it flashes is the
// component's own; the clipboard is a fixture that can accept or refuse.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { renderHook } from "../hooks/__fixtures__/react-hook-shim.mjs";

const path = (url) => fileURLToPath(new URL(url, import.meta.url)).replaceAll("\\", "/");
const calls = [];
let refuse = false;
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
  alias: {
    "react/jsx-runtime": path("../node_modules/react/jsx-runtime.js"),
    react: path("../hooks/__fixtures__/react-hook-shim.mjs"),
    [path("../hooks/useI18n")]: path("./__fixtures__/kanban-i18n.mjs"),
    [path("../lib/clipboard")]: path("./__fixtures__/kanban-key-clipboard.mjs"),
  },
});
const { KanbanCardKeyChip, KANBAN_CARD_KEY_COPIED_MS } = await jiti.import("./KanbanCardKeyChip.tsx");
const clipboardFixture = await jiti.import("./__fixtures__/kanban-key-clipboard.mjs");
clipboardFixture.setCopy((text) => {
  calls.push(text);
  return refuse ? Promise.reject(new Error("denied")) : Promise.resolve();
});

function nodes(node) {
  if (!node || typeof node !== "object") return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}
const button = (view) => nodes(view.result).find((node) => node.type === "button");
const status = (view) => nodes(view.result).find((node) => node.props?.role === "status");
const check = (view) => nodes(button(view)).some((node) => node.type?.name === "CheckIcon");

test("a click copies the key, confirms it, and lets the card beneath it rest", async () => {
  calls.length = 0;
  refuse = false;
  const view = renderHook(KanbanCardKeyChip, { cardKey: "PIW-42", query: "piw" });
  const chip = button(view);
  assert.equal(chip.props["data-kanban-card-key"], "PIW-42");
  assert.equal(chip.props["data-copied"], undefined, "a fresh chip is quiet");
  // The board card opens on click and picks up on pointerdown: neither may see this press.
  let reachedCard = 0;
  const press = { stopPropagation: () => { reachedCard += 1; } };
  chip.props.onPointerDown(press);
  chip.props.onClick(press);
  await Promise.resolve();
  view.flush();
  assert.deepEqual(calls, ["PIW-42"]);
  assert.equal(reachedCard, 2, "click and pointerdown are both stopped");
  assert.equal(button(view).props["data-copied"], "true");
  assert.ok(check(view), "the confirmation carries a check");
  assert.equal(status(view).props.children, "kanban.cardKeyCopied");
  // The chip hands the board's filter query to the key's highlighter, so a
  // typed reference marks its own key.
  const highlight = nodes(button(view)).find((node) => node.type?.name === "KanbanSearchText");
  assert.equal(highlight?.props.query, "piw");
  view.unmount();
});

test("the confirmation is temporary: the chip goes quiet again", async () => {
  calls.length = 0;
  refuse = false;
  const view = renderHook(KanbanCardKeyChip, { cardKey: "PIW-43" });
  button(view).props.onClick({ stopPropagation() {} });
  await Promise.resolve();
  view.flush();
  assert.equal(button(view).props["data-copied"], "true");
  await new Promise((resolve) => setTimeout(resolve, KANBAN_CARD_KEY_COPIED_MS + 60));
  view.flush();
  assert.equal(button(view).props["data-copied"], undefined);
  view.unmount();
});

test("a refused write never claims a copy", async () => {
  calls.length = 0;
  refuse = true;
  const view = renderHook(KanbanCardKeyChip, { cardKey: "PIW-44", variant: "detail" });
  const chip = button(view);
  assert.equal(chip.props["data-kanban-detail-key"], "PIW-44", "the detail tab keeps its own marker");
  chip.props.onClick({ stopPropagation() {} });
  await Promise.resolve();
  view.flush();
  assert.deepEqual(calls, ["PIW-44"]);
  assert.equal(button(view).props["data-copied"], undefined);
  assert.ok(!check(view));
  assert.equal(status(view).props.children, "kanban.cardKeyCopyFailed");
  view.unmount();
});

test("the board card's marker is not duplicated onto a detail chip", () => {
  refuse = false;
  const board = renderHook(KanbanCardKeyChip, { cardKey: "PIW-45" });
  assert.equal(button(board).props["data-kanban-card-key"], "PIW-45");
  assert.equal(button(board).props["data-kanban-detail-key"], undefined);
  board.unmount();
});
