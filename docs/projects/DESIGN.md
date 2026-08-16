# Projects — Design

The project registry: the things agents get pointed at. Owns project identity, local
location, per-project defaults, the backlog of work items, per-project history, and
**workspace allocation** — deciding which directory a given assignment actually runs in
when several agents are on one project at once.

Scope boundaries: this element does not run agents (runner), does not decide who works on
what (orchestrator), and does not invent storage or secret handling (foundation).

## Conformance to architecture.md

- **D1** — everything here is Node/TypeScript in the core service. Git operations shell out
  to the `git` CLI via `child_process`; no PowerShell at runtime.
- **D2** — project defaults may carry environment variables, but a project may never set
  `ANTHROPIC_API_KEY` (rejected at validation, since it would silently override subscription
  auth). Workspace leases are a cheap local resource and are unrelated to the runner's
  rate-limit queue; acquiring a workspace never implies a session may start.
- **D3** — every flow below is a core API consumed by the one web frontend. Nothing depends
  on Electron: the folder picker degrades to a server-side directory-browse endpoint so
  quick-add works identically from the tailnet browser.
- **D4** — the registry is assignment-aware. Workspaces, work items, and history are keyed
  by `assignment_id`, including the trivial one-agent assignment.
- **D5** — the directory-browse endpoint is a filesystem-exposure surface. It is served by
  the same authenticated API as everything else and is restricted to configured browse roots
  (default: the user profile and the projects root). It never returns file contents.
- **D6** — no edition-specific code paths. Browse roots and the projects root are config.

## 1. Data model

Structured state lives in foundation's SQLite database (foundation owns the connection,
migration runner, and file layout). `projects` itself is shipped by foundation in
`0001_init.sql` — more than one element joins on it — with the column set specified below;
the remaining tables are this element's migration contribution, shipped as
`migrations/projects/NNNN_*.sql` under foundation §1.3's element-migration mechanism. Free
text that benefits from being diffable — project notes — is stored as a column but is plain
Markdown, so an export writes it straight to a file.

### 1.1 Project

```ts
type ProjectId = string;            // ULID
type ProjectStatus = 'provisioning' | 'active' | 'archived';

interface Project {
  id: ProjectId;
  slug: string;                     // lowercase, [a-z0-9-], <= 24 chars, unique.
                                    // Used in worktree paths — kept short deliberately.
  name: string;                     // display name, defaults to folder basename
  localPath: string;                // canonical absolute Windows path, no trailing slash
  repoUrl: string | null;           // origin remote, or the URL it was cloned from
  defaultBranch: string | null;     // detected at registration, refreshed on demand
  vcs: 'git' | 'none';
  notes: string;                    // Markdown, free-form
  status: ProjectStatus;
  workspacePolicy: WorkspacePolicy; // see §4
  defaults: ProjectDefaults;        // see §1.2
  retention: RetentionSettings | null;  // null = inherit global (see §5.3)
  createdAt: string;                // ISO-8601 UTC
  updatedAt: string;
  lastActivityAt: string | null;    // last session start on this project
}
```

Table (**shipped by foundation**, columns specified here — foundation §1.4):

```sql
CREATE TABLE projects (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  local_path       TEXT NOT NULL,          -- display form, original casing
  local_path_key   TEXT NOT NULL UNIQUE,   -- lowercased canonical form, the identity key
  repo_url         TEXT,
  default_branch   TEXT,
  vcs              TEXT NOT NULL DEFAULT 'none',
  notes            TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'active',
  workspace_policy TEXT NOT NULL DEFAULT 'auto',
  defaults_json    TEXT NOT NULL DEFAULT '{}',
  retention_json   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_activity_at TEXT,
  archived_at      TEXT                    -- set on archive; foundation's FK/archival story uses it
);
```

**Path identity (Windows).** `local_path_key` is the identity of a project, not the name.
Canonicalization: `path.resolve` → resolve any junction/symlink via `fs.realpath` →
uppercase the drive letter → strip trailing separators → lowercase the whole string for the
key. NTFS is case-insensitive, so `C:\Code\App` and `c:\code\app` must collide. UNC paths
(`\\server\share\...`) are accepted and stored, but flagged: worktrees on a network share
are refused (§4.4). Registration is rejected if the path is inside, or contains, an existing
project's path (nested registries make workspace leasing and scope overlap meaningless), or
if it is inside AgentManager's own data root.

