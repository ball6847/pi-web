// The card menu on a phone must survive the soft keyboard it may raise
// (issue: the menu opened and vanished at once). The filter field takes focus,
// `interactiveWidget: "resizes-content"` (app/layout.tsx) resizes the layout
// viewport for the keyboard, and the board used to close its menu on every
// `window.resize` — one frame after opening. The keyboard's own resizes are
// now told apart from a real one (lib/soft-keyboard.ts), and the menu re-places
// itself into the visual viewport instead (hooks/useFloatingPlacement.ts).
//
// A real turn of the device still closes it: its anchor rectangle would point
// at nothing.
import assert from "node:assert/strict";

const MENU = "[data-kanban-card-menu]";
const CARD = "[data-kanban-card]";

export async function checkKanbanCardMenuOnPhone({ browser, base, project, sessionId, post }) {
  // A title of its own: a re-run of this file finds its card again, and the
  // cleanup below removes exactly that one.
  const title = `E2E card menu keyboard ${Date.now()}`;
  const created = await post("/api/kanban", {
    cwd: project,
    action: "add-card",
    laneId: "lane-plan",
    title,
  });
  const cardId = created.board?.cards?.find((entry) => entry.title === title)?.id;
  assert.ok(cardId, "the fixture card exists");

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    locale: "en-US",
  });
  const errors = [];
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (event) => { if (event.type() === "error") errors.push(event.text()); });

  const cdp = await context.newCDPSession(page);
  /** What the keyboard does to the layout viewport under `interactiveWidget: "resizes-content"`. */
  const setViewport = (width, height) =>
    cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 3, mobile: true });

  try {
    await page.goto(`${base}/?session=${sessionId}`, { waitUntil: "domcontentloaded" });
    await page.locator('button[title="Board"]').first().click();
    const card = page.locator(`${CARD}[data-kanban-card="${cardId}"]`);
    await card.waitFor();
    await card.locator('button[aria-label="Card actions"]').click();
    await page.locator(MENU).waitFor();
    assert.ok(
      await page.locator(`${MENU} button[role="menuitem"]`).count() > 6,
      "the menu is long enough to show its filter",
    );
    // The bug: the keyboard opens (the layout viewport shrinks by a
    // keyboard-sized band under `interactiveWidget: "resizes-content"`) and the
    // board's own resize listener closed the menu one frame after it opened.
    await setViewport(390, 464);
    await page.waitForTimeout(600);
    assert.equal(await page.locator(MENU).count(), 1, "the keyboard's resize must not close the card menu");
    const box = await page.locator(MENU).boundingBox();
    assert.ok(box, "the menu is still laid out");
    assert.ok(box.y + box.height <= 464, `the menu stays above the keyboard (bottom ${Math.round(box.y + box.height)} > 464)`);

    // The keyboard closes again: still there.
    await setViewport(390, 844);
    await page.waitForTimeout(600);
    assert.equal(await page.locator(MENU).count(), 1, "the keyboard closing must not close the card menu");

    // The menu has no filter field at all, on any device: a card menu is a
    // handful of rows, the field cost a tap on a phone and covered them with
    // the keyboard it raised.
    assert.equal(await page.locator(`${MENU} input`).count(), 0, "the menu has no filter field");
    assert.ok(await page.locator(`${MENU} button[role="menuitem"]`).count() > 6, "every action is listed");
    assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), "INPUT", "nothing raised the keyboard");

    // A real resize — the phone turned — leaves the anchor pointing at nothing.
    await setViewport(844, 390);
    await page.waitForTimeout(600);
    assert.equal(await page.locator(MENU).count(), 0, "turning the device closes the card menu");

    assert.deepEqual(errors, [], "no page errors");
  } finally {
    await context.close();
    // The card may already be gone (a cleanup from an earlier run); the delete is best-effort.
    await post("/api/kanban", { cwd: project, action: "delete-card", cardId }).catch(() => {});
  }
}
