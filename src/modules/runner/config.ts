/**
 * The runner's configuration sub-schema (runner DESIGN §12).
 *
 * Three of these keys — `maxConcurrent`, `queueLimit`, `defaultModel` — were
 * already pinned by foundation §2.3; the rest is this element's, "contributed
 * through foundation §2.1's composition mechanism".
 *
 * **How the contribution reaches the loader, and why it is not a
 * `registry.register` call.** Foundation's {@link ConfigSchemaRegistry} keys a
 * contribution by *namespace* and refuses a second claim on one, and the
 * `runner` namespace is already claimed by foundation (it ships those three
 * keys, and `config/defaults.json` documents them). Two contributions to one
 * namespace would need a merge rule foundation has not defined. So the schema
 * and its defaults live **here**, owned by this element, and
 * `src/config/schema.ts` composes them into the single `runner` contribution —
 * the same arrangement foundation already uses for `orchestrator` ("registered
 * by foundation until that module exists"), with the difference that the shape
 * itself is this file rather than a copy inside foundation's. Nothing about the
 * five layers, the env mapping, or validation changes.
 *
 * Every bound below is a real refusal rather than decoration: an out-of-range
 * value is a fatal validation error naming the key, because a runner that
 * silently clamps a mistyped `maxConcurrent: 40` to 8 is a runner that saturates
 * the owner's shared rate-limit window and reports nothing (D2, §6.1).
 */
import { z } from 'zod';

/**
 * The upper bound §6.1 pins for the runtime override
 * (`PUT /api/runner/capacity` "clamped to 1..8"), applied to the configured
 * value as a hard validation bound. The two must be the same number, or the
 * config file could set a cap the UI is forbidden to ask for.
 */
export const MAX_CONCURRENT_LIMIT = 8;

const positiveInt = z.number().int().positive();

/** DESIGN §12, key for key. */
export const runnerConfigSchema = z.strictObject({
  /** Sum-of-weights cap (§6.1). `edition.work.json` lowers it to 1. */
  maxConcurrent: z.number().int().min(1).max(MAX_CONCURRENT_LIMIT),
  /** A `startSession` past this is refused `queue_full` with no row (§6.2). */
  queueLimit: z.number().int().min(0),
  /** Only a fallback — roster's definitions carry a model (§12). */
  defaultModel: z.string().min(1),
  /** No `system/init` by then → `failed` / `start_timeout` (§3.2). */
  startTimeoutMs: positiveInt,
  /** 20 min with no SDK message of any kind → `failed` / `idle_timeout` (§12). */
  idleTimeoutMs: positiveInt,
  /** The SDK has no session timeout; this is ours (§12). */
  wallClockMaxMinutes: positiveInt,
  /** Must fit inside `service.shutdownGraceSeconds` (§9.1). */
  gracefulInterruptMs: positiveInt,
  /** How long a session may sit `queued` on a retryable workspace refusal (§3.2). */
  workspaceWaitMinutes: positiveInt,
  /** A queue entry older than this becomes `interrupted` / `stale_queue` on boot (§9.2). */
  queueStaleHours: positiveInt,
  question: z.strictObject({
    /** Stage 1 of the bridge: `canUseTool` stays pending this long (§5.4). */
    holdMs: positiveInt,
    /** Orchestrator's sweep reads this; runner owns the key (§5.4). */
    expireHours: positiveInt,
  }),
  transcript: z.strictObject({
    /** fsync every N lines (§8.2). */
    flushLines: positiveInt,
    /** …or after this long, whichever comes first (§8.2). */
    flushMs: positiveInt,
    /** Hard per-session cap; the writer stops rather than filling the disk (§8.2). */
    maxMb: z.number().positive(),
    /** Ceiling on `?tail=<bytes>` (§11.1). */
    maxTailBytes: positiveInt,
  }),
  rateLimit: z.strictObject({
    /** First cool-down after an observed rate limit (§6.4). */
    cooldownMs: positiveInt,
    /** …doubling up to this (§6.4). */
    maxCooldownMs: positiveInt,
  }),
});

/** The frozen shape modules read off `ctx.config.runner`. */
export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

/** DESIGN §12's defaults, mirrored by `config/defaults.json` (layer 1). */
export const RUNNER_CONFIG_DEFAULTS: RunnerConfig = {
  maxConcurrent: 2,
  queueLimit: 50,
  defaultModel: 'sonnet',
  startTimeoutMs: 90_000,
  idleTimeoutMs: 1_200_000,
  wallClockMaxMinutes: 120,
  gracefulInterruptMs: 10_000,
  workspaceWaitMinutes: 60,
  queueStaleHours: 24,
  question: { holdMs: 900_000, expireHours: 24 },
  transcript: { flushLines: 50, flushMs: 2000, maxMb: 512, maxTailBytes: 1_048_576 },
  rateLimit: { cooldownMs: 300_000, maxCooldownMs: 1_800_000 },
};

/**
 * `?tail=` with no byte count (§11.1: "default 1 MB, 64 KB when unspecified").
 *
 * The two numbers answer different questions — this one is "how much does the
 * session view need to render the end of a transcript", `maxTailBytes` is "how
 * much may a client ask for at once" — so only the ceiling is configurable.
 */
export const DEFAULT_TAIL_BYTES = 65_536;
