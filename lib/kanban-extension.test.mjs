import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { createKanbanExtension } = await createJiti(import.meta.url).import("./kanban-extension.ts");

async function tool(options) {
  const tools = [];
  const extension = createKanbanExtension(options);
  await extension.factory({ registerTool: (definition) => tools.push(definition) });
  assert.equal(tools.length, 1);
  return tools[0];
}
const context = (tools) => ({ cwd: "/must-not-touch", sessionManager: {
  getSessionId: () => "actor",
  getSessionName: () => "Actor",
  getEntries: () => tools === undefined ? [] : [{ type: "custom", customType: "pi-web:tool-selection", data: { version: 1, tools } }],
} });

test("registers one direct tool with flat schema, output schema, no hooks", async () => {
  const definition = await tool();
  assert.equal(definition.name, "kanban");
  assert.equal(definition.exposure, "direct");
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ["action", "cardId", "description", "laneId", "title"]);
  assert.ok(definition.outputSchema);
  assert.match(definition.description, /not idempotent|not retry|not blindly retry/i);
});

test("execute validates unknown/action-specific keys itself (not just SDK)", async () => {
  const definition = await tool();
  for (const request of [{ action: "read", title: "x" }, { action: "create", title: "x", cwd: "/wrong" }, { action: "update", advance: true }]) {
    const result = await definition.execute("id", request, undefined, undefined, context());
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "invalid-request");
    assert.match(result.content[0].text, /invalid-request/);
  }
});

test("default read-only policy is re-read on each execute, before store access", async () => {
  const definition = await tool();
  let selection = ["read"];
  const ctx = context();
  ctx.sessionManager.getEntries = () => context(selection).sessionManager.getEntries();
  const invoke = () => definition.execute("id", { action: "create", title: "blocked" }, undefined, undefined, ctx);
  const blocked = await invoke();
  assert.equal(blocked.isError, true);
  assert.equal(blocked.structuredContent.code, "read-only");
  selection = ["read", "write"];
  assert.notEqual((await invoke()).structuredContent.code, "read-only");
  selection = ["read"];
  assert.equal((await invoke()).structuredContent.code, "read-only");
  const read = await definition.execute("id", { action: "read" }, undefined, undefined, ctx);
  assert.notEqual(read.structuredContent.code, "read-only");
});

test("child callback receives current context and overrides normal persisted policy", async () => {
  let locked = true;
  const seen = [];
  const definition = await tool({ isReadOnly: (ctx) => { seen.push(ctx); return locked; } });
  const ctx = context(["read", "write"]);
  const invoke = () => definition.execute("parent/nested", { action: "create", title: "x" }, undefined, undefined, ctx);
  assert.equal((await invoke()).structuredContent.code, "read-only");
  locked = false;
  assert.notEqual((await invoke()).structuredContent.code, "read-only");
  assert.deepEqual(seen, [ctx, ctx]);
});
