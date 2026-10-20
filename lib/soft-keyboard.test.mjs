import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  SOFT_KEYBOARD_MIN_HEIGHT_PX,
  isSoftKeyboardOpen,
  isSoftKeyboardResize,
  softKeyboardBand,
} = await jiti.import("./soft-keyboard.ts");
const boardSource = await readFile(new URL("../components/KanbanBoard.tsx", import.meta.url), "utf8");

// The report this covers: on a phone the card menu opened and was gone again.
// The filter field raised the soft keyboard; `interactiveWidget:
// "resizes-content"` resized the layout viewport; the board's own
// `window.resize` listener closed the menu one frame after it opened.

test("the keyboard's band is the visual viewport's shortfall at the current zoom", () => {
  assert.equal(softKeyboardBand({ innerHeight: 844, viewportHeight: 510, viewportScale: 1 }), 334);
});

test("a pinch zoom shrinks both viewports together: no keyboard band", () => {
  assert.equal(softKeyboardBand({ innerHeight: 844, viewportHeight: 422, viewportScale: 2 }), 0);
});

test("a keyboard-sized band counts as open, browser chrome does not", () => {
  assert.equal(isSoftKeyboardOpen({ innerHeight: 844, viewportHeight: 510, viewportScale: 1 }), true);
  assert.equal(isSoftKeyboardOpen({ innerHeight: 844, viewportHeight: 844, viewportScale: 1 }), false);
  // A Safari toolbar shift stays under the threshold.
  assert.equal(isSoftKeyboardOpen({
    innerHeight: 844,
    viewportHeight: 844 - (SOFT_KEYBOARD_MIN_HEIGHT_PX - 1),
    viewportScale: 1,
  }), false);
});

test("a height-only resize is the keyboard's, a width change is a real resize", () => {
  assert.equal(isSoftKeyboardResize({ width: 390, height: 844 }, { width: 390, height: 510 }), true);
  assert.equal(isSoftKeyboardResize({ width: 390, height: 510 }, { width: 390, height: 844 }), true);
  // Turning the phone, or a window drag: a new anchor is needed.
  assert.equal(isSoftKeyboardResize({ width: 390, height: 844 }, { width: 844, height: 390 }), false);
  // Nothing moved.
  assert.equal(isSoftKeyboardResize({ width: 390, height: 844 }, { width: 390, height: 844 }), false);
});

test("the keyboard's own resize never closes the card menu", () => {
  // The listener still closes on a real resize...
  assert.match(boardSource, /if \(previous && !isRealResize\(previous, next\)\) return;/);
  assert.match(boardSource, /setMenuFor\(null\);\n      setLinkFor\(null\);/);
  // ...after the keyboard check, so a keyboard's band returns before the close.
  const listener = boardSource.slice(boardSource.indexOf("const onResize = () => {"));
  assert.ok(
    listener.indexOf("isRealResize") < listener.indexOf("setMenuFor(null)"),
    "the keyboard check must come before the close",
  );
});

test("the card menu re-places instead of depending on a fixed viewport", () => {
  assert.match(boardSource, /const floating = useFloatingPlacement\(true\);/);
  assert.match(boardSource, /return floating\.subscribePlacement\(place\);/);
  // Clamped to the visual viewport, not innerHeight, so an iOS keyboard covers nothing.
  assert.doesNotMatch(boardSource.slice(boardSource.indexOf("export function CardMenu("),
    boardSource.indexOf("// -- session picker (portal)")), /window\.innerWidth/);
});

test("the card menu has no filter field: the list is the list", () => {
  const cardMenu = boardSource.slice(boardSource.indexOf("export function CardMenu("),
    boardSource.indexOf("// -- session picker (portal)"));
  // A card menu is a handful of rows. The field cost a tap on a phone, raised
  // a keyboard over the very rows it narrowed, and unmounted itself (caret
  // and all) once a query left six of them: it is gone rather than tuned.
  assert.doesNotMatch(cardMenu, /<input/);
  assert.doesNotMatch(cardMenu, /useState\(""\)/);
  assert.doesNotMatch(cardMenu, /menuFilter|menuNoMatch/);
  // The entries map straight through, and a menu is never empty.
  assert.match(cardMenu, /\{entries\.map\(\(entry\) => \{/);
  assert.doesNotMatch(cardMenu, /visible\.length === 0/);
  // Focus lands on the first action, which is what arrows and Enter walk from.
  assert.match(cardMenu, /querySelector<HTMLElement>\("button\[role='menuitem'\]:not\(:disabled\)"\)\?\.focus\(\{ preventScroll: true \}\)/);
  // Escape closes on the first press: there is no query to clear.
  assert.match(cardMenu, /if \(event\.key === "Escape"\) \{\n        event\.preventDefault\(\);\n        event\.stopPropagation\(\);\n        close\(\);/);
});