### 1.2 Per-project defaults

```ts
interface ProjectDefaults {
  agentIds: string[];               // roster agents suggested for this project, ordered;
                                    // the UI pre-selects agentIds[0] on drag-and-drop launch
  overseerAgentId?: string;         // preferred overseer for orchestrated assignments
  permissions?: PermissionOverride; // roster's permission vocabulary, see §1.3
  permissionElevation?: {           // the only widening path (roster §6.2); see below
    allow: string[];
    reason: string;                 // required, non-empty
  };
  env?: EnvEntry[];                 // see §1.4
  setupCommand?: string;            // optional, run once in a freshly created worktree (§4.4)
  instructionsPath?: string;        // relative path to a project brief; its resolved text fills
                                    // roster's fourth system-prompt slot (roster §4)
}
```

**`permissionElevation`.** Projects is the storage and the API surface for the escape hatch
roster defines; it does not decide whether it applies. Three rules hold here:

- `reason` is enforced non-empty at write time — a `PATCH` carrying an `allow` list with a
  blank or absent reason is a 400 naming the field. An elevation nobody had to justify is the
  failure mode the reason string exists to prevent.
- The field is returned by `GET /api/projects/:id` and carried on the launch-context call
  (§5), so the UI can show it before launch and the session header can show it during.
- Whether it is honoured is roster's and foundation's: roster's compiler applies it only when
  `policy.allowPermissionElevation` is true (foundation §2.3), and drops it with a diagnostic
  when the work edition sets that key false.

**`instructionsPath`** is for briefs the repository does not itself carry. An agent with
`settingSources: ["project"]` — roster's default — already loads the repo's `CLAUDE.md` and
`.claude/` rules through the SDK, so pointing `instructionsPath` at `CLAUDE.md` would load it
twice. Leave it unset unless there is a separate brief to append.

Default agents are stored relationally rather than in `defaults_json`, so that roster
deletions can be resolved without scanning JSON:

```sql
CREATE TABLE project_default_agents (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL,
  rank       INTEGER NOT NULL,
  PRIMARY KEY (project_id, agent_id)
);
```

A dangling `agent_id` (agent deleted from the roster) is dropped lazily on read and reported
once in the project's health payload — projects does not subscribe to roster lifecycle
events in v1.

### 1.3 Permission override (storage only)

Projects does **not** define a permission vocabulary and **does not compose one**. It stores a
`PermissionOverride` in roster's shape and hands it over as raw input:

```ts
interface PermissionOverride {
  allow?: string[];                 // rule patterns, roster's vocabulary
  deny?:  string[];
  ask?:   string[];                 // roster unions `ask` from every layer, so projects carries it
  mode?:  PermissionMode;
}
```

Composition happens in exactly one place: roster's `compilePermissions` (roster §6.2), which
is **monotonically narrowing** — `deny` and `ask` union, `allow` *intersects*, `mode` takes
the ladder minimum. See roster §6.2's table for the authoritative rule; it is not restated
here, because a second copy is a second thing to get wrong.

The consequence worth stating plainly: **a project cannot widen an agent's permissions by
listing a rule in `allow`.** A project `allow` entry that is not in the agent's baseline is
dropped. This is not a policy preference but the SDK's semantics — `allowedTools` is an
auto-approve list, not a restriction list, so "widening" an allow set would not restrict
anything it omitted, and the narrowing model is the only one that means what it says. The one
widening path is `defaults.permissionElevation` (§1.2), which requires a reason, is visible in
the launch flow and the session header, and is gated by `policy.allowPermissionElevation`.
Rules in foundation's `policy.globalDeny` (foundation §2.3) are unioned into every deny set
and no layer — project, elevation, or assignment — can remove them.

What projects *does* contribute is **scope-path rewriting**. If an assignment carries path
scopes, the orchestrator states them relative to the repo root, and a worktree has a different
absolute prefix; projects rewrites them onto the leased workspace's actual root and returns
them as rule strings. Those are input rules for roster to compose, not an effective set.
Whether scopes are advisory or enforced is the orchestrator's decision; projects supplies the
rewriting either way.

### 1.4 Environment

