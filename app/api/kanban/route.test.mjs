import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import lockfile from "proper-lockfile";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const route = await jiti.import("./route.ts");
const store = await jiti.import("../../../lib/kanban-store.ts");
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");

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
 * A temp agent dir (the PI_CODING_AGENT_DIR override the session tests use) and a
 * temp project dir that is an allowed root, so cwd validation passes.
 */
function fixture(t, { allow = true } = {}) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-web-kanban-route-")));
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
  return {
    root,
    agentDir,
    project,
    path: join(project, ".pi", "kanban.json"),
    file: () => JSON.parse(fs.readFileSync(join(project, ".pi", "kanban.json"), "utf8")),
    bytes: () => fs.readFileSync(join(project, ".pi", "kanban.json"), "utf8"),
    exists: () => fs.existsSync(join(project, ".pi", "kanban.json")),
    stat: () => fs.statSync(join(project, ".pi", "kanban.json")),
  };
}

/** A fabricated `<agentDir>/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl` with just a header. */
function fabricateSession(agentDir, cwd, id) {
  const dir = join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`), JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd }) + "\n");
  return dir;
}

function quietWarnings(t) {
  const previous = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = previous;
  });
}

const TRUSTED = { host: "localhost" };
const UNTRUSTED = { host: "evil.example" };

async function get(project, extra = "", headers = TRUSTED) {
  const response = await route.GET(new Request(`http://localhost/api/kanban?cwd=${encodeURIComponent(project)}${extra}`, { headers }));
  return { status: response.status, body: await response.json() };
}

async function post(body, headers = { ...TRUSTED, "Content-Type": "application/json" }) {
  const response = await route.POST(new Request("http://localhost/api/kanban", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

test("a GET auto-creates the board on first read and answers the second read without rewriting", async (t) => {
  const f = fixture(t);
  const first = await get(f.project);
  assert.equal(first.status, 200);
  assert.equal(first.body.board.projectDir, f.project);
  assert.equal(first.body.board.lanes.length, 6);
  assert.deepEqual(first.body.board.cards, []);
  assert.ok(f.exists());
  assert.equal(f.file().schemaVersion, 1);

  const bytes = f.bytes();
  const second = await get(f.project);
  assert.equal(second.status, 200);
  assert.equal(second.body.revision, first.body.revision);
  assert.equal(f.bytes(), bytes);
});

test("a GET with create=0 reads a missing board as empty, writes nothing, and skips the request gate", async (t) => {
  const f = fixture(t);
  const missing = await get(f.project, "&create=0");
  assert.equal(missing.status, 200);
  assert.equal(missing.body.revision, 0);
  assert.equal(missing.body.board.lanes.length, 6);
  assert.equal(missing.body.board.cards.length, 0);
  assert.ok(!f.exists(), "create=0 never writes");

  // The gate only guards the creating read; a no-write poll may come from anywhere.
  const untrusted = await get(f.project, "&create=0", UNTRUSTED);
  assert.equal(untrusted.status, 200);
  assert.equal(untrusted.body.revision, 0);
  assert.ok(!f.exists());
});

test("a GET with revOnly=1 is a pure stat: no parse, no write, revision 0 for a missing board", async (t) => {
  const f = fixture(t);
  const missing = await get(f.project, "&revOnly=1");
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body, { revision: 0 });
  assert.ok(!f.exists(), "revOnly never creates");

  await get(f.project);
  const created = await get(f.project);
  const stat = await get(f.project, "&revOnly=1");
  assert.equal(stat.status, 200);
  assert.deepEqual(stat.body, { revision: created.body.revision });
});

test("a creating GET from an untrusted host is refused before anything is written", async (t) => {
  const f = fixture(t);
  const denied = await get(f.project, "", UNTRUSTED);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "request-denied");
  assert.ok(!f.exists());
});

test("a GET answers cwd problems with the validator's typed codes", async (t) => {
  const f = fixture(t);
  const missingCwd = await route.GET(new Request("http://localhost/api/kanban", { headers: TRUSTED })).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.equal(missingCwd.status, 400);
  assert.equal(missingCwd.body.code, "cwd-invalid");

  assert.equal((await get(f.root)).status, 403); // the parent is not an allowed root
  const above = (await get(f.root)).body;
  assert.equal(above.code, "cwd-denied");

  // A path that cannot be proven to sit inside an allowed root gets the same
  // answer whether or not it exists: 403 cwd-denied (the validator's contract).
  const absent = await get(join(f.project, "nope"));
  assert.equal(absent.status, 403);
  assert.equal(absent.body.code, "cwd-denied");

  fs.writeFileSync(join(f.project, "plain.txt"), "x");
  const fileAsCwd = await get(join(f.project, "plain.txt"));
  assert.equal(fileAsCwd.status, 400);
  assert.equal(fileAsCwd.body.code, "cwd-not-directory");
});

test("a POST refuses an untrusted host and a wrong Content-Type before anything else", async (t) => {
  const f = fixture(t);
  const untrusted = await post({ cwd: f.project, action: "add-card", laneId: "lane-todo", title: "X" }, UNTRUSTED);
  assert.equal(untrusted.status, 403);
  assert.equal(untrusted.body.code, "request-denied");

  const wrongType = await post({ cwd: f.project, action: "add-card", laneId: "lane-todo", title: "X" }, { ...TRUSTED, "Content-Type": "text/plain" });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.body.code, "content-type");
  assert.ok(!f.exists());
});

