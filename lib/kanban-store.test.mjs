import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import lockfile from "proper-lockfile";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const store = await jiti.import("./kanban-store.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");

function resetGlobalState() {
  store.resetKanbanStateForTests();
  globalThis.__piSessionListCache = undefined;
  globalThis.__piSessionListPromise = undefined;
  globalThis.__piSessionListPromiseGeneration = undefined;
  globalThis.__piSessionListGeneration = 0;
  globalThis.__piSessionPathCache = undefined;
  globalThis.__piPathToSessionIdCache = undefined;
  globalThis.__piAllowedRootsCache = undefined;
  globalThis.__piAdditionalAllowedRoots = undefined;
}

/**
 * A temp agent dir (the PI_CODING_AGENT_DIR override the session tests use) and
 * a temp project dir that is an allowed root, so cwd validation passes.
 */
function fixture(t, { allow = true } = {}) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-web-kanban-store-")));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  resetGlobalState();
  if (allow) allowFileRoot(project);
  t.after(() => {
    resetGlobalState();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const path = join(project, ".pi", "kanban.json");
  return {
    root,
    agentDir,
    project,
    path,
    file: () => JSON.parse(fs.readFileSync(path, "utf8")),
    bytes: () => fs.readFileSync(path, "utf8"),
  };
}

/** A fabricated `<agentDir>/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl` with just a header. */
function fabricateSession(agentDir, cwd, id) {
  const dir = join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  fs.mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd }) + "\n");
  return file;
}

function quietWarnings(t) {
  const previous = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = previous;
  });
}

const add = (project, title, laneId = "lane-todo", extra = {}) =>
  store.applyMutation(project, { action: "add-card", laneId, title, ...extra });

test("first read auto-creates the envelope with six lanes and no cards; the second read rewrites nothing", async (t) => {
  const f = fixture(t);
  const first = await store.readBoard(f.project);
  assert.equal(first.ok, true);
  assert.equal(first.board.projectDir, f.project);
  assert.equal(first.board.lanes.length, 6);
  assert.equal(first.board.cards.length, 0);
  const file = f.file();
  assert.equal(file.schemaVersion, 1);
  assert.equal(file.board.lanes.length, 6);
  assert.equal(file.board.lanes[0].id, "lane-backlog");
  assert.equal(file.board.lanes[0].fixed, true);
  assert.deepEqual(file.board.cards, []);
  assert.deepEqual(fs.readdirSync(join(f.project, ".pi")), ["kanban.json"]); // no lock or temp leftovers

  const bytes = f.bytes();
  const mtime = fs.statSync(f.path).mtimeMs;
  const second = await store.readBoard(f.project);
  assert.equal(second.ok, true);
  assert.equal(second.revision, first.revision);
  assert.equal(f.bytes(), bytes);
  assert.equal(fs.statSync(f.path).mtimeMs, mtime);
});

test("a mutation round-trips through the file and bumps the revision strictly each time", async (t) => {
  const f = fixture(t);
  const initial = await store.readBoard(f.project);
  const a = await add(f.project, "  First  ", "lane-todo", { cardId: "c1", description: "d" });
  assert.equal(a.ok, true);
  assert.ok(a.revision > initial.revision);
  const b = await add(f.project, "Second", "lane-plan", { cardId: "c2" });
  assert.ok(b.revision > a.revision);

  const onDisk = f.file();
  assert.deepEqual(onDisk.board.cards.map((c) => [c.id, c.title, c.laneId]), [["c1", "First", "lane-todo"], ["c2", "Second", "lane-plan"]]);
  const reread = await store.readBoard(f.project);
  assert.deepEqual(reread.board, b.board);
  assert.equal(reread.revision, b.revision);

  const moved = await store.applyMutation(f.project, { action: "advance-card", cardId: "c1" });
  assert.equal(moved.board.cards.find((c) => c.id === "c1").laneId, "lane-plan");
  const lane = await store.applyMutation(f.project, { action: "rename-lane", laneId: "lane-todo", name: "Ready" });
  assert.equal(lane.board.lanes[1].name, "Ready");
  assert.equal(f.file().board.lanes[1].name, "Ready");
});