```ts
type EnvEntry =
  | { name: string; value: string }              // plain value, stored in the DB
  | { name: string; secretRef: string };         // resolved from foundation's secret store
```

Secrets are never stored in a project row. `secretRef` names an entry in foundation's secret
store (`project.<projectId>.<name>`, foundation §3.3) and is resolved by roster's option
compiler at session start — the authorized reveal site; an unresolvable ref is a
launch-blocking error with a clear message, not a silent empty string. `ANTHROPIC_API_KEY` and
`CLAUDE_CODE_OAUTH_TOKEN` are rejected as project env names (D2).

Projects performs **no merge of its own**. It hands roster an ordered `EnvEntry[]` — its
contribution to the single merge roster §13 performs, whose order is: core process env →
foundation's `agentEnv` → **project env** → assignment env, later winning. Projects' place in
that order is what "core → project → assignment" meant; the merge itself happens once, in the
option compiler, alongside secret resolution.

### 1.5 Work items (the backlog)

See the decision in §7.2 — v1 carries a deliberately thin per-project list.

```ts
interface WorkItem {
  id: string;
  projectId: ProjectId;
  kind: 'bug' | 'feature' | 'chore' | 'question';
  title: string;                    // required, one line
  body: string;                     // Markdown, may be empty
  status: 'open' | 'in_progress' | 'done' | 'dropped';
  rank: number;                     // manual ordering only; no priority field
  scopePaths: string[];             // optional hint, repo-relative
  source: 'user' | 'overseer';
  createdAt: string; updatedAt: string; closedAt: string | null;
}
```

```sql
CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', rank REAL NOT NULL,
  scope_paths_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, closed_at TEXT
);
CREATE INDEX work_items_board ON work_items (project_id, status, rank);

CREATE TABLE work_item_assignments (
  work_item_id  TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL,
  PRIMARY KEY (work_item_id, assignment_id)
);
```

Status transitions are mostly derived, not managed: an item flips to `in_progress` when an
assignment linking to it starts and back to `open` if every linked assignment ends without a
human marking it `done`. There is no workflow engine, no assignee (the assignment carries
the agents), no dependencies, no labels.

**Who writes `work_item_assignments`.** Projects owns the table and derives status from it,
but it never populates it on its own: the writer is **orchestrator's assignment-creation
path** — both the pattern engine and the solo-launch endpoint — whenever work items are
attached to the assignment being created (orchestrator §17, R4). Projects exposes the two
calls it uses, on the internal service surface of §5:

```ts
linkWorkItems(assignmentId: string, workItemIds: string[]): Promise<void>;   // at assignment create
unlinkWorkItems(assignmentId: string): Promise<void>;                        // at assignment close
```

Both are idempotent, validate that every item belongs to the assignment's project, and are
the only sanctioned writers — nothing else composes SQL against the table (foundation §1.3).
Linking is optional end to end: an assignment created with no work items writes no rows, and
a work item never linked to anything simply stays `open`.

### 1.6 Workspace lease

```ts
interface WorkspaceLease {
  id: string;
  projectId: ProjectId;
  assignmentId: string;
  kind: 'primary' | 'worktree';
  path: string;                     // absolute; equals project.localPath when kind=primary
  branch: string | null;            // worktree only
  baseCommit: string | null;        // worktree only
  write: boolean;                   // false = read/plan assignment, does not hold the tree
  state: 'active' | 'released' | 'orphaned';
  acquiredAt: string; releasedAt: string | null;
}
```

```sql
CREATE TABLE workspace_leases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL,
  kind TEXT NOT NULL, path TEXT NOT NULL, branch TEXT, base_commit TEXT,
  write INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active',
  acquired_at TEXT NOT NULL, released_at TEXT
);
CREATE UNIQUE INDEX workspace_leases_active_assignment
  ON workspace_leases (project_id, assignment_id) WHERE state = 'active';
```

## 2. Registration and discovery

Both flows are two steps: **inspect** (cheap, read-only, returns everything the form needs
pre-filled plus warnings) then **create**. The split is what makes the UI's one-minute
quick-add possible — the user types or picks one thing and confirms a filled form.

### 2.1 Register an existing folder

1. `POST /api/projects/inspect { localPath }`.
2. Server canonicalizes the path and checks: exists, is a directory, readable *and*
   writable, not already registered, not nested with an existing project, not inside the
   AgentManager data root, not a system directory.