test("a POST with an invalid body is a typed 400 and writes nothing", async (t) => {
  const f = fixture(t);
  const badJson = await post("not json");
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.code, "invalid-request");

  const notAnObject = await post("[1, 2]");
  assert.equal(notAnObject.status, 400);
  assert.equal(notAnObject.body.code, "invalid-request");

  const unknownAction = await post({ cwd: f.project, action: "explode" });
  assert.equal(unknownAction.status, 400);
  assert.equal(unknownAction.body.code, "invalid-request");

  const blankTitle = await post({ cwd: f.project, action: "add-card", laneId: "lane-todo", title: "   " });
  assert.equal(blankTitle.status, 400);
  assert.equal(blankTitle.body.code, "invalid-request");

  const foreignCwd = await post({ cwd: f.root, action: "add-card", laneId: "lane-todo", title: "X" });
  assert.equal(foreignCwd.status, 403);
  assert.equal(foreignCwd.body.code, "cwd-denied");
  assert.ok(!f.exists());
});

test("a POST link-session for a session that does not exist in the project is a 404 session-missing and leaves the card alone", async (t) => {
  const f = fixture(t);
  const created = await post({ cwd: f.project, action: "add-card", laneId: "lane-todo", title: "Card", cardId: "c1" });
  assert.equal(created.status, 200);

  const missing = await post({ cwd: f.project, action: "link-session", cardId: "c1", sessionId: "ghost", sessionTitle: "Ghost" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "session-missing");
  const card = f.file().board.cards.find((c) => c.id === "c1");
  assert.equal(card.sessionId, null);

  fabricateSession(f.agentDir, f.project, "real-1");
  const linked = await post({ cwd: f.project, action: "link-session", cardId: "c1", sessionId: "real-1", sessionTitle: "Real" });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.board.cards.find((c) => c.id === "c1").sessionId, "real-1");
});

test("a POST add-card with a session into the fixed backlog is a 400 refused and writes nothing", async (t) => {
  const f = fixture(t);
  await post({ cwd: f.project, action: "add-card", laneId: "lane-todo", title: "Existing" }); // materialize the board
  const before = f.file();
  fabricateSession(f.agentDir, f.project, "real-1");
  const refused = await post({ cwd: f.project, action: "add-card", laneId: "lane-backlog", title: "Tracked", sessionId: "real-1", sessionTitle: "Real" });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "refused");
  assert.equal(JSON.stringify(f.file()), JSON.stringify(before), "the refusal writes nothing");
});

