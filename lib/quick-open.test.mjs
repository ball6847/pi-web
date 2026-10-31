import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const quickOpen = await jiti.import("./quick-open.ts");

// The palette's index and ranking: every project by default, a title hit
// above an opening-message hit, and the recent list in activity order.

function session(overrides = {}) {
  return {
    path: "/tmp/session.jsonl",
    id: "s1",
    cwd: "/Users/dev/pi-web",
    created: "2024-05-01T10:00:00.000Z",
    modified: "2024-05-02T10:00:00.000Z",
    messageCount: 12,
    firstMessage: "the first message of the session",
    ...overrides,
  };
}

test("a candidate's title is the session's name, else its first message", () => {
  const [named] = quickOpen.quickOpenCandidates([session({ name: "the name" })]);
  assert.equal(named.title, "the name");
  const [unnamed] = quickOpen.quickOpenCandidates([session()]);
  assert.equal(unnamed.title, "the first message of the session");
});

test("a candidate knows its project", () => {
  const [candidate] = quickOpen.quickOpenCandidates([session()]);
  assert.equal(candidate.projectKey, "/Users/dev/pi-web");
  assert.equal(candidate.projectName, "pi-web");
});

test("the scope defaults to every project", () => {
  const candidates = quickOpen.quickOpenCandidates([
    session({ id: "a", cwd: "/Users/dev/one" }),
    session({ id: "b", cwd: "/Users/dev/two" }),
  ]);
  const hits = quickOpen.searchQuickOpen(candidates, "", { scope: "all" });
  assert.equal(hits.length, 2);
});

test("the project scope keeps one project's sessions", () => {
  const candidates = quickOpen.quickOpenCandidates([
    session({ id: "a", cwd: "/Users/dev/one" }),
    session({ id: "b", cwd: "/Users/dev/two" }),
  ]);
  const hits = quickOpen.searchQuickOpen(candidates, "", { scope: "project", projectKey: "/Users/dev/two" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].candidate.session.id, "b");
});

test("an empty query is the recent list, newest first", () => {
  const candidates = quickOpen.quickOpenCandidates([
    session({ id: "old", modified: "2024-05-01T10:00:00.000Z" }),
    session({ id: "new", modified: "2024-05-03T10:00:00.000Z" }),
    session({ id: "mid", modified: "2024-05-02T10:00:00.000Z" }),
  ]);
  const hits = quickOpen.searchQuickOpen(candidates, "", { scope: "all" });
  assert.deepEqual(hits.map((hit) => hit.candidate.session.id), ["new", "mid", "old"]);
});

test("a title hit comes before an opening-message hit", () => {
  const candidates = quickOpen.quickOpenCandidates([
    session({ id: "message", name: "unrelated title", firstMessage: "the kanban board work" }),
    session({ id: "title", name: "the kanban board work", firstMessage: "unrelated opening" }),
  ]);
  const hits = quickOpen.searchQuickOpen(candidates, "kanban", { scope: "all" });
  assert.deepEqual(hits.map((hit) => hit.candidate.session.id), ["title", "message"]);
});

test("a query that lands in the opening message keeps the session", () => {
  const candidates = quickOpen.quickOpenCandidates([
    session({ id: "message", name: "unrelated title", firstMessage: "the kanban board work" }),
  ]);
  const hits = quickOpen.searchQuickOpen(candidates, "kanban", { scope: "all" });
  assert.equal(hits.length, 1);
  assert.ok(hits[0].messagePositions.length > 0);
  assert.equal(hits[0].titlePositions.length, 0);
});

test("every term of the query must land somewhere", () => {
  const candidates = quickOpen.quickOpenCandidates([
    session({ id: "one", name: "kanban board" }),
    session({ id: "two", name: "kanban drag ghost" }),
  ]);
  const hits = quickOpen.searchQuickOpen(candidates, "kanban drag", { scope: "all" });
  assert.deepEqual(hits.map((hit) => hit.candidate.session.id), ["two"]);
});

test("the better match of two comes first", () => {
  const candidates = quickOpen.quickOpenCandidates([
    session({ id: "inside", name: "the board we work on" }),
    session({ id: "starts", name: "board work" }),
  ]);
  const hits = quickOpen.searchQuickOpen(candidates, "board", { scope: "all" });
  assert.deepEqual(hits.map((hit) => hit.candidate.session.id), ["starts", "inside"]);
});

test("a query matches nothing when it is nowhere", () => {
  const candidates = quickOpen.quickOpenCandidates([session({ name: "kanban board" })]);
  assert.equal(quickOpen.searchQuickOpen(candidates, "zzz", { scope: "all" }).length, 0);
});

test("the recent list is cut into day groups", () => {
  const now = new Date(2024, 4, 10, 12, 0, 0);
  const candidates = quickOpen.quickOpenCandidates([
    session({ id: "today", modified: new Date(2024, 4, 10, 9, 0, 0).toISOString() }),
    session({ id: "yesterday", modified: new Date(2024, 4, 9, 9, 0, 0).toISOString() }),
    session({ id: "week", modified: new Date(2024, 4, 6, 9, 0, 0).toISOString() }),
    session({ id: "earlier", modified: new Date(2024, 3, 1, 9, 0, 0).toISOString() }),
  ]);
  const hits = quickOpen.searchQuickOpen(candidates, "", { scope: "all" });
  const groups = quickOpen.groupQuickOpenHits(hits, now);
  assert.deepEqual(groups.map((group) => group.key), ["today", "yesterday", "week", "earlier"]);
  assert.equal(groups[0].hits[0].candidate.session.id, "today");
});

test("a title is cut like the sidebar's row cuts it", () => {
  const title = "a".repeat(200);
  const window = quickOpen.quickOpenTitleWindow(title, []);
  assert.equal(window.text.length, 51);
  assert.ok(window.text.endsWith("…"));
});

test("a match beyond the cut moves the window to it", () => {
  const title = `${"a".repeat(120)}needle${"b".repeat(20)}`;
  const window = quickOpen.quickOpenTitleWindow(title, [120, 121, 122, 123, 124, 125]);
  assert.ok(window.text.includes("needle"));
  assert.deepEqual(window.positions, [13, 14, 15, 16, 17, 18]);
});

test("a match inside the cut keeps the title's start, even with another outside", () => {
  const title = `needle${"b".repeat(120)}`;
  const window = quickOpen.quickOpenTitleWindow(title, [0, 1, 2, 3, 4, 5]);
  assert.ok(window.text.startsWith("needle"));
  assert.deepEqual(window.positions, [0, 1, 2, 3, 4, 5]);
});

test("a match inside the cut keeps the title's start", () => {
  const title = `needle${"b".repeat(200)}`;
  const window = quickOpen.quickOpenTitleWindow(title, [0, 1, 2, 3, 4, 5]);
  assert.ok(window.text.startsWith("needle"));
  assert.deepEqual(window.positions, [0, 1, 2, 3, 4, 5]);
});
