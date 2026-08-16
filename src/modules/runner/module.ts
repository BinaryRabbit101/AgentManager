/**
 * The `runner` module (runner IMPLEMENTATION M1).
 *
 * Registering it wires four things at once, all keyed on the module id:
 *
 * - **`migrations/runner/`** — foundation's `moduleMigrationsFor` maps the
 *   topologically ordered module list onto `migrations/<moduleId>/`, so §3.5's
 *   columns are applied after foundation's core set and tracked in
 *   `schema_migrations` under `runner` purely by virtue of this module being in
 *   the list (foundation §1.3);
 * - **routes**, recorded on foundation's one route table during `init`;
 * - **the service**, published as `runner` so orchestrator and the UI reach it
 *   through `ctx.require` without importing this element (§11.2, §15.1 item 1);
 * - **`dependsOn`**, which is also the start order: `storage`, `secrets`,
 *   `roster` and `projects` are all present before the first session can be
 *   admitted (M1's list, unchanged).
 *
 * ## Why the database handle is a constructor argument
 *
 * The same reason projects takes one: §3.5's columns and `session_inputs`
 * arrive in this element's own migration, and foundation gives a feature module
 * repositories rather than a handle. `sessions` itself is runner's table (§1),
 * so composing SQL against it is the sanctioned path — see `repository.ts`. The
 * getter is lazy because the module list is built *before* the database opens:
 * its topological order is what decides migration order.
 *
 * ## Not critical
 *
 * A runner that fails to initialise must leave the service reachable so the
 * owner can read the logs and fix it (foundation §6.2). Losing agent execution
 * is bad; losing the ability to see why is worse.
 */
import type { Storage } from '../../storage/index.js';
import type { Module, ModuleContext, ModuleHandle } from '../types.js';

import { createSessionRepository, type SessionRepository } from './repository.js';
import { createRunnerRoutes } from './routes.js';
import { createRunnerService, type RunnerService } from './service.js';
import { createTranscriptFactory, type TranscriptFactory } from './transcript.js';
import { createTranscriptReader, type TranscriptReader } from './transcriptReader.js';

/** The module id: `dependsOn`, the service registry, and `migrations/runner/`. */
export const RUNNER_MODULE_ID = 'runner';

/** The name `ctx.require('runner')` answers to (§11.2). */
export const RUNNER_SERVICE = 'runner';

/** Everything the module builds, exposed for the tests that drive it directly. */
export interface RunnerInternals {
  readonly sessions: SessionRepository;
  readonly transcripts: TranscriptFactory;
  readonly reader: TranscriptReader;
  readonly service: RunnerService;
}

export interface RunnerModuleOptions {
  /** Receives what the module built, so a test can exercise it through `init`. */
  readonly onReady?: (internals: RunnerInternals) => void;
}

export function createRunnerModule(
  storage: () => Storage,
  options: RunnerModuleOptions = {},
): Module {
  return {
    id: RUNNER_MODULE_ID,
    dependsOn: ['storage', 'secrets', 'roster', 'projects'],
    init(ctx: ModuleContext): ModuleHandle {
      const open = storage();
      const runner = ctx.config.runner;

      const sessions = createSessionRepository({
        db: open.db,
        store: ctx.store,
        clock: ctx.clock,
      });

      const transcripts = createTranscriptFactory({
        transcripts: ctx.store.transcripts,
        sessions: ctx.store.sessions,
        clock: ctx.clock,
        log: (level, message, detail) => {
          if (level === 'warn') ctx.logger.warn(detail ?? {}, message);
          else ctx.logger.debug(detail ?? {}, message);
        },
      });

      const reader = createTranscriptReader({
        transcripts: ctx.store.transcripts,
        sessions: ctx.store.sessions,
        maxTailBytes: runner.transcript.maxTailBytes,
        onMalformedLine: (sessionId) => {
          ctx.logger.warn({ sessionId }, 'transcript line did not parse as JSON');
        },
      });

      const service = createRunnerService({ sessions, transcripts: reader });

      ctx.provide(RUNNER_SERVICE, service);
      ctx.registerRoutes(createRunnerRoutes({ service, logger: ctx.logger }));
      options.onReady?.({ sessions, transcripts, reader, service });

      ctx.logger.info(
        {
          maxConcurrent: runner.maxConcurrent,
          queueLimit: runner.queueLimit,
          transcripts: open.paths.transcripts,
        },
        'runner ready',
      );

      return {
        health: () => {
          const counts = sessions.countByStatus();
          return {
            status: 'ok',
            detail: {
              sessions: counts,
              // The two numbers a queue panel needs before the scheduler (M5)
              // exists to report anything richer.
              capacity: runner.maxConcurrent,
              queueLimit: runner.queueLimit,
            },
          };
        },
      };
    },
  };
}