test("a POST mutation round-trips to the file and bumps the revision", async (t) => {
  const f = fixture(t);
  const base = await get(f.project);
  const added = await post({ cwd: f.project, action: "add-card", laneId: "lane-todo", title: " First ", description: "d", cardId: "c1" });
  assert.equal(added.status, 200);
  assert.ok(added.body.revision > base.body.revision);
  assert.deepEqual(f.file().board.cards.map((c) => [c.id, c.title, c.laneId]), [["c1", "First", "lane-todo"]]);

  // A sessionless card may rest in a work lane only because it was added there; moving
  // it to another work lane is refused. Linking a session unblocks the move.
  const refusedMove = await post({ cwd: f.project, action: "move-card", cardId: "c1", laneId: "lane-plan" });
  assert.equal(refusedMove.status, 400);
  assert.equal(refusedMove.body.code, "refused");

  fabricateSession(f.agentDir, f.project, "s-move");
  await post({ cwd: f.project, action: "link-session", cardId: "c1", sessionId: "s-move", sessionTitle: "Move" });
  const moved = await post({ cwd: f.project, action: "move-card", cardId: "c1", laneId: "lane-plan" });
  assert.equal(moved.status, 200);
  assert.ok(moved.body.revision > added.body.revision);
  assert.equal(f.file().board.cards[0].laneId, "lane-plan");

  // A sessionless card leaving the backlog for a work lane is refused too, and writes nothing.
  await post({ cwd: f.project, action: "add-card", laneId: "lane-backlog", title: "Stuck", cardId: "c2" });
  const refusedBacklog = await post({ cwd: f.project, action: "move-card", cardId: "c2", laneId: "lane-todo" });
  assert.equal(refusedBacklog.status, 400);
  assert.equal(refusedBacklog.body.code, "refused");
  assert.equal(f.file().board.cards.length, 2);
  assert.equal(f.file().board.cards.find((c) => c.id === "c2").laneId, "lane-backlog");
});

test("a POST while another process holds the lock is a 423 locked and leaves the file alone", { timeout: 30_000 }, async (t) => {
  quietWarnings(t);
  const f = fixture(t);
  await get(f.project);
  const release = await lockfile.lock(f.path, { realpath: false, stale: 60_000 });
  const bytes = f.bytes();
  try {
    const blocked = await post({ cwd: f.project, action: "add-card", laneId: "lane-todo", title: "Blocked" });
    assert.equal(blocked.status, 423);
    assert.equal(blocked.body.code, "locked");
    assert.equal(f.bytes(), bytes);
  } finally {
    await release();
  }
  const after = await post({ cwd: f.project, action: "add-card", laneId: "lane-todo", title: "Unblocked" });
  assert.equal(after.status, 200);
});

test("a POST on a board from a newer schema is a 500 unsupported-schema and leaves the file untouched", async (t) => {
  const f = fixture(t);
  await get(f.project);
  const current = f.file();
  const newer = JSON.stringify({ ...current, schemaVersion: 2 });
  fs.writeFileSync(f.path, newer);

  const denied = await post({ cwd: f.project, action: "add-card", laneId: "lane-todo", title: "X" });
  assert.equal(denied.status, 500);
  assert.equal(denied.body.code, "unsupported-schema");
  assert.equal(f.bytes(), newer, "the file is left as found");

  // The creating read refuses it the same way.
  const read = await get(f.project);
  assert.equal(read.status, 500);
  assert.equal(read.body.code, "unsupported-schema");
  assert.equal(f.bytes(), newer);
});

/** Writes garbage where the board would live, so the next read sees it as corrupt. */
function corruptBoard(f) {
  fs.mkdirSync(dirname(f.path), { recursive: true });
  fs.writeFileSync(f.path, "{ this is not json ");
}

function corruptBackups(f) {
  return fs.readdirSync(dirname(f.path)).filter((name) => name.includes(".corrupt-"));
}

test("a create=0 GET on a corrupt file reads it as an empty board and leaves it exactly as found", async (t) => {
  const f = fixture(t);
  corruptBoard(f);
  const bytes = f.bytes();

  const read = await get(f.project, "&create=0");
  assert.equal(read.status, 200);
  assert.equal(read.body.revision, 0);
  assert.equal(read.body.board.lanes.length, 6);
  assert.equal(read.body.board.cards.length, 0);
  assert.equal(f.bytes(), bytes, "a no-write read never sets the file aside");
  assert.deepEqual(corruptBackups(f), []);
});

test("a revOnly=1 GET on a corrupt file is still a pure stat: the file's mtime, no parse, no backup", async (t) => {
  const f = fixture(t);
  corruptBoard(f);
  const bytes = f.bytes();
  const mtime = fs.statSync(f.path).mtimeMs;

  const read = await get(f.project, "&revOnly=1");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, { revision: mtime });
  assert.equal(f.bytes(), bytes);
  assert.deepEqual(corruptBackups(f), []);
});

test("a creating GET on a corrupt file sets it aside and answers a fresh board", async (t) => {
  const f = fixture(t);
  quietWarnings(t);
  corruptBoard(f);

  const read = await get(f.project);
  assert.equal(read.status, 200);
  assert.equal(read.body.board.lanes.length, 6);
  assert.equal(read.body.board.cards.length, 0);
  assert.equal(corruptBackups(f).length, 1, "exactly one backup sibling");
  assert.equal(f.file().schemaVersion, 1, "the new file is a valid board");
});

