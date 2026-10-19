---
createdAt: "2026-10-19T00:00:00Z"
implementedAt: null
reviewedAt: null
# SIGN-OFF: PENDING — GOAL.md requires the operator's sign-off in this header
# before any M4 (shared storage) coding starts. The continuous-improvement
# loop must not implement this plan until a line like
# `signoff: "<operator>, <date>"` is added below.
signoff: null
# The sign-off should also settle the two open questions in Design
# (Q1 board-key scheme, Q2 migration policy); the recommendations below
# are the default the loop follows if the operator signs off as-is.
---

# Plan: Move the kanban board from the project checkout to pi's shared agent storage

## Background & Context

- **Business Driver**: operator decision 2026-10-19 (GOAL.md M4). A board at
  `<project>/.pi/kanban.json` forks per git worktree (every checkout gets its
  own copy) and drags live task state through version control. All worktrees
  of a project must read and write **one** board.
- **Technical Context**: the file location is a server-side detail.
  `lib/kanban-store.ts` line 91 (`join(cwd, ".pi", "kanban.json")`) is the only
  path resolution; the route takes a `cwd`, resolves the project root, and the
  client keys its cache by the project directory string (`/api/kanban?cwd=…`).
  Everything downstream of the path — the schema envelope, atomic temp+rename
  writes, the corrupt set-aside, the 4 MiB cap, the 0644 mode rule, and the
  revision = max(in-process counter, file mtime) — is location-agnostic and
  already cross-process (the 423 lock test runs a second process on the same
  file). Session→card matching is by `sessionId` inside the JSON: agnostic.
- **Related Decisions**: the "committable board" property is dropped **by
  design** (the whole point). The M3 `.gitignore` guidance in
  `docs/agents/kanban.md` becomes obsolete and is replaced by a migration
  note in the same section. **Predecessor**: the current location was the
  user-chosen option 1 of `KANBAN_REAL_API_PLAN.md` (this folder,
  implemented 2026-10-18); its post-implementation notes now carry the
  supersession pointer back to this plan.

## Key Information

### Success Criteria

- [ ] A board for project `P` lives at `~/.pi/agent/kanban/<key(P)>.json`;
      a creating GET writes there and writes nothing under the project.
- [ ] Two worktrees of `P` see each other's mutations through the one shared
      file (the existing revision poll picks them up, no new channel).
- [ ] An existing `<project>/.pi/kanban.json` is imported exactly once (cards,
      lanes, schema, revision continuity preserved); a corrupt one is set
      aside like any corrupt read and the board starts fresh.
- [ ] All existing store/reducer/route tests pass with the new path
      (they key on `cwd`, not on the file's directory).
- [ ] Client behavior is unchanged: the same `/api/kanban` URL, the same
      responses, the same sidebar/strip/board UI.
- [ ] `docs/agents/kanban.md`: **Not built** loses the entry; **File and
      envelope** names the new location, the key, and the migration; the M3
      gitignore section becomes a migration note.
- [ ] check.sh gains the M4 predicate (store no longer resolves under the
      project directory) and the score map is updated for the M3 change.

### Design

The one-line core change, plus the two decisions the sign-off settles:

```
 <cwd> ──resolveProject──> projectRoot ──boardKey──> ~/.pi/agent/kanban/<key>.json
                                            (all store machinery unchanged)
```

- **Q1 — the board key.** Recommendation: the **encoded project root
  path**, using the same encoding pi's session directories use for
  `~/.pi/agent/sessions/<encoded-cwd>/` (the SDK `SessionManager` path
  scheme — reuse it, do not invent a new one). Human-readable in the
  agent dir, stable across renames of individual worktrees (the key is
  the *project root*, which a worktree resolution already canonicalizes),
  unique per project. Alternative (not recommended): a short hash of the
  path — opaque, and a hash-collision policy would have to be invented.
- **Q2 — migration of existing boards.** Recommendation: **import-on-first
  read, then delete the legacy file.** At the first *creating* read for a
  project whose legacy `<project>/.pi/kanban.json` exists and whose shared
  file does not: read the legacy bytes through the existing (corrupt-safe)
  reader, write them to the shared path (atomic), delete the legacy file
  (its corrupt sibling, if any, goes with the set-aside rules). A later
  read never touches the legacy path. Alternative (not recommended):
  leave the file in place — two boards for one project, exactly the bug
  being fixed.
- **No path leaks**: the key is computed from the resolved project root, so
  a worktree cwd, a subdirectory cwd, and the top-level cwd all map to the
  same file (same canonicalization `resolveProject` already does for the
  route).
- **Security/trust**: the route's request gate and cwd validation are
  unchanged (they validate the *project* cwd; the destination under
  `~/.pi/agent` is an implementation detail of the store, like the agent
  dir already is for sessions).

### Test Cases

| # | Case | Expectation |
|---|------|-------------|
| 1 | Creating GET for project P | file at `~/.pi/agent/kanban/<key(P)>.json`; no `.pi/kanban.json` under P |
| 2 | `?create=0` (no board yet) | shared file **not** created (the creating-read rule survives the move) |
| 3 | Worktrees A and B of P: mutate in A, read from B | B's read sees A's card; one file on disk |
| 4 | Legacy board exists, shared absent | import-on-first-read: cards/lanes/schema moved, legacy file deleted, revision continues |
| 5 | Legacy board corrupt, shared absent | set-aside per the corrupt rules; fresh empty shared board; no crash |
| 6 | Projects P and Q | two distinct shared files; no cross-contamination |
| 7 | Existing store tests (lock, corrupt, mode, cap, revision, schema) | all green at the new path, unchanged |
| 8 | Route tests (all 12 actions, gates, pruning) | all green; responses byte-identical in shape |
| 9 | Docs | **Not built** entry gone; File section names location/key/migration; M3 section replaced; check.sh M3 predicate updated to match |
| 10 | Client | `/api/kanban` URL and response shape unchanged; no new i18n keys |

### Rollout

One commit: the store path function (+ key), the import-on-first-read,
the doc updates, and the store/route test updates (they mostly just need
the fixture's file-assertion paths pointed at the agent dir). Client code,
i18n, and the route's external shape are untouched.
