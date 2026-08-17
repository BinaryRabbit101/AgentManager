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
 * ## `bind` is a keyword, never an address
 *
 * This is the one key in the whole inventory whose *type* is a security control.
 * DESIGN §11: "v1 schema accepts this literal ONLY — an IP literal is rejected,
 * because a config-editable bind address is a hole through D5". A `z.string()`
 * here would let `config.json` move the listener onto the LAN with one edit and
 * no code change, which is precisely the boundary architecture D5 exists to
 * close.
 *
 * The 2026-08-17 amendment to D5 adds a **second mode, not a second form**:
 * `remote.bind` still takes only a keyword — now `"tailscale"` or `"proxy"` —
 * and IP literals stay rejected outright. Proxy mode's address lives under its
 * own key ({@link remoteProxySchema}), where it is one *declared* LAN interface
 * that the listener still proves against the machine's real interfaces at start
 * and immediately before every `listen()`, alongside the peer allowlist that is
 * the core's own control once the tailnet-membership gate has moved to the proxy
 * host. D5's property — the bound address is proven, never taken on trust —
 * therefore holds in both modes; what differs is which fact is proven.
 */
import { z } from 'zod';

const port = z.number().int().min(1).max(65535);
const nonEmpty = z.string().min(1);
const positiveInt = z.number().int().positive();

/** The two keywords `remote.bind` accepts (D5, amended 2026-08-17). */
export const REMOTE_BIND_MODES = ['tailscale', 'proxy'] as const;

/** Which of D5's two bind modes this install uses. */
export type RemoteBindMode = (typeof REMOTE_BIND_MODES)[number];

/** The original mode: bind the local Tailscale interface (§2.1). */
export const REMOTE_BIND_LITERAL: RemoteBindMode = 'tailscale';

/** The amended mode: bind one declared LAN address behind the proxy host. */
export const REMOTE_BIND_PROXY: RemoteBindMode = 'proxy';

/**
 * The refusal a configured bind *address* produces.
 *
 * Names D5 explicitly, because the reader who typed an IP address here was
 * trying to do something reasonable and needs to be told why the product will
 * not do it — not merely that zod disagreed.
 */
export const REMOTE_BIND_MESSAGE =
  'remote.bind accepts only the keywords "tailscale" and "proxy" — never an address. In ' +
  '"tailscale" mode the remote listener binds the Tailscale interface it detects and validates at ' +
  'start-up; in "proxy" mode it binds the single LAN address declared under remote.proxy.bind and ' +
  'answers only the peers named in remote.proxy.allowedPeers. Neither mode takes a bind address ' +
  'from this key, because a config-editable bind address would be a hole through architecture D5 ' +
  '("the remote listener binds only to the Tailscale interface — never LAN or public", amended ' +
  '2026-08-17 to add the proxy mode). Set it to "tailscale" or "proxy".';

/** A dotted-quad IPv4 literal, and nothing else. */
const IPV4_LITERAL =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** True for `0.0.0.0` and the other spellings of "every interface". */
function isWildcardLiteral(address: string): boolean {
  const value = address.trim().toLowerCase();
  return value === '0.0.0.0' || value === '::' || value === '*';
}

/** True for a loopback literal — reachable only from this machine. */
function isLoopbackLiteral(address: string): boolean {
  const value = address.trim().toLowerCase();
  return value === '::1' || value === 'localhost' || value.startsWith('127.');
}

function ipv4(label: string): z.ZodString {
  return z
    .string()
    .regex(IPV4_LITERAL, { error: `${label} must be an IPv4 literal such as "192.168.0.42".` });
}

/**
 * `remote.proxy` — the amended D5 mode's two facts.
 *
 * `bind` is refused here for the two shapes that can never be a single machine
 * interface — a wildcard, which would expose every interface the host has, and
 * loopback, which the proxy host could never reach — so the mistake is caught by
 * `--set` rather than at boot. It is *still* proven against the machine's real
 * interfaces at start and before every `listen()`: this is the cheap early
 * refusal, not the control.
 */