test("a POST on a corrupt file sets it aside, applies the action to a fresh board, and has no corrupt flag of its own", async (t) => {
  const f = fixture(t);
  quietWarnings(t);
  corruptBoard(f);

  const added = await post({ cwd: f.project, action: "add-card", laneId: "lane-todo", title: "After the mess" });
  assert.equal(added.status, 200);
  assert.equal(added.body.board.cards.length, 1);
  assert.equal(added.body.board.cards[0].title, "After the mess");
  assert.deepEqual(Object.keys(added.body).sort(), ["board", "revision"], "the response shape never gained a flag");
  assert.equal(corruptBackups(f).length, 1);
  assert.equal(f.file().board.cards.length, 1);
});

test("a POST whose cwd is an existing regular file is a 400 cwd-not-directory", async (t) => {
  const f = fixture(t);
  const file = join(f.project, "a-file.txt");
  fs.writeFileSync(file, "x");

  const denied = await post({ cwd: file, action: "add-card", laneId: "lane-todo", title: "X" });
  assert.equal(denied.status, 400);
  assert.equal(denied.body.code, "cwd-not-directory");
  assert.ok(!f.exists(), "a non-directory cwd cannot start a board");
});

test("a move-card with a session jumps to any work lane but never into the backlog", async (t) => {
  const f = fixture(t);
  fabricateSession(f.agentDir, f.project, "mv-1");
  await get(f.project);

  const created = await post({ cwd: f.project, action: "create-card-for-session", sessionId: "mv-1", sessionTitle: "MV", laneId: "lane-todo" });
  assert.equal(created.status, 200);
  const card = created.body.board.cards.find((c) => c.sessionId === "mv-1");
  assert.ok(card);

  const jumped = await post({ cwd: f.project, action: "move-card", cardId: card.id, laneId: "lane-deploy" });
  assert.equal(jumped.status, 200);
  assert.equal(jumped.body.board.cards.find((c) => c.id === card.id).laneId, "lane-deploy");

  const toBacklog = await post({ cwd: f.project, action: "move-card", cardId: card.id, laneId: "lane-backlog" });
  assert.equal(toBacklog.status, 400);
  assert.equal(toBacklog.body.code, "refused");
  assert.equal(jumped.body.board.cards.find((c) => c.id === card.id).laneId, f.file().board.cards.find((c) => c.id === card.id).laneId);
});

test("create-card-for-session is idempotent per session, and unlink keeps the snapshot title", async (t) => {
  const f = fixture(t);
  fabricateSession(f.agentDir, f.project, "un-1");
  await get(f.project);

  const first = await post({ cwd: f.project, action: "create-card-for-session", sessionId: "un-1", sessionTitle: "Same title" });
  assert.equal(first.status, 200);
  assert.equal(first.body.board.cards.length, 1);
  assert.equal(first.body.board.cards[0].laneId, "lane-todo", "a null lane lands in the first work lane");

  // Same title again: the reducer returns the same board, so nothing is written.
  const again = await post({ cwd: f.project, action: "create-card-for-session", sessionId: "un-1", sessionTitle: "Same title" });
  assert.equal(again.status, 200);
  assert.equal(again.body.revision, first.body.revision, "an unchanged board is not rewritten");
  assert.equal(again.body.board.cards.length, 1);

  // A new title updates the snapshot instead of adding a card.
  const retitled = await post({ cwd: f.project, action: "create-card-for-session", sessionId: "un-1", sessionTitle: "New title" });
  assert.equal(retitled.status, 200);
  assert.equal(retitled.body.board.cards.length, 1);
  assert.equal(retitled.body.board.cards[0].sessionTitle, "New title");

  const unlinked = await post({ cwd: f.project, action: "unlink-session", cardId: retitled.body.board.cards[0].id });
  assert.equal(unlinked.status, 200);
  const card = unlinked.body.board.cards[0];
  assert.equal(card.sessionId, null);
  assert.equal(card.sessionTitle, "New title", "the snapshot survives the unlink");
});

