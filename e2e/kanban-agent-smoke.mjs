// Real Next routes + Pi sessions + host Kanban tool, with a deterministic local
// provider (no credentials, network model calls, or changes to the user's board).
// Run: node e2e/kanban-agent-smoke.mjs
// For browser inspection: node e2e/kanban-agent-smoke.mjs --serve
// In --serve mode the manifest is test-results/kanban-agent-smoke/fixture.json;
// POST its delegateCommand to its delegatePath to advance the child card live.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
assert.ok(!existsSync(join(root, ".next/dev/lock")), "Use a checkout without an active dev server");
const artifacts = join(root, "test-results/kanban-agent-smoke");
mkdirSync(artifacts, { recursive: true });
const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-kanban-smoke-")));
const project = join(dir, "board-tool-demo");
mkdirSync(project);
mkdirSync(join(dir, "extensions"));
mkdirSync(join(dir, "agents"));
writeFileSync(join(dir, "agents/settings.json"), JSON.stringify({ builtInEnabled: true }));
writeFileSync(join(dir, "agents/board-worker.md"), `---
description: Deterministic board smoke worker
tools: read, write, edit
load_skills: false
load_extensions: true
---
Handle exactly the assigned board card. Claim it, record progress, then mark it done.
`);
writeFileSync(join(dir, "settings.json"), JSON.stringify({
  defaultProvider: "kanban-smoke", defaultModel: "board-model",
  defaultThinkingLevel: "off", defaultTools: ["read", "write", "edit"],
  enabledModels: ["kanban-smoke/board-model"],
}));
// Each extension runtime gets its own provider; response selection is derived
// from the transcript, so reloads/children cannot consume each other's queue.
writeFileSync(join(dir, "extensions/smoke.js"), `
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
export default function(pi) {
  const faux = fauxProvider({ provider: "kanban-smoke", api: "kanban-smoke-api", models: [{ id: "board-model", name: "Kanban smoke (local)" }] });
  const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  const reply = (text) => fauxAssistantMessage([fauxText(text)]);
  const choose = (context) => {
    const messages = context.messages;
    const userAt = messages.findLastIndex(m => m.role === "user");
    const user = messages[userAt];
    const prompt = typeof user?.content === "string" ? user.content : user?.content?.map(b => b.text ?? "").join("") ?? "";
    const results = messages.slice(userAt + 1).filter(m => m.role === "toolResult");
    if (results.some(m => m.isError)) return reply("SMOKE_TOOL_ERROR: " + JSON.stringify(results));
    if (prompt.includes("KANBAN_SMOKE_CHILD")) {
      const id = prompt.match(/KANBAN_SMOKE_CHILD ([\\w-]+)/)?.[1];
      const actions = [
        { action: "read", cardId: id },
        { action: "update", cardId: id, laneId: "lane-implement" },
        { action: "update", description: "Regression test added. Verification passed; ready for the next stage." },
        { action: "update", laneId: "lane-done" },
      ];
      return results.length < actions.length ? call("kanban", actions[results.length]) : reply("Delegated card verified and completed.");
    }
    if (prompt.includes("KANBAN_SMOKE_DELEGATE")) {
      const id = prompt.match(/KANBAN_SMOKE_DELEGATE ([\\w-]+)/)?.[1];
      return results.length === 0 ? call("Agent", {
        subagent_type: "board-worker", description: "Fix the unrelated flaky test",
        prompt: "KANBAN_SMOKE_CHILD " + id, run_in_background: false,
      }) : reply("The subagent completed its card. My original card remains linked to this conversation.");
    }
    if (prompt.includes("KANBAN_SMOKE_PARENT")) {
      const actions = [
        { action: "read" },
        { action: "create", title: "Ship minimal Kanban tools", description: "Parent owns this focused task.", laneId: "lane-plan" },
        { action: "create", title: "Fix unrelated flaky test", description: "Independent work for a dedicated subagent." },
      ];
      return results.length < actions.length ? call("kanban", actions[results.length]) : reply("Parent card is in Plan. Independent work is in Backlog, ready to delegate.");
    }
    return reply("Local deterministic smoke fixture; no external model was called.");
  };
  pi.registerProvider("kanban-smoke", {
    api: faux.api, apiKey: "local-fixture", baseUrl: "http://127.0.0.1:9",
    models: [{ id: "board-model", name: "Kanban smoke (local)", reasoning: false,
      input: ["text"], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      faux.setResponses([choose(context)]);
      return faux.provider.streamSimple(model, context, options);
    },
  });
}
`);

