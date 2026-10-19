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

test("the revision poll stays quiet while a write is pending, then resumes", { timeout: 30_000 }, async (t) => {
  // Mocked timers: real-time waits let a loaded machine reorder the 2.5 s poll
  // tick against the 3 s write (check.sh has seen the tick land after the write
  // "answered"). On a mocked clock the order is the assertion.
  const previousDoc = globalThis.document;
  globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  const previousFetch = globalThis.fetch;
  const calls = [];
  let writeDone = false; // a revOnly after the write answers 9 (no spurious refetch)
  globalThis.fetch = (url, init) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const call = { url: u, method };
    calls.push(call);
    const isRev = u.includes("revOnly=1");
    const hang = method === "POST" && String(init?.body ?? "").includes("New"); // the pending write
    const delay = hang ? 3000 : 0;
    const body = method === "POST"
      ? { board: serverBoard("/pw", hang ? { title: "New" } : {}), revision: hang ? 9 : 1 }
      : isRev ? { revision: writeDone ? 9 : 1 } : { board: serverBoard("/pw"), revision: 1 };
    return (async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (hang) writeDone = true;
      call.end = Date.now();
      return { ok: true, status: 200, json: async () => body };
    })();
  };
  let release = null;
  t.after(() => {
    release?.();
    globalThis.document = previousDoc;
    globalThis.fetch = previousFetch;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const revs = () => calls.filter((c) => c.url.includes("revOnly=1")).length;

  // Seed the board through the client's own blind path, not loadBoard:
  // loadBoard installs its own fetch mock, which would shadow this one.
  // The sandwich order matters: the fetch (and its mocked response delay)
  // only exists after the write's microtask has run, so flush, then tick,
  // then flush again to adopt the answer.
  kanban.kanbanCreateCardForSession("/pw", "s0", "Seed", "lane-todo");
  await flush();
  t.mock.timers.tick(0);
  await flush();

  release = kanban.acquireBoardWatcherForTests("/pw");
  await flush();
  t.mock.timers.tick(0);
  await flush(); // the acquire's immediate revision check
  assert.equal(revs(), 1, "the acquire of a cached board checks the revision now");

  kanban.kanbanAddCard("/pw", "lane-todo", { title: "New" }); // the POST answers at 3 s
  await flush();
  const write = calls.filter((c) => c.method === "POST").pop();
  assert.ok(write, "the write POST went out");

  t.mock.timers.tick(2500); // the poll tick lands inside the pending window (answers at 3 s)
  await flush();
  assert.equal(write.end, undefined, "the write is still pending");
  assert.equal(revs(), 1, "the tick inside the pending window sent no request");

  t.mock.timers.tick(500); // the write answers at 3 s and is adopted
  await flush();
  assert.ok(write.end !== undefined, "the pending write answered");

  t.mock.timers.tick(2500); // the next tick: queue drained, the poll resumes
  await flush();
  t.mock.timers.tick(0);
  await flush(); // ...and its revOnly answer lands
  assert.ok(revs() >= 2, "the poll resumed once the queue drained");
});
test("one fetch in flight per board: a second watcher during the load starts no second request", { timeout: 30_000 }, async (t) => {
  // Mocked timers: the 300 ms load delay sits on the mocked clock, so the
  // mid-flight assertion and the resumption tick are exact, not raced.
  const previousDoc = globalThis.document;
  globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  let release1 = null;
  let release2 = null;
  t.after(() => {
    release1?.();
    release2?.();
    globalThis.document = previousDoc;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const calls = mockFetch(t, (i) => {
    if (i === 0) return { status: 200, delay: 300, body: { board: serverBoard("/pw2"), revision: 3 } };
    return { status: 200, body: { revision: 3 } };
  });

  release1 = kanban.acquireBoardWatcherForTests("/pw2", true);
  release2 = kanban.acquireBoardWatcherForTests("/pw2");
  await flush(); // the first load is in flight (answers at 300 ms)
  assert.equal(calls.length, 1, "the second watcher reuses the in-flight load, not a new request");

  t.mock.timers.tick(300); // the load answers and is adopted
  await flush();
  assert.equal(calls.filter((c) => c.url.includes("revOnly=1")).length, 0, "not loaded yet means no revision poll");

  release1(); // one watcher left: the next tick polls
  t.mock.timers.tick(2500);
  await flush();
  t.mock.timers.tick(0);
  await flush(); // its revOnly answer lands (3 === 3, no refetch)
  assert.ok(calls.filter((c) => c.url.includes("revOnly=1")).length >= 1, "the poll went out once the load has answered and fetching is clear");
  assert.equal(calls[0].method, "GET");
});

test("a hidden tab skips the poll and the visible check is immediate", { timeout: 30_000 }, async (t) => {
  // Mocked timers: the post-show check arrives via a setTimeout(0), and the
  // real-clock version timed out on a loaded machine waiting for it.
  const previousDoc = globalThis.document;
  const handlers = {};
  const stub = {
    visibilityState: "visible",
    addEventListener: (type, fn) => { handlers[type] = fn; },
    removeEventListener: (type) => { delete handlers[type]; },
  };
  globalThis.document = stub;
  let release = null;
  t.after(() => {
    release?.();
    globalThis.document = previousDoc;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const calls = mockFetch(t, () => ({ status: 200, body: { board: serverBoard("/pw3"), revision: 4 } }));
  const revs = () => calls.filter((c) => c.url.includes("revOnly=1")).length;

  release = kanban.acquireBoardWatcherForTests("/pw3");
  await flush(); // the creating GET goes out in a microtask
  t.mock.timers.tick(0);
  await flush(); // its answer is adopted
  assert.equal(calls[0].method, "GET");
  assert.equal(revs(), 0);

  stub.visibilityState = "hidden";
  handlers.visibilitychange(); // disarms the 2.5 s timer
  t.mock.timers.tick(2700); // past one poll interval, while hidden
  await flush();
  assert.equal(revs(), 0, "a hidden tab's poll never fires");

  stub.visibilityState = "visible";
  handlers.visibilitychange(); // one check straight away, then re-arm
  t.mock.timers.tick(0);
  await flush();
  assert.equal(revs(), 1, "one check as soon as the tab is shown, no burst");
});

test("an identical refetch keeps the board object; a changed one replaces it", async (t) => {
  const previousDoc = globalThis.document;
  globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  const previousFetch = globalThis.fetch;
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let revCount = 0;
  let fullCount = 0;
  const settle = async () => {
    for (let n = 0; n < 5; n++) {
      await flush();
      t.mock.timers.tick(0);
      await flush();
    }
  };
  globalThis.fetch = (url, init) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const isRev = u.includes("revOnly=1");
    let body;
    if (method === "POST") body = { board: serverBoard("/pw4"), revision: 1 };
    else if (isRev) body = { revision: ++revCount + 1 }; // each distinct → each forces a full fetch
    else body = { board: serverBoard(fullCount++ < 2 ? {} : { title: "Replaced" }), revision: revCount + 1 };
    return (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { ok: true, status: 200, json: async () => body };
    })();
  };
  let release = null;
  t.after(() => {
    release?.();
    globalThis.document = previousDoc;
    globalThis.fetch = previousFetch;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });

  kanban.kanbanCreateCardForSession("/pw4", "s0", "Seed", "lane-todo");
  await settle();
  release = kanban.acquireBoardWatcherForTests("/pw4");
  await settle(); // immediate check (rev 2) → identical full fetch #1
  assert.equal(revCount, 1);
  assert.equal(fullCount, 1, "one full fetch after the changed revision");
  const before = kanban.kanbanBoardSnapshotForTests("/pw4");
  assert.ok(before, "the board is settled and non-null");

  t.mock.timers.tick(2500);
  await settle(); // rev 3 → identical full fetch #2
  assert.equal(fullCount, 2, "a second full fetch went out");
  assert.equal(kanban.kanbanBoardSnapshotForTests("/pw4"), before, "identical JSON keeps the object: no re-render");

  t.mock.timers.tick(2500);
  await settle(); // rev 4 → full fetch #3, changed board
  assert.ok(fullCount >= 3, "the changed board was fetched");
  assert.notEqual(kanban.kanbanBoardSnapshotForTests("/pw4"), before, "changed JSON replaces the object");
});

test("a GET answering while a write is pending is discarded: that write's board lands", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previousDoc = globalThis.document;
  globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  let release = null;
  t.after(() => {
    release?.();
    globalThis.document = previousDoc;
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const key = "/pw5";
  // Self-contained mock (no shared helper: this file has two writers).
  const calls = [];
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  let i = 0;
  globalThis.fetch = (url, init) => {
    const call = { url: String(url), method: init?.method ?? "GET" };
    calls.push(call);
    const n = i++;
    const answer =
      n === 0 ? { delay: 0, body: { board: serverBoard(key), revision: 1 } } // the blind seed
      : n === 1 ? { delay: 0, body: { revision: 9 } } // revision moved → full refetch follows
      : n === 2 ? { delay: 1000, body: { board: serverBoard(key, { id: "c-x" }), revision: 9 } } // the slow GET
      : n === 3 ? { delay: 3000, body: { board: serverBoard(key, { id: "c-y" }), revision: 10 } } // the pending write
      : { delay: 0, body: { board: serverBoard(key, { id: "c-y" }), revision: 10 } };
    return (async () => {
      await new Promise((resolve) => setTimeout(resolve, answer.delay));
      call.end = Date.now();
      return { ok: true, status: 200, json: async () => answer.body };
    })();
  };

  kanban.kanbanCreateCardForSession(key, "s0", "Seed", "lane-todo");
  await flush();
  t.mock.timers.tick(0);
  await flush(); // seed adopted, board shown

  release = kanban.acquireBoardWatcherForTests(key);
  await flush();
  t.mock.timers.tick(0);
  await flush(); // revOnly answered 9, the slow full GET is now in flight

  kanban.kanbanAddCard(key, "lane-todo", { title: "In flight" });
  await flush(); // the write posts and hangs for 3 s

  t.mock.timers.tick(1000);
  await flush(); // the GET answers while the write is still pending → discarded
  t.mock.timers.tick(2000);
  await flush(); // the write answers → adopted

  const moved = kanban.kanbanAdvanceCard(key, "c-y");
  assert.ok(moved && moved.id === "lane-plan", "the in-flight GET was discarded; the pending write's board is current");
});

test("a GET answering after a finished write is discarded via loadId: the write's board stays", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previousDoc = globalThis.document;
  globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  let release = null;
  t.after(() => {
    release?.();
    globalThis.document = previousDoc;
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const key = "/pw6";
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  let i = 0;
  globalThis.fetch = (url, init) => {
    const method = init?.method ?? "GET";
    const n = i++;
    const answer =
      n === 0 ? { delay: 0, body: { board: serverBoard(key), revision: 1 } } // the blind seed
      : n === 1 ? { delay: 0, body: { revision: 9 } } // revision moved → full refetch follows
      : n === 2 ? { delay: 1000, body: { board: serverBoard(key, { id: "c-x" }), revision: 9 } } // the slow GET, captured loadId
      : { delay: 300, body: { board: serverBoard(key, { id: "c-y" }), revision: 10 } }; // the write, answers first
    return (async () => {
      await new Promise((resolve) => setTimeout(resolve, answer.delay));
      return { ok: true, status: 200, json: async () => answer.body };
    })();
  };

  kanban.kanbanCreateCardForSession(key, "s0", "Seed", "lane-todo");
  await flush(); t.mock.timers.tick(0); await flush(); // seed adopted
  release = kanban.acquireBoardWatcherForTests(key);
  await flush(); t.mock.timers.tick(0); await flush(); // rev 9 seen, slow GET in flight

  kanban.kanbanAddCard(key, "lane-todo", { title: "New" }); // POST answers at 300 ms
  await flush(); t.mock.timers.tick(300); await flush(); // write lands: loadId bumped, queue empty
  const settled = kanban.kanbanBoardSnapshotForTests(key);
  assert.ok(settled && settled.cards[0].id === "c-y", "the write's board is shown");

  t.mock.timers.tick(700); await flush(); // the slow GET answers at 1000 ms: too late
  const after = kanban.kanbanBoardSnapshotForTests(key);
  assert.equal(after, settled, "the stale GET changed nothing: loadId discarded it");
  assert.equal(after.cards[0].id, "c-y", "the write's board stays, not the stale c-x");
});
