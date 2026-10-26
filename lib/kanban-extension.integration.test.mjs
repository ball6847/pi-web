import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools, Type } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

const jiti = createJiti(import.meta.url);
const { createKanbanExtension } = await jiti.import("./kanban-extension.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
const { kanbanBoardPath, encodeKanbanProjectKey } = await jiti.import("./kanban-data.ts");
const { readBoard, getBoardRevision } = await jiti.import("./kanban-store.ts");
const { appendSessionToolSelection, appendClearedSessionToolSelection } = await jiti.import("./session-tool-selection.ts");

async function fixture(t, options) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "kanban-sdk-")));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  fs.mkdirSync(project);
  fs.mkdirSync(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  allowFileRoot(root);
  const faux = fauxProvider({ models: [{ id: "faux-model" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const nested = [];
  const services = await createAgentSessionServices({
    cwd: project, agentDir, modelRuntime, settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [createKanbanExtension(options), (pi) => pi.registerTool({
        name: "script", label: "Script", description: "Nested tool caller like codemode", parameters: Type.Object({ request: Type.Any() }),
        async execute(_id, params, signal, _onUpdate, ctx) {
          const result = await ctx.executeTool("kanban", params.request, { signal });
          nested.push(result);
          return { ...result.result, isError: result.isError };
        },
      })],
    },
  });
  const manager = SessionManager.create(project, join(agentDir, "sessions", encodeKanbanProjectKey(project)));
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel("faux-model") });
  t.after(() => {
    session.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  // ToolInfo and persisted transcript messages omit outputSchema/structuredContent;
  // active definitions and execution events carry them, as do nested outcomes.
  const definition = session.agent.state.tools.find((tool) => tool.name === "kanban");
  const executions = [];
  session.subscribe((event) => { if (event.type === "tool_execution_end") executions.push(event); });
  const invoke = async (request, via = "kanban") => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(via, via === "script" ? { request } : request)], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    await session.prompt("Use the requested tool.");
    const message = session.agent.state.messages.findLast((m) => m.role === "toolResult" && m.toolName === via);
    const execution = executions.findLast((e) => e.toolName === via && !e.parentToolCallId);
    assert.deepEqual(message.content, execution.result.content);
    assert.deepEqual(message.details, execution.result.details);
    return { ...execution.result, isError: execution.isError };
  };
  const output = (message) => {
    assert.equal(message?.isError, false, JSON.stringify(message));
    assert.equal(Check(definition.outputSchema, message.structuredContent), true, JSON.stringify(message.structuredContent));
    assert.deepEqual(JSON.parse(message.content[0].text), message.structuredContent, "model receives the same data as scripts");
    return message.structuredContent;
  };
  return { project, manager, session, faux, nested, definition, invoke, output, path: kanbanBoardPath(project) };
}

test("real SDK declares the flat tool; model and nested calls persist cards and matching typed content", async (t) => {
  const f = await fixture(t);
  assert.ok(f.session.getActiveToolNames().includes("kanban"));
  assert.ok(f.session.getCallableToolNames().includes("kanban"));
  assert.equal(f.definition.parameters.type, "object");
  const before = f.output(await f.invoke({ action: "read" }));
  assert.equal(before.revision, 0);
  assert.equal(before.currentCardId, null);
  assert.equal(fs.existsSync(f.path), false, "discovery creates no board file");
  const created = f.output(await f.invoke({ action: "create", title: "independent", description: "keep" }));
  assert.equal(created.card.sessionId, null);
  assert.equal(created.lane.id, "lane-backlog");
  const claimed = f.output(await f.invoke({ action: "update", cardId: created.card.id, laneId: "lane-plan", title: "claimed" }, "script"));
  assert.equal(claimed.card.sessionId, f.session.sessionId);
  assert.equal(claimed.card.description, "keep");
  assert.equal(claimed.currentCardId, created.card.id);
  assert.equal(f.nested.at(-1).isError, false);
  const done = f.output(await f.invoke({ action: "update", laneId: "lane-done", description: "" }));
  assert.equal(done.nextLaneId, null);
  assert.equal(done.revision, claimed.revision + 1);
  const same = f.output(await f.invoke({ action: "update", laneId: "lane-done" }));
  assert.equal(same.revision, done.revision);
  const read = f.output(await f.invoke({ action: "read", cardId: done.card.id }, "script"));
  assert.deepEqual(read.cards, [done.card]);
  assert.equal((await getBoardRevision(f.project)).revision, same.revision);
  assert.deepEqual((await readBoard(f.project, { create: false })).board.cards, [done.card]);
  let declared;
  f.faux.setResponses([(context) => {
    declared = getCurrentTools(context.messages).find((tool) => tool.name === "kanban");
    return fauxAssistantMessage([fauxText("done")]);
  }]);
  await f.session.prompt("Check declarations.");
  assert.ok(declared);
  assert.deepEqual(Object.keys(declared.parameters.properties).sort(), ["action", "cardId", "description", "laneId", "title"]);
});

test("real SDK read-only pin blocks direct AND nested mutations, allows reads, follows later selections", async (t) => {
  const f = await fixture(t);
  appendSessionToolSelection(f.manager, ["read", "grep", "find", "ls"]);
  for (const via of ["kanban", "script"]) {
    const read = f.output(await f.invoke({ action: "read" }, via));
    assert.equal(read.revision, 0);
    for (const request of [{ action: "create", title: "blocked" }, { action: "update", title: "blocked" }]) {
      const result = await f.invoke(request, via);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.code, "read-only");
      assert.equal(Check(f.definition.outputSchema, result.structuredContent), true);
      assert.match(result.content[0].text, /read-only/);
      assert.equal(fs.existsSync(f.path), false);
    }
  }
  appendSessionToolSelection(f.manager, ["read", "write"]);
  const created = f.output(await f.invoke({ action: "create", title: "allowed", laneId: "lane-todo" }, "script"));
  appendSessionToolSelection(f.manager, ["read"]);
  assert.equal((await f.invoke({ action: "update", title: "blocked" }, "script")).isError, true);
  assert.equal((await getBoardRevision(f.project)).revision, created.revision);
  appendClearedSessionToolSelection(f.manager);
  assert.equal(f.output(await f.invoke({ action: "update", title: "allowed again" })).card.title, "allowed again");
});

test("real SDK child callback is authoritative and queried on nested calls", async (t) => {
  let readOnly = true;
  const seen = [];
  const f = await fixture(t, { isReadOnly: (ctx) => { seen.push(ctx.sessionManager.getSessionId()); return readOnly; } });
  appendSessionToolSelection(f.manager, ["write"]);
  assert.equal((await f.invoke({ action: "create", title: "blocked" }, "script")).structuredContent.code, "read-only");
  readOnly = false;
  appendSessionToolSelection(f.manager, ["read"]);
  assert.equal(f.output(await f.invoke({ action: "create", title: "allowed" }, "script")).card.title, "allowed");
  assert.deepEqual(seen, [f.session.sessionId, f.session.sessionId]);
});

test("real SDK rejects unknown/action-specific fields and malformed patches without writes", async (t) => {
  const f = await fixture(t);
  for (const via of ["kanban", "script"]) {
    for (const request of [{ action: "read", title: "forbidden" }, { action: "create", title: "x", extra: true }, { action: "create", title: "x", cardId: "forbidden" }, { action: "update" }, { action: "update", description: null }, { action: "update", title: " " }]) {
      const result = await f.invoke(request, via);
      assert.equal(result.isError, true, JSON.stringify({ request, result }));
      assert.equal(fs.existsSync(f.path), false);
    }
  }
});
