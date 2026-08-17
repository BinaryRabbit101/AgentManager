/**
 * Remote's configuration sub-schema (remote DESIGN §11), contributed through
 * foundation §2.1's registry.
 *
 * **How the contribution reaches the loader.** Exactly the arrangement runner
 * established in `src/modules/runner/config.ts` and orchestrator repeated:
 * foundation's `ConfigSchemaRegistry` keys a contribution by *namespace* and
 * refuses a second claim on one, and the `remote` namespace is already claimed —
 * foundation registered it while this module did not exist, shipping §2.3's three
 * keys (`bind`, `port`, `hostnameHint`). So the schema and its defaults live
 * **here**, owned by this element, and `src/config/schema.ts` composes them into
 * the single `remote` contribution. Nothing about the five layers, the env
 * mapping, or validation changes, and the three original keys keep the exact
 * meaning and defaults they already had.
 *
 * `modules.remote.enabled` stays where foundation §2.3 put it and is **not**
 * duplicated here. `remote.enabled` — the runtime kill switch — is deliberately
 * absent: DESIGN §5 puts it in `settings`, because it is a toggle the UI owns and
 * a config-file rewrite must not clobber it.
 *
 * ## `bind` is a literal, not a string
 *
 * This is the one key in the whole inventory whose *type* is a security control.
 * DESIGN §11: "v1 schema accepts this literal ONLY — an IP literal is rejected,
 * because a config-editable bind address is a hole through D5". A `z.string()`
 * here would let `config.json` move the listener onto the LAN with one edit and
 * no code change, which is precisely the boundary architecture D5 exists to
 * close. The address the listener binds is *detected and validated* (§2.1), never
 * configured.
 */
import { z } from 'zod';

const port = z.number().int().min(1).max(65535);
const nonEmpty = z.string().min(1);
const positiveInt = z.number().int().positive();

/** The only value `remote.bind` accepts. */
export const REMOTE_BIND_LITERAL = 'tailscale';

/**
 * The refusal a configured bind address produces.
 *
 * Names D5 explicitly, because the reader who typed an IP address here was
 * trying to do something reasonable and needs to be told why the product will
 * not do it — not merely that zod disagreed.
 */
export const REMOTE_BIND_MESSAGE =
  'remote.bind accepts only the literal "tailscale". The remote listener binds the Tailscale ' +
  'interface it detects and validates at start-up, and never an address from configuration: a ' +
  'config-editable bind address would be a hole through architecture D5 ("the remote listener ' +
  'binds only to the Tailscale interface — never LAN or public"). Remove the value, or set it to ' +
  '"tailscale".';

/** DESIGN §11, key for key. */
export const remoteConfigSchema = z.strictObject({
  /** Foundation §2.3, narrowed to a literal by DESIGN §11. */
  bind: z.literal(REMOTE_BIND_LITERAL, { error: REMOTE_BIND_MESSAGE }),
  /** Foundation §2.3. */
  port,
  /**
   * Foundation §2.3. The MagicDNS name used for the client URL, the QR payload
   * and the `Host` allowlist (§9.2 #8) when the CLI cannot supply one.
   */
  hostnameHint: nonEmpty.nullable(),
  detect: z.strictObject({
    /**
     * An explicit `tailscale.exe`. `null` searches
     * `C:\Program Files\Tailscale\tailscale.exe` then `PATH` (§2.2).
     */
    cli: nonEmpty.nullable(),
    /** How often a bound listener re-validates its address (§2.3). */
    pollMs: positiveInt,
    /** The ceiling the retry backoff doubles up to (§2.3). */
    retryMaxMs: positiveInt,
  }),
  token: z.strictObject({
    /** `null` = never expires — allowed, and flagged in the UI (§4.4). */
    ttlDays: positiveInt.nullable(),
    /** A hygiene cap on forgotten devices, not a security control (§4.2). */
    maxActive: positiveInt,
  }),
  auth: z.strictObject({
    maxFailures: positiveInt,
    failWindowMs: positiveInt,
    blockMs: positiveInt,
  }),
  stream: z.strictObject({
    ticketTtlSec: positiveInt,
    heartbeatMs: positiveInt,
  }),
  agentAccess: z.strictObject({
    /** The sliding grant window of §6.3. */
    ttlHours: positiveInt,
  }),
  /** The per-token `fs/browse` bucket of §3.3. */
  browseRateLimitPerMin: positiveInt,
});

/** The frozen shape the module reads off `ctx.config.remote`. */
export type RemoteConfig = z.infer<typeof remoteConfigSchema>;

/** DESIGN §11's defaults, mirrored by `config/defaults.json` (layer 1). */
export const REMOTE_CONFIG_DEFAULTS: RemoteConfig = {
  bind: REMOTE_BIND_LITERAL,
  port: 7478,
  hostnameHint: null,
  detect: { cli: null, pollMs: 30_000, retryMaxMs: 120_000 },
  token: { ttlDays: 90, maxActive: 10 },
  auth: { maxFailures: 10, failWindowMs: 300_000, blockMs: 900_000 },
  stream: { ticketTtlSec: 30, heartbeatMs: 30_000 },
  agentAccess: { ttlHours: 72 },
  browseRateLimitPerMin: 60,
};
