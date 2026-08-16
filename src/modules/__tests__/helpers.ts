/**
 * Test helpers for the module system.
 *
 * Everything here stays off the developer's real data root: temp directories
 * only, and the install root is the repository's own read-only `config/`
 * directory, so the tests exercise the files that actually ship.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger } from 'pino';

import { findInstallRoot, loadConfig, type AppConfig } from '../../config/index.js';
import type { SecretResolver } from '../../secrets/index.js';
import type { SettingsRepository, Store } from '../../storage/index.js';
import type { HealthReport, Module, ModuleContext } from '../types.js';

/** The repository root, which is also a valid install root (`config/defaults.json`). */
export const repoRoot = findInstallRoot(dirname(fileURLToPath(import.meta.url)));

export interface TempDir {
  readonly path: string;
  cleanup(): void;
}

export function makeTempDir(prefix = 'agentmanager-modules-'): TempDir {
  const path = mkdtempSync(resolve(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true, maxRetries: 5 }) };
}

/**
 * A real {@link AppConfig} from the shipped layers, so unit tests are not
 * written against a hand-made object that could drift from the schema.
 *
 * `dataRoot` points at a path that need not exist: nothing is written, because
 * a missing `config.json` is a warning, not a failure.
 */
export function testConfig(argv: readonly string[] = []): AppConfig {
  return loadConfig({
    argv,
    env: {},
    installRoot: repoRoot,
    dataRootOverride: resolve(tmpdir(), 'agentmanager-config-not-written'),
  }).config;
}

export interface LoggedLine {
  readonly level: string;
  readonly msg: string;
  readonly data: Record<string, unknown>;
}

/**
 * A pino-shaped logger that records instead of writing.
 *
 * The runtime only ever calls `logger.<level>(object, message)` and
 * `logger.<level>(message)`, so recreating that surface is cheaper — and quieter
 * — than building the real logging subsystem for a unit test.
 */
export function stubLogger(lines: LoggedLine[] = []): Logger & { readonly lines: LoggedLine[] } {
  const record =
    (level: string) =>
    (first: unknown, second?: unknown): void => {
      const data = typeof first === 'object' && first !== null ? first : {};
      const msg = typeof first === 'string' ? first : typeof second === 'string' ? second : '';
      lines.push({ level, msg, data: data as Record<string, unknown> });
    };

  return {
    lines,
    level: 'debug',
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    silent: () => {},
    child: () => stubLogger(lines),
  } as unknown as Logger & { readonly lines: LoggedLine[] };
}

/**
 * A {@link Store} with an in-memory `settings` repository and nothing else.
 *
 * The runtime itself touches only `store.settings` (it puts it on the context);
 * anything that needs real repositories opens real storage instead of extending
 * this.
 */
export function fakeStore(): Store {
  const values = new Map<string, unknown>();
  const settings: Partial<SettingsRepository> = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    set: (key, value) => {
      values.set(key, value);
      return { key, value, updatedAt: '1970-01-01T00:00:00.000Z' };
    },
    has: (key) => values.has(key),
    deleteByKey: (key) => void values.delete(key),
  };
  return { settings } as unknown as Store;
}

/** A resolver that answers nothing — no test here needs a real secret. */
export const emptyResolver: SecretResolver = { get: () => Promise.resolve(undefined) };

export interface RecordingModuleOptions {
  readonly id: string;
  readonly dependsOn?: readonly string[];
  readonly critical?: boolean;
  /** Appends `<id>.<hook>` for each hook it reaches. */
  readonly log: string[];
  /** Throw at this hook, to exercise §6.2's failure handling. */
  readonly failAt?: 'init' | 'start' | 'stop';
  /** Never settle at this hook, to exercise the per-module timeout. */
  readonly hangAt?: 'start' | 'stop';
  readonly onInit?: (ctx: ModuleContext) => void;
  readonly health?: () => HealthReport;
}

/** A module that records every lifecycle hook it reaches, in order. */
export function recordingModule(options: RecordingModuleOptions): Module {
  const { id, log } = options;
  const mark = (hook: string): void => void log.push(`${id}.${hook}`);

  return {
    id,
    dependsOn: options.dependsOn ?? [],
    ...(options.critical === undefined ? {} : { critical: options.critical }),
    init(ctx) {
      mark('init');
      options.onInit?.(ctx);
      if (options.failAt === 'init') throw new Error(`${id} failed in init`);
      return {
        start: async () => {
          mark('start');
          if (options.failAt === 'start') throw new Error(`${id} failed in start`);
          if (options.hangAt === 'start') await new Promise<never>(() => {});
        },
        stop: async () => {
          mark('stop');
          if (options.failAt === 'stop') throw new Error(`${id} failed in stop`);
          if (options.hangAt === 'stop') await new Promise<never>(() => {});
        },
        ...(options.health === undefined ? {} : { health: options.health }),
      };
    },
  };
}
