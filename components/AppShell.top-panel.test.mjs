import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const draftStore = await jiti.import("@/lib/draft-store");

function callbackBody(name, nextName) {
  const start = source.indexOf(`const ${name} = useCallback`);
  const end = source.indexOf(`\n  const ${nextName}`, start);
  assert.notEqual(start, -1, `${name} callback not found`);
  assert.notEqual(end, -1, `${nextName} callback not found after ${name}`);
  return source.slice(start, end);
}

const callbacks = [
  callbackBody("handleSelectSession", "handleNewSession"),
  source.slice(
    source.indexOf("const handleOpenSubagentParentChat = useCallback"),
    source.indexOf("// The focus belongs to the hand-over"),
  ),
].join("\n");
const parkedKeyHelper = source.slice(source.indexOf("function parkedNewSessionDraftKey"), source.indexOf("export function AppShell"));

function makeContext(overrides = {}) {
  const context = vm.createContext({
    ...draftStore,
    crypto: globalThis.crypto,
    URLSearchParams,
    window: { location: { pathname: "/", search: "" } },
    router: { replace() {} },
    workspaceKeyOf: (value) => value.projectKey ?? value.cwd,
    useCallback: (callback) => callback,
    changeFileWorkspace() {},
    invalidateWorkspaceRestore() {},
    activeNewSessionDraftKeyRef: { current: null },
    activeProjectKeyRef: { current: "/p" },
    branchLeafChangeFnRef: { current: null },
    suppressCwdBumpRef: { current: false },
    isMobile: false,
    activeCwd: "/p",
    newSessionCwd: null,
    newSessionDraftId: "initial",
    selectedSession: null,
    sessionKey: 0,
    activeTopPanel: "agents",
    sessionsWithSelection: [],
    ...overrides,
  });
  for (const [setter] of callbacks.matchAll(/\bset[A-Z]\w*(?=\()/g)) {
    const state = setter[3].toLowerCase() + setter.slice(4);
    context[setter] = (value) => {
      context[state] = typeof value === "function" ? value(context[state]) : value;
    };
  }
  vm.runInContext(stripTypeScriptTypes(`${parkedKeyHelper}\n${callbacks}
    globalThis.pick = handleSelectSession;
    globalThis.handOver = handleOpenSubagentParentChat;
  `), context);
  return context;
}

const session = { id: "picked", cwd: "/p", projectKey: "/p" };

test("a session pick closes the open top panel", () => {
  const context = makeContext();
  context.pick(session);
  assert.equal(context.selectedSession, session);
  assert.equal(context.activeTopPanel, null, "the agent switcher closes once the user picked an agent");
});

test("re-picking the session already open closes the panel too", () => {
  const context = makeContext({ selectedSession: session });
  context.pick(session);
  assert.equal(context.activeTopPanel, null, "the early return for the open session still closes the picker");
});

test("a restore leaves the panel as it is", () => {
  const context = makeContext();
  context.pick(session, true);
  assert.equal(context.activeTopPanel, "agents", "URL/tab-memory replay is not a pick");
});

test("the subagent hand-over reopens the panel after the pick", () => {
  const context = makeContext({
    sessionsWithSelection: [session],
  });
  context.handOver(session.id, "child-id");
  assert.equal(context.activeTopPanel, "agents", "the panel opens after the pick closed it");
  assert.equal(context.agentPanelFocus.sessionId, "child-id");
});

// The outside-close effect: a pointerdown outside the panel and the top bar
// closes it, one inside either does not (top-bar buttons toggle it themselves).
const commentStart = source.indexOf("// A top-panel dropdown is a picker");
const effectStart = source.indexOf("useEffect(() => {", commentStart);
const effectEnd = source.indexOf("}, [activeTopPanel]);", effectStart) + "}, [activeTopPanel]);".length;
assert.notEqual(commentStart, -1, "outside-close comment not found");
assert.ok(effectEnd > effectStart, "outside-close effect not found");
const effectSource = source.slice(effectStart, effectEnd).replace(/;\s*$/, "");

function runOutsideClose(composedPath) {
  let onPointerDown = null;
  const context = vm.createContext({
    activeTopPanel: "agents",
    useEffect: (fn) => { fn(); },
    document: {
      addEventListener: (type, fn) => { onPointerDown = fn; },
      removeEventListener() {},
    },
    topPanelRef: { current: "panel-node" },
    topBarRef: { current: "top-bar-node" },
    setActiveTopPanel: (value) => {
      context.activeTopPanel = typeof value === "function" ? value(context.activeTopPanel) : value;
    },
  });
  vm.runInContext(stripTypeScriptTypes(`(${effectSource})`), context);
  assert.ok(onPointerDown, "the effect registered a document listener");
  onPointerDown({ composedPath: () => composedPath });
  return context;
}

test("a pointerdown outside the panel closes it", () => {
  assert.equal(runOutsideClose(["chat-input-node", "body"]).activeTopPanel, null);
});

test("a pointerdown inside the panel keeps it open", () => {
  assert.equal(runOutsideClose(["row-node", "panel-node", "body"]).activeTopPanel, "agents");
});

test("a pointerdown on the top bar keeps the panel open for its toggle button", () => {
  assert.equal(runOutsideClose(["agents-button", "top-bar-node", "body"]).activeTopPanel, "agents");
});
