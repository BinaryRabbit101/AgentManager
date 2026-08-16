# Projects — Implementation

Ordered v1 milestones for the project registry, implementing [DESIGN.md](DESIGN.md).
Each milestone is independently verifiable and leaves the system working.

**Prerequisites from foundation** (blocking M1): SQLite connection + migration runner, config
loader (`projectsRoot`, `worktreesRoot`, `browseRoots`, retention defaults), data-root path
resolution, logger, core event bus, module registration, secret-store read API. If foundation
is not yet landed, M1 may proceed against a thin local adapter, but must not define its own
DB file or config format.

**Coordination points to confirm before the milestone that needs them**: roster's permission
rule shape (M4), runner/orchestrator's `session` and `assignment` tables carrying `project_id`
/ `assignment_id` / `transcript_path` / token totals (M5), transcript file layout (M5),
runner's launch-context call and lease usage (M6).

---

## M1 — Schema, storage, and the project repository module

Create the migration adding `project`, `project_default_agent`, `work_item`,
`work_item_assignment`, `workspace_lease`. Implement path canonicalization
(realpath → drive-letter upcase → strip trailing separators → lowercased key), slug
generation with dedup, and a `ProjectRepository` with typed CRUD. Register the module with
the core.

**Acceptance**
- Migration applies to an empty DB and is idempotent on re-run.
- `C:\Code\App`, `c:\code\app\`, and a junction pointing at it all resolve to the same
  `local_path_key`; a second registration of any of them is rejected with a typed conflict.
- Slug collisions produce `app`, `app-2`, `app-3`; slugs never exceed 24 chars and match
  `^[a-z0-9-]+$`.
- Round-trip create/read/update/delete unit tests pass; `defaults_json` and `retention_json`
  parse into typed objects with defaults applied for missing fields.

## M2 — Register an existing folder (inspect + create)

Implement `POST /api/projects/inspect { localPath }` and `POST /api/projects`: existence,
directory, read/write access, nesting checks (contains-or-inside an existing project, inside
the data root), git detection via `.git` (rejecting a `.git` *file* — an existing worktree),
`git remote get-url origin`, default-branch detection, derived name/slug, and warnings
(UNC path, empty folder, dirty repo). Emit `project.created`.

**Acceptance**
- Inspecting a git repo returns name, slug, `repoUrl`, `defaultBranch`, `vcs: 'git'`.
- Inspecting a plain folder returns `vcs: 'none'` and no repo fields; creation succeeds.
- Nested registration (parent or child of an existing project) is refused with a message
  naming the conflicting project.
- A path that does not exist, is a file, or is not writable each returns a distinct typed
  error, not a stack trace.
- Inspect completes in well under a second on a large repo (no full tree walk).

## M3 — Clone from a repo URL

Implement `POST /api/projects/clone`: URL parsing (https + ssh), name/slug/target derivation
under `projectsRoot`, immediate row creation with `status: 'provisioning'`, background
`git clone --progress` job, progress/completed/failed events, flip to `active` with
`defaultBranch` filled, and failure rollback (delete the row; delete the target directory
only if the clone created it).

**Acceptance**
- Cloning a small public repo produces an `active` project whose `localPath` contains a
  working checkout, with at least one intermediate `project.clone.progress` event observed.
- A bad URL and an auth failure both end as `project.clone.failed` carrying git's stderr; no
  project row and no directory remain.
- A `provisioning` project is rejected by the launch-context call.
- Target path already exists and is non-empty → refused before any clone starts.

## M4 — Defaults, permissions, environment, and launch context

Default-agent list management (ordered, with lazy drop of ids missing from the roster),
permission override storage in roster's shape, env entries with `secretRef` resolution, and
`getEffectiveLaunchContext(projectId, assignmentId)` returning `{ cwd, env, permissions,
instructions, workspace }`. Implement the composition rule: union allows, union denies, deny
wins, most restrictive mode; env merge core → project → assignment.

**Acceptance**
- A rule denied at the global level stays denied when a project allows it.
- A project allow that the agent lacks appears in the effective set; a project deny removes
  an agent allow.
- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` as a project env name is rejected at write
  time with a message citing D2.
- A `secretRef` resolves from foundation's store; an unresolvable ref fails the launch call
  with a named error rather than yielding an empty value.
- Deleting a roster agent leaves the project readable, with the dangling id absent from
  defaults and reported in health.

## M5 — Project activity timeline and retention

Implement `GET /api/projects/:id/activity` over runner/orchestrator rows, grouped by
assignment and paged, plus session pinning and the daily retention job (age then size cap,
pinned exempt, `transcriptAvailable` flipped to false). Per-project retention overrides in
`PATCH`.

