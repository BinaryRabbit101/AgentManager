/**
 * The `projects` module (projects IMPLEMENTATION M1: "Register the module with
 * the core").
 *
 * Registering the module is what wires three separate things at once, because
 * foundation keys all three on the module id:
 *
 * - **its migration set.** `moduleMigrationsFor` maps the topologically ordered
 *   module list onto `migrations/<moduleId>/`, so `migrations/projects/` is
 *   applied — after foundation's core set, tracked in `schema_migrations` under
 *   `projects` — purely by virtue of this module being in the list (foundation
 *   §1.3). There is nothing else to declare;
 * - **its routes**, recorded on foundation's one route table during `init` and
 *   mounted by the `http` module when it starts (foundation §6.4);
 * - **its service**, published as `projects` so runner and orchestrator can
 *   reach it through `ctx.require` without importing this element (§6.1).
 *
 * ## The database handle, and why it is a constructor argument
 *
 * Foundation §1.3 gives a feature module repositories and deliberately no `db`:
 * "no feature module composes SQL against **another element's** tables". But the
 * same section hands each element its *own* tables through element-owned
 * migrations — `project_default_agents`, `work_items`, `work_item_assignments`
 * and `workspace_leases` are all this element's — and provides no accessor for
 * them. So the handle arrives the way foundation's own modules receive the
 * resources they wrap (`createStorageModule` takes `() => Storage`): as a
 * getter from the composition root, resolved lazily because the module list is
 * built *before* the database is opened, since its topological order is what
 * decides migration order.
 *
 * The `projects` table itself is still reached only through
 * `ctx.store.projects`. The handle here is used for one thing:
 * `project_default_agents`.
 */
import { homedir } from 'node:os';

import type { Storage } from '../../storage/index.js';
import type { HealthCondition, Module, ModuleContext, ModuleHandle } from '../types.js';

import { createGitRunner, type GitRunner } from './git.js';
import { createWorkspaceLeaseRepository } from './leases.js';
import { createKeyedMutex } from './mutex.js';
import { createProjectRepository, type ProjectRepository } from './repository.js';
import { createProjectRoutes } from './routes.js';
import { createProjectsService, type ProjectsService } from './service.js';
import { BUILT_IN_RETENTION_DEFAULTS, type RetentionDefaults } from './types.js';
import { createWorkspaceService, type WorkspaceService } from './workspaces.js';
import { createCommandRunner, readLongPathsEnabled, type CommandRunner } from './worktree.js';

/** The module id: `dependsOn`, the service registry and `migrations/projects/`. */
export const PROJECTS_MODULE_ID = 'projects';

/** The name `ctx.require('projects')` answers to. */
export const PROJECTS_SERVICE = 'projects';

/**
 * The two filesystem-facing seams, both absent in production.
 *
 * They exist because Windows makes one of them untestable otherwise:
 * `fs.access(W_OK)` ignores ACLs, so the not-writable refusal can only be
 * exercised by substituting the probe.
 */
export interface ProjectsModuleOptions {
  readonly git?: GitRunner;
  readonly probeWritable?: (directory: string) => string | undefined;
  /** Runs `defaults.setupCommand` in a fresh worktree (§4.4); the shell in production. */
  readonly runCommand?: CommandRunner;
  /** Reads `LongPathsEnabled`; the registry in production, a stub in tests. */
  readonly longPaths?: () => boolean | undefined;
}

/**
 * Builds the module.
 *
 * @param storage getter for the open {@link Storage}, resolved on `init` — see
 *   the note above on why this is not `ctx.store`.
 */
