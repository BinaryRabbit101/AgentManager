/**
 * Integrations → `mcpServers` (roster DESIGN §10, IMPLEMENTATION M6).
 *
 * §10's decision: the roster schema carries per-agent MCP server configs,
 * because "an email-responder agent is defined by its mailbox access as much as
 * by its persona — the integration belongs to the identity, not to the project".
 * The schema stores **references** to credentials and never values; this module
 * is where those references become values, and it is the second of the two
 * authorized `.reveal()` sites foundation §3.2 permits (the first being the env
 * merge next door, and "any third call site is a review failure, not a
 * judgement call").
 *
 * Four rules the code enforces rather than trusts:
 *
 * 1. **An unresolved ref fails the launch.** §10: "an unresolved ref fails the
 *    launch with a clear 'agent Priya needs secret `mcp.gmail.token`' error
 *    rather than starting a session whose tools will silently 401." That is a
 *    thrown {@link SessionCompileError}, not a diagnostic, because a diagnostic
 *    is something a caller may choose to ignore and this is not.
 * 2. **`${VAR}` is not expanded by the SDK.** It works in `.mcp.json` and not in
 *    the programmatic option (§10), so nothing here relies on it and nothing
 *    emits it.
 * 3. **`env` replaces rather than merges.** The session environment is spread
 *    into a stdio server's `env` whenever the integration declares one at all —
 *    losing `PATH` "breaks stdio servers in ways that look like MCP bugs" (§10).
 *    When the integration declares no `env`, the key is omitted entirely so that
 *    whatever inheritance the launcher does is left intact.
 * 4. **`http` only.** `streamable-http` is a `.mcp.json` alias the programmatic
 *    option does not accept (§10, confirmed SDK-NOTES §3); the schema makes it
 *    unrepresentable and this module never invents it.
 */
import type { SecretResolver } from '../../secrets/index.js';

import type { Diagnostic } from './contracts.js';
import type { AgentDefinition, IntegrationConfig, SecretValue } from './schema.js';
import { isSecretRef } from './schema.js';
import { SessionCompileError } from './sessionOptions.js';

// ---------------------------------------------------------------------------
// The compiled shapes
// ---------------------------------------------------------------------------

/**
 * The three `McpServerConfig` members §10 compiles to, restated structurally.
 *
 * Structural for the reason `skills.ts` gives: SDK type imports live in
 * `sessionOptions.ts` and `compileSession.ts` (§13). These are assignable to the
 * SDK's declarations by shape, so the typecheck still catches a version that
 * moves them — `compileSession` assigns the record straight onto
 * `Options.mcpServers`.
 */
