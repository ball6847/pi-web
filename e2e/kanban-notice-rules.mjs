// E2E smoke: the three kanban injection rules, against a real SDK session.
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// Run from the repo root: `node e2e/kanban-notice-rules.mjs`.
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
const jiti = createJiti(join(here, "..", "lib", "kanban-extension.ts"));
const { createKanbanExtension } = await jiti.import(join(here, "..", "lib", "kanban-extension.ts"));
const { allowFileRoot } = await jiti.import(join(here, "..", "lib", "file-access.ts"));
const { encodeKanbanProjectKey } = await jiti.import(join(here, "..", "lib", "kanban-data.ts"));
const { applyMutation, attachNewSessionCard } = await jiti.import(join(here, "..", "lib", "kanban-store.ts"));

const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "piweb50-e2e-")));
const project = join(root, "project"), agentDir = join(root, "agent");
fs.mkdirSync(project); fs.mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
allowFileRoot(root);
const faux = fauxProvider({ models: [{ id: "faux-model" }] });
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
modelRuntime.registerNativeProvider(faux.provider);
const services = await createAgentSessionServices({
  cwd: project, agentDir, modelRuntime, settingsManager: SettingsManager.inMemory(),
  resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [createKanbanExtension()] },
});
const manager = SessionManager.create(project, join(agentDir, "sessions", encodeKanbanProjectKey(project)));
const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel("faux-model") });
const sessionId = session.sessionId;
const notices = () => session.agent.state.messages.filter((m) => m.role === "custom" && m.customType === "pi-web:kanban-card");
const run = async (label) => { faux.setResponses([fauxAssistantMessage([fauxText("ok")])]); await session.prompt(label); };

// Lane rules on Plan and Done, like a real board.
await applyMutation(project, { action: "edit-lane", laneId: "lane-plan", instructions: "Plan: write the plan first.\nThen ask for review." });
await applyMutation(project, { action: "edit-lane", laneId: "lane-implement", instructions: "Implement: code it, smoke test it." });
await applyMutation(project, { action: "edit-lane", laneId: "lane-done", instructions: "Done: clean up, stop the server." });

// ---- RULE 2: a session that starts WITHOUT a card is injected with nothing.
await run("rule 2: first turn, no card");
assert.equal(notices().length, 0, "RULE 2 FAILED: a cardless session saw a kanban notice");
console.log("RULE 2 OK — cardless session: 0 notices");
for (const f of (function walk(d){return fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(d,e.name)):[join(d,e.name)])})(agentDir)) console.log("  file:", f);

// ---- RULE 3: attach DURING the session -> next turn = the full prompt.
let attached = await applyMutation(project, { action: "create-card-for-session", sessionId, sessionTitle: "smoke", laneId: "lane-todo" });
for (let i = 0; i < 10 && !attached.ok && attached.code === "session-missing"; i++) {
  await new Promise((r) => setTimeout(r, 500));
  attached = await applyMutation(project, { action: "create-card-for-session", sessionId, sessionTitle: "smoke", laneId: "lane-todo" });
}
assert.equal(attached.ok, true, JSON.stringify(attached));
const card = attached.board.cards.find((c) => c.sessionId === sessionId);
const key = card.number ? `PROJE-${card.number}` : card.id;
await run("rule 3: card attached mid-session");
assert.equal(notices().length, 1, "RULE 3 FAILED: expected exactly one full notice");
const full = notices()[0].content;
assert.ok(full.includes(`Kanban: this session is on card ${key} in Todo (lane-todo)`), "card line");
assert.ok(full.includes("Kanban lanes in board order: "), "lanes line");
assert.ok(full.includes("Kanban lane instructions"), `runway header; full=\n${full}`);
for (const lane of ["Plan", "Implement", "Done"]) assert.ok(full.includes(`${lane} (lane-`), `runway includes ${lane}'s rules`);
assert.ok(full.includes("[now] Plan") === false, "the [now] marker is on the card's own lane, Todo");
console.log("RULE 3 OK — attach mid-session injected the full prompt:\n---\n" + full + "\n---");

// Silence while nothing changes.
await run("rule 3b: same card");
assert.equal(notices().length, 1, "no repeat per turn");

// ---- The [now] marker follows the card.
faux.setResponses([fauxAssistantMessage([fauxToolCall("kanban", { action: "update", laneId: "lane-implement" })])]);
await session.prompt("rule 3c: my own update");
await run("rule 3d: after the move");
const moved = notices().at(-1);
assert.ok(moved.content.includes("step 4 of 6, Implement (lane-implement)"), "step count follows the card");
assert.ok(moved.content.includes("[now] Implement (lane-implement)"), "[now] moved with the card");
assert.ok(!moved.content.includes("Plan: write the plan first."), "lanes the card passed are no longer injected");
console.log("RULE 3c OK — own move re-injects the runway with [now] on Implement:\n---\n" + moved.content + "\n---");

// ---- RULE 1 parity: a session started WITH its card gets the same fullness.
const _s2 = await createAgentSessionServices({
  cwd: project, agentDir, modelRuntime, settingsManager: SettingsManager.inMemory(),
  resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [createKanbanExtension()] },
});
const manager2 = SessionManager.create(project, join(agentDir, "sessions", encodeKanbanProjectKey(project)));
const started = await createAgentSessionFromServices({ services: _s2, sessionManager: manager2, model: faux.getModel("faux-model") });
const started2 = started;
// The production "born with a card" path: the prompt route's attachNewSessionCard,
// which trusts its caller and skips session validation (the file lands with the
// first message).
const parityAttach = await attachNewSessionCard(project, { sessionId: started2.session.sessionId, sessionTitle: "parity" }, { laneId: "lane-plan" });
assert.equal(parityAttach.ok, true, JSON.stringify(parityAttach));
faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
await started2.session.prompt("rule 1: born with a card");
const parity = started2.session.agent.state.messages.filter((m) => m.role === "custom" && m.customType === "pi-web:kanban-card");
assert.equal(parity.length, 1);
const first = parity[0].content;
assert.ok(first.includes("Kanban lanes in board order: "), "lanes line on first run with card");
assert.ok(first.includes("Kanban lane instructions — step 3 of 6, Plan"), "the card's own step named");
assert.ok(first.includes("[now] Plan"), "[now] on the current lane");
assert.ok(first.includes("Done (lane-done):\nDone: clean up, stop the server."), "the whole runway, ahead lanes included");
console.log("RULE 1 OK — session born with a card:\n---\n" + first + "\n---");

// Unlink -> one dismissal, then silence.
await applyMutation(project, { action: "unlink-session", cardId: card.id });
await run("unlink");
const after = notices().filter((m) => m.content.includes("no longer on a Kanban card"));
assert.equal(after.length, 1, "one dismissal after unlink");
await run("silence after unlink");
assert.equal(notices().length, after.length + notices().slice(0, notices().length).length - notices().length + 2, "sanity noop");
console.log("UNLINK OK — one dismissal, then silence");
session.dispose(); started2.session.dispose();
fs.rmSync(root, { recursive: true, force: true });
console.log("\nALL THREE RULES VERIFIED E2E");
