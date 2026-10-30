import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper, startRpcSession, setRpcSessionTools } = await jiti.import("./rpc-manager.ts");
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { readSubagentSessionResources, SUBAGENT_META_TYPE } = await jiti.import("./subagents.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
const { readBoard } = await jiti.import("./kanban-store.ts");
const READ_ONLY = ["read", "grep", "find", "ls"];
const CONTROL_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"];
const text = (result) => result.content.map((block) => block.text ?? "").join("");
const answer = () => fauxAssistantMessage([fauxText("done")]);

// Real RPC wrappers, resource loading, SDK tool validation/dispatch and QuickJS sandbox.
// Only model responses are synthetic; all board/session files live in the temporary agent dir.
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-web-kanban-runtime-")));
  const agentDir = join(dir, "agent"), cwd = join(dir, "project");
  const wrappers = new Set();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(cwd);
  await mkdir(join(agentDir, "agents"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "faux", defaultModel: "kanban-test", defaultTools: ["+codemode"],
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  allowFileRoot(cwd);
  const faux = fauxProvider({ models: [{ id: "kanban-test" }] });
  const originalCreate = ModelRuntime.create;
  t.mock.method(ModelRuntime, "create", async (...args) => {
    const runtime = await originalCreate.call(ModelRuntime, { ...args[0], refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    return runtime;
  });
  t.after(async () => {
    for (const wrapper of wrappers) if (wrapper.isAlive()) await wrapper.shutdown();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const keep = async (started) => {
    const wrapper = (await started).session;
    wrappers.add(wrapper);
    await wrapper.waitUntilReady();
    return wrapper;
  };
  const normal = (toolNames) => keep(startRpcSession(`__new__${crypto.randomUUID()}`, "", cwd, {
    ...(toolNames !== undefined ? { toolNames } : {}), initialModel: { provider: "faux", modelId: "kanban-test" },
  }));
  const reopen = async (wrapper) => {
    const id = wrapper.inner.sessionId, file = wrapper.sessionFile;
    await wrapper.shutdown();
    return keep(startRpcSession(id, file));
  };
  let callNumber = 0;
  const callDuring = async (run, getWrapper, name, args) => {
    const id = `kanban-runtime-${++callNumber}`;
    let declared;
    faux.setResponses([
      (context) => {
        declared = getCurrentTools(context.messages).map((tool) => tool.name);
        return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
      }, answer(),
    ]);
    await run();
    const result = getWrapper().inner.sessionManager.getEntries().findLast((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id)?.message;
    assert.ok(result, `missing ${name} result`);
    return { result, declared };
  };
  const call = (wrapper, name, args) => callDuring(() => wrapper.inner.prompt("Exercise the tool."), () => wrapper, name, args);
  const board = async () => {
    const result = await readBoard(cwd, { create: false });
    assert.equal(result.ok, true, result.error);
    return result;
  };
  const profile = (name, lines) => writeFile(join(agentDir, "agents", `${name}.md`),
    ["---", `description: ${name}`, ...lines, "---", "Complete the assigned task."].join("\n"));
  const children = (parent) => {
    let child;
    const byId = new Map();
    const paths = new Map();
    const controller = createSubagentController({
      getSession: (id) => id === parent.inner.sessionId ? parent : byId.get(id),
      registerSession(inner, options) {
        child = new AgentSessionWrapper(inner, options);
        child.start(); child.beginExtensionBinding();
        wrappers.add(child); byId.set(inner.sessionId, child); paths.set(inner.sessionId, child.sessionFile);
        return child;
      },
      async reopenSession(id, file) {
        child = await keep(startRpcSession(id, file)); byId.set(id, child); return child;
      },
      resolveSessionPath: async (id) => paths.get(id) ?? null,
      invalidateSessionList() {}, isBuiltInSubagentsEnabled: () => true,
    });
    const request = { parentContext: parent.inner, parentToolCallId: "delegate", task: "work", description: "work", runInBackground: false };
    const run = async (resume, name, args, profileName) => callDuring(async () => {
      const execution = resume
        ? await controller.extensionRuntime.resume({ ...request, sessionId: child.inner.sessionId })
        : await controller.extensionRuntime.start({ ...request, profile: profileName });
      const result = await execution.completion;
      assert.equal(result.status, "completed", result.error);
    }, () => child, name, args);
    return {
      get child() { return child; },
      spawn: (profileName, name, args) => run(false, name, args, profileName),
      resume: (name, args) => run(true, name, args),
    };
  };
  return { agentDir, cwd, faux, normal, reopen, call, board, profile, children, keep };
}

function assertKanban(wrapper) {
  assert.ok(wrapper.inner.getActiveToolNames().includes("kanban"));
  assert.equal(wrapper.inner.getAllTools().filter((tool) => tool.name === "kanban").length, 1);
}
function assertChildScope(wrapper) {
  assertKanban(wrapper);
  for (const name of CONTROL_TOOLS) assert.equal(wrapper.inner.getAllTools().some((tool) => tool.name === name), false);
}
function assertReadOnly(result) {
  assert.equal(result.isError, true, text(result));
  assert.match(text(result), /read.only/i);
}

const script = (title) => `const before = await tools.kanban({ action: "read" });
let mutation;
try { mutation = await tools.kanban({ action: "create", title: ${JSON.stringify(title)} }); }
catch (error) { mutation = { error: String(error) }; }
return JSON.stringify({ before, mutation, callable: Object.keys(tools) });`;

test("normal Kanban survives presets, reload and reopen; read-only direct and nested calls cannot mutate", async (t) => {
  const f = await fixture(t);
  let wrapper = await f.normal(READ_ONLY);
  assertKanban(wrapper);
  const read = await f.call(wrapper, "kanban", { action: "read" });
  assert.ok(read.declared.includes("kanban"));
  assert.equal(read.result.isError, false, text(read.result));
  assert.equal(existsSync(join(f.agentDir, "kanban")), false, "discovery creates no board directory");
  assertReadOnly((await f.call(wrapper, "kanban", { action: "create", title: "forbidden" })).result);
  const nested = await f.call(wrapper, "codemode", { code: script("nested forbidden") });
  assert.match(text(nested.result), /read.only/i);
  assert.deepEqual((await f.board()).board.cards, []);

  await setRpcSessionTools(wrapper.inner.sessionId, wrapper.sessionFile, ["read", "write"]);
  assertKanban(wrapper);
  const created = await f.call(wrapper, "kanban", { action: "create", title: "normal", laneId: "lane-todo" });
  assert.equal(created.result.isError, false, text(created.result));
  let board = await f.board();
  assert.equal(board.board.cards[0].sessionId, wrapper.inner.sessionId);
  await wrapper.send({ type: "reload" });
  assertKanban(wrapper);
  wrapper = await f.reopen(wrapper);
  assertKanban(wrapper);
  const moved = await f.call(wrapper, "kanban", { action: "update", laneId: "lane-done" });
  assert.equal(moved.result.isError, false, text(moved.result));
  board = await f.board();
  assert.equal(board.board.cards[0].laneId, "lane-done");

  await setRpcSessionTools(wrapper.inner.sessionId, wrapper.sessionFile, READ_ONLY);
  await wrapper.send({ type: "reload" });
  wrapper = await f.reopen(wrapper);
  assertReadOnly((await f.call(wrapper, "kanban", { action: "update", title: "forbidden edit" })).result);
  assert.deepEqual(await f.board(), board, "reopened read-only call leaves board and revision unchanged");
});

test("normal tree navigation retains the host Kanban tool even on a pre-Kanban branch", async (t) => {
  const f = await fixture(t);
  const wrapper = await f.normal(READ_ONLY);
  assertKanban(wrapper);
  wrapper.inner.setActiveToolsByName(wrapper.inner.getActiveToolNames().filter((name) => name !== "kanban"));
  f.faux.setResponses([answer()]);
  await wrapper.inner.prompt("old branch without kanban");
  const oldLeaf = wrapper.inner.sessionManager.getLeafId();
  wrapper.inner.setActiveToolsByName([...wrapper.inner.getActiveToolNames(), "kanban"]);
  await f.call(wrapper, "kanban", { action: "read" });
  const newLeaf = wrapper.inner.sessionManager.getLeafId();
  await wrapper.inner.navigateTree(oldLeaf, {});
  // pi 1.4 keeps an extension tool the target branch never added or removed,
  // so the host Kanban tool is already there; pi-web's own carry (the
  // navigate_tree below) is what kept it on the pi versions that dropped it.
  assert.equal(wrapper.inner.getActiveToolNames().includes("kanban"), true, "the host Kanban tool survives the branch switch");
  await wrapper.inner.navigateTree(newLeaf, {});
  await wrapper.send({ type: "navigate_tree", targetId: oldLeaf });
  assertKanban(wrapper);
  assertReadOnly((await f.call(wrapper, "kanban", { action: "create", title: "still read-only" })).result);
});

test("Chat-only gets no Kanban; an unpinned normal session with no coding defaults does", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultTools: [] }));
  const normal = await f.normal();
  assertKanban(normal);
  assert.equal((await f.call(normal, "kanban", { action: "create", title: "unpinned" })).result.isError, false);
  let chat = await f.normal([]);
  assert.deepEqual(chat.inner.getAllTools(), []);
  f.faux.setResponses([answer()]);
  await chat.inner.prompt("persist chat");
  await chat.send({ type: "reload" });
  chat = await f.reopen(chat);
  assert.deepEqual(chat.inner.getAllTools(), []);
});

for (const [name, lines, readOnly] of [
  ["writer", ["tools: read, write", "load_extensions: false", "load_skills: false"], false],
  ["reader", ["tools: read", "load_extensions: false", "load_skills: false"], true],
  ["extensions-only", ["tools: none", "load_extensions: true", "load_skills: false"], false],
  ["skills-only", ["tools: none", "load_extensions: false", "load_skills: true"], false],
  ["selected", ["tools: read, ext:alpha", "load_extensions: true", "load_skills: false"], true],
]) {
  test(`${name} child keeps Kanban eligibility and built-in read-only policy through reload, live resume and cold resume`, async (t) => {
    const f = await fixture(t);
    await f.profile(name, [...lines, "codemode: on"]);
    await mkdir(join(f.agentDir, "extensions"));
    await writeFile(join(f.agentDir, "extensions", "alpha.ts"), `export default function(pi) {
      for (const name of ["alpha_tool", "Agent", "get_subagent_result", "steer_subagent"]) pi.registerTool({
        name, label: name, description: name, parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }) });
    }`);
    const parent = await f.normal(["read", "write"]);
    const children = f.children(parent);
    const first = await children.spawn(name, "kanban", { action: "create", title: name, laneId: "lane-todo" });
    assertChildScope(children.child);
    const resources = readSubagentSessionResources(children.child.inner.sessionManager.getEntries());
    assert.ok(resources.tools.includes("kanban"), "host eligibility is persisted even with loadExtensions off");
    if (readOnly) assertReadOnly(first.result);
    else {
      assert.equal(first.result.isError, false, text(first.result));
      assert.equal((await f.board()).board.cards[0].sessionId, children.child.inner.sessionId);
    }
    const before = await f.board();
    // Editing the profile cannot change the running child's or reopened snapshot's policy.
    await f.profile(name, ["tools: none", "load_extensions: false", "load_skills: false"]);
    await children.child.send({ type: "reload" });
    assertChildScope(children.child);
    const resumed = await children.resume("codemode", { code: script(`${name}-nested`) });
    assert.equal(resumed.result.isError, false, text(resumed.result));
    assert.match(text(resumed.result), /kanban/);
    if (readOnly) {
      assert.match(text(resumed.result), /read.only/i);
      assert.deepEqual(await f.board(), before);
    } else assert.equal((await f.board()).board.cards.length, 2);
    for (const name of CONTROL_TOOLS) assert.doesNotMatch(text(resumed.result), new RegExp(`"${name}"`));
    // The runtime's resume must reopen from the existing snapshot, not re-resolve the profile.
    await children.child.shutdown();
    const cold = await children.resume("kanban", readOnly
      ? { action: "create", title: "cold forbidden" }
      : { action: "update", laneId: "lane-done" });
    assertChildScope(children.child);
    if (readOnly) assertReadOnly(cold.result);
    else {
      assert.equal(cold.result.isError, false, text(cold.result));
      assert.equal((await f.board()).board.cards.find((card) => card.sessionId === children.child.inner.sessionId).laneId, "lane-done");
    }
    const reopened = await f.reopen(children.child);
    assertChildScope(reopened);
    assert.equal((await f.call(reopened, "kanban", { action: "read" })).result.isError, false);
  });
}

test("a tools-only child needs neither loaded extensions nor Code mode to retain Kanban", async (t) => {
  const f = await fixture(t);
  await f.profile("plain", ["tools: read, write", "load_extensions: false", "load_skills: false"]);
  const children = f.children(await f.normal(["read", "write"]));
  const first = await children.spawn("plain", "kanban", { action: "create", title: "plain", laneId: "lane-todo" });
  assert.equal(first.result.isError, false, text(first.result));
  const expected = ["kanban", "read", "write"];
  assert.deepEqual(children.child.inner.getActiveToolNames().sort(), expected);
  assert.deepEqual(readSubagentSessionResources(children.child.inner.sessionManager.getEntries()).tools.sort(), expected);
  await children.child.send({ type: "reload" });
  assert.deepEqual(children.child.inner.getActiveToolNames().sort(), expected);
  const reopened = await f.reopen(children.child);
  assertChildScope(reopened);
  assert.deepEqual(reopened.inner.getActiveToolNames().sort(), expected);
  assert.equal((await f.call(reopened, "kanban", { action: "update", laneId: "lane-done" })).result.isError, false);
});

test("codemode only hides Kanban's declaration without bypassing its snapshot read-only policy", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ codemode: { mode: "only" } }));
  await f.profile("only", ["tools: read", "load_extensions: false", "load_skills: false", "codemode: on"]);
  const children = f.children(await f.normal(["read"]));
  const called = await children.spawn("only", "codemode", { code: script("must not write") });
  assertChildScope(children.child);
  assert.deepEqual(called.declared, ["codemode"]);
  assert.equal(called.result.isError, false, text(called.result));
  assert.match(text(called.result), /read.only/i);
  assert.deepEqual((await f.board()).board.cards, []);
});

