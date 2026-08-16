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
import type { Storage } from '../../storage/index.js';
import type { Module, ModuleContext, ModuleHandle } from '../types.js';

import type { GitRunner } from './git.js';
import { createProjectRepository, type ProjectRepository } from './repository.js';
import { createProjectRoutes } from './routes.js';
import { createProjectsService, type ProjectsService } from './service.js';
import { BUILT_IN_RETENTION_DEFAULTS, type RetentionDefaults } from './types.js';

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
      });

      const service: ProjectsService = createProjectsService({
        repository,
        bus: ctx.bus,
        dataRoot: open.paths.dataRoot,
        ...(options.git === undefined ? {} : { git: options.git }),
        ...(options.probeWritable === undefined ? {} : { probeWritable: options.probeWritable }),
      });

      ctx.provide(PROJECTS_SERVICE, service);
      ctx.registerRoutes(createProjectRoutes({ service, logger: ctx.logger }));

      ctx.logger.info(
        { dataRoot: open.paths.dataRoot, projectsRoot: ctx.config.projects.root },
        'project registry ready',
      );

      return {
        health: () => ({
          status: 'ok',
          detail: { projects: repository.list({ includeArchived: true }).length },
        }),
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
