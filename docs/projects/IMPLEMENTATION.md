# Projects — Implementation

Ordered v1 milestones for the project registry, implementing [DESIGN.md](DESIGN.md).
Each milestone is independently verifiable and leaves the system working.

**Prerequisites from foundation** (blocking M1): SQLite connection + migration runner, config
loader (`projectsRoot`, `worktreesRoot`, `browseRoots`, retention defaults), data-root path
resolution, logger, core event bus, module registration, secret-store read API. If foundation
is not yet landed, M1 may proceed against a thin local adapter, but must not define its own
DB file or config format.

**Already pinned by wave 1, not open coordination points**: roster's permission rule shape and
the fact that roster alone composes it (M4); foundation's `sessions` / `assignments` columns,
session status vocabulary, and `session_usage` token split (M5); the transcript layout and
`sessions.transcript_path` / `transcript_bytes` (M5); runner's launch-context call and lease usage
(M6, runner §3.1); and orchestrator's scope-rule shape (M7, orchestrator §2.5 / §2.7). Nothing in
this list is an open coordination point.

---

## M1 — Schema, storage, and the project repository module

Create the element migration (`migrations/projects/0001_*.sql`, per foundation DESIGN §1.3)
adding `project_default_agents`, `work_items`, `work_item_assignments`, `workspace_leases`.
`projects` itself is **not** here — foundation ships it in `0001_init.sql` with the column set
DESIGN §1.1 specifies, so this element codes against foundation's `projects` repository rather
than creating the table. Implement path canonicalization
(realpath → drive-letter upcase → strip trailing separators → lowercased key), slug
generation with dedup, and a `ProjectRepository` with typed CRUD. Register the module with
the core.

**Acceptance**
- The element migration applies after foundation's core set, is idempotent on re-run, and
  registers in `schema_migrations` under module `projects`.
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
`PermissionOverride` storage in roster's shape (`allow` / `deny` / `ask` / `mode`),
`permissionElevation` storage with its mandatory reason, env entries carried as an ordered
list, and `getEffectiveLaunchContext(projectId, assignmentId)` returning
`{ cwd, env, permissionOverride, elevation, instructions, workspace }`. **No composition and
no merging is implemented here** — roster's `compilePermissions` composes and roster's
`compileSession` performs the single env merge and secret resolution; this milestone produces
their inputs.

**Acceptance**
- The launch context is raw input: it carries no `permissions` key, resolves no `secretRef`,
  and merges no environment — asserted by a test that plants a ref and finds it still a ref.
- A project `allow` rule not present in the agent's baseline is dropped, unless it is declared
  under `permissionElevation` (verified end-to-end against roster's compiler, not restated
  locally).
- `permissionElevation` with an empty or missing `reason` is rejected at write time with a 400
  naming the field; elevation is refused with a diagnostic when
  `policy.allowPermissionElevation` is false.
- `defaults.permissionElevation` is present in the `GET /api/projects/:id` payload and on the
  launch-context result.
- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` as a project env name is rejected at write
  time with a message citing D2.
- Env entries come back in projects' declared order, positioned after foundation's `agentEnv`
  and before the assignment's in roster's merge; an unresolvable `secretRef` fails the launch
  in roster's compiler with a named error rather than yielding an empty value.
- Deleting a roster agent leaves the project readable, with the dangling id absent from
  defaults and reported in health.

## M5 — Project activity timeline and retention

Implement `GET /api/projects/:id/activity` over foundation's `sessions` / `assignments` /
`session_usage` repositories, grouped by assignment and paged, with the assignment `outcome`
derived from foundation's session status vocabulary per DESIGN §3.1, plus session pinning and
the daily retention job (age then size cap, pinned exempt). Per-project retention overrides in
`PATCH`.

**Acceptance**
- A finished assignment with two agents renders as one entry listing both agents, its
  workspace, token totals joined from `session_usage`, the derived outcome, and per-session
  summaries read from `sessions.summary`.
- Every value of `sessions.status` maps to exactly one assignment `outcome` per the DESIGN
  §3.1 table, including `orphaned` and `interrupted`; no status is silently unhandled.
- The prune job removes transcripts older than the configured days and, separately, trims
  oldest-first once `SUM(sessions.transcript_bytes)` for the project exceeds its MB cap — in
  both cases NULLing `transcript_path` so the timeline entry stays present with
  `transcriptAvailable: false`, and never walking the transcript directory tree.
- A session with `pinned` set survives both prune paths.
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

Rewrite orchestrator-supplied repo-relative scope paths onto the leased workspace root,
producing **input rules** for roster's compiler (never an effective set — DESIGN §1.3), and
emit `project.scope.overlap` when active assignments sharing a workspace have overlapping path
prefixes.

**Acceptance**
- A scope of `src/api` in a worktree produces rules rooted at the worktree path, not
  `localPath`, and those rules reach roster's `compilePermissions` as assignment-scope input.
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
- `browse` resolves the requested path **and every listed entry** to its real path before the
  browse-root containment check: a directory junction or symlink created inside a browse root
  and pointing outside it (e.g. `mklink /J %USERPROFILE%\escape C:\`) is not listed and is
  refused with 403 when requested directly, even though its literal path is root-prefixed.
  UNC and network paths are rejected. Test on NTFS with a real junction, not a mock — a
  lexical prefix check passes this case and is exactly the bug (DESIGN §2.1).

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
