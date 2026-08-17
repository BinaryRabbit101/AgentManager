/**
 * The derived health payload (projects DESIGN §2.3; IMPLEMENTATION M4, M9).
 *
 * > "**Health** is derived on read, never stored: `missing` (path gone —
 * > external drive, moved folder), `dirty` (uncommitted changes in the primary
 * > tree), `stale-agents` (default agent ids no longer in the roster),
 * > `orphaned-worktrees`."
 *
 * "Derived on read" is the whole design and it is why this is a function rather
 * than a column. A stored `dirty` flag is wrong the moment somebody saves a file
 * in their editor, and a stored `missing` flag is wrong the moment the external
 * drive is plugged back in — so the payload is recomputed every time it is
 * asked for, and none of it survives the call.
 *
 * ## Why the function is asynchronous
 *
 * Three of the four conditions are database or `existsSync` reads and could be
 * synchronous. `dirty` is `git status`, which is a child process, and making
 * *that* synchronous would block the event loop for the duration of a status on
 * a large repository — on every project, on every health poll. So the whole
 * payload is a promise, and `ModuleHandle.health()` (which foundation declares
 * synchronous, §6.1) contributes the per-project conditions through
 * `registerHealthCheck`, which foundation explicitly allows to be async.
 *
 * The one condition not in §2.3's list is `elevation-refused`: a project that
 * declares a `permissionElevation` on an install whose
 * `policy.allowPermissionElevation` is false has a setting that will be dropped
 * with a diagnostic at launch (§1.2), and saying so before the launch is exactly
 * what a health payload is for.
 */
import { existsSync } from 'node:fs';

import type { GitRunner } from './git.js';
import type { ProjectRepository } from './repository.js';
import type { Project, ProjectHealth, ProjectHealthCondition } from './types.js';
import { isDirty } from './worktree.js';
import type { WorkspaceService } from './workspaces.js';

export interface HealthDeps {
  readonly repository: ProjectRepository;
  readonly workspaces: WorkspaceService;
  readonly git: GitRunner;
  /** Foundation's `policy.allowPermissionElevation` (§1.2). */
  readonly allowPermissionElevation: boolean;
  /** Seam for the `missing` probe, so a test need not unplug a drive. */
  readonly exists?: (path: string) => boolean;
}

/**
 * Every condition that holds for one project, right now (§2.3).
 *
 * Order is deliberate: `missing` first, because when the folder is gone every
 * other answer is either unknowable or misleading — a `dirty` probe on a path
 * that does not exist would report "clean", which is true and useless.
 */
export async function deriveProjectHealth(
  project: Project,
  deps: HealthDeps,
): Promise<ProjectHealth> {
  const conditions: ProjectHealthCondition[] = [];
  const exists = deps.exists ?? existsSync;
  const present = project.localPath.length > 0 && exists(project.localPath);

  if (!present) {
    conditions.push({
      code: 'missing',
      level: 'error',
      message:
        `${project.localPath} no longer exists. The folder was moved or renamed, or its drive is ` +
        'not connected. Relocate the project onto its new path to keep its history (DESIGN §2.3).',
      detail: { localPath: project.localPath },
    });
  } else if (project.vcs === 'git' && (await isDirty(deps.git, project.localPath))) {
    // Untracked files included: the question this answers is "would an agent
    // find a clean tree", and an untracked file it has to reason about counts.
    conditions.push({
      code: 'dirty',
      level: 'warn',
      message:
        'The primary tree has uncommitted changes. Agents will see them, and an assignment that ' +
        'requires a clean base is refused until they are committed or stashed (DESIGN §4.4).',
      detail: { localPath: project.localPath },
    });
  }

  const dangling = deps.repository.danglingDefaultAgents(project.id);
  if (dangling.length > 0) {
    conditions.push({
      code: 'stale-agents',
      level: 'warn',
      message:
        `${String(dangling.length)} default agent(s) are no longer in the roster and were ` +
        "dropped from this project's defaults: " +
        dangling.join(', '),
      detail: { agentIds: [...dangling] },
    });
  }

  const orphans = deps.workspaces.orphaned(project.id);
  if (orphans.length > 0) {
    conditions.push({
      code: 'orphaned-worktrees',
      level: 'warn',
      message:
        `${String(orphans.length)} workspace lease(s) are orphaned — the service stopped while ` +
        'they were held, or a worktree could not be removed. Review them on the project page.',
      detail: {
        leases: orphans.map((lease) => ({
          id: lease.id,
          assignmentId: lease.assignmentId,
          kind: lease.kind,
          path: lease.path,
          branch: lease.branch,
        })),
      },
    });
  }

  if (project.defaults.permissionElevation !== undefined && !deps.allowPermissionElevation) {
    conditions.push({
      code: 'elevation-refused',
      level: 'warn',
      message:
        'This project declares a permissionElevation, but policy.allowPermissionElevation is ' +
        'false on this install, so roster drops it with a diagnostic and the widening is not in ' +
        'force (DESIGN §1.2).',
      detail: {
        allow: [...project.defaults.permissionElevation.allow],
        reason: project.defaults.permissionElevation.reason,
      },
    });
  }

  return { projectId: project.id, conditions };
}