export function createProjectsModule(
  storage: () => Storage,
  options: ProjectsModuleOptions = {},
): Module {
  return {
    id: PROJECTS_MODULE_ID,
    // Storage owns the migration set this module's tables arrive in, and the
    // repositories it codes against. Nothing else is needed: `http` mounts the
    // route table at `start()`, by which point every `init` has run.
    dependsOn: ['storage'],
    // Not critical: a project registry that fails to initialise must still leave
    // the service reachable so the owner can read the logs and fix it (§6.2).
    init(ctx: ModuleContext): ModuleHandle {
      const open = storage();

      const repository: ProjectRepository = createProjectRepository({
        db: open.db,
        projects: ctx.store.projects,
        retentionDefaults: retentionDefaultsFrom(ctx),
        clock: ctx.clock,
        onWarning: (projectId, message) => {
          ctx.logger.warn(
            { projectId },
            `stored project settings were repaired on read: ${message}`,
          );
        },
        // §1.2's lazy drop, resolved through foundation's rebuildable `agents`
        // index — the projection roster pushes on every registry change
        // (foundation §1.4, roster §2.2). Not through `ctx.require('roster')`:
        // the index is a repository this element is already given, it answers
        // the one question asked here in a single indexed lookup, and it leaves
        // the read path working when the roster module is not in the list at
        // all. Archived agents are *known* — §9.3 keeps them readable by id —
        // so only a purged agent is dangling.
        knownAgent: (agentId) => ctx.store.agents.get(agentId) !== undefined,
      });

      const git: GitRunner = options.git ?? createGitRunner();

      const workspaces: WorkspaceService = createWorkspaceService({
        projects: repository,
        leases: createWorkspaceLeaseRepository(open.db, ctx.clock),
        mutex: createKeyedMutex(),
        bus: ctx.bus,
        clock: ctx.clock,
        // `<dataRoot>\worktrees` unless `projects.worktreesRoot` relocates it;
        // foundation resolved that once, at boot (foundation §1.2).
        worktreesRoot: open.paths.worktrees,
        git,
        runCommand: options.runCommand ?? createCommandRunner(),
        longPaths: options.longPaths ?? readLongPathsEnabled,
        log: (level, message, detail) => {
          if (level === 'warn') ctx.logger.warn(detail ?? {}, message);
          else ctx.logger.info(detail ?? {}, message);
        },
      });

      const service: ProjectsService = createProjectsService({
        repository,
        workspaces,
        bus: ctx.bus,
        dataRoot: open.paths.dataRoot,
        allowPermissionElevation: ctx.config.policy.allowPermissionElevation,
        git,
        ...(options.probeWritable === undefined ? {} : { probeWritable: options.probeWritable }),
        log: (message, detail) => {
          ctx.logger.warn(detail ?? {}, message);
        },
      });

      ctx.provide(PROJECTS_SERVICE, service);
      ctx.registerRoutes(
        createProjectRoutes({
          service,
          logger: ctx.logger,
          // §2.1's folder picker. `browseRoots: null` means the documented
          // default — `%USERPROFILE%` and `projects.root` — resolved in
          // `browse.ts` rather than here, so the rule has one home.
          browse: {
            browseRoots: ctx.config.projects.browseRoots,
            projectsRoot: ctx.config.projects.root,
            homeDirectory: process.env['USERPROFILE'] ?? homedir(),
          },
        }),
      );

      // §4.4's orphan recovery. A boot task, not `start()`: foundation runs it
      // after storage is up and *before* any listener binds (foundation §4.2),
      // so nothing can acquire a workspace in the window where last run's leases
      // still look active.
      ctx.registerBootTask(async () => {
        const result = await workspaces.reconcileOrphans();
        if (result.orphaned.length > 0) {
          ctx.logger.warn(
            { leases: result.orphaned.length, pruned: result.pruned.length },
            'workspace leases from a previous run were marked orphaned and worktrees pruned',
          );
        }
      }, 'projects:reconcile-workspaces');

      ctx.logger.info(
        {
          dataRoot: open.paths.dataRoot,
          projectsRoot: ctx.config.projects.root,
          worktreesRoot: open.paths.worktrees,
        },
        'project registry ready',
      );

      return {
        health: () => {
          const projects = repository.list({ includeArchived: true });
          // Health is derived on read (§2.3), so the aggregate is simply every
          // project's own conditions, prefixed with the project so a UI banner
          // can say which one it is about.
          const conditions: HealthCondition[] = [];
          for (const project of projects) {
            for (const condition of service.health(project.id).conditions) {
              conditions.push({
                id: `projects.${condition.code}:${project.id}`,
                level: condition.level,
                message: `${project.name}: ${condition.message}`,
              });
            }
          }
          return {
            // A project with a stale agent id or an orphaned worktree is a
            // condition to show, not a module that is failing: everything else
            // about the registry works.
            status: 'ok',
            conditions,
            detail: { projects: projects.length, worktreesRoot: open.paths.worktrees },
          };
        },
      };
    },
  };
}

/**
 * §3.3's per-project retention defaults, taken from foundation's config.
 *
 * `keepPinned` has no configuration key — foundation's `retention` namespace
 * carries the two numbers — so the design's `true` stands. Reading the numbers
 * from config rather than hard-coding 90/500 is what makes "a project may
 * override either number" mean "override *the configured* number".
 */
function retentionDefaultsFrom(ctx: ModuleContext): RetentionDefaults {
  return {
    transcriptDays: ctx.config.retention.transcriptDays,
    transcriptCapMb: ctx.config.retention.transcriptCapMb,
    keepPinned: BUILT_IN_RETENTION_DEFAULTS.keepPinned,
  };
}
