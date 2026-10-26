import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { renderHook } from "../hooks/__fixtures__/react-hook-shim.mjs";

const path = (url) => fileURLToPath(new URL(url, import.meta.url)).replaceAll("\\", "/");
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" }, tsconfigPaths: true,
  alias: { "react/jsx-runtime": path("../node_modules/react/jsx-runtime.js"), react: path("../hooks/__fixtures__/react-hook-shim.mjs"), [path("../hooks/useI18n")]: path("./__fixtures__/kanban-i18n.mjs") },
});
const { KanbanSearchField, KanbanSearchStyles } = await jiti.import("./KanbanSearch.tsx");
function descendants(node) {
  if (!node || typeof node !== "object") return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(descendants)];
}
function field(query = "auth") {
  let value = query;
  const hook = renderHook(KanbanSearchField, { query, onQueryChange: next => { value = next; } });
  const nodes = descendants(hook.result);
  const input = nodes.find(n => n.type === "input");
  const clear = nodes.find(n => n.type === "button");
  let focus = 0;
  input.props.ref.current = { focus() { focus++; } };
  return { input, clear, get value() { return value; }, get focus() { return focus; } };
}
function key(overrides = {}) {
  return { key: "Escape", nativeEvent: { isComposing: false }, keyCode: 27, defaultPrevented: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides };
}

test("mobile input renders at 14px without dropping Safari's 16px focus-zoom threshold", () => {
  const hook = renderHook(KanbanSearchField, { query: "auth", onQueryChange() {} });
  const slot = descendants(hook.result).find(n => n.props?.className === "kanban-search-input-slot");
  assert.ok(slot, "a separate slot scales only the input, not its icon or clear target");
  assert.equal(descendants(slot).filter(n => n.type === "input").length, 1);
  assert.equal(descendants(slot).filter(n => n.type === "button").length, 0);
  const styles = KanbanSearchStyles().props.children;
  const mobile = styles.slice(styles.indexOf("@media (max-width: 640px)"));
  assert.match(mobile, /font-size: 16px/);
  assert.match(mobile, /scale\(0\.875\)/);
  assert.match(mobile, /width: calc\(100% \/ 0\.875\)/, "inverse width keeps the entire input slot usable");
  assert.match(mobile, /height: calc\(100% \/ 0\.875\)/, "tap height must not shrink with the text");
  assert.match(mobile, /button \{ width: 32px; height: 32px;/);
  hook.unmount();
});

test("typing is immediate; clearing raw whitespace restores focus without a pointer blur", () => {
  const f = field("  ");
  assert.ok(f.clear);
  const down = key();
  f.clear.props.onMouseDown(down);
  assert.equal(down.prevented, true);
  f.clear.props.onClick();
  assert.equal(f.value, "");
  assert.equal(f.focus, 1);
  f.input.props.onChange({ target: { value: "Title" } });
  assert.equal(f.value, "Title");
  assert.equal(f.input.props.autoFocus, undefined);
});

test("input Escape clears only its own query, guards IME and respects a nearer handler", () => {
  for (const overrides of [{ nativeEvent: { isComposing: true } }, { keyCode: 229 }, { defaultPrevented: true }, { key: "Enter" }]) {
    const f = field();
    const event = key(overrides);
    f.input.props.onKeyDown(event);
    assert.equal(f.value, "auth");
    assert.equal(event.prevented, undefined);
    assert.equal(event.stopped, undefined);
  }
  const f = field();
  const escape = key();
  f.input.props.onKeyDown(escape);
  assert.equal(f.value, "");
  assert.equal(escape.prevented, true);
  assert.equal(escape.stopped, true);
  const empty = field("");
  const event = key();
  empty.input.props.onKeyDown(event);
  assert.equal(event.prevented, undefined);
});