test("lane operations: add (client id, dup id refused), rename (backlog refused), move (edges refused), delete relocates cards", async (t) => {
  const f = fixture(t);
  await get(f.project);

  const added = await post({ cwd: f.project, action: "add-lane", name: "Ship", laneId: "lane-ship" });
  assert.equal(added.status, 200);
  assert.equal(added.body.board.lanes.length, 7);
  assert.equal(added.body.board.lanes[6].id, "lane-ship");

  const dupId = await post({ cwd: f.project, action: "add-lane", name: "Shipped", laneId: "lane-ship" });
  assert.equal(dupId.status, 400);
  assert.equal(dupId.body.code, "refused");

  const renameBacklog = await post({ cwd: f.project, action: "rename-lane", laneId: "lane-backlog", name: "Inbox" });
  assert.equal(renameBacklog.status, 400);
  assert.equal(renameBacklog.body.code, "refused");

  const renamed = await post({ cwd: f.project, action: "rename-lane", laneId: "lane-plan", name: "Planned" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.board.lanes.find((l) => l.id === "lane-plan").name, "Planned");

  const moved = await post({ cwd: f.project, action: "move-lane", laneId: "lane-plan", direction: -1 });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body.board.lanes.map((l) => l.id), ["lane-backlog", "lane-plan", "lane-todo", "lane-implement", "lane-deploy", "lane-done", "lane-ship"]);

  const pastEnd = await post({ cwd: f.project, action: "move-lane", laneId: "lane-ship", direction: 1 });
  assert.equal(pastEnd.status, 400);
  assert.equal(pastEnd.body.code, "refused");

  const badDirection = await post({ cwd: f.project, action: "move-lane", laneId: "lane-plan", direction: 0 });
  assert.equal(badDirection.status, 400);
  assert.equal(badDirection.body.code, "invalid-request");

  const backlogMove = await post({ cwd: f.project, action: "move-lane", laneId: "lane-backlog", direction: 1 });
  assert.equal(backlogMove.status, 400);
  assert.equal(backlogMove.body.code, "refused");

  // A card in the lane being deleted is relocated to the backlog, unlinked.
  const carded = await post({ cwd: f.project, action: "add-card", laneId: "lane-ship", title: "Ships", description: "d" });
  assert.equal(carded.status, 200);
  const deleted = await post({ cwd: f.project, action: "delete-lane", laneId: "lane-ship" });
  assert.equal(deleted.status, 200);
  assert.ok(!deleted.body.board.lanes.some((l) => l.id === "lane-ship"));
  const relocated = deleted.body.board.cards.find((c) => c.title === "Ships");
  assert.equal(relocated.laneId, "lane-backlog");
  assert.equal(relocated.sessionId, null);
});

test("edit-card: title and description update, neither is an invalid request, an unknown card is refused", async (t) => {
  const f = fixture(t);
  await get(f.project);
  const added = await post({ cwd: f.project, action: "add-card", laneId: "lane-backlog", title: "Old", description: "old text" });
  assert.equal(added.status, 200);
  const card = added.body.board.cards[0];

  const edited = await post({ cwd: f.project, action: "edit-card", cardId: card.id, title: "New", description: "new text" });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.board.cards[0].title, "New");
  assert.equal(edited.body.board.cards[0].description, "new text");

  const neither = await post({ cwd: f.project, action: "edit-card", cardId: card.id });
  assert.equal(neither.status, 400);
  assert.equal(neither.body.code, "invalid-request");

  const unknown = await post({ cwd: f.project, action: "edit-card", cardId: "nope", title: "X" });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, "refused");
});

test("a revOnly=1 GET passes an untrusted host: a pure stat, like create=0, and never writes", async (t) => {
  const f = fixture(t);
  await get(f.project);
  const bytesBefore = f.bytes();
  const trusted = await get(f.project, "&revOnly=1");
  assert.equal(trusted.status, 200);

  const untrusted = await get(f.project, "&revOnly=1", UNTRUSTED);
  assert.equal(untrusted.status, 200);
  assert.equal(untrusted.body.revision, trusted.body.revision);
  assert.equal(f.bytes(), bytesBefore, "a stat never rewrites");

  const bare = fixture(t);
  const none = await get(bare.project, "&revOnly=1", UNTRUSTED);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body, { revision: 0 });
  assert.ok(!bare.exists(), "a stat never creates");
});