const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const serverLog = createWriteStream(join(artifacts, "server.log"));
const server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: root,
  env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_WEB_PASSWORD: "", PI_WEB_DISABLE_MCP: "1", NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.pipe(serverLog, { end: false });
server.stderr.pipe(serverLog, { end: false });
const stopped = once(server, "exit");
const stop = () => server.kill("SIGTERM");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
async function request(path, body) {
  const response = await fetch(base + path, {
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function until(fn, label) {
  const deadline = Date.now() + 120_000;
  do {
    assert.equal(server.exitCode, null, "Server exited; see server.log");
    const result = await fn();
    if (result) return result;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
try {
  await until(async () => fetch(base + "/api/home", { signal: AbortSignal.timeout(5000) }).then(r => r.ok).catch(() => false), "server ready");
  const created = await request("/api/agent/new", {
    cwd: project, type: "prompt", message: "KANBAN_SMOKE_PARENT",
    provider: "kanban-smoke", modelId: "board-model", toolNames: ["read", "edit", "write"],
  });
  const parentId = created.sessionId;
  assert.ok(parentId);
  const boardPath = `/api/kanban?cwd=${encodeURIComponent(project)}&create=0`;
  const initial = await until(async () => {
    const value = await request(boardPath);
    return value.board.cards.length === 2 ? value : false;
  }, "parent tool creates two cards");
  await until(async () => {
    const { state } = await request(`/api/agent/${parentId}?systemPrompt=0`);
    return state && !state.isStreaming && !state.isPromptRunning;
  }, "parent idle");
  const parentCard = initial.board.cards.find(c => c.sessionId === parentId);
  const childCard = initial.board.cards.find(c => c.sessionId === null);
  assert.equal(parentCard.title, "Ship minimal Kanban tools");
  assert.equal(parentCard.laneId, "lane-plan");
  assert.equal(childCard.laneId, "lane-backlog");
  const manifest = {
    base, project, agentDir: dir, parentId, parentCardId: parentCard.id, childCardId: childCard.id,
    boardUrl: `${base}/?session=${parentId}&board=${encodeURIComponent(project)}`,
    delegatePath: `/api/agent/${parentId}`,
    delegateCommand: { type: "prompt", message: `KANBAN_SMOKE_DELEGATE ${childCard.id}` },
  };
  writeFileSync(join(artifacts, "fixture.json"), JSON.stringify(manifest, null, 2));
  console.log("PASS: real model-issued read/create calls made parent Plan + child Backlog cards");
  if (process.argv.includes("--serve")) {
    console.log(`READY: ${manifest.boardUrl}\nManifest: ${join(artifacts, "fixture.json")}`);
    await stopped;
  } else {
    await request(manifest.delegatePath, manifest.delegateCommand);
    const done = await until(async () => {
      const value = await request(boardPath);
      return value.board.cards.find(c => c.id === childCard.id)?.laneId === "lane-done" ? value : false;
    }, "subagent claims and completes card");
    const child = done.board.cards.find(c => c.id === childCard.id);
    assert.ok(child.sessionId && child.sessionId !== parentId);
    assert.match(child.description, /Verification passed/);
    assert.deepEqual(done.board.cards.find(c => c.id === parentCard.id), parentCard);
    const transcript = await request(`/api/sessions/${child.sessionId}`);
    assert.ok(transcript.context.messages.some(m => m.role === "toolResult" && m.toolName === "kanban"));
    assert.ok(done.revision > initial.revision);
    await until(async () => {
      const { state } = await request(`/api/agent/${parentId}?systemPrompt=0`);
      return state && !state.isStreaming && !state.isPromptRunning;
    }, "delegation settled");
    console.log("PASS: real Agent child claims/partially updates/completes card; parent stays unchanged; transcript readable");
    writeFileSync(join(artifacts, "result.json"), JSON.stringify({ ...manifest, childId: child.sessionId, initial, done }, null, 2));
  }
} finally {
  stop();
  await stopped;
  serverLog.end();
  // Only this script's temporary fixture data; no user sessions or boards.
  rmSync(dir, { recursive: true, force: true });
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