export const remoteProxySchema = z.strictObject({
  /**
   * The one LAN address the listener binds in proxy mode.
   *
   * Declared rather than discovered, because a machine has several LAN addresses
   * and D5's boundary is "one socket, on exactly the interface the owner named" —
   * the same refusal to guess as §2.1 rule 3.
   */
  bind: ipv4('remote.proxy.bind')
    .refine((value) => !isWildcardLiteral(value), {
      error:
        'remote.proxy.bind must name one interface, never a wildcard: binding "0.0.0.0" would ' +
        'expose every interface this machine has, which is the exposure architecture D5 exists ' +
        'to prevent.',
    })
    .refine((value) => !isLoopbackLiteral(value), {
      error:
        'remote.proxy.bind must be a LAN address the proxy host can reach, not loopback. A ' +
        'loopback listener is unreachable from the proxy, so proxy mode would silently never work.',
    }),
  /**
   * The peer IPs whose raw TCP connections this listener answers at all — in
   * practice the household proxy host (the mini-pc).
   *
   * Non-empty, because an empty allowlist is a listener nobody may reach and a
   * reader who wrote `[]` meant something else. The check runs on
   * `req.socket.remoteAddress` **before** bearer auth and before the rate
   * limiter's failure accounting; `X-Forwarded-For` is never consulted.
   */
  allowedPeers: z.array(ipv4('every entry of remote.proxy.allowedPeers')).min(1, {
    error:
      'remote.proxy.allowedPeers must name at least one peer IP — the proxy host that fronts this ' +
      'listener. An empty allowlist refuses every connection, which is never what was meant.',
  }),
});

/** The declared LAN address and peer allowlist of proxy mode. */
export type RemoteProxyConfig = z.infer<typeof remoteProxySchema>;

/** The refusal for `bind: "proxy"` with no `remote.proxy` block. */
export const REMOTE_PROXY_REQUIRED_MESSAGE =
  'remote.bind is "proxy", so remote.proxy is required: proxy mode needs the LAN address to bind ' +
  '(remote.proxy.bind) and the peer IPs it will answer (remote.proxy.allowedPeers). Without both ' +
  'there is no boundary at all — in this mode the tailnet-membership gate lives on the proxy ' +
  'host, and the peer allowlist plus the bearer token are the core’s own controls (architecture ' +
  'D5, amended 2026-08-17).';

/** The refusal for a `remote.proxy` block while the mode is `"tailscale"`. */
export const REMOTE_PROXY_UNEXPECTED_MESSAGE =
  'remote.proxy is set but remote.bind is "tailscale", and the two describe different boundaries. ' +
  'Rather than ignore a security-relevant block the reader clearly meant, this is refused: set ' +
  'remote.bind to "proxy" to use it, or remove remote.proxy to bind the Tailscale interface ' +
  '(architecture D5, amended 2026-08-17).';

/** DESIGN §11, key for key. */
export const remoteConfigSchema = z
  .strictObject({
    /** Foundation §2.3, narrowed to two keywords by DESIGN §11 and D5's amendment. */
    bind: z.enum(REMOTE_BIND_MODES, { error: REMOTE_BIND_MESSAGE }),
    /**
     * Proxy mode's declared LAN address and peer allowlist; `null` in tailscale
     * mode.
     *
     * Required when `bind` is `"proxy"` and refused when it is `"tailscale"`.
     * That is a cross-key rule, so it is a refinement on this namespace rather
     * than two independent keys that are free to disagree.
     */
    proxy: remoteProxySchema.nullable(),
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
  })
  // The cross-key half of D5's amendment. Both directions are refusals rather
  // than one refusal and one silent ignore: a `remote.proxy` block that is
  // quietly unused reads to its author as a boundary that is in force.
  .superRefine((value, ctx) => {
    if (value.bind === REMOTE_BIND_PROXY && value.proxy === null) {
      ctx.addIssue({ code: 'custom', path: ['proxy'], message: REMOTE_PROXY_REQUIRED_MESSAGE });
    }
    if (value.bind === REMOTE_BIND_LITERAL && value.proxy !== null) {
      ctx.addIssue({ code: 'custom', path: ['proxy'], message: REMOTE_PROXY_UNEXPECTED_MESSAGE });
    }
  });

/** The frozen shape the module reads off `ctx.config.remote`. */
export type RemoteConfig = z.infer<typeof remoteConfigSchema>;

/** DESIGN §11's defaults, mirrored by `config/defaults.json` (layer 1). */
export const REMOTE_CONFIG_DEFAULTS: RemoteConfig = {
  bind: REMOTE_BIND_LITERAL,
  // Tailscale mode is the shipped default, so there is no proxy block to honour.
  proxy: null,
  port: 7478,
  hostnameHint: null,
  detect: { cli: null, pollMs: 30_000, retryMaxMs: 120_000 },
  token: { ttlDays: 90, maxActive: 10 },
  auth: { maxFailures: 10, failWindowMs: 300_000, blockMs: 900_000 },
  stream: { ticketTtlSec: 30, heartbeatMs: 30_000 },
  agentAccess: { ttlHours: 72 },
  browseRateLimitPerMin: 60,
};
