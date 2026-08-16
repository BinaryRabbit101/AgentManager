/**
 * The modules foundation itself provides — the first two entries of §6.2's
 * list, and the two the design names as `critical`:
 *
 * ```ts
 * const modules = [storage, secrets, http, roster, projects, runner];
 * ```
 *
 * `http` (M8), `roster`, `projects`, `runner` and `orchestrator` join the list
 * as their elements land; nothing here has to change when they do.
 *
 * ## Why these two wrap resources they did not create
 *
 * Storage and the secret store are built by the composition root *before* the
 * runtime exists, because every module's context needs `store` and `secrets` on
 * the very first `init` — and because the migration order is derived from the
 * module graph, so the graph must exist before the database is opened (§1.3).
 * The modules here are what give those resources a place in the lifecycle:
 * a health contribution, and — for storage — the `stop()` that checkpoints the
 * WAL and closes the handle last, since stopping runs in reverse order (§4.2).
 */
import type {
  HealthCondition as SecretsHealthCondition,
  SecretStoreHandle,
} from '../secrets/index.js';
import type { Storage } from '../storage/index.js';

import type { HealthReport, Module } from './types.js';

/** The service name storage publishes on the registry. */
export const STORAGE_SERVICE = 'storage';
/** The service name the secrets module publishes on the registry. */
export const SECRETS_SERVICE = 'secrets';

/** What `ctx.require('storage')` yields: the facts, never the handle (§1.3). */
export interface StorageService {
  readonly schemaVersion: number;
  readonly installId: string;
  readonly dataRoot: string;
  /** Final version of every applied migration set, keyed by set id. */
  readonly setVersions: Readonly<Record<string, number>>;
  /** Newest backup on disk, for the restore instruction in a fatal message. */
  newestBackup(): { readonly path: string } | undefined;
}

/**
 * The `storage` module (§6.2: critical).
 *
 * Takes a getter rather than the {@link Storage} itself so the module list can
 * be built — and topologically sorted, which is what decides migration order —
 * before the database is opened.
 */
export function createStorageModule(get: () => Storage): Module {
  return {
    id: 'storage',
    dependsOn: [],
    critical: true,
    init(ctx) {
      const storage = get();
      const service: StorageService = {
        schemaVersion: storage.schemaVersion,
        installId: storage.installId,
        dataRoot: storage.paths.dataRoot,
        setVersions: storage.setVersions,
        newestBackup: () => storage.newestBackup(),
      };
      ctx.provide(STORAGE_SERVICE, service);

      return {
        health: (): HealthReport => ({
          status: 'ok',
          detail: {
            schemaVersion: storage.schemaVersion,
            installId: storage.installId,
            dataRoot: storage.paths.dataRoot,
            setVersions: storage.setVersions,
          },
        }),
        // Stopping is reverse topological order, and nothing depends on
        // storage in reverse — so this runs last, which is where §4.2 puts the
        // WAL checkpoint and the close.
        stop: () => {
          ctx.logger.info('checkpointing and closing the database');
          storage.close();
        },
      };
    },
  };
}

/** What `ctx.require('secrets')` yields. Deliberately not the store (§3.2). */
export interface SecretsService {
  readonly provider: 'dpapi' | 'keyfile' | 'env';
  /** True when `auto` fell back to `keyfile` because DPAPI would not load. */
  readonly degraded: boolean;
}

export interface SecretsModuleOptions {
  readonly get: () => SecretStoreHandle;
  /**
   * Conditions raised outside the store itself — in v1 the
   * `ANTHROPIC_API_KEY`-overrides-subscription warning of §3.5, which the
   * composition root checks because only it sees the process environment and
   * `auth.mode` together.
   */
  readonly conditions?: () => readonly SecretsHealthCondition[];
}

/**
 * The `secrets` module (§6.2: critical).
 *
 * Its whole runtime job is health: the provider in use, the keyfile-fallback
 * degradation of §3.1, and the `ANTHROPIC_API_KEY` condition of §3.5 — "a
 * persistent health warning that the UI displays", as opposed to a log line
 * that scrolls away.
 */
export function createSecretsModule(options: SecretsModuleOptions): Module {
  return {
    id: 'secrets',
    dependsOn: [],
    critical: true,
    init(ctx) {
      const store = options.get();
      const service: SecretsService = {
        provider: store.provider,
        degraded: store.degraded !== undefined,
      };
      ctx.provide(SECRETS_SERVICE, service);

      return {
        health: (): HealthReport => {
          const health = store.health();
          const extra = options.conditions?.() ?? [];
          const conditions = [...health.conditions, ...extra];
          return {
            status: health.status === 'ok' && extra.length === 0 ? 'ok' : 'degraded',
            conditions,
            detail: { provider: health.provider },
          };
        },
      };
    },
  };
}