3. Detects `.git` (including a `.git` file for an existing worktree — refused, register the
   main repo instead), then reads `git remote get-url origin` and the default branch.
   Non-git folders are fully supported; they simply get `vcs: 'none'` and no worktrees.
4. Derives `name` from the folder basename and `slug` from the name (deduplicated with a
   numeric suffix); returns warnings (path on a network share, repo has uncommitted changes,
   folder is empty).
5. `POST /api/projects` with the reviewed values creates the row, `status: 'active'`, and
   emits `project.created`.

**Folder picking.** Electron uses the native dialog and posts the resulting path. The
browser (and remote) path uses `GET /api/fs/browse?path=` — a directory-only listing rooted
in the configured browse roots, with `..` traversal outside a root rejected. Typing a full
path is always accepted.

**Containment is checked against the *real* path, not the requested one.** Before the
`browseRoots` prefix check runs, the requested path — and every entry about to be listed —
is resolved to its real path on disk (`fs.realpath`, which on Windows follows directory
junctions, symlinks, and mount points alike). The prefix check then runs on the resolved
result, and the response reports the resolved path. A lexical check on the requested string
is not a control on Windows: a junction anywhere under `%USERPROFILE%` (a default browse
root) points wherever it likes while its path still starts with the root, so `C:\Users\me\x`
can be `C:\` and the check passes. Resolve first, compare second. Also rejected outright:
UNC and network paths (`\\server\share`, mapped drives that resolve to one) — a browse root
is a local tree, and reaching a file server through this endpoint is not something the
feature is for. A path that resolves outside every root returns 403 and lists nothing, and
an entry whose resolved target escapes is omitted from the listing rather than shown and
refused on click. Remote raised this (remote §13, R7): the route is deliberately allowed
over the tailnet (remote §3.3), and containment is the whole of its access control.

No filesystem-wide auto-scan for repos in v1: it is slow on Windows, noisy, and the manual
path takes seconds. Deferred as a possible "scan a folder for repos" bulk import.

### 2.2 Clone from a repo URL

1. `POST /api/projects/inspect { repoUrl }` — parses the URL (https or ssh), derives the
   name and slug, proposes `targetPath = <projectsRoot>/<name>` (projects root is foundation
   config, default `%USERPROFILE%\Documents\AgentManager\projects`), and reports whether the
   target already exists.
2. `POST /api/projects/clone { repoUrl, targetPath, name }` creates the project row
   immediately with `status: 'provisioning'` and returns its id, then runs
   `git clone --progress` as a tracked background job.
3. Progress and failures stream on the core event bus (`project.clone.progress`,
   `project.clone.failed`, `project.clone.completed`) so the UI can show a bar and the user
   can leave the dialog. On success the row flips to `active` and `defaultBranch` is filled.
4. On failure the target directory is removed **only if the clone created it**, and the row
   is deleted. Auth failures surface the git stderr verbatim — credentials are the user's
   existing git credential helper; AgentManager stores no git credentials in v1
   (deferred: per-project deploy keys / PAT via foundation's secret store).
5. A `provisioning` project cannot be launched against; the runner rejects it.

Clone runs as a core-service job, never as an agent action.

### 2.3 Lifecycle

- **Archive** hides the project from the board and blocks new assignments; nothing on disk
  changes and history is retained.
- **Remove** deletes the registry row, work items, leases and history index after confirming
  outstanding worktrees are cleaned up. **Never deletes the project folder.** Transcript
  files are deleted only if the user ticks the explicit option.
- **Health** is derived on read, never stored: `missing` (path gone — external drive, moved
  folder), `dirty` (uncommitted changes in the primary tree), `stale-agents` (default agent
  ids no longer in the roster), `orphaned-worktrees`. A missing path offers "relocate",
  which re-canonicalizes a new path onto the same project id, preserving history.

## 3. History per project

### 3.1 What is retained

Projects owns the *question* "what has happened on this project", not the storage of session
records. Runner owns `sessions`, orchestrator owns `assignments`, and both tables are
foundation's (foundation §1.4); projects reads them through foundation's repositories, which
are the sanctioned cross-element read path. The columns this element consumes are already
pinned there: `sessions.project_id`, `assignment_id`, `status`, `summary`, `pinned`,
`transcript_path`, `transcript_bytes`, and the per-session token split in `session_usage`,
which the read model joins.

`sessions.status` is foundation's vocabulary —
`queued | running | paused | done | failed | interrupted | orphaned` — and projects consumes it
rather than defining its own. The timeline's assignment-level `outcome` is a **derived
projection** of the statuses of an assignment's sessions, defined here:

| Assignment outcome | When |
|---|---|
| `running` | any session is `queued`, `running`, or `paused` |
| `completed` | every session is `done` |
| `stopped` | no session `running`, at least one `interrupted`, none `failed` |
| `failed` | any session is `failed` or `orphaned` |

```ts
interface ProjectActivityEntry {
  assignmentId: string;
  workItemIds: string[];
  agentIds: string[];
  pattern: string | null;            // orchestrator pattern, null for a solo assignment
  scopeSummary: string | null;
  workspace: { kind: 'primary' | 'worktree'; path: string; branch: string | null };
  startedAt: string; endedAt: string | null;
  outcome: 'running' | 'completed' | 'stopped' | 'failed';   // derived, per the table above
  tokens: { input: number; output: number };                 // joined from session_usage
  sessions: { id: string; agentId: string;
              status: SessionStatus;                         // foundation's vocabulary, verbatim
              transcriptAvailable: boolean;                  // = transcript_path IS NOT NULL
              summary: string | null;                        // sessions.summary
              pinned: boolean }[];
}
```

`GET /api/projects/:id/activity` returns this grouped by assignment, newest first — it is the
project page's timeline and the source of "which agents are/have been active here".

### 3.2 Where transcripts live

Full transcripts are plain files, not database rows: they are large, append-only, and never
queried relationally. **The layout is foundation's and is settled** (foundation §1.5):

```
<dataRoot>\state\transcripts\<YYYY>\<MM>\<session-id>.jsonl
```

Projects does not address transcripts by path at all. `sessions.transcript_path` is
authoritative, and every read, prune, and availability check goes through it — which is what
makes a project rename free, since no path encodes a slug. A short **summary** (first user
prompt, last assistant message, outcome) is written to `sessions.summary` by the runner so the
timeline renders without opening any transcript, and `sessions.transcript_bytes` carries the
file's size so size accounting never walks the tree.

### 3.3 Retention

```ts
interface RetentionSettings {
  transcriptDays: number;    // default 90
  transcriptCapMb: number;   // default 500, per project
  keepPinned: boolean;       // default true
}
```

- **Metadata (assignments, sessions, tokens, summaries) is kept indefinitely.** It is tiny
  and it is what the timeline and the "who worked here" view read.
- **Transcript files** are pruned by a daily job: older than `transcriptDays`, or oldest-first
  once the project exceeds `transcriptCapMb`. The size measure is
  `SUM(sessions.transcript_bytes)` over the project's sessions — a single indexed query, not a
  directory walk, because foundation's transcript tree is grouped by month rather than by
  project and has no per-project directory to measure.
- Pruning deletes the file, NULLs `sessions.transcript_path` in the same transaction (so
  `transcriptAvailable` becomes false by derivation), and zeroes `transcript_bytes`. The entry
  stays in the timeline. Sessions with `pinned` set are exempt from both paths.
- Defaults are global (`retention.transcriptDays` / `retention.transcriptCapMb` in foundation
  config); a project may override either number.
- Archiving does not prune. Removing a project prunes only if the user opts in.

## 4. Concurrency: multiple agents on one project

### 4.1 The decision

**Hybrid, defaulting to the shared primary tree.** An assignment gets its own git worktree
if and only if all three hold:

1. the project is a git repo, and
2. the assignment is **write-capable**, and
3. another write-capable assignment already holds the primary tree.

Read-only and planning/docs assignments always run in the primary tree and never take the
write hold. So the common cases stay boring: one agent working alone, or an architect/skeptic
pair writing a design doc, all share `localPath` and see each other's files. Only the second
concurrent *code-editing* assignment pays the worktree cost.

Rationale. Always-shared corrupts concurrent code edits and produces incoherent diffs.
Always-worktree is worse in practice on Windows: `git worktree add` does not bring untracked
or ignored files, so every worktree starts without `node_modules`, `.env`, or build output —
a planning agent that just needs to read the repo would get a subtly broken copy, and the
adversarial-pair pattern (the orchestrator's v1 slice) would be split across two directories
for no benefit. Isolation is only worth its cost where writes actually collide.

Scope paths do not replace this rule. Two disjoint path scopes still share an index, a
`node_modules`, and a build output directory, and scope enforcement is the orchestrator's
option rather than a guarantee — so scopes are used to *warn*, not to grant shared write
access.

### 4.2 Policy override

`Project.workspacePolicy`:

- `auto` (default) — the rule above.
- `shared` — never create worktrees. A second write-capable assignment is refused with a
  clear reason, and the orchestrator can queue it. Correct for projects with a heavy or
  non-relocatable setup (native builds, absolute paths in config, huge `node_modules`).
- `worktree` — every write-capable assignment gets its own worktree, including the first.
  Keeps the user's checkout pristine at the cost of setup per assignment.

Non-git projects are forced to `shared` regardless of the setting.

### 4.3 The lease API

```ts
acquireWorkspace(projectId, assignmentId, {
  write: boolean, scopePaths?: string[]
}): Promise<WorkspaceLease | WorkspaceRefusal>

