import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { buildToolResultsMap, EMPTY_TRANSCRIPT, mergeTailPage, prependOlderPage } from "./subagent-viewer-state.ts";

const message = (id) => ({ role: "user", content: id });
const page = (ids, { hasMore = false, oldest = ids[0] ?? null } = {}) => ({
  messages: ids.map(message),
  entryIds: ids,
  oldestEntryId: oldest,
  hasMore,
});

test("buildToolResultsMap pairs tool results by tool call id", () => {
  const result = { role: "toolResult", toolCallId: "call-1", content: [] };
  assert.equal(buildToolResultsMap([message("a"), result]).get("call-1"), result);
});

test("a poll keeps the older pages loaded above the newest page", () => {
  // The user paged up to a1; the run then appended e5 and e6.
  const shown = page(["a1", "a2", "e1", "e2", "e3", "e4"], { hasMore: true, oldest: "a0" });
  const merged = mergeTailPage(shown, page(["e3", "e4", "e5", "e6"], { hasMore: true }));
  assert.deepEqual(merged.entryIds, ["a1", "a2", "e1", "e2", "e3", "e4", "e5", "e6"]);
  assert.equal(merged.oldestEntryId, "a0");
  assert.equal(merged.hasMore, true);
  // Messages already shown keep their objects, so MessageView's memo holds.
  assert.equal(merged.messages[4], shown.messages[4]);
  assert.equal(merged.messages.length, merged.entryIds.length);
});

test("a poll that no longer overlaps, or covers the whole branch, replaces the transcript", () => {
  const shown = page(["a1", "a2"], { hasMore: true });
  assert.deepEqual(mergeTailPage(shown, page(["z1", "z2"], { hasMore: true })).entryIds, ["z1", "z2"]);
  assert.deepEqual(mergeTailPage(shown, page(["a2", "a3"])).entryIds, ["a2", "a3"]);
  assert.deepEqual(mergeTailPage(EMPTY_TRANSCRIPT, page(["a1"])).entryIds, ["a1"]);
});

test("an older page is prepended once, and only onto the cursor it was asked for", () => {
  const shown = page(["e1", "e2"], { hasMore: true, oldest: "e1" });
  const older = page(["a1", "a2"], { hasMore: false, oldest: "a1" });
  const prepended = prependOlderPage(shown, "e1", older);
  assert.deepEqual(prepended.entryIds, ["a1", "a2", "e1", "e2"]);
  assert.equal(prepended.oldestEntryId, "a1");
  assert.equal(prepended.hasMore, false);
  // The same answer arriving again, or after a poll moved the cursor, is dropped.
  assert.equal(prependOlderPage(prepended, "e1", older), prepended);
});

// The read-only notice is a plain function: run its real source (JSX transpiled)
// with a stub i18n, so its text, its button and the hand-over callback are the
// shipped ones rather than a copy.
const viewerSource = await readFile(new URL("./SubagentViewer.tsx", import.meta.url), "utf8");
const viewerAst = ts.createSourceFile("SubagentViewer.tsx", viewerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const noticeNode = viewerAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "SubagentReadOnlyNotice");
const noticeCode = ts.transpileModule(
  `${noticeNode.getText(viewerAst).replace(/^export /, "")}\nglobalThis.notice = SubagentReadOnlyNotice;`,
  { compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React } },
).outputText;
const noticeContext = vm.createContext({
  React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
  useI18n: () => ({ t: (key) => key }),
});
vm.runInContext(noticeCode, noticeContext);

function noticeElements(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((child) => noticeElements(child, out)); return out; }
  out.push(node);
  noticeElements(node.props?.children, out);
  return out;
}

test("the read-only notice explains why there is no input and hands over to the main agent's chat", () => {
  const opened = [];
  const tree = noticeContext.notice({ onOpen: () => opened.push("opened") });
  const elements = noticeElements(tree);
  const notice = elements.find((node) => node.props?.role === "note");
  assert.ok(notice, "the banner is a note");
  const texts = elements.flatMap((node) => node.props?.children ?? []).filter((child) => typeof child === "string");
  assert.ok(texts.includes("subagent.viewer.readOnly"), "says the transcript is read-only");
  const button = elements.find((node) => node.type === "button");
  assert.ok(texts.includes("subagent.viewer.openMain"), "names the way out");
  button.props.onClick();
  assert.deepEqual(opened, ["opened"]);
});

test("the notice is rendered only for a sub-agent whose parent is known and openable", () => {
  // Guarded in the component: no parent id (an unreadable session) and no
  // handler (a caller that cannot hand over) means no banner at all.
  assert.match(viewerSource, /parentSessionId && onOpenParentChat && \(\s*<SubagentReadOnlyNotice/);
  assert.match(viewerSource, /onOpen=\{\(\) => onOpenParentChat\(parentSessionId, sessionId\)\}/);
});
