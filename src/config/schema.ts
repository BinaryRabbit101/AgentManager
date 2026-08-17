/**
 * The v1 key inventory (foundation DESIGN.md §2.3) expressed as registry
 * contributions.
 *
 * Every namespace here is registered through the same seam a feature module
 * would use (registry.ts). Foundation registers them all for now because no
 * feature module exists yet; when the orchestrator module lands it takes over
 * the `orchestrator` contribution unchanged, and nothing in the loader moves.
 *
 * The defaults declared here and the shipped `config/defaults.json` are the same
 * values twice: the file is layer 1 and is the documentation of what is
 * configurable, while these defaults let a module ship a namespace the file does
 * not mention yet. `shipped.test.ts` pins them to each other.
 */
import { z } from 'zod';

import {
  ORCHESTRATOR_CONFIG_DEFAULTS,
  orchestratorConfigSchema,
} from '../modules/orchestrator/config.js';
// `config.ts` only — never `../modules/remote/index.js`. The remote *module* is
// reached through a dynamic import behind the edition gate (§6.2); its
// configuration namespace has to be in the composed schema in both editions,
// because that is what lets the work edition *reject* `modules.remote.enabled`
// instead of merely ignoring it. `config.ts` holds no listener and no load probe.
import { REMOTE_CONFIG_DEFAULTS, remoteConfigSchema } from '../modules/remote/config.js';
import { RUNNER_CONFIG_DEFAULTS, runnerConfigSchema } from '../modules/runner/config.js';

import { ConfigSchemaRegistry } from './registry.js';
import type { ConfigInvariant } from './registry.js';

const port = z.number().int().min(1).max(65535);
const nonEmpty = z.string().min(1);

/** `home` | `work` — DESIGN §2.2. */
export const editionSchema = z.enum(['home', 'work']);
export type Edition = z.infer<typeof editionSchema>;

export const EDITIONS: readonly Edition[] = editionSchema.options;

export function isEdition(value: unknown): value is Edition {
  return typeof value === 'string' && (EDITIONS as readonly string[]).includes(value);
}

/**
 * The shape of `AppConfig`. Kept as a static object literal so the type is
 * inferred rather than hand-written; the registry composes the same schemas at
 * runtime, and `registry.test.ts` asserts the two agree.
 */
export const foundationConfigShape = {
  edition: editionSchema,
  /** `null` = `%LOCALAPPDATA%\AgentManager` (DESIGN §1.2). */
  dataRoot: nonEmpty.nullable(),
  library: z.strictObject({
    root: nonEmpty.nullable(),
    watch: z.boolean(),
  }),
  http: z.strictObject({
    bind: nonEmpty,
    port,
  }),
  /**
   * Contributed by the remote element (remote DESIGN §11). Foundation §2.3's
   * three keys — `bind`, `port`, `hostnameHint` — are the first three entries of
   * that schema and keep the exact meaning and defaults they had while foundation
   * shipped them alone; `bind` is additionally narrowed to the literal
   * `"tailscale"`, because a config-editable bind address would be a hole through
   * architecture D5. The shape lives in `src/modules/remote/config.ts` so the
   * element owns it, and is registered from here for the same reason `runner` and
   * `orchestrator` are — one namespace, one contribution.
   */
  remote: remoteConfigSchema,
  modules: z.strictObject({
    remote: z.strictObject({ enabled: z.boolean() }),
    orchestrator: z.strictObject({ enabled: z.boolean() }),
  }),
  /**
   * Contributed by the runner element (runner DESIGN §12). Foundation §2.3's
   * three keys are the first three entries of that schema; the shape itself
   * lives in `src/modules/runner/config.ts` so the element owns it, and is
   * registered from here for the same reason `orchestrator` is — one namespace,
   * one contribution.
   */
  runner: runnerConfigSchema,
  projects: z.strictObject({
    /** `null` = `%USERPROFILE%\Documents\AgentManager\projects`. */
    root: nonEmpty.nullable(),
    /** `null` = `<dataRoot>\worktrees`. */
    worktreesRoot: nonEmpty.nullable(),
    /** `null` = `[ %USERPROFILE%, projects.root ]`. */
    browseRoots: z.array(nonEmpty).nullable(),
  }),
  /** Added to every agent child process environment; `null` means "compute the default". */
  agentEnv: z.record(nonEmpty, z.string().nullable()),
  policy: z.strictObject({
    allowPermissionElevation: z.boolean(),
    globalDeny: z.array(nonEmpty),
  }),
  auth: z.strictObject({ mode: z.enum(['subscription', 'env', 'bedrock']) }),
  secrets: z.strictObject({ provider: z.enum(['auto', 'dpapi', 'keyfile', 'env']) }),
  logging: z.strictObject({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
    maxFileMB: z.number().positive(),
    maxFiles: z.number().int().min(1),
    retentionDays: z.number().int().min(1),
  }),
  service: z.strictObject({
    autostart: z.boolean(),
    shutdownGraceSeconds: z.number().int().min(0),
  }),
  retention: z.strictObject({
    eventDays: z.number().int().min(1),
    eventMaxRows: z.number().int().min(1),
    /** Per-project defaults, not a global cap (DESIGN §2.3). */
    transcriptDays: z.number().int().min(1),
    transcriptCapMb: z.number().positive(),
  }),
  /**
   * Contributed by the orchestrator element (orchestrator DESIGN §12). Its
   * `notify.enabled` key is foundation §2.3's third edition lever and keeps
   * exactly the meaning and default it had while foundation shipped it alone;
   * the shape itself lives in `src/modules/orchestrator/config.ts` so the
   * element owns it, and is registered from here for the same reason `runner`
   * is — one namespace, one contribution.
   */
  orchestrator: orchestratorConfigSchema,
} as const;