releaseWorkspace(leaseId, { cleanup?: 'keep' | 'remove' }): Promise<void>
listWorkspaces(projectId): Promise<WorkspaceLease[]>
```

Acquisition is serialized per project (an in-process async mutex plus the partial unique
index, so a crash-restart cannot double-lease). The runner calls `acquireWorkspace` before
starting the first session of an assignment and uses the returned `path` as `cwd`; it
releases when the assignment ends. Solo drag-and-drop launches go through the same call with
the trivial assignment.

**Conflict awareness.** When a second write-capable assignment lands in the *same* workspace
(policy `shared`, or a read/plan assignment alongside a writer), projects computes prefix
overlap between the active scope path sets and emits `project.scope.overlap` with the
offending paths. It is a warning, surfaced by the UI and available to the orchestrator; it
does not block. Blocking on overlap is deferred until real usage shows it is needed.

### 4.4 Worktree mechanics (Windows/NTFS)

- **Location**: `%LOCALAPPDATA%\AgentManager\worktrees\<project-slug>\<assignment-id-8>`
  (root configurable). Outside the user's repo folder, so file watchers, IDE indexers, and
  `git status` in the main checkout never see them. Slugs are capped at 24 chars and the
  assignment id is truncated to 8 to stay well clear of `MAX_PATH`; setup checks
  `LongPathsEnabled` and warns once if it is off.
- **Branch**: `agentmanager/<assignment-id-8>-<slug>`, created from the primary tree's
  current HEAD, recorded as `baseCommit`. Detached-HEAD worktrees are not used — a named
  branch is what makes the work reviewable.
- **Creation**: `git worktree add -b <branch> <path> <baseCommit>`, then optional
  `defaults.setupCommand` (empty by default) run in the new directory with the project's
  env, with output captured to the activity timeline. If setup fails the lease is refused and
  the worktree is removed.
- **Refusals**: network/UNC path, repo mid-rebase/merge, or a dirty primary tree when the
  assignment requires a clean base — each returns a typed refusal with a reason string, not
  a generic error. `WorkspaceRefusal` carries `retryable: boolean` (requested by runner
  §15.4): `true` means the condition will clear on its own — e.g. another write-capable
  assignment currently holds the primary tree — so the runner may queue and retry; `false`
  means the configuration can never work as-is and the assignment fails immediately.
- **Merge-back is manual in v1.** AgentManager never merges, pushes, or deletes a branch with
  unmerged commits. On release, a worktree with no commits beyond `baseCommit` and no
  uncommitted changes is removed automatically (`git worktree remove`, then
  `git branch -d`); anything else is kept and listed on the project page as "review needed"
  with commit count, dirty flag, and a "clean up" action that removes it after confirmation.
- **Orphan recovery**: at startup, leases marked `active` with no live assignment are set to
  `orphaned`, `git worktree prune` runs, and orphans appear in the project's health payload.
- **Windows removal**: directory deletion retries a few times with backoff — antivirus and
  editor handles routinely hold files briefly. Persistent failure marks the lease `orphaned`
  rather than throwing.

## 5. API surface (core → UI, one element's slice)

```
GET    /api/projects                       list (+ health, active assignment count)
POST   /api/projects/inspect               { localPath } | { repoUrl } → prefilled form
POST   /api/projects                       register an existing folder
POST   /api/projects/clone                 clone + register (returns id immediately)
GET    /api/projects/:id                   full record + defaults + workspaces
PATCH  /api/projects/:id                   name, notes, defaults, policy, retention
POST   /api/projects/:id/archive|restore
DELETE /api/projects/:id                   ?pruneTranscripts=true|false
GET    /api/projects/:id/activity          §3.1 timeline, paged
GET    /api/projects/:id/health
GET    /api/projects/:id/workspaces
POST   /api/projects/:id/workspaces/:lid/cleanup
GET    /api/projects/:id/work-items        ?status=
POST   /api/projects/:id/work-items
PATCH  /api/work-items/:id                 title, body, kind, status, rank, scopePaths
GET    /api/fs/browse?path=                directory listing within configured roots
                                           (containment checked on the realpath-resolved
                                           path, §2.1; UNC/network paths rejected)
