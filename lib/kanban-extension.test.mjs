import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { createKanbanExtension, kanbanCardNotice, kanbanBoardLanesText, KANBAN_CARD_NOTICE_TYPE } = await jiti.import("./kanban-extension.ts");
const { defaultLanes } = await jiti.import("./kanban-types.ts");
const lanes = defaultLanes();

async function harness(options) {
  const tools = [];
  const handlers = new Map();
  const extension = createKanbanExtension(options);
  await extension.factory({ registerTool: (definition) => tools.push(definition), on: (event, handler) => handlers.set(event, handler) });
  assert.equal(tools.length, 1);
  return { definition: tools[0], beforeAgentStart: handlers.get("before_agent_start") };
}

async function tool(options) {
  return (await harness(options)).definition;
}
const context = (tools) => ({ cwd: "/must-not-touch", sessionManager: {
  getSessionId: () => "actor",
  getSessionName: () => "Actor",
  getEntries: () => tools === undefined ? [] : [{ type: "custom", customType: "pi-web:tool-selection", data: { version: 1, tools } }],
} });

test("registers one direct tool with flat schema and output schema, plus the card notice hook", async () => {
  const definition = await tool();
  assert.equal(definition.name, "kanban");
  assert.equal(definition.exposure, "direct");
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ["action", "cardId", "description", "laneId", "limit", "query", "title"]);
  assert.ok(definition.outputSchema);
  assert.match(definition.description, /not idempotent|not retry|not blindly retry/i);
  assert.equal(typeof (await harness()).beforeAgentStart, "function");
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
  // Discovery reads cover search too: only create/update are gated.
  const search = await definition.execute("id", { action: "search", query: "x" }, undefined, undefined, ctx);
  assert.notEqual(search.structuredContent.code, "read-only");
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

test("the notice's state is the link and the lane ids: a move or a rename is not a state transition", () => {
  const card = { id: "card-1", title: "Ship it", description: "long body", laneId: "lane-todo", sessionId: "me", sessionTitle: "Me", createdAt: 1, updatedAt: 1 };
  const notice = kanbanCardNotice(lanes, card);
  assert.equal(notice.state.card, "card-1");
  assert.equal(notice.state.lanes, JSON.stringify(lanes.map((lane) => lane.id)));
  // The move/rename case: same link, same lanes, so nothing to say.
  const moved = kanbanCardNotice(lanes, { ...card, laneId: "lane-done", title: "Renamed" });
  assert.deepEqual(moved.state, notice.state);
  const renamedLane = kanbanCardNotice(lanes.map((lane) => lane.id === "lane-plan" ? { ...lane, name: "Planned" } : lane), card);
  assert.deepEqual(renamedLane.state, notice.state, "a lane id did not change");
  assert.equal(KANBAN_CARD_NOTICE_TYPE, "pi-web:kanban-card");
});

test("the card line is one link sentence, and the body and instructions stay out of it", () => {
  const card = { id: "0f3b9a1c-0000-4000-8000-000000000007", title: "Ship it", description: "long body", laneId: "lane-todo", sessionId: "me", sessionTitle: "Me", createdAt: 1, updatedAt: 1 };
  const tracked = kanbanCardNotice(lanes, card, { lanesChanged: false });
  assert.equal(tracked.content, `Kanban: this session is on card ${card.id}. Always keep its lane matching your actual status with kanban update (no cardId).`);
  for (const absent of ["Ship it", "long body", "lane-todo", "kanban read"]) {
    assert.equal(tracked.content.includes(absent), false, `"${absent}" must not be in the notice`);
  }
  assert.equal(kanbanCardNotice(lanes, null, { lanesChanged: false }).content, "", "untracked and unchanged says nothing");
  assert.equal(
    kanbanCardNotice(lanes, card, { cardChanged: false }).content,
    `Kanban lanes in board order: ${kanbanBoardLanesText(lanes)}`,
    "a lane change alone never re-sends the card line",
  );
  assert.equal(kanbanCardNotice(lanes, null, { wasTracked: true, lanesChanged: false }).content, "Kanban: this session is no longer on a Kanban card.");
});

test("the lanes line is bare ids in board order and bounds itself", () => {
  assert.equal(
    kanbanBoardLanesText(lanes),
    "lane-backlog,lane-todo,lane-plan,lane-implement,lane-deploy,lane-done",
  );
  const notice = kanbanCardNotice(lanes, null);
  assert.equal(notice.content, `Kanban lanes in board order: ${kanbanBoardLanesText(lanes)}`);
  assert.ok(notice.content.length < 130, `notice was ${notice.content.length} chars`);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `lane-${i}`, name: `L${i}` }));
  const text = kanbanBoardLanesText(many);
  assert.match(text, /lane-23 \+6 more \(kanban read lists them\)/);
  assert.equal(text.includes("lane-24"), false);
});

test("an unreadable board never blocks a run and says nothing", async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.mkdtempSync(join(tmpdir(), "kanban-notice-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
  const { beforeAgentStart } = await harness();
  // A folder outside the allowed roots: the store refuses, the run continues.
  assert.equal(await beforeAgentStart({}, context()), undefined);
});
