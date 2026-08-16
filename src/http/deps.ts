/**
 * What foundation's own routes need from the rest of the service.
 *
 * A single explicit dependency object, rather than each route reaching for a
 * module context: the routes are then plain functions of their inputs, and the
 * `http` module is the only thing that knows how to build one. It is also what
 * lets a route test construct exactly the pieces it exercises — a log route
 * test needs `logging` and nothing else.
 */
import type { Logger } from 'pino';

import type { AppConfig, ConfigSourceMap } from '../config/index.js';
import type { Logging } from '../logging/index.js';
import type { EventBus, HealthAggregate, LifecyclePhase } from '../modules/types.js';
import type { Clock, EventsRepository } from '../storage/index.js';

/** Where configuration was actually read from, for `/api/config/effective`. */
export interface ConfigOrigins {
  readonly installRoot: string;
  readonly dataRoot: string;
  /** `null` when no machine-local `config.json` exists (§2.1, layer 3). */
  readonly configFile: string | null;
  readonly editionFile: string | null;
}

export interface HttpDeps {
  readonly version: string;
  readonly config: AppConfig;
  /** Per-key winning layer (§2.4). */
  readonly sources: ConfigSourceMap;
  readonly origins: ConfigOrigins;
  readonly logging: Logging;
  /** `<dataRoot>/state/logs` — the directory `/api/logs/download` zips (§5.3). */
  readonly logsDir: string;
  /** Replay half of `/api/events` (§6.5). */
  readonly events: EventsRepository;
  /** Live half of `/api/events`, and the same type matcher (§6.5). */
  readonly bus: EventBus;
  /** M7's aggregation, served as `/api/health` (§6.2). */
  readonly health: () => Promise<HealthAggregate>;
  readonly phase: () => LifecyclePhase;
  /**
   * Starts the graceful stop of §4.2. Called after the response has been
   * written, so the caller learns the shutdown began rather than losing the
   * connection mid-answer.
   */
  readonly requestShutdown: (reason: string) => void;
  /** Directory holding the built SPA, or `undefined` when none is installed. */
  readonly webRoot: string | undefined;
  /** Boot instant, for `/healthz`'s `uptime`. */
  readonly startedAt: Date;
  readonly clock: Clock;
  readonly logger: Logger;
}
