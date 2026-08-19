/**
 * The `roster` module (roster IMPLEMENTATION M2/M3; foundation DESIGN §6.1).
 *
 * Registering the module wires four things at once, because foundation keys them
 * all on the module id:
 *
 * - **its migration set.** `moduleMigrationsFor` maps the module list onto
 *   `migrations/<moduleId>/`, so `migrations/roster/` — `agent_ui_state`, §2.2 —
 *   is applied after foundation's core set and tracked in `schema_migrations`
 *   under `roster`, purely by virtue of this module being in the list;
 * - **its routes**, recorded on foundation's one route table during `init` and
 *   mounted by the `http` module when it starts (foundation §6.4);
 * - **its service**, published as `roster` so runner and orchestrator can reach
 *   it through `ctx.require` without importing this element;
 * - **the library itself.** Bootstrap *and seeding* are roster's, not the
 *   installer's (§2.1, foundation §4.4), and `init` is where both happen: the
 *   installer leaves an empty ACLed directory, and this is what turns it into a
 *   git repository with `roster.json`, `.gitignore`, `agents/`, a README and —
 *   on a first run against an empty library — the four starter agents of M10.
 *
 * ## The database handle, and why it is a constructor argument
 *
 * The same note the projects module carries, for the same reason. Foundation
 * §1.3 gives a feature module repositories and deliberately no `db`, but hands
 * each element its *own* tables through element-owned migrations and provides no
 * accessor for them. `agent_ui_state` is this element's. So the handle arrives
 * the way foundation's own modules receive the resources they wrap: as a getter
 * from the composition root, resolved lazily because the module list is built
 * *before* the database is opened, since its topological order is what decides
 * migration order.
 *
 * `ctx.store.agents` and `ctx.store.sessions` are still reached only through the
 * repositories — the index roster pushes into (§2.2) and the purge guard of
 * §9.3.
 *
 * ## Load at `init`, watch at `start`
 *
 * The registry is populated during `init` so that any module initialised after
 * this one can already `ctx.require('roster')` and get a loaded roster. The
 * filesystem watcher starts in `start()`, because a watcher firing during the
 * init phase would reload a registry other modules are mid-way through reading.
 */
import type { Storage } from '../../storage/index.js';
import type { Module, ModuleContext, ModuleHandle } from '../types.js';

import { bootstrapLibrary, type GitCommand } from './bootstrap.js';
import { compileSession } from './compileSession.js';
import type { Diagnostic } from './contracts.js';
import { realDraftQuery, type DraftQueryFn } from './draft.js';
import { createRosterRoutes } from './routes.js';
import { seedLibrary } from './seed.js';
import { createRosterService, type ProjectDefaultsProvider } from './service.js';
import type { CompileSessionInput, SessionToolsetProvider } from './sessionOptions.js';
import { createRosterStore, type StoreHooks } from './store.js';
import { createAgentUiStateRepository } from './uiState.js';
import { createRosterWatcher, inertWatcher, type RosterWatcher } from './watcher.js';

/** The module id: `dependsOn`, the service registry and `migrations/roster/`. */
export const ROSTER_MODULE_ID = 'roster';

/** The name `ctx.require('roster')` answers to. */
export const ROSTER_SERVICE = 'roster';

export interface RosterModuleOptions {
  /** Defaults to the real `git` executable; injected in tests. */
  readonly git?: GitCommand;
  /** `false` skips `git init` — a library without version history still works. */
  readonly initGit?: boolean;
  /** Overrides §2.3's ~250 ms debounce; tests shorten it. */
  readonly watchDebounceMs?: number;
  /** The atomic-write seam of `store.ts`; absent in production. */
  readonly hooks?: StoreHooks;
  /**
   * §12's `query()` seam (M8). Production takes the real one; a test passes a
   * scripted generator, because the drafting pipeline is a property of the
   * harness — the prompt, the extraction, the repair round-trip, the degraded
   * partial — and pinning it to a live subscription would prove the least
   * interesting half of it.
   */
  readonly draftQuery?: DraftQueryFn;
}