**Acceptance**
- A finished assignment with two agents renders as one entry listing both agents, its
  workspace, token totals, outcome, and per-session summaries.
- The prune job removes transcripts older than the configured days and, separately, trims
  oldest-first once a project exceeds its MB cap — in both cases leaving every timeline entry
  present with `transcriptAvailable: false`.
- A pinned session survives both prune paths.
- `lastActivityAt` updates when a session starts on the project.

## M6 — Workspace leases: primary tree and git worktrees

Implement `acquireWorkspace` / `releaseWorkspace` / `listWorkspaces` with the §4.1 rule,
per-project serialization (async mutex + the partial unique index), `workspacePolicy`
handling, worktree creation under `worktreesRoot` with the `agentmanager/<id>-<slug>` branch,
optional `setupCommand`, typed refusals, auto-removal of untouched worktrees on release,
retention of worktrees with commits or dirty state, startup orphan reconciliation
(`git worktree prune`), and retry-with-backoff directory removal.

**Acceptance**
- One write assignment gets `kind: 'primary'` at `project.localPath`.
- A second concurrent write assignment gets a worktree at
  `%LOCALAPPDATA%\AgentManager\worktrees\<slug>\<id8>` on branch `agentmanager/<id8>-<slug>`,
  based on the primary tree's HEAD; the primary tree's `git status` is unaffected.
- A read/plan assignment run alongside a writer gets the primary tree and takes no hold.
- `workspacePolicy: 'shared'` refuses the second writer with a typed reason; a non-git project
  behaves as `shared` regardless of policy.
- Releasing an untouched worktree removes both directory and branch; releasing one with a
  commit or dirty file retains it and lists it as "review needed" with commit count.
- Killing the service mid-assignment and restarting marks the lease `orphaned` and surfaces it
  in health; re-acquiring for the same assignment does not double-lease.
- Total worktree path length is verified against `MAX_PATH` for a 24-char slug, and a warning
  is logged once when `LongPathsEnabled` is off.
- UNC-path projects refuse worktree creation with a specific reason.

## M7 — Scope handling and conflict warnings

Rewrite orchestrator-supplied repo-relative scope paths onto the leased workspace root when
building permission rules, and emit `project.scope.overlap` when active assignments sharing a
workspace have overlapping path prefixes.

**Acceptance**
- A scope of `src/api` in a worktree produces rules rooted at the worktree path, not
  `localPath`.
- Two shared-workspace assignments scoped to `src/api` and `src/api/routes` emit one overlap
  event naming both assignments and the overlapping prefix; disjoint scopes emit nothing.
- The overlap event never blocks acquisition or session start.

## M8 — Work items

CRUD over the thin backlog, ordering by `rank`, assignment linking, and derived status
transitions (`open` → `in_progress` when a linked assignment starts; back to `open` when all
linked assignments end without a manual `done`).

**Acceptance**
- An item created from the UI appears in `GET /work-items?status=open` in rank order;
  reordering persists.
- Linking an item to an assignment that then starts flips it to `in_progress`; the assignment
  ending without user action returns it to `open`.
- Marking `done` sets `closedAt` and is not undone by later assignment events.
- Launching with no work item works unchanged (the link is nullable end to end).

## M9 — Lifecycle, health, and the browse endpoint

Archive/restore, remove (with `pruneTranscripts` opt-in and worktree cleanup confirmation,
never touching the project folder), relocate for a missing path, the derived health payload
(`missing`, `dirty`, `stale-agents`, `orphaned-worktrees`), and `GET /api/fs/browse` limited to
configured roots.

**Acceptance**
- Archived projects are excluded from the default list and refuse new assignments; history is
  intact after restore.
- Remove deletes registry rows only; the project directory still exists afterwards, and
  transcripts survive unless `pruneTranscripts=true`.
- Renaming the folder on disk shows health `missing`; relocate to the new path preserves the
  project id, its activity timeline, and its work items.
- `browse` lists directories only, rejects `..` escapes outside every configured root, and
  returns 401/403 through the same auth as the rest of the API (D5).

## M10 — End-to-end acceptance

Wire the element into the UI's quick-add and the runner's launch path and validate the two
headline scenarios.

**Acceptance**
- Registering a project by folder, and by repo URL, each completes in under 60 seconds from
  an empty form with no file editing, in Electron *and* in a tailnet browser.
- Two concurrent assignments on one project run correctly: an architect/skeptic docs pair in
  the primary tree, and a code-editing assignment started alongside them in its own worktree
  on its own branch — with the project page showing both workspaces, one activity timeline,
  and the review-needed branch after they finish.
