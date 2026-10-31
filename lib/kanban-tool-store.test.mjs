import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";
import lockfile from "proper-lockfile";

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./kanban-store.ts");
const data = await jiti.import("./kanban-data.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
const { serializeByKey } = await jiti.import("./key-serializer.ts");
const { KANBAN_SCHEMA_VERSION } = await jiti.import("./kanban-types.ts");

function fixture(t) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "kanban-tool-store-")));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  fs.mkdirSync(project);
  fs.mkdirSync(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  allowFileRoot(root);
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const session = (id, cwd = project) => {
    const dir = join(agentDir, "sessions", data.encodeKanbanProjectKey(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const path = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    fs.writeFileSync(path, JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-01-01T00:00:00Z" }) + "\n");
    return { sessionId: id, sessionTitle: id };
  };
  const actor = session(`actor-${root.split("-").at(-1)}`);
  const path = data.kanbanBoardPath(project);
  const call = (request, who = actor, signal, cwd = project) => store.executeKanbanToolRequest(cwd, who, request, signal);
  const read = () => store.readBoard(project, { create: false });
  const bytes = () => fs.readFileSync(path);
  return { root, project, agentDir, actor, path, session, call, read, bytes };
}
const create = (title) => ({ action: "create", title });
const claim = (cardId, extra = {}) => ({ action: "update", cardId, laneId: "lane-todo", ...extra });

test("read and invalid requests do not create/import/prune anything", async (t) => {
  const f = fixture(t);
  assert.equal((await f.call({ action: "read" })).revision, 0);
  assert.equal((await f.call({ action: "read", cardId: "missing" })).code, "refused");
  assert.equal((await f.call({ action: "create", title: "x", other: true })).code, "invalid-request");
  assert.equal((await f.call({ action: "update", title: "x" })).code, "refused");
  assert.equal(fs.existsSync(f.path), false, "refusal does not materialize a board");
  assert.equal(fs.existsSync(join(f.project, ".pi")), false);
  fs.mkdirSync(join(f.project, ".pi"));
  const legacy = join(f.project, ".pi", "kanban.json");
  fs.writeFileSync(legacy, "legacy bytes");
  await f.call({ action: "read" });
  assert.equal(fs.readFileSync(legacy, "utf8"), "legacy bytes");
  assert.equal(fs.existsSync(f.path), false);
});

test("claim race by two sessions has one winner and no loser text edits", async (t) => {
  const f = fixture(t);
  const created = await f.call(create("unclaimed"));
  const other = f.session(`other-${f.actor.sessionId}`);
  const results = await Promise.all([
    f.call(claim(created.card.id, { title: "first" })),
    f.call(claim(created.card.id, { title: "second" }), other),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.match(results.find((r) => !r.ok).error, /another session/);
  const winner = results.find((r) => r.ok);
  assert.equal(winner.revision, created.revision + 1);
  // The tool's card carries its key; the stored row is the row.
  const stored = { ...winner.card };
  delete stored.key;
  assert.deepEqual((await f.read()).board.cards, [stored]);
});

test("two concurrent claims by one actor: only one card can be claimed", async (t) => {
  const f = fixture(t);
  const a = await f.call(create("a"));
  const b = await f.call(create("b"));
  const results = await Promise.all([f.call(claim(a.card.id)), f.call(claim(b.card.id))]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.match(results.find((r) => !r.ok).error, /already.*card/);
  const snapshot = await f.read();
  assert.equal(snapshot.board.cards.filter((c) => c.sessionId === f.actor.sessionId).length, 1);
  assert.equal(snapshot.revision, b.revision + 1);
});

test("implicit target is resolved after a prior queued claim, not before the lock", async (t) => {
  const f = fixture(t);
  const a = await f.call(create("a"));
  let releaseQueue;
  let entered;
  const started = new Promise((r) => { entered = r; });
  const holding = serializeByKey(Symbol.for("pi-web:kanban-write-queue"), f.path, () => {
    entered();
    return new Promise((r) => { releaseQueue = r; });
  });
  await started;
  const claiming = f.call(claim(a.card.id));
  // Let validation finish and queue the claim before the implicit edit.
  await new Promise((r) => setTimeout(r, 50));
  const editing = f.call({ action: "update", description: "after claim" });
  await new Promise((r) => setTimeout(r, 50));
  releaseQueue();
  await holding;
  assert.equal((await claiming).ok, true);
  const edited = await editing;
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(edited.card.id, a.card.id);
  assert.equal(edited.card.description, "after claim");
});

test("same-lane retries and text no-ops preserve bytes/order/revision, partial edits preserve fields", async (t) => {
  const f = fixture(t);
  const a = await f.call({ action: "create", title: "a", description: "keep", laneId: "lane-todo" });
  await f.call({ action: "create", title: "b", laneId: "lane-todo" }, f.session(`other-${f.actor.sessionId}`));
  const before = await f.read();
  const bytes = f.bytes();
  const same = await f.call({ action: "update", laneId: "lane-todo", title: " a " });
  assert.equal(same.revision, before.revision);
  assert.deepEqual(f.bytes(), bytes);
  assert.deepEqual((await f.read()).board.cards.map((c) => c.id), before.board.cards.map((c) => c.id));
  const patch = await f.call({ action: "update", description: "" });
  assert.deepEqual(patch.card, { ...a.card, description: "", updatedAt: patch.card.updatedAt });
  assert.equal(patch.revision, before.revision + 1);
  assert.equal((await store.getBoardRevision(f.project)).revision, patch.revision);
});

test("foreign edits and invalid lane roll back all text, timestamps and revision", async (t) => {
  const f = fixture(t);
  const a = await f.call({ action: "create", title: "a", laneId: "lane-plan" });
  const before = f.bytes();
  for (const [request, actor] of [[{ action: "update", cardId: a.card.id, title: "stolen" }, f.session(`other-${f.actor.sessionId}`)], [{ action: "update", title: "changed", laneId: "unknown" }, f.actor], [{ action: "update", laneId: "lane-backlog", title: "changed" }, f.actor]]) {
    const result = await f.call(request, actor);
    assert.equal(result.code, "refused");
    assert.deepEqual(f.bytes(), before);
  }
});

test("SQLite write failure rolls back patch, claim, move and revision together", async (t) => {
  const f = fixture(t);
  const a = await f.call(create("a"));
  const db = new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON cards BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  db.close();
  const before = await f.read();
  const result = await f.call(claim(a.card.id, { title: "must roll back", description: "" }));
  assert.equal(result.code, "internal");
  assert.match(result.error, /injected failure/);
  assert.deepEqual(await f.read(), before);
  assert.equal(fs.existsSync(`${f.path}.lock`), false);
});

test("cancelled while waiting on the file lock does not mutate or initialize a missing board", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(dirname(f.path), { recursive: true });
  const release = await lockfile.lock(f.path, { realpath: false, stale: 60_000 });
  const controller = new AbortController();
  const pending = f.call(create("cancelled"), f.actor, controller.signal);
  await new Promise((r) => setTimeout(r, 100));
  controller.abort();
  await release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /cancel/i);
  assert.equal(fs.existsSync(f.path), false);
  assert.equal(fs.existsSync(`${f.path}.lock`), false);
});

test("cancelled while queued against an existing board preserves bytes and revision", async (t) => {
  const f = fixture(t);
  const a = await f.call(create("a"));
  const before = f.bytes();
  const release = await lockfile.lock(f.path, { realpath: false, stale: 60_000 });
  const controller = new AbortController();
  const pending = f.call(claim(a.card.id, { title: "cancelled" }), f.actor, controller.signal);
  await new Promise((r) => setTimeout(r, 100));
  controller.abort();
  await release();
  assert.match((await pending).error, /cancel/i);
  assert.deepEqual(f.bytes(), before);
  assert.equal((await f.read()).revision, a.revision);
});

test("store failures retain locked/unsupported-schema codes on the agent path", { timeout: 15_000 }, async (t) => {
  const f = fixture(t);
  const a = await f.call(create("a"));
  const before = f.bytes();
  const release = await lockfile.lock(f.path, { realpath: false, stale: 60_000 });
  try {
    assert.equal((await f.call(claim(a.card.id))).code, "locked");
    assert.deepEqual(f.bytes(), before);
  } finally {
    await release();
  }
  const db = new DatabaseSync(f.path);
  db.exec(`PRAGMA user_version = ${KANBAN_SCHEMA_VERSION + 1}`);
  db.close();
  const newer = f.bytes();
  for (const request of [{ action: "read" }, claim(a.card.id)]) {
    assert.equal((await f.call(request)).code, "unsupported-schema");
    assert.deepEqual(f.bytes(), newer);
  }
});

test("pre-aborted and missing/foreign/invalid sessions never create board files", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  assert.match((await f.call(create("x"), f.actor, controller.signal)).error, /cancel/i);
  const otherProject = join(f.root, "elsewhere");
  fs.mkdirSync(otherProject);
  for (const actor of [{ sessionId: "" }, { sessionId: "missing" }, { sessionId: null }, f.session(`foreign-${f.actor.sessionId}`, otherProject)]) {
    for (const request of [{ action: "read" }, create("x")]) {
      assert.equal((await f.call(request, actor)).code, "session-missing");
    }
  }
  assert.equal(fs.existsSync(join(f.agentDir, "kanban")), false);
});

test("tool read preserves dead links, and a no-op does not prune unrelated cards", async (t) => {
  const f = fixture(t);
  const a = await f.call({ action: "create", title: "a", laneId: "lane-todo" });
  const ghost = f.session(`ghost-${f.actor.sessionId}`);
  await f.call({ action: "create", title: "dead", laneId: "lane-plan" }, ghost);
  const dir = join(f.agentDir, "sessions", data.encodeKanbanProjectKey(f.project));
  fs.unlinkSync(join(dir, `2026-01-01T00-00-00-000Z_${ghost.sessionId}.jsonl`));
  const before = f.bytes();
  // The overview carries counts only; search is how a caller sees other cards.
  const read = await f.call({ action: "read" });
  assert.equal(read.totalCards, 2);
  const search = await f.call({ action: "search" });
  assert.equal(search.cards[1].sessionId, undefined);
  assert.equal(search.cards[1].linked, true);
  const ghostCard = await f.call({ action: "read", cardId: search.cards[1].id });
  assert.equal(ghostCard.card.sessionId, ghost.sessionId);
  assert.equal(search.revision, read.revision);
  assert.equal((await f.call({ action: "update", laneId: a.card.laneId })).revision, read.revision);
  assert.deepEqual(f.bytes(), before);
});

test("same repository worktrees share the board; unrelated project session is refused", async (t) => {
  const f = fixture(t);
  const git = (...args) => execFileSync("git", ["-C", f.project, ...args], { stdio: "pipe" });
  git("init");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture");
  const wt = join(f.root, "worktree");
  git("worktree", "add", "-b", "test-child", wt);
  const child = f.session(`child-${f.actor.sessionId}`, wt);
  const created = await f.call(create("delegated"));
  const result = await f.call(claim(created.card.id), child, undefined, wt);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.card.sessionId, child.sessionId);
  const shared = await f.call({ action: "search" });
  assert.equal((await f.call({ action: "read", cardId: shared.cards[0].id })).card.sessionId, child.sessionId);
  assert.equal(shared.cards[0].linked, true);
  assert.equal(fs.existsSync(data.kanbanBoardPath(wt)), false);
});

// ---------------------------------------------------------------------------
// Delegation: a subagent acts on the card of the session that called it
// ---------------------------------------------------------------------------

/** The meta entry pi-web writes at dispatch; a real child's file holds it on line 2. */
function delegate(f, child, parent) {
  const dir = join(f.agentDir, "sessions", data.encodeKanbanProjectKey(f.project));
  const path = join(dir, `2026-01-01T00-00-00-000Z_${child.sessionId}.jsonl`);
  fs.appendFileSync(path, JSON.stringify({
    type: "custom", id: "meta", parentId: null, timestamp: "2026-01-01T00:00:01Z",
    customType: "pi-web:subagent",
    data: { version: 1, parentSessionId: parent.sessionId, parentSessionPath: join(dir, `2026-01-01T00-00-00-000Z_${parent.sessionId}.jsonl`) },
  }) + "\n");
  return child;
}

test("a delegated session comments on its caller's card and moves it one lane forward", async (t) => {
  const f = fixture(t);
  const caller = f.session(`caller-${f.actor.sessionId}`);
  const created = await f.call(create("delegated work"), caller);
  const claimed = await f.call(claim(created.card.id), caller);
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const child = delegate(f, f.session(`child-${f.actor.sessionId}`), caller);

  // The child owns no card, so it names its caller's by key — and keeps it.
  const moved = await f.call({ action: "update", cardId: claimed.card.key, laneId: "lane-plan" }, child);
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.card.laneId, "lane-plan");
  assert.equal(moved.card.sessionId, caller.sessionId);
  assert.equal(moved.currentCardId, null);

  const commented = await f.call({ action: "comment", cardId: claimed.card.key, body: "implemented it" }, child);
  assert.equal(commented.ok, true, JSON.stringify(commented));
  // The journal names the session that wrote it: that is the whole point.
  assert.equal(commented.comment.sessionId, child.sessionId);
  assert.equal(commented.comment.sessionTitle, child.sessionId);

  // Words stay the owner's, and the card only moves forward.
  const words = await f.call({ action: "update", cardId: claimed.card.key, title: "not yours" }, child);
  assert.equal(words.ok, false);
  assert.match(words.error, /delegated to you/);
  const back = await f.call({ action: "update", cardId: claimed.card.key, laneId: "lane-todo" }, child);
  assert.equal(back.ok, false);
  assert.match(back.error, /forward only/);
  const stored = (await f.read()).board.cards[0];
  assert.equal(stored.title, "delegated work");
  assert.equal(stored.laneId, "lane-plan");
  assert.equal(stored.sessionId, caller.sessionId);
});

test("a fork is not a delegation: it carries a parentSession header but no dispatch entry", async (t) => {
  const f = fixture(t);
  const caller = f.session(`caller-${f.actor.sessionId}`);
  const claimed = await f.call(claim((await f.call(create("owner card"), caller)).card.id), caller);
  // Same header field, no meta entry — which is exactly what pi-web's own Fork writes.
  const dir = join(f.agentDir, "sessions", data.encodeKanbanProjectKey(f.project));
  const forkId = `fork-${f.actor.sessionId}`;
  fs.writeFileSync(join(dir, `2026-01-01T00-00-00-000Z_${forkId}.jsonl`), JSON.stringify({
    type: "session", version: 3, id: forkId, cwd: f.project, timestamp: "2026-01-01T00:00:00Z",
    parentSession: join(dir, `2026-01-01T00-00-00-000Z_${caller.sessionId}.jsonl`),
  }) + "\n");
  const result = await f.call({ action: "comment", cardId: claimed.card.key, body: "hello" }, { sessionId: forkId, sessionTitle: forkId });
  assert.equal(result.ok, false);
  assert.match(result.error, /another session/);
});
