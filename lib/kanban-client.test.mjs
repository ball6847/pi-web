import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// The client store of `lib/kanban.ts` driven through its exported actions with
// a mocked fetch (no React rendering, no document: the exported actions never
// touch the hooks' React or document paths, only the shared reducer and the
// request pipeline). The rules under test, from docs/agents/kanban.md:
//   - a reducer refusal (null) never posts and changes nothing;
//   - a same-board result does not post either;
//   - without a loaded board mutations are no-ops, except
//     kanbanCreateCardForSession, which posts blind;
//   - a success adopts the server's board and revision;
//   - writes of one board go out one at a time, in order;
//   - a session-missing failure re-posts 1.5 s apart before it counts as
//     failed; exhaustion rolls the write back and resyncs quietly.
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const kanban = await jiti.import("./kanban.ts");
const types = await jiti.import("./kanban-types.ts");

/** The board the mock server holds for a project key. */
function serverBoard(project, card = {}, done = {}) {
  return {
    projectDir: project,
    lanes: types.defaultLanes(),
    cards: [
      { id: "c1", title: "Existing", description: "", laneId: "lane-todo", sessionId: null, sessionTitle: null, createdAt: 1, updatedAt: 1, ...card },
      { id: "cd", title: "Done card", description: "", laneId: "lane-done", sessionId: "sd", sessionTitle: "D", createdAt: 1, updatedAt: 1, ...done },
    ],
  };
}

/**
 * A scripted fetch: `step(index)` chooses the answer for the nth call; every
 * call is recorded with its method, body and start/end times.
 */
function mockFetch(t, step) {
  const calls = [];
  const previous = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async (url, init) => {
    const answer = step(i);
    const call = { url: String(url), method: init?.method ?? "GET", body: init?.body, start: Date.now() };
    calls.push(call);
    await new Promise((resolve) => setTimeout(resolve, answer.delay ?? 0));
    call.end = Date.now();
    i += 1;
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  return calls;
}

async function waitFor(predicate, budgetMs, what) {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Loads a board the only way an unwatched project gets one: a blind post. */
async function loadBoard(t, project, then) {
  const calls = mockFetch(t, (i) =>
    i === 0
      ? { status: 200, body: { board: serverBoard(project), revision: 1 } }
      : then ? then(i - 1) : { status: 200, body: { board: serverBoard(project), revision: 1 } }
  );
  kanban.kanbanCreateCardForSession(project, "s0", "Seed", "lane-todo");
  await waitFor(() => calls.length >= 1 && calls[0].end !== undefined, 10_000, "the blind write to answer");
  return calls;
}

test("without a loaded board a mutation is a no-op: null back, nothing posted", (t) => {
  const calls = mockFetch(t, () => ({ status: 200, body: { board: serverBoard("/k1"), revision: 1 } }));
  assert.equal(kanban.kanbanAddCard("/k1", "lane-todo", { title: "No board yet" }), null);
  assert.equal(kanban.kanbanAdvanceCard("/k1", "c1"), null);
  assert.equal(calls.length, 0);
});

test("kanbanCreateCardForSession posts blind for an unloaded board; the answer loads it", (t) => {
  const calls = mockFetch(t, () => ({ status: 200, body: { board: serverBoard("/k2"), revision: 7 } }));
  kanban.kanbanCreateCardForSession("/k2", "s1", "Session one", "lane-todo");
  return waitFor(() => calls.length >= 1 && calls[0].end !== undefined, 10_000, "the blind post").then(async () => {
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "/api/kanban");
    const posted = JSON.parse(calls[0].body);
    assert.equal(posted.action, "create-card-for-session");
    assert.equal(posted.cwd, "/k2");
    assert.equal(posted.sessionId, "s1");
    assert.equal(posted.laneId, "lane-todo");

    // The success adopted the server's board: ordinary mutations now run.
    const card = kanban.kanbanAddCard("/k2", "lane-todo", { title: "After load" });
    assert.ok(card && card.title === "After load");
    await waitFor(() => calls.length >= 2, 5_000, "the mutation's post");
    assert.equal(calls.length, 2);
  });
});

test("a refused action never posts: advancing the card already in the last lane", async (t) => {
  const calls = await loadBoard(t, "/k3");
  assert.equal(kanban.kanbanAdvanceCard("/k3", "cd"), null);
  assert.equal(calls.length, 1, "the refusal changes nothing and posts nothing");
});

test("an edit that changes nothing does not post", async (t) => {
  const calls = await loadBoard(t, "/k4");
  kanban.kanbanUpdateCard("/k4", "c1", { title: "Existing" });
  assert.equal(calls.length, 1, "the same-board result is not posted");
});

test("writes of one board go out one at a time, in order", async (t) => {
  const calls = await loadBoard(t, "/k5", (i) => ({ status: 200, body: { board: serverBoard("/k5"), revision: 2 + i }, delay: 200 }));
  kanban.kanbanAddCard("/k5", "lane-todo", { title: "Second" });
  kanban.kanbanAddCard("/k5", "lane-todo", { title: "Third" });
  await waitFor(() => calls.length >= 3, 10_000, "the two queued writes");
  const [first, second, third] = calls;
  assert.ok(second.start >= first.end, "the second write starts only after the first answered");
  assert.ok(third.start >= second.end, "the third waits for the second");
});

test("a session-missing failure re-posts 1.5 s apart and links when the session appears", { timeout: 30_000 }, async (t) => {
  const missing = () => ({ status: 404, body: { error: "That session does not exist in this project", code: "session-missing" } });
  const calls = await loadBoard(t, "/k6", (i) => (i < 3 ? missing() : { status: 200, body: { board: serverBoard("/k6", { sessionId: "s1", sessionTitle: "S1" }), revision: 9 } }));
  const started = Date.now();
  kanban.kanbanLinkCard("/k6", "c1", "s1", "S1");
  await waitFor(() => calls.length >= 5 && calls[4].end !== undefined, 20_000, "the four attempts");
  assert.equal(calls.length, 5);
  assert.ok(Date.now() - started >= 4_400, "the three retries keep their 1.5 s spacing");
  // The success adopted the linked board: a later edit posts against it.
  kanban.kanbanUpdateCard("/k6", "c1", { title: "Renamed" });
  await waitFor(() => calls.length >= 6, 5_000, "the edit's post");
  assert.equal(calls.length, 6);
});

test("a permanently missing session is dropped after the retries: rollback, quiet resync, board still usable", { timeout: 30_000 }, async (t) => {
  const missing = () => ({ status: 404, body: { error: "That session does not exist in this project", code: "session-missing" } });
  const calls = await loadBoard(t, "/k7", (i) => (i < 4 ? missing() : { status: 200, body: { board: serverBoard("/k7"), revision: 2 } }));
  kanban.kanbanLinkCard("/k7", "c1", "s1", "S1");
  await waitFor(() => calls.length >= 6 && calls[5].end !== undefined, 20_000, "the four attempts plus the resync");
  assert.ok(calls.slice(1, 5).every((c) => c.method === "POST"));
  // The quiet resync is a read-only GET (no board view watches this board: create=0).
  assert.equal(calls[5].method, "GET");
  assert.ok(calls[5].url.includes("create=0"));
  // The rolled-back board is still what the server holds: a new card posts.
  kanban.kanbanAddCard("/k7", "lane-todo", { title: "After rollback" });
  await waitFor(() => calls.length >= 7, 5_000, "the card's post");
  assert.equal(calls.length, 7);
});
