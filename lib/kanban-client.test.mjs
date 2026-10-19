import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// The client store of `lib/kanban.ts` driven through its exported actions with
// a mocked fetch (no React rendering; the one document the watch-lifecycle test
// needs is a visibility stub: the exported actions only touch the shared reducer
// and the request pipeline, the watcher only document.visibilityState). The rules under test, from docs/agents/kanban.md:
//   - a reducer refusal (null) never posts and changes nothing;
//   - a same-board result does not post either;
//   - without a loaded board mutations are no-ops, except
//     kanbanCreateCardForSession, which posts blind;
//   - a success adopts the server's board and revision;
//   - writes of one board go out one at a time, in order;
//   - a session-missing failure re-posts 1.5 s apart before it counts as
//     failed; exhaustion rolls the write back and resyncs quietly;
//   - the revision poll stays quiet while a write is pending.
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

test("the watch lifecycle: the first watcher polls, the last stops it, a re-acquire on a cached board checks now", async (t) => {
  const previousDoc = globalThis.document;
  globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  t.after(() => {
    globalThis.document = previousDoc;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const body = String(url).includes("revOnly=1") ? { revision: 7 } : { board: serverBoard("/pw"), revision: 7 };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  t.after(() => {
    globalThis.fetch = previous;
  });

  const revs = () => calls.filter((c) => c.url.includes("revOnly=1")).length;
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const release1 = kanban.acquireBoardWatcherForTests("/pw", true);
  await flush();
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].url.includes("revOnly=1"), "the creating read goes out immediately");
  assert.equal(revs(), 0);

  t.mock.timers.tick(2500);
  await flush(); // the poll reschedules itself in a microtask
  assert.equal(revs(), 1, "one revision poll per tick while watched");
  t.mock.timers.tick(2500);
  await flush();
  assert.equal(revs(), 2);

  const release2 = kanban.acquireBoardWatcherForTests("/pw");
  await flush();
  assert.equal(revs(), 3, "re-acquiring a cached board checks now");

  release1();
  t.mock.timers.tick(2500);
  await flush();
  assert.equal(revs(), 4, "one watcher left, the poll continues");

  release2();
  t.mock.timers.tick(2500);
  await flush();
  t.mock.timers.tick(2500);
  await flush();
  assert.equal(revs(), 4, "no watcher left, no more polls");
});

test("the revision poll stays quiet while a write is pending, then resumes", async (t) => {
  let release = null;
  const previousDoc = globalThis.document;
  globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const call = { url: u, method };
    calls.push(call);
    const isRev = u.includes("revOnly=1");
    const hang = method === "POST" && String(init?.body ?? "").includes("New"); // the pending write
    const body = hang || (method === "POST")
      ? { board: serverBoard("/pw", hang ? { title: "New" } : {}), revision: hang ? 9 : 1 }
      : isRev ? { revision: 1 } : { board: serverBoard("/pw"), revision: 1 };
    return (async () => {
      await new Promise((resolve) => setTimeout(resolve, hang ? 3000 : 0));
      call.end = Date.now();
      return { ok: true, status: 200, json: async () => body };
    })();
  };
  t.after(() => {
    release?.(); // stop the poller before the stub it reads goes away
    globalThis.document = previousDoc;
    globalThis.fetch = previousFetch;
  });

  // Seed the board through the client's own blind path, not loadBoard:
  // loadBoard installs its own fetch mock, which would shadow this one.
  kanban.kanbanCreateCardForSession("/pw", "s0", "Seed", "lane-todo");
  await waitFor(() => calls.length >= 1 && calls[0].end !== undefined, 10_000, "the blind seed write to answer");
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the write drain

  release = kanban.acquireBoardWatcherForTests("/pw");
  const revs = () => calls.filter((c) => c.url.includes("revOnly=1")).length;
  await waitFor(() => revs() >= 1, 5000, "the acquire's immediate revision check");

  kanban.kanbanAddCard("/pw", "lane-todo", { title: "New" }); // POST answers in 3 s
  await waitFor(() => calls.filter((c) => c.method === "POST").length >= 2, 5000, "the write POST to go out");
  const revsBefore = revs();
  const write = calls.filter((c) => c.method === "POST").pop();
  await new Promise((resolve) => setTimeout(resolve, 2700)); // covers the 2.5 s tick
  assert.equal(write.end, undefined, "the write is still pending");
  assert.equal(revs(), revsBefore, "the tick inside the pending window sent no request");

  await waitFor(() => write.end !== undefined, 5000, "the pending write to answer");
  await waitFor(() => revs() > revsBefore, 6000, "the poll to resume after the queue drained");
});
test("one fetch in flight per board: a second watcher during the load starts no second request", async (t) => {
  const previousDoc = globalThis.document;
  globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  t.after(() => {
    release1?.();
    release2?.();
    globalThis.document = previousDoc;
  });

  let release1 = null;
  let release2 = null;
  const calls = mockFetch(t, (i) => {
    if (i === 0) return { status: 200, delay: 300, body: { board: serverBoard("/pw2"), revision: 3 } };
    return { status: 200, body: { revision: 3 } };
  });

  release1 = kanban.acquireBoardWatcherForTests("/pw2", true);
  release2 = kanban.acquireBoardWatcherForTests("/pw2");
  await new Promise((resolve) => setTimeout(resolve, 150)); // mid-flight
  assert.equal(calls.length, 1, "the second watcher reuses the in-flight load, not a new request");

  await waitFor(() => calls.length >= 1 && calls[0].end !== undefined, 5000, "the load to answer");
  assert.equal(calls.filter((c) => c.url.includes("revOnly=1")).length, 0, "not loaded yet means no revision poll");

  release1();
  await waitFor(() => calls.filter((c) => c.url.includes("revOnly=1")).length >= 1, 5000, "the poll going out once the load has answered and fetching is clear");
  assert.equal(calls[0].method, "GET");
});

test("a hidden tab skips the poll and the visible check is immediate", async (t) => {
  const previousDoc = globalThis.document;
  const handlers = {};
  const stub = {
    visibilityState: "visible",
    addEventListener: (type, fn) => { handlers[type] = fn; },
    removeEventListener: (type) => { delete handlers[type]; },
  };
  globalThis.document = stub;
  t.after(() => {
    release?.();
    globalThis.document = previousDoc;
  });
  let release = null;

  const calls = mockFetch(t, () => ({ status: 200, body: { board: serverBoard("/pw3"), revision: 4 } }));
  const revs = () => calls.filter((c) => c.url.includes("revOnly=1")).length;

  release = kanban.acquireBoardWatcherForTests("/pw3");
  await waitFor(() => calls.length >= 1 && calls[0].end !== undefined, 5000, "the load to answer");

  stub.visibilityState = "hidden";
  handlers.visibilitychange(); // clears the armed timer while hidden
  await new Promise((resolve) => setTimeout(resolve, 2700)); // past one poll interval
  assert.equal(revs(), 0, "a hidden tab's poll never fires");

  stub.visibilityState = "visible";
  handlers.visibilitychange();
  await waitFor(() => revs() >= 1, 5000, "the shown-again check");
  assert.equal(revs(), 1, "one check as soon as the tab is shown, no burst");
});
