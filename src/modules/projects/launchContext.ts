/**
 * `getEffectiveLaunchContext` (projects DESIGN §5; IMPLEMENTATION M4).
 *
 * > "The name is now the only misleading thing about it, and it is kept for
 * > continuity: this call returns **raw inputs, not an effective anything**.
 * > There is no `permissions` key, because projects does not compute one."
 *
 * So the whole of this file is a *gathering* operation, and the three things it
 * pointedly does not do are the design decisions:
 *
 * - **no permission composition.** The stored `PermissionOverride` and the
 *   `permissionElevation` go across as they were written. Roster's
 *   `compilePermissions` is the sole composer (§1.3, §7.6, roster §6.2) — which
 *   is also why a project `allow` rule outside the agent's baseline disappears:
 *   allow is an intersection *there*, not a filter here;
 * - **no env merge.** The entries come back in the order the project declared
 *   them, to be applied by roster's single merge (§13) between foundation's
 *   `agentEnv` and the assignment's own;
 * - **no secret resolution.** A `secretRef` is still a `secretRef` in the
 *   result. Foundation §3.2 names exactly two authorized reveal sites and this
 *   is neither; an unresolvable ref fails loudly in roster's compiler, which is
 *   a better place for it to fail than in a getter.
 *
 * `cwd` is the leased workspace root rather than `project.localPath`, which is
 * the entire reason the lease has to exist before this call: for a second
 * concurrent writer those two are different directories, and handing back the
 * project folder would put two agents in one tree (§4.1).
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import {
  ProjectNotFoundError,
  ProjectNotLaunchableError,
  WorkspaceNotLeasedError,
} from './errors.js';
import type { WorkspaceLeaseRepository } from './leases.js';
import { pathKey, pathRelation } from './paths.js';
import type { ProjectRepository } from './repository.js';
import { rewriteScopeRules } from './scope.js';
import { projectLaunchBlock, type LaunchContext, type Project } from './types.js';

export interface LaunchContextDeps {
  readonly projects: ProjectRepository;
  readonly leases: WorkspaceLeaseRepository;
  /** Reads the project brief; injected so a test needs no file. */
  readonly readInstructions?: (absolutePath: string) => string | undefined;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

/** Reads a brief off disk, answering `undefined` rather than throwing. */
export function readInstructionsFile(absolutePath: string): string | undefined {
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Resolves `defaults.instructionsPath` against the **project folder**.
 *
 * Not against the leased workspace: a brief the repository does not itself carry
 * (§1.2's whole reason for the field) is untracked, and `git worktree add` does
 * not bring untracked files (§4.1) — so resolving against a worktree would make
 * the brief vanish for exactly the assignments that got isolated.
 *
 * The containment check is repeated here even though the write path already
 * refuses `..`: a value stored by an older build, or edited in the database, must
 * not turn a launch into an arbitrary file read.
 */
export function resolveInstructionsPath(project: Project, relative: string): string | undefined {
  const absolute = resolve(project.localPath, relative);
  if (isAbsolute(relative)) return undefined;
  const relation = pathRelation(pathKey(absolute), project.localPathKey);
  return relation === 'inside' ? absolute : undefined;
}

/**
 * The raw inputs a session is compiled from (§5).
 *
 * @throws ProjectNotFoundError when the id is unknown.
 * @throws ProjectNotLaunchableError for a `provisioning` or `archived` project.
 * @throws WorkspaceNotLeasedError when `acquireWorkspace` has not run.
 */
export function getEffectiveLaunchContext(
  projectId: string,
  assignmentId: string,
  deps: LaunchContextDeps,
): LaunchContext {
  const project = deps.projects.get(projectId);
  if (project === undefined) throw new ProjectNotFoundError(projectId);
  // §2.2: "A `provisioning` project cannot be launched against; the runner
  // rejects it" — and an archived one accepts no new assignments (§2.3).
  const blocked = projectLaunchBlock(project);
  if (blocked !== undefined) throw new ProjectNotLaunchableError(projectId, blocked);

  const workspace = deps.leases.activeFor(projectId, assignmentId);
  if (workspace === undefined) throw new WorkspaceNotLeasedError(projectId, assignmentId);

  const { permissions, permissionElevation, env, instructionsPath } = project.defaults;

  let instructions: string | undefined;
  if (instructionsPath !== undefined) {
    const absolute = resolveInstructionsPath(project, instructionsPath);
    instructions =
      absolute === undefined
        ? undefined
        : (deps.readInstructions ?? readInstructionsFile)(absolute);
    if (instructions === undefined) {
      // Not launch-blocking: a missing brief is a project setting to fix, not a
      // reason to refuse work. It is logged rather than swallowed so the reason
      // the fourth prompt slot is empty is findable.
      deps.log?.(
        `the project brief at ${instructionsPath} could not be read; the launch continues without it`,
        { projectId, instructionsPath },
      );
    }
  }

  // M7 (§1.3): the orchestrator states scopes relative to the repo root, and a
  // worktree has a different absolute prefix — so they are rewritten onto the
  // *leased* root here, which is the only place that knows which one that is.
  // Still input rules: roster's `compilePermissions` composes them (§7.6).
  const scopeRules = rewriteScopeRules(workspace.path, workspace.scopePaths);

  return {
    cwd: workspace.path,
    // A copy, so a caller cannot mutate the stored defaults through the result.
    env: [...(env ?? [])],
    ...(permissions === undefined ? {} : { permissionOverride: permissions }),
    ...(permissionElevation === undefined ? {} : { elevation: permissionElevation }),
    ...(instructions === undefined ? {} : { instructions }),
    // Absent rather than empty for a whole-project assignment: an empty allow
    // list and "no scope stated" are different things to roster's compiler, and
    // only the second one is true here (orchestrator SDK-NOTES C1-3).
    ...(scopeRules.allow.length === 0 ? {} : { scopeRules }),
    workspace,
  };
}