export interface CompiledStdioServer {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface CompiledSseServer {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}
export interface CompiledHttpServer {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}
export type CompiledMcpServer = CompiledStdioServer | CompiledSseServer | CompiledHttpServer;

export interface CompiledIntegrations {
  readonly servers: Record<string, CompiledMcpServer>;
  readonly diagnostics: readonly Diagnostic[];
}

// ---------------------------------------------------------------------------
// Tool naming (§10)
// ---------------------------------------------------------------------------

/** `gmail` → `mcp__gmail__`. The prefix every permission rule for that server
 *  starts with, and the reason the schema forbids `__` inside a name. */
export function mcpToolPrefix(server: string): string {
  return `mcp__${server}__`;
}

/**
 * §10's validator warning.
 *
 * "`acceptEdits` does **not** auto-approve MCP tools — an integration agent that
 * should not prompt on every mailbox read needs explicit `mcp__gmail__*` entries
 * in `allow`. Roster's validator warns when an agent declares an integration but
 * has no matching allow rule, because the failure mode otherwise is a session
 * that stalls on a permission prompt nobody expected."
 *
 * `ask` counts as a match: an agent whose mailbox reads are deliberately gated
 * has answered the question the warning asks, and warning about it anyway would
 * train the owner to ignore the warning.
 */
export function validateIntegrationAllowRules(
  definition: Pick<AgentDefinition, 'id' | 'integrations' | 'permissions'>,
): Diagnostic[] {
  const integrations = definition.integrations;
  if (integrations === undefined) return [];

  const rules = [...(definition.permissions?.allow ?? []), ...(definition.permissions?.ask ?? [])];
  const diagnostics: Diagnostic[] = [];

  for (const name of Object.keys(integrations)) {
    const prefix = mcpToolPrefix(name);
    if (rules.some((rule) => rule.startsWith(prefix))) continue;
    diagnostics.push({
      level: 'warn',
      code: 'roster.integration.no-allow-rule',
      message:
        `integration "${name}" is declared but no permission rule mentions ${prefix}*; ` +
        'acceptEdits does not auto-approve MCP tools, so every call to this server will stop ' +
        'the session on a permission prompt (DESIGN §10)',
      agentId: definition.id,
      path: `integrations.${name}`,
    });
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Credential references (§10, the API shape)
// ---------------------------------------------------------------------------

/** One `{ secretRef }` an integration carries, and where it sits. */
export interface IntegrationSecretRef {
  readonly integration: string;
  /** `env` for stdio, `headers` for sse/http — the two credential-bearing maps. */
  readonly kind: 'env' | 'headers';
  /** The variable or header name. */
  readonly key: string;
  readonly secretRef: string;
  /** Dotted path into the definition, for a diagnostic or a UI deep-link. */
  readonly path: string;
}

function credentialMap(
  config: IntegrationConfig,
): { readonly kind: 'env' | 'headers'; readonly values: Record<string, SecretValue> } | undefined {
  if (config.transport === 'stdio') {
    return config.env === undefined ? undefined : { kind: 'env', values: config.env };
  }
  return config.headers === undefined ? undefined : { kind: 'headers', values: config.headers };
}

/** Every `secretRef` in the agent's integrations, in a stable order. */
export function integrationSecretRefs(
  definition: Pick<AgentDefinition, 'integrations'>,
): IntegrationSecretRef[] {
  const out: IntegrationSecretRef[] = [];
  for (const [integration, config] of Object.entries(definition.integrations ?? {})) {
    const map = credentialMap(config);
    if (map === undefined) continue;
    for (const [key, value] of Object.entries(map.values)) {
      if (!isSecretRef(value)) continue;
      out.push({
        integration,
        kind: map.kind,
        key,
        secretRef: value.secretRef,
        path: `integrations.${integration}.${map.kind}.${key}`,
      });
    }
  }
  return out;
}

/**
 * One credential's resolution state, as the API returns it (§10).
 *
 * "The API returns `{ secretRef, resolved: true|false }` so the UI can show a
 * 'needs credential' badge on the card." There is no third field carrying the
 * value, and there is no code path that could add one: this shape is built from
 * a `has`-style probe, never from a `reveal()`.
 */
export interface IntegrationCredentialStatus extends IntegrationSecretRef {
  readonly resolved: boolean;
}

/** Resolve every ref to a boolean — and to nothing else. */
export async function integrationCredentialStatus(
  definition: Pick<AgentDefinition, 'integrations'>,
  secrets: SecretResolver,
): Promise<IntegrationCredentialStatus[]> {
  const refs = integrationSecretRefs(definition);
  const out: IntegrationCredentialStatus[] = [];
  for (const ref of refs) {
    const secret = await secrets.get(ref.secretRef);
    // Presence only. The `Secret` is dropped here without being revealed, which
    // is what keeps this function usable from the API layer at all.
    out.push({ ...ref, resolved: secret !== undefined });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export interface CompileIntegrationsInput {
  readonly agentId: string;
  /** Names the agent in the failure message §10 specifies. */
  readonly agentName: string;
  readonly integrations: AgentDefinition['integrations'];
  readonly secrets: SecretResolver;
  /**
   * The merged session environment (§13). Spread into a stdio server's `env`
   * when it declares one, so the child keeps `PATH`.
   */
  readonly sessionEnv?: Readonly<Record<string, string>> | undefined;
}

/**
 * Resolve one credential map.
 *
 * @throws {SessionCompileError} naming the agent and the ref (§10).
 */
async function resolveValues(
  values: Record<string, SecretValue>,
  input: CompileIntegrationsInput,
  integration: string,
  kind: 'env' | 'headers',
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!isSecretRef(value)) {
      out[key] = value;
      continue;
    }
    const secret = await input.secrets.get(value.secretRef);
    if (secret === undefined) {
      throw new SessionCompileError(
        `agent ${input.agentName} needs secret \`${value.secretRef}\` for integration ` +
          `"${integration}" (${kind}.${key}), and it is not in the secret store`,
        [
          {
            level: 'error',
            code: 'roster.secret.unresolved',
            message: `secret \`${value.secretRef}\` did not resolve`,
            agentId: input.agentId,
            path: `integrations.${integration}.${kind}.${key}`,
          },
        ],
      );
    }
    // The authorized `.reveal()` site (foundation §3.2, roster DESIGN §10).
    out[key] = secret.reveal();
  }
  return out;
}

/**
 * `integrations` → `options.mcpServers`, with every `secretRef` resolved.
 *
 * @throws {SessionCompileError} when any ref does not resolve. No session is
 * started: §10's whole point is that a 401 three turns in is a worse failure
 * than a refusal at launch.
 */
export async function compileIntegrations(
  input: CompileIntegrationsInput,
): Promise<CompiledIntegrations> {
  const servers: Record<string, CompiledMcpServer> = {};
  const diagnostics: Diagnostic[] = [];

  for (const [name, config] of Object.entries(input.integrations ?? {})) {
    if (config.transport === 'stdio') {
      const server: CompiledStdioServer = { type: 'stdio', command: config.command };
      if (config.args !== undefined) server.args = [...config.args];
      if (config.env !== undefined) {
        const resolved = await resolveValues(config.env, input, name, 'env');
        // §10's PATH guard: the SDK's `env` replaces rather than merges, so a
        // server that declares one variable would otherwise lose every other.
        server.env = { ...(input.sessionEnv ?? {}), ...resolved };
      }
      servers[name] = server;
      continue;
    }

    const headers =
      config.headers === undefined
        ? undefined
        : await resolveValues(config.headers, input, name, 'headers');

    if (config.transport === 'sse') {
      const server: CompiledSseServer = { type: 'sse', url: config.url };
      if (headers !== undefined) server.headers = headers;
      servers[name] = server;
      continue;
    }

    const server: CompiledHttpServer = { type: 'http', url: config.url };
    if (headers !== undefined) server.headers = headers;
    servers[name] = server;
  }

  return { servers, diagnostics };
}
