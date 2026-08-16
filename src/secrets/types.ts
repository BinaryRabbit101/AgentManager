/**
 * The secrets contract of DESIGN §3.2.
 *
 * Every other element codes against {@link SecretResolver} — the read-only face
 * — so no feature module holds a handle that can `set` or `delete`. The full
 * {@link SecretStore} exists for the settings UI, the CLI and the install
 * scripts, and for nothing else.
 */
import type { Secret } from './secret.js';

/**
 * A key in the §3.3 namespace: dot-separated segments of letters, digits and
 * hyphens (`claude.oauthToken`, `mcp.gmail.token`, `project.<id>.<name>`).
 *
 * Underscores are deliberately excluded: the `env` provider maps a key onto an
 * environment variable name by turning `.` into `__`, and that mapping is only
 * reversible while the key itself carries no underscores.
 */
export type SecretKey = string;

/** The providers of §3.1. `auto` is a *selection* input, never a resolved provider. */
export type SecretProvider = 'dpapi' | 'keyfile' | 'env';

/** The `secrets.provider` config value. `auto` means dpapi-with-keyfile-fallback. */
export type SecretProviderSelection = 'auto' | SecretProvider;

/** One row of {@link SecretStore.list} — metadata only, never plaintext. */
export interface SecretListEntry {
  readonly key: SecretKey;
  /** ISO-8601 UTC, as every timestamp in this project is. */
  readonly setAt: string;
  /** The last four characters of the value, for human recognition. */
  readonly preview: string;
}

/** DESIGN §3.2. */
export interface SecretStore {
  get(key: SecretKey): Promise<Secret | undefined>;
  set(key: SecretKey, value: string): Promise<void>;
  delete(key: SecretKey): Promise<void>;
  list(): Promise<SecretListEntry[]>;
  readonly provider: SecretProvider;
}

/** The read-only face handed to consumers that resolve refs but must never write. */
export type SecretResolver = Pick<SecretStore, 'get'>;

/**
 * Why the store is running with weaker at-rest protection than it asked for.
 *
 * Present only when `auto` fell back to `keyfile` because the native binding
 * would not load (§3.1). An install that *chose* `keyfile` is not degraded — it
 * got what it configured — so this field is the fallback signal specifically,
 * not a general "keyfile is weaker" note.
 */
export interface SecretsDegradation {
  readonly provider: 'keyfile';
  /** What was asked for before the fallback. */
  readonly requested: SecretProviderSelection;
  /** The binding failure, already stringified — never an Error with a stack in a health payload. */
  readonly reason: string;
  /** ISO-8601 UTC instant the fallback happened. */
  readonly since: string;
}

/**
 * A condition the health system surfaces to the UI.
 *
 * Foundation's `HealthReport` (§6.1) is M7's; this is the smallest shape that
 * milestone can lift verbatim into it, and it keeps secrets from depending on a
 * module system that does not exist yet.
 */
export interface HealthCondition {
  /** Stable identifier, so the UI can dismiss/track a condition across restarts. */
  readonly id: string;
  readonly level: 'warn';
  readonly message: string;
}

/** What `/api/health` reads from the secrets module. */
export interface SecretsHealth {
  readonly status: 'ok' | 'degraded';
  readonly provider: SecretProvider;
  readonly degraded?: SecretsDegradation;
  readonly conditions: readonly HealthCondition[];
}

/** A {@link SecretStore} plus the operational facts foundation needs from it. */
export interface SecretStoreHandle extends SecretStore {
  /** Set only when `auto` fell back to `keyfile`; see {@link SecretsDegradation}. */
  readonly degraded?: SecretsDegradation;
  /** The health contribution of §3.1, read by `/api/health`. */
  health(): SecretsHealth;
}

/** A function returning the current instant; injectable so tests are not time-dependent. */
export type Clock = () => Date;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * The minimal logging shape the secret store accepts.
 *
 * `secrets` is a critical module (§6.2) and is also driven from the CLI and
 * install scripts, so it takes a plain callback rather than importing the pino
 * logger; the composition root adapts `ctx.logger` to it.
 */
export type LogFn = (level: LogLevel, msg: string, data?: Record<string, unknown>) => void;

/** Discards everything. The default when no sink is supplied. */
export const silentLog: LogFn = () => {};