test("Chat-only child has no Kanban on spawn, reload or reopen", async (t) => {
  const f = await fixture(t);
  await f.profile("chat", ["tools: none", "load_extensions: false", "load_skills: false"]);
  const children = f.children(await f.normal(["read"]));
  const called = await children.spawn("chat", "kanban", { action: "read" });
  assert.equal(called.result.isError, true);
  assert.deepEqual(called.declared, []);
  assert.deepEqual(children.child.inner.getAllTools(), []);
  assert.deepEqual(readSubagentSessionResources(children.child.inner.sessionManager.getEntries()).tools, []);
  await children.child.send({ type: "reload" });
  const reopened = await f.reopen(children.child);
  assert.deepEqual(reopened.inner.getAllTools(), []);
});

for (const loadExtensions of [false, true]) {
  test(`legacy child snapshot without Kanban never gains the host tool (loadExtensions=${loadExtensions})`, async (t) => {
    const f = await fixture(t);
    const manager = SessionManager.create(f.cwd);
    manager.appendCustomEntry(SUBAGENT_META_TYPE, {
      version: 1, parentSessionId: "legacy-parent", parentSessionPath: join(f.agentDir, "parent.jsonl"),
      resourceSnapshot: { version: 1, tools: ["read"], appendSystemPrompt: [], loadSkills: false,
        loadExtensions, ...(loadExtensions ? { allExtensionTools: true } : {}) },
    });
    manager.appendMessage({ role: "user", content: "legacy", timestamp: Date.now() });
    manager.appendMessage(answer());
    let wrapper = await f.keep(startRpcSession(manager.getSessionId(), manager.getSessionFile()));
    for (let pass = 0; pass < 2; pass++) {
      assert.equal(wrapper.inner.getAllTools().some((tool) => tool.name === "kanban"), false);
      await wrapper.send({ type: "reload" });
      assert.equal(wrapper.inner.getAllTools().some((tool) => tool.name === "kanban"), false);
      wrapper = await f.reopen(wrapper);
    }
  });
}