export function createRosterModule(
  storage: () => Storage,
  options: RosterModuleOptions = {},
): Module {
  return {
    id: ROSTER_MODULE_ID,
    // Storage owns the migration set `agent_ui_state` arrives in, and the
    // `agents` / `sessions` repositories this module codes against. Nothing
    // else is needed: `http` mounts the route table at `start()`, by which
    // point every `init` has run.
    dependsOn: ['storage'],
    // Not critical: a library that will not load must still leave the service
    // up so the owner can read the logs and fix the file (§2.3, foundation
    // §6.2). One unloadable agent is already a diagnostic rather than a crash;
    // an unloadable *library* must not be worse than that.
    init(ctx: ModuleContext): ModuleHandle {
      const open = storage();
      const libraryRoot = open.paths.library;

      const bootstrap = bootstrapLibrary({
        root: libraryRoot,
        ...(options.git === undefined ? {} : { git: options.git }),
        ...(options.initGit === undefined ? {} : { initGit: options.initGit }),
        ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      });
      for (const diagnostic of bootstrap.diagnostics) {
        ctx.logger.warn({ code: diagnostic.code, path: diagnostic.path }, diagnostic.message);
      }

      const store = createRosterStore({
        root: libraryRoot,
        clock: ctx.clock,
        ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      });

      // The starter roster (M10), between bootstrap and the first load: the
      // library exists by now, and the registry has not read it yet, so the
      // seeds arrive as ordinary folders rather than as a special case anything
      // downstream has to know about. Through `store.write`, so a seed is
      // validated, gets its plugin manifest and is read back exactly like an
      // agent created over the API.
      const seedDiagnostics: Diagnostic[] = [];
      if (ctx.config.library.seed) {
        const seeded = seedLibrary({
          store,
          clock: ctx.clock,
          ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
        });
        seedDiagnostics.push(...seeded.diagnostics);
        for (const diagnostic of seeded.diagnostics) {
          ctx.logger.warn(
            { code: diagnostic.code, agentId: diagnostic.agentId },
            diagnostic.message,
          );
        }
        if (seeded.seeded.length > 0) {
          ctx.logger.info(
            { agentIds: seeded.seeded, libraryRoot },
            `seeded ${String(seeded.seeded.length)} starter agent(s) into a new agent library`,
          );
        } else if (seeded.reason === 'library-not-empty') {
          ctx.logger.info(
            { libraryRoot },
            'the agent library already holds agents; the starter roster was not written',
          );
        }
        // The template half runs on its own stamp, so it can write into a
        // library the agent half deliberately left alone (§2.4, WO5).
        if (seeded.templates.seeded.length > 0) {
          ctx.logger.info(
            { templateIds: seeded.templates.seeded, libraryRoot },
            `seeded ${String(seeded.templates.seeded.length)} starter task template(s)`,
          );
        }
      }

      /**
       * §13's orchestration row (orchestrator R1), resolved **per launch**.
       *
       * `ctx.require` is called inside the closure rather than once at init for
       * two reasons: orchestrator initialises after roster, so there would be
       * nothing to find here; and the instance must be new every time — a
       * `createSdkMcpServer` instance is single-use, and a cached one produces a
       * session that believes it has the toolset and gets no answers
       * (orchestrator SDK-NOTES G2). `undefined` — no module, or a build with no
       * toolset wired — is §11's orchestrator-disabled case, not an error.
       */
      const toolset: SessionToolsetProvider = (launch) => {
        const orchestrator = ctx.require<{
          readonly getSessionToolset?: SessionToolsetProvider | undefined;
        }>('orchestrator');
        return orchestrator?.getSessionToolset?.(launch);
      };

      const service = createRosterService({
        store,
        uiState: createAgentUiStateRepository(open.db),
        agents: ctx.store.agents,
        sessions: ctx.store.sessions,
        bus: ctx.bus,
        clock: ctx.clock,
        bootDiagnostics: [...bootstrap.diagnostics, ...seedDiagnostics],
        // §10's `{ secretRef, resolved }` badge. The read-only face: this
        // service probes for presence and never reveals a value.
        secrets: ctx.secrets,
        // §6.2's two out-of-band inputs, so `POST /agents/:id/validate` composes
        // exactly what a launch would.
        policy: ctx.config.policy,
        // Resolved lazily for the same reason as the toolset: projects is not
        // in the registry while roster is initialising.
        projects: () => ctx.require<ProjectDefaultsProvider>('projects'),
        toolset,
        draftQuery: options.draftQuery ?? realDraftQuery,
        log: (message, detail) => {
          ctx.logger.debug(detail ?? {}, message);
        },
      });

      const loaded = service.load();
      ctx.logger.info(
        {
          libraryRoot,
          agents: service.registry.list().length,
          created: bootstrap.created.length,
          gitInitialised: bootstrap.gitInitialised,
          watch: ctx.config.library.watch,
        },
        `agent library ready with ${String(service.registry.list().length)} agent(s)`,
      );
      if (loaded.agentIds.length > 0) {
        ctx.logger.debug({ agentIds: loaded.agentIds }, 'agents loaded from the library');
      }

      // The published service additionally carries roster §13's compiler —
      // runner's launch chain consumes `registry.get` + `compileSession`
      // structurally through the registry (runner contracts `RosterProvider`),
      // and a roster build that does not publish the compiler turns every
      // launch into a named `launch_failed` refusal.
      //
      // The published one is *bound to the toolset provider* (R1): the compiler
      // is a pure function and does not reach into the service registry, so the
      // module — the thing that holds a `ModuleContext` — is what supplies it.
      // A caller that passes its own wins, which is what makes the compiler
      // still testable in isolation.
      ctx.provide(
        ROSTER_SERVICE,
        Object.assign(service, {
          compileSession: (input: CompileSessionInput) =>
            compileSession({ ...input, toolset: input.toolset ?? toolset }),
        }),
      );
      ctx.registerRoutes(createRosterRoutes({ service, logger: ctx.logger }));

      let watcher: RosterWatcher = inertWatcher();
      let templateWatcher: RosterWatcher = inertWatcher();

      return {
        start() {
          if (!ctx.config.library.watch) {
            ctx.logger.info(
              'library.watch is off; external edits to the agent library will need a restart',
            );
            return;
          }
          const debounce =
            options.watchDebounceMs === undefined ? {} : { debounceMs: options.watchDebounceMs };
          watcher = createRosterWatcher({
            dir: store.paths.agents,
            logger: ctx.logger,
            ...debounce,
            onChanged: (folders) => {
              const change =
                folders === undefined ? service.reload() : service.reloadFolders(folders);
              if (change.changed) {
                ctx.logger.info(
                  { agentIds: change.agentIds },
                  'the agent library changed on disk and was reloaded',
                );
              }
            },
          });
          // A second watcher over `templates/` (§2.4, WO5) rather than one
          // recursive watch of the library root: the two have different reload
          // paths, and one merged stream of folder names would have to be
          // re-attributed by guessing which directory a name came from.
          templateWatcher = createRosterWatcher({
            dir: store.paths.templates,
            logger: ctx.logger,
            ...debounce,
            onChanged: (folders) => {
              const change =
                folders === undefined
                  ? service.reloadTemplates()
                  : service.reloadTemplateFolders(folders);
              if (change.changed) {
                ctx.logger.info(
                  { templateIds: change.templateIds },
                  'the task templates changed on disk and were reloaded',
                );
              }
            },
          });
        },

        stop() {
          watcher.close();
          templateWatcher.close();
        },

        health() {
          const diagnostics = [
            ...service.bootDiagnostics,
            ...service.registry.diagnostics(),
            // A `template.json` that will not parse is a fault of exactly the
            // same weight as an `agent.json` that will not: it degrades, it does
            // not fail, and it says which file to open.
            ...service.listTemplates().diagnostics,
          ];
          const errors = diagnostics.filter((diagnostic) => diagnostic.level === 'error');
          const conditions = diagnostics
            .filter((diagnostic) => diagnostic.level !== 'info')
            .map((diagnostic) => ({
              // A template diagnostic names no agent, so the file it points at
              // is what keeps two broken templates from collapsing into one
              // condition the owner can only fix half of.
              id: `${diagnostic.code}:${diagnostic.agentId ?? diagnostic.path ?? 'library'}`,
              level: diagnostic.level === 'error' ? ('error' as const) : ('warn' as const),
              message: diagnostic.message,
            }));

          return {
            // A definition that will not load is a real fault the board has to
            // show, but it is not this module failing — every other agent is
            // loaded and launchable, which is exactly what `degraded` means.
            status: errors.length > 0 ? ('degraded' as const) : ('ok' as const),
            conditions,
            detail: {
              agents: service.registry.list().length,
              archived: service.registry.listArchived().length,
              templates: service.listTemplates().templates.length,
              libraryRoot,
              watching: watcher.watching,
              watchingTemplates: templateWatcher.watching,
            },
          };
        },
      };
    },
  };
}
