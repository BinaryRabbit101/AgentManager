/**
 * `GET /api/config/effective` (DESIGN §2.4).
 *
 * > "Returns the merged config with a `source` annotation per key (which layer
 * > won) and secrets redacted. This is how the UI knows the edition and hides
 * > remote controls, and how support diagnostics work."
 *
 * ## Why redaction is belt *and* braces here
 *
 * Configuration is not supposed to hold credentials — they live in the
 * `SecretStore` (§3.1) and are referenced by key name (§3.3). But `agentEnv` is
 * an open record injected into every agent process, `policy.globalDeny` holds
 * arbitrary strings, and a support diagnostic is exactly the payload someone
 * pastes into a chat window. So the response goes through all three of §5.4's
 * mechanisms before it leaves:
 *
 * 1. key-path redaction ({@link redactValue}) — `agentEnv.GITHUB_TOKEN` becomes
 *    `[redacted]` whatever its value looks like;
 * 2. per-string scrubbing of `sk-ant-…` and `Bearer …`, which catches a secret
 *    parked under an innocent key name;
 * 3. a final {@link scrubText} pass over the serialised body, so anything either
 *    earlier pass reached around — a key added later, a nested structure — still
 *    cannot ship a credential.
 *
 * Sources are safe by construction: an origin is a file path or a variable
 * *name* (`env:AGENTMANAGER_HTTP_PORT`), never a value.
 */
import type { AppConfig } from '../../config/index.js';
import { CONFIG_LAYERS } from '../../config/index.js';
import { REDACTED, isSecretKey, redactValue, scrubText } from '../../logging/index.js';
import type { RouteDefinition } from '../../modules/types.js';
import type { HttpDeps } from '../deps.js';

/**
 * Top-level namespaces the key-path rules would redact wholesale, but which
 * hold no credential at all: `auth` is `{mode}` and `secrets` is `{provider}`
 * (§2.3). Blanking them would take the two facts a support diagnostic most
 * wants — which auth mode and which secret provider are in force — out of the
 * one endpoint that exists to report them. Their *children* still go through
 * the ordinary rules, so a credential added under either is still caught.
 */
const STRUCTURAL_NAMESPACES: ReadonlySet<string> = new Set(['auth', 'secrets']);

/** Key-path redaction over the config, with the exception above. */
function redactConfig(config: AppConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = !STRUCTURAL_NAMESPACES.has(key) && isSecretKey(key) ? REDACTED : redactValue(value);
  }
  return out;
}

/**
 * Strips the value out of a `cli:--set <key>=<value>` origin.
 *
 * The loader records the whole flag as the origin, which is right for the
 * per-key error report it was built for and wrong the moment it is published:
 * `--set agentEnv.SUPPORT_TOKEN=…` would ship the credential in the *attribution*
 * even though the value itself is redacted. The key alone says everything the
 * annotation needs to say. File paths, `env:VAR_NAME` and `registry:<owner>`
 * origins name no values and pass through untouched.
 */
export function sanitiseOrigin(origin: string): string {
  if (!origin.startsWith('cli:')) return origin;
  const equals = origin.indexOf('=');
  return equals === -1 ? origin : origin.slice(0, equals);
}

export interface EffectiveConfigResponse {
  readonly edition: string;
  readonly version: string;
  /** The merged, validated config — redacted (§5.4). */
  readonly config: unknown;
  /** Dotted key → the layer that won it and the concrete thing that set it. */
  readonly sources: Record<string, { readonly layer: string; readonly origin: string }>;
  /** Where the layers were read from; `configFile: null` means none exists. */
  readonly origins: HttpDeps['origins'];
  /** The five layers, lowest precedence first (§2.1) — so a UI can order them. */
  readonly layers: readonly string[];
  readonly redacted: true;
}

export function buildEffectiveConfig(deps: HttpDeps): EffectiveConfigResponse {
  return {
    edition: deps.config.edition,
    version: deps.version,
    config: redactConfig(deps.config),
    sources: Object.fromEntries(
      Object.entries(deps.sources).map(([key, source]) => [
        key,
        { layer: source.layer, origin: sanitiseOrigin(source.origin) },
      ]),
    ),
    origins: deps.origins,
    layers: CONFIG_LAYERS,
    redacted: true,
  };
}

export function createConfigRoutes(deps: HttpDeps): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/api/config/effective',
      description: 'Merged configuration with per-key winning layer; secrets redacted.',
      handler: (_req, res) => {
        const body = JSON.stringify(buildEffectiveConfig(deps)) ?? 'null';
        return res.bytes(
          Buffer.from(scrubText(body), 'utf8'),
          'application/json; charset=utf-8',
          {},
        );
      },
    },
  ];
}
