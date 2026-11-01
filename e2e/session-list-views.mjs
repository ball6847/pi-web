import assert from "node:assert/strict";

/*
 * The session list's two views: the project groups and the flat list of
 * every session, the keyboard that walks the rows, and the chord that puts
 * the focus on the active session's row.
 *
 * The flat list is the answer to "which session was that?" when the project
 * is not known: one list, cut into day buckets, every row naming its
 * project (the groups' headers are gone, so the row says it).
 */

/** The focus's row key, or null when the focus is outside the tree. */
async function focusedRowKey(page) {
  return page.evaluate(() => document.activeElement?.closest("[data-row-key]")?.getAttribute("data-row-key") ?? null);
}

export async function checkSessionListViews(page) {
  const tree = page.locator(".session-tree-scroll");
  await tree.waitFor({ state: "visible" });
  // The groups: a project header per project.
  await page.locator(".session-tree-group-name").first().waitFor();

  // The flat list: every session in one list, cut into day buckets, each
  // row naming its project.
  const toggle = page.locator(".sidebar-view-toggle");
  await toggle.waitFor({ state: "visible" });
  await toggle.click();
  await page.locator(".session-tree-section-label").first().waitFor();
  const sections = await page.locator(".session-tree-section-label").allTextContents();
  assert.ok(sections.length > 0, "the flat list is cut into day buckets");
  assert.ok(await page.locator(".session-tree-session").count() > 0, "the flat list shows sessions");
  assert.ok(
    await page.locator(".session-tree-flat-meta .session-tree-project").count() > 0,
    "a flat row names its project, since the list has no group header",
  );

  // The keyboard: the arrow keys walk the rows.
  await page.locator(".session-tree-session .session-tree-main").first().focus();
  const first = await focusedRowKey(page);
  assert.ok(first, "a session row has the focus");
  await page.keyboard.press("ArrowDown");
  const second = await focusedRowKey(page);
  assert.notEqual(second, first, "the arrow key moves the focus to the next row");
  await page.keyboard.press("End");
  const last = await focusedRowKey(page);
  assert.notEqual(last, second, "End jumps to the last row");

  // `j` and `k` walk the rows like the arrows do.
  await page.locator(".session-tree-session .session-tree-main").first().focus();
  const beforeJ = await focusedRowKey(page);
  await page.keyboard.press("j");
  const afterJ = await focusedRowKey(page);
  assert.notEqual(afterJ, beforeJ, "j moves the focus to the next row");
  await page.keyboard.press("k");
  const afterK = await focusedRowKey(page);
  assert.equal(afterK, beforeJ, "k moves the focus back to the previous row");

  // The chord (Cmd/Ctrl+Shift+E, VSCode's "focus on the explorer"): the tree
  // takes the focus on the active session's row, from wherever the focus was.
  const composer = page.locator(".chat-input-textarea").first();
  await composer.waitFor({ state: "visible" });
  await composer.focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+E" : "Control+Shift+E");
  await page.waitForTimeout(400);
  const focused = await focusedRowKey(page);
  assert.ok(focused?.startsWith("session:"), `the chord focuses a session row (${focused})`);

  // The view's chord (Cmd/Ctrl+Shift+G): the flat list becomes the groups,
  // from the keyboard as well as from the toolbar's button.
  assert.equal(await page.locator(".session-tree-section-label").count() > 0, true, "the flat list is on show");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+G" : "Control+Shift+G");
  await page.locator(".session-tree-group-name").first().waitFor();
  assert.equal(await page.locator(".session-tree-section-label").count(), 0, "the chord brings the groups back");

  // The toolbar's search button opens the Quick Open palette, not the
  // sidebar's own search field.
  await page.locator(".sidebar-search-toggle").click();
  await page.waitForTimeout(300);
  assert.ok(await page.locator("[data-quick-open]").count() > 0, "the search button opens the palette");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}