/**
 * The frozen, typed configuration every module receives on its context
 * (DESIGN §2.4). Inferred from the shape above rather than hand-written, so the
 * type cannot drift from the schema the loader validates against.
 */
export type AppConfig = z.infer<z.ZodObject<typeof foundationConfigShape>>;

/**
 * Shipped defaults, namespace by namespace. Mirrors `config/defaults.json`.
 *
 * `orchestrator.notify.enabled` defaults to `false` and is turned on by
 * `edition.home.json`: outbound push from a machine is a policy decision, so the
 * unconfigured value is the closed one.
 */
const foundationDefaults: { readonly [K in keyof typeof foundationConfigShape]: AppConfig[K] } = {
  edition: 'work',
  dataRoot: null,
  library: { root: null, watch: true },
  http: { bind: '127.0.0.1', port: 7477 },
  remote: REMOTE_CONFIG_DEFAULTS,
  modules: { remote: { enabled: false }, orchestrator: { enabled: true } },
  runner: RUNNER_CONFIG_DEFAULTS,
  projects: { root: null, worktreesRoot: null, browseRoots: null },
  agentEnv: {
    // Auto-memory is read regardless of settingSources, so it is disabled explicitly.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    // `null` = `<dataRoot>\state\claude-config`; never the user's own config dir.
    CLAUDE_CONFIG_DIR: null,
  },
  policy: { allowPermissionElevation: true, globalDeny: [] },
  auth: { mode: 'subscription' },
  secrets: { provider: 'auto' },
  logging: { level: 'info', maxFileMB: 10, maxFiles: 10, retentionDays: 14 },
  service: { autostart: false, shutdownGraceSeconds: 20 },
  retention: {
    eventDays: 30,
    eventMaxRows: 200000,
    transcriptDays: 90,
    transcriptCapMb: 500,
  },
  orchestrator: ORCHESTRATOR_CONFIG_DEFAULTS,
};

/**
 * The message DESIGN §2.2's rejection produces. Exported so the boundary suite
 * (M11) can pin it: "Edition is not merely a set of defaults the user can undo —
 * it is an invariant enforced at validation *and* at bind time".
 */
export const WORK_EDITION_REMOTE_MESSAGE =
  'edition "work" cannot enable the remote module: the work edition never starts a remote ' +
  'listener (foundation DESIGN.md §2.2, architecture D6). Set modules.remote.enabled to false, ' +
  'or set edition to "home".';

export const workEditionRemoteInvariant: ConfigInvariant = {
  id: 'work-edition-forbids-remote',
  check: (config) => {
    const modules = config['modules'];
    if (config['edition'] !== 'work' || typeof modules !== 'object' || modules === null) return [];
    const remote = (modules as Record<string, unknown>)['remote'];
    if (typeof remote !== 'object' || remote === null) return [];
    if ((remote as Record<string, unknown>)['enabled'] !== true) return [];
    return [{ path: ['modules', 'remote', 'enabled'], message: WORK_EDITION_REMOTE_MESSAGE }];
  },
};

/** The v1 registry: every §2.3 namespace plus the cross-key edition invariant. */
export function createFoundationRegistry(): ConfigSchemaRegistry {
  const registry = new ConfigSchemaRegistry();
  for (const namespace of Object.keys(
    foundationConfigShape,
  ) as (keyof typeof foundationConfigShape)[]) {
    registry.register({
      namespace,
      schema: foundationConfigShape[namespace],
      defaults: foundationDefaults[namespace],
      owner:
        namespace === 'orchestrator' || namespace === 'runner' || namespace === 'remote'
          ? namespace
          : 'foundation',
    });
  }
  registry.registerInvariant(workEditionRemoteInvariant);
  return registry;
}