test("a read unlinks a card whose session file vanished: keeps lane and snapshot, writes only while something was dead", async (t) => {
  const f = fixture(t);
  const dir = fabricateSession(f.agentDir, f.project, "d-1");
  await get(f.project);

  const linked = await post({ cwd: f.project, action: "create-card-for-session", sessionId: "d-1", sessionTitle: "Dead one" });
  assert.equal(linked.status, 200);
  const cardId = linked.body.board.cards[0].id;

  fs.rmSync(join(dir, "2026-01-01T00-00-00-000Z_d-1.jsonl"));

  const pruned = await get(f.project);
  assert.equal(pruned.status, 200);
  const card = pruned.body.board.cards.find((c) => c.id === cardId);
  assert.equal(card.sessionId, null, "the dead link is unlinked");
  assert.equal(card.sessionTitle, "Dead one", "the snapshot survives");
  assert.equal(card.laneId, "lane-todo", "the lane survives");

  const bytes = f.bytes();
  const again = await get(f.project);
  assert.equal(again.status, 200);
  assert.equal(f.bytes(), bytes, "a read with nothing dead writes nothing");
});

test("a mutation prunes dead links inside its own lock: the answered board is already clean", async (t) => {
  const f = fixture(t);
  const dir2 = fabricateSession(f.agentDir, f.project, "d-2");
  fabricateSession(f.agentDir, f.project, "d-3");
  await get(f.project);

  const two = await post({ cwd: f.project, action: "create-card-for-session", sessionId: "d-2", sessionTitle: "Going" });
  assert.equal(two.status, 200);
  const card2 = two.body.board.cards.find((c) => c.sessionId === "d-2");
  const three = await post({ cwd: f.project, action: "add-card", laneId: "lane-plan", title: "T3", sessionId: "d-3", sessionTitle: "Three" });
  assert.equal(three.status, 200);
  const card3 = three.body.board.cards.find((c) => c.sessionId === "d-3");

  fs.rmSync(join(dir2, "2026-01-01T00-00-00-000Z_d-2.jsonl"));

  const advanced = await post({ cwd: f.project, action: "advance-card", cardId: card3.id });
  assert.equal(advanced.status, 200);
  assert.equal(advanced.body.board.cards.find((c) => c.id === card3.id).laneId, "lane-implement");
  const prunedCard = advanced.body.board.cards.find((c) => c.id === card2.id);
  assert.equal(prunedCard.sessionId, null, "the dead link is gone from the answered board");
  assert.equal(prunedCard.sessionTitle, "Going");
  assert.equal(f.file().board.cards.find((c) => c.id === card2.id).sessionId, null);
});

test("a fresh board's bytes are exactly the canonical envelope: 2-space JSON, trailing newline, committable", async (t) => {
  const f = fixture(t);
  const res = await get(f.project);
  assert.equal(res.status, 200);
  const expected = JSON.stringify({ schemaVersion: 1, board: res.body.board }, null, 2) + "\n";
  assert.equal(f.bytes(), expected, "the written file is the envelope re-serialized canonically");
  assert.ok(!f.bytes().includes("undefined"));
  assert.equal(f.stat().mode & 0o777, 0o644);
});

test("an edit that changes nothing writes nothing and leaves the revision standing", async (t) => {
  const f = fixture(t);
  await get(f.project);
  const added = await post({ cwd: f.project, action: "add-card", laneId: "lane-todo", title: "Same" });
  assert.equal(added.status, 200);
  const rev = added.body.revision;
  assert.ok(rev > 0);
  const bytes = f.bytes();
  const cardId = added.body.board.cards[0].id;

  const noop = await post({ cwd: f.project, action: "edit-card", cardId, title: "Same" });
  assert.equal(noop.status, 200);
  assert.equal(noop.body.revision, rev, "the reducer's same-object result skips the write, so no bump");
  assert.equal(f.bytes(), bytes, "the file is untouched");

  const real = await post({ cwd: f.project, action: "edit-card", cardId, title: "Changed" });
  assert.equal(real.status, 200);
  assert.ok(real.body.revision > rev, "a real change moves the revision");
});

test("a refused mutation on a bare project still materializes the fresh board", async (t) => {
  const f = fixture(t);
  assert.ok(!f.exists());
  const res = await post({ cwd: f.project, action: "advance-card", cardId: "nope" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "refused");
  assert.ok(f.exists(), "the edit writes the fresh board even though the action was refused");
  assert.equal(f.file().board.cards.length, 0);
  const rev = await get(f.project, "&revOnly=1");
  assert.equal(rev.status, 200);
  assert.ok(rev.body.revision > 0, "the write left a revision behind");
});