```

`GET /api/projects/:id` returns the full record including `defaults.permissionElevation` (its
`allow` list and `reason`), so the UI can warn before a launch rather than after.

Internal (in-process, for runner/orchestrator):

```ts
getEffectiveLaunchContext(projectId, assignmentId): Promise<{
  cwd: string;                        // the leased workspace root
  env: EnvEntry[];                    // ordered, unresolved — refs stay refs
  permissionOverride?: PermissionOverride;   // stored, uncomposed (§1.3)
  elevation?: { allow: string[]; reason: string };
  instructions?: string;              // resolved instructionsPath text (roster §4's fourth slot)
  workspace: WorkspaceLease;
}>
```

The name is now the only misleading thing about it, and it is kept for continuity: this call
returns **raw inputs, not an effective anything**. There is no `permissions` key, because
projects does not compute one — roster's `compilePermissions` is the sole composer (roster
§6.2), and roster's `compileSession` performs the single env merge and the single secret
resolution. Everything here is material handed to that function. The lease API of §4.3 and
`linkWorkItems` / `unlinkWorkItems` (§1.5, called by orchestrator's assignment-creation and
close paths) complete the internal surface.

Events on the core bus: `project.created|updated|archived|removed`,
`project.clone.progress|completed|failed`, `workspace.acquired|released|orphaned`,
`project.scope.overlap`, `workitem.created|updated`.

## 6. Deliberately deferred past v1

Auto-scan of the filesystem for repos; GitHub/Jira issue sync and import; per-project git
credentials/deploy keys; automated merge-back or PR creation from worktrees; blocking (rather
than warning) on scope overlap; work-item priorities, labels, dependencies, or agent-created
items; project templates and grouping/tags; per-worktree dependency caching (hardlinked
`node_modules`); non-git VCS support; multi-machine project registries.

## 7. Decisions

**7.1 Session history: how much is retained per project, and where?**
Metadata forever in SQLite (assignments, sessions, agents, tokens, outcome, one-line
summaries); full transcripts as plain `.jsonl` files in **foundation's layout**, addressed
solely through `sessions.transcript_path` (§3.2), pruned after 90 days or 500 MB per project
— the latter measured as `SUM(sessions.transcript_bytes)` — whichever comes first, with
pinning as the escape hatch. *Rationale*: the timeline the UI actually reads is tiny and worth
keeping permanently; transcripts are large, rarely reread, and are the only thing that grows
without bound — separating them lets history stay complete while disk stays bounded. Projects
sets the *policy* and owns none of the *layout*: one owner of the path scheme is what keeps a
pruner and a writer from disagreeing about where a file is.

**7.2 Do projects carry work-item lists, or is assignment purely prompt-driven?**
Yes, a deliberately thin list — title, body, kind, status, manual rank, optional scope paths
— and assignments link to zero or more items. Prompt-driven launch remains fully supported
and is the default path; the link is nullable everywhere. *Rationale*: one table and CRUD buys
a durable place for "found a bug, no time now", makes one-tap relaunch from the phone
possible, and gives the overseer somewhere to put a decomposed goal that survives a restart.
Anything richer (priorities, labels, dependencies, issue-tracker sync) is a tracker, which
this is not trying to be.

**7.3 Shared working tree vs per-agent worktrees?**
Hybrid, defaulting to shared: a worktree is created only for a write-capable assignment when
another write-capable assignment already holds the primary tree; read/plan/docs assignments
always share. Per-project `workspacePolicy` can force `shared` or `worktree`. *Rationale*:
worktrees solve concurrent-write corruption but lose untracked and ignored files (no
`node_modules`, no `.env`) and split collaborating agents across directories — pay that cost
only where writes actually collide, which is exactly the case the orchestrator's docs/planning
v1 slice avoids.

**7.4 Project identity — path or name?**
The canonicalized, lowercased path. *Rationale*: NTFS is case-insensitive and users rename
things; the path is what actually collides, and unique-path prevents the same repo being
registered twice under two names with divergent defaults.

**7.5 Are nested projects allowed?**
No — registration is refused if the path contains or is inside another project. *Rationale*:
nesting makes workspace leasing, scope overlap detection, and transcript attribution
ambiguous for no real gain; a monorepo is one project with path-scoped assignments.

**7.6 How do project permissions compose with roster permissions?**
They don't — not here. Projects stores a `PermissionOverride` (`allow` / `deny` / `ask` /
`mode`) and hands it over uncomposed; roster's `compilePermissions` is the sole composer, and
its rule is monotonic narrowing: `deny` and `ask` union, `allow` **intersects**, `mode` takes
the ladder minimum (roster §6.2). A project therefore narrows — never `git push` here — and
cannot widen; a project `allow` absent from the agent's baseline is dropped. The single
widening path is `defaults.permissionElevation`, which carries a mandatory reason, is visible
in the launch flow and the session header, and is gated by `policy.allowPermissionElevation`.
Foundation's `policy.globalDeny` stays absolute above all of it. *Rationale*: the union model
this document previously specified reads well but does not survive the SDK's semantics —
`allowedTools` is an auto-approve list, not a restriction list, so a set built by union
restricts nothing it omits. Narrowing plus one loud, justified escape hatch is the only shape
where "the agent's permissions are its ceiling" is a statement that holds. And a composer
implemented in two elements is two answers to one question, so there is one.

**7.7 Where do per-project secrets live?**
Not in the project row — env entries hold either a literal value or a `secretRef` into
foundation's secret store, resolved at session start. `ANTHROPIC_API_KEY` is rejected outright.
*Rationale*: foundation owns secrets (CLAUDE.md ground rule), and D2 says a stray API key
silently defeats subscription auth.

**7.8 Registration UX — how is the one-minute quick-add met?**
Two-call inspect-then-create for both routes, with the server deriving name, slug, git remote,
and default branch so the user confirms rather than types. *Rationale*: the only genuinely
required input is one path or one URL; everything else is either derivable or has a default.

**7.9 Folder picking without Electron?**
A server-side directory-browse endpoint restricted to configured roots, with typed paths
always accepted. *Rationale*: D3 says one UI codebase for local and remote — a native-dialog-only
flow would strand project quick-add on the desktop, and an unrestricted browse endpoint is a
filesystem-read surface on a remote-reachable API (D5).

**7.10 Does deleting a project delete files?**
Never the project folder. Worktrees are cleaned up (with confirmation for unmerged work), and
transcripts are pruned only if explicitly requested. *Rationale*: the folder predates
AgentManager and usually outlives it; an agent manager that can eat a repo is not one anybody
leaves running unattended.

**7.11 Is a clone an agent task or a service job?**
A core-service job with streamed progress. *Rationale*: it needs no reasoning, must work
before any agent is pointed at the project, and burning rate-limited subscription tokens (D2)
on `git clone` would be absurd.

**7.12 Who cleans up worktrees, and when?**
Automatically on assignment end when the worktree has no commits and no uncommitted changes;
otherwise it is retained, surfaced as "review needed", and removed only on explicit user
action. Orphans from a crash are reconciled at startup. *Rationale*: agent output must never
be silently discarded, but the common no-op case shouldn't accumulate directories.

**7.13 Are assignment scope conflicts blocked?**
No — overlapping scopes in a shared workspace emit a warning event only. *Rationale*: scope
enforcement is the orchestrator's decision and path prefixes are a crude proxy for real
conflict; a false-positive block would stall legitimate work, while a warning costs nothing.
Revisit once concurrent code assignments are common.