test("an edit that changes nothing writes nothing", async (t) => {
  const f = fixture(t);
  await add(f.project, "Only", "lane-todo", { cardId: "c1" });
  const bytes = f.bytes();
  const mtime = fs.statSync(f.path).mtimeMs;
  const same = await store.applyMutation(f.project, { action: "delete-card", cardId: "no-such-card" });
  assert.equal(same.ok, true);
  assert.equal(f.bytes(), bytes);
  assert.equal(fs.statSync(f.path).mtimeMs, mtime);
});

test("a rule refusal is typed, writes nothing, and leaves the revision alone", async (t) => {
  const f = fixture(t);
  await add(f.project, "Last", "lane-done", { cardId: "c1" });
  const before = await store.readBoard(f.project);
  const bytes = f.bytes();
  const refused = await store.applyMutation(f.project, { action: "advance-card", cardId: "c1" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "refused");
  const sessionless = await store.applyMutation(f.project, { action: "move-card", cardId: "c1", laneId: "lane-todo" });
  assert.equal(sessionless.code, "refused");
  assert.equal(f.bytes(), bytes);
  assert.equal((await store.getBoardRevision(f.project)).revision, before.revision);
});

test("corrupt garbage is set aside as a backup sibling and replaced by a fresh board, without throwing", async (t) => {
  quietWarnings(t);
  const f = fixture(t);
  fs.mkdirSync(join(f.project, ".pi"), { recursive: true });
  fs.writeFileSync(f.path, "{ this is not json \u0000\u0001");
  const result = await store.readBoard(f.project);
  assert.equal(result.ok, true);
  assert.equal(result.board.lanes.length, 6);
  assert.equal(result.board.cards.length, 0);
  const files = fs.readdirSync(join(f.project, ".pi"));
  const backups = files.filter((name) => name.startsWith("kanban.json.corrupt-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(join(f.project, ".pi", backups[0]), "utf8"), "{ this is not json \u0000\u0001");
  assert.equal(f.file().schemaVersion, 1);
  assert.equal(f.file().board.lanes.length, 6);
});

test("valid JSON that is not a board is corrupt too; a mutation also recovers", async (t) => {
  quietWarnings(t);
  const f = fixture(t);
  fs.mkdirSync(join(f.project, ".pi"), { recursive: true });
  fs.writeFileSync(f.path, JSON.stringify({ schemaVersion: 1, board: { lanes: [{ id: "x", name: "X" }], cards: [] } }));
  const result = await add(f.project, "After corrupt", "lane-todo", { cardId: "c1" });
  assert.equal(result.ok, true);
  assert.equal(result.board.cards.length, 1);
  assert.equal(fs.readdirSync(join(f.project, ".pi")).filter((n) => n.includes(".corrupt-")).length, 1);
});

test("a file from a newer schema is refused and left untouched", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(join(f.project, ".pi"), { recursive: true });
  const text = JSON.stringify({ schemaVersion: 2, board: {} });
  fs.writeFileSync(f.path, text);
  const read = await store.readBoard(f.project);
  assert.equal(read.ok, false);
  assert.equal(read.code, "unsupported-schema");
  const write = await add(f.project, "x");
  assert.equal(write.code, "unsupported-schema");
  assert.equal(f.bytes(), text);
  assert.deepEqual(fs.readdirSync(join(f.project, ".pi")), ["kanban.json"]);
});

test("a hand-edited file is read leniently: stray lanes go to backlog, projectDir follows the folder", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(join(f.project, ".pi"), { recursive: true });
  const lanes = [
    { id: "lane-backlog", name: "Backlog", description: "", fixed: true },
    { id: "lane-todo", name: "Todo", description: "" },
  ];
  const card = (id, laneId, extra = {}) => ({ id, title: id, description: "", laneId, sessionId: null, sessionTitle: null, createdAt: 1, updatedAt: 1, ...extra });
  fs.writeFileSync(
    f.path,
    JSON.stringify({
      schemaVersion: 1,
      board: {
        projectDir: "/somewhere/else",
        lanes,
        cards: [card("a", "lane-gone"), card("b", "lane-todo"), card("b", "lane-todo"), "junk", card("c", "lane-todo", { sessionId: "s", sessionTitle: "T" })],
      },
    }),
  );
  const result = await store.readBoard(f.project);
  // "s" does not exist as a session, so it is pruned as well.
  assert.equal(result.board.projectDir, f.project);
  assert.deepEqual(result.board.cards.map((c) => [c.id, c.laneId, c.sessionId]), [["a", "lane-backlog", null], ["b", "lane-todo", null], ["c", "lane-todo", null]]);
});

test("revision is a pure stat that follows a manual mtime bump", async (t) => {
  const f = fixture(t);
  // No file yet: 0, and asking creates nothing.
  const none = await store.getBoardRevision(f.project);
  assert.deepEqual(none, { ok: true, revision: 0 });
  assert.equal(fs.existsSync(join(f.project, ".pi")), false);

  const created = await store.readBoard(f.project);
  const before = await store.getBoardRevision(f.project);
  assert.equal(before.revision, created.revision);

  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(f.path, future, future);
  const after = await store.getBoardRevision(f.project);
  assert.ok(after.revision >= future.getTime());
  assert.ok(after.revision > before.revision);

  // The next write moves forward from there, not back.
  const written = await add(f.project, "Later");
  assert.ok(written.revision >= after.revision);
});

test("a linked session that exists is linked; one whose file is gone is pruned on read (lane and title kept)", async (t) => {
  const f = fixture(t);
  const sessionFile = fabricateSession(f.agentDir, f.project, "sess-1");
  fabricateSession(f.agentDir, f.project, "sess-2");
  await add(f.project, "Card one", "lane-implement", { cardId: "c1" });
  await add(f.project, "Card two", "lane-plan", { cardId: "c2" });
  const l1 = await store.applyMutation(f.project, { action: "link-session", cardId: "c1", sessionId: "sess-1", sessionTitle: "Session one" });
  assert.equal(l1.ok, true);
  const l2 = await store.applyMutation(f.project, { action: "link-session", cardId: "c2", sessionId: "sess-2", sessionTitle: "Session two" });
  assert.equal(l2.board.cards.find((c) => c.id === "c1").sessionId, "sess-1");

  fs.rmSync(sessionFile);
  const read = await store.readBoard(f.project);
  assert.equal(read.ok, true);
  const pruned = read.board.cards.find((c) => c.id === "c1");
  assert.equal(pruned.sessionId, null);
  assert.equal(pruned.sessionTitle, "Session one");
  assert.equal(pruned.laneId, "lane-implement");
  assert.equal(read.board.cards.find((c) => c.id === "c2").sessionId, "sess-2");
  assert.ok(read.revision > l2.revision);
  assert.equal(f.file().board.cards.find((c) => c.id === "c1").sessionId, null); // written back

  const again = await store.readBoard(f.project);
  assert.equal(again.revision, read.revision); // nothing left to prune: no rewrite
});

test("every mutation prunes dead links from its result", async (t) => {
  const f = fixture(t);
  const sessionFile = fabricateSession(f.agentDir, f.project, "sess-1");
  await add(f.project, "Card", "lane-todo", { cardId: "c1" });
  await store.applyMutation(f.project, { action: "link-session", cardId: "c1", sessionId: "sess-1", sessionTitle: "S" });
  fs.rmSync(sessionFile);
  const result = await add(f.project, "Other", "lane-todo", { cardId: "c2" });
  assert.equal(result.ok, true);
  assert.equal(result.board.cards.find((c) => c.id === "c1").sessionId, null);
  assert.equal(result.board.cards.find((c) => c.id === "c1").sessionTitle, "S");
});

test("create-card-for-session makes a card for an existing session", async (t) => {
  const f = fixture(t);
  fabricateSession(f.agentDir, f.project, "sess-1");
  const result = await store.applyMutation(f.project, { action: "create-card-for-session", sessionId: "sess-1", sessionTitle: "Tracked", laneId: "lane-deploy" });
  assert.equal(result.ok, true);
  const card = result.board.cards.find((c) => c.sessionId === "sess-1");
  assert.equal(card.laneId, "lane-deploy");
  assert.equal(card.title, "Tracked");
  const unknown = await store.applyMutation(f.project, { action: "create-card-for-session", sessionId: "nope", sessionTitle: "x", laneId: null });
  assert.equal(unknown.code, "session-missing");
});

test("validateSession: exists for this cwd only", async (t) => {
  const f = fixture(t);
  fabricateSession(f.agentDir, f.project, "sess-1");
  const other = join(f.root, "other");
  fs.mkdirSync(other);
  fabricateSession(f.agentDir, other, "sess-other");
  assert.equal(await store.validateSession(f.project, "sess-1"), true);
  assert.equal(await store.validateSession(f.project, "sess-other"), false);
  assert.equal(await store.validateSession(f.project, "missing"), false);
  assert.equal(await store.validateSession(f.project, ""), false);
});

test("TC-06: link-session with an unknown session is a 404-style refusal; board and revision unchanged", async (t) => {
  const f = fixture(t);
  await add(f.project, "Card", "lane-todo", { cardId: "c1" });
  const before = await store.readBoard(f.project);
  const bytes = f.bytes();
  const mtime = fs.statSync(f.path).mtimeMs;
  const result = await store.applyMutation(f.project, { action: "link-session", cardId: "c1", sessionId: "does-not-exist", sessionTitle: "Ghost" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "session-missing");
  const added = await add(f.project, "With ghost session", "lane-todo", { cardId: "c2", sessionId: "does-not-exist" });
  assert.equal(added.code, "session-missing");
  assert.equal(f.bytes(), bytes);
  assert.equal(fs.statSync(f.path).mtimeMs, mtime);
  const after = await store.readBoard(f.project);
  assert.deepEqual(after.board, before.board);
  assert.equal(after.revision, before.revision);
});

test("a create:false read writes nothing: a missing board reads empty (revision 0), a corrupt one is left alone", async (t) => {
  const f = fixture(t);
  const read = await store.readBoard(f.project, { create: false });
  assert.equal(read.ok, true);
  assert.equal(read.revision, 0);
  assert.equal(read.board.cards.length, 0);
  assert.equal(read.board.lanes.length, 6);
  assert.equal(fs.existsSync(f.path), false);
  fs.mkdirSync(join(f.project, ".pi"), { recursive: true });
  fs.writeFileSync(f.path, "not json at all");
  const corrupt = await store.readBoard(f.project, { create: false });
  assert.equal(corrupt.ok, true);
  assert.equal(corrupt.revision, 0);
  assert.equal(fs.readFileSync(f.path, "utf8"), "not json at all");
  assert.ok(!fs.readdirSync(join(f.project, ".pi")).some((name) => name.startsWith("kanban.json.corrupt-")));
});

test("TC-08: a bad cwd is a typed refusal and nothing is created", async (t) => {
  const f = fixture(t);
  const missing = join(f.root, "definitely-not-a-project");
  allowFileRoot(missing);
  const file = join(f.root, "a-file");
  fs.writeFileSync(file, "x");
  allowFileRoot(file);
  const outside = join(f.root, "outside");
  fs.mkdirSync(outside); // exists, but is not an allowed root

  for (const [cwd, code] of [
    [missing, "cwd-denied"], // outside the roots as given: the same answer whether or not it exists, as /api/mcp
    [file, "cwd-not-directory"],
    [outside, "cwd-denied"],
    ["relative/dir", "cwd-invalid"],
    ["", "cwd-invalid"],
    [undefined, "cwd-invalid"],
  ]) {
    const read = await store.readBoard(cwd);
    assert.equal(read.ok, false, String(cwd));
    assert.equal(read.code, code, String(cwd));
    assert.equal(typeof read.error, "string");
    const write = await store.applyMutation(cwd, { action: "add-lane", name: "x" });
    assert.equal(write.code, code, String(cwd));
    const revision = await store.getBoardRevision(cwd);
    assert.equal(revision.code, code, String(cwd));
  }
  assert.equal(fs.existsSync(missing), false);
  assert.equal(fs.existsSync(join(outside, ".pi")), false);
  assert.equal(fs.readFileSync(file, "utf8"), "x");
});

test("concurrent mutations in one process are serialized: none is lost", async (t) => {
  const f = fixture(t);
  await store.readBoard(f.project);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => add(f.project, `Card ${i}`, "lane-todo", { cardId: `c${i}` })));
  assert.ok(results.every((r) => r.ok));
  assert.equal(f.file().board.cards.length, 12);
  const revisions = results.map((r) => r.revision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b));
  assert.equal(new Set(revisions).size, 12);
});

test("another process holding the lock gives a typed `locked` refusal, never a throw", { timeout: 30_000 }, async (t) => {
  quietWarnings(t);
  const f = fixture(t);
  await store.readBoard(f.project);
  const release = await lockfile.lock(f.path, { realpath: false, stale: 60_000 });
  const bytes = f.bytes();
  try {
    const result = await add(f.project, "Blocked");
    assert.equal(result.ok, false);
    assert.equal(result.code, "locked");
    assert.equal(f.bytes(), bytes);
  } finally {
    await release();
  }
  const after = await add(f.project, "Unblocked");
  assert.equal(after.ok, true);
});
