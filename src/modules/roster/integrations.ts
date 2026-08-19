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
import type { AgentDefinition, IntegrationConfig, Integrations, SecretValue } from './schema.js';
import { isConnectorRef, isSecretRef } from './schema.js';
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
// Connector references (§10.3, WO3)
// ---------------------------------------------------------------------------

/**
 * "What is behind connector id X", and nothing else.
 *
 * The one seam between an agent's `{ connector: "gmail" }` and the library
 * folder that defines it. Everything that reads an integration goes through
 * {@link resolveIntegrations} first, so there is no path in the element where a
 * ref reaches secret resolution, `mcpServers`, or a preflight row unresolved.
 *
 * `undefined` from the lookup means the id is not in the library *right now* —
 * a deleted connector, a `git pull` that dropped one, a typo in a hand-edited
 * `agent.json`. That is a **dangling ref**, and every consumer treats it as a
 * refusal rather than as an absent integration: a launch that quietly mounted
 * one fewer server is a session whose tools are missing for no stated reason.
 */
export type ConnectorLookup = (id: string) => IntegrationConfig | undefined;

/** One attachment with its definition in hand, whatever it was written as. */
export interface ResolvedIntegration {
  /** The agent-local server name — the record key, and the tool prefix. */
  readonly name: string;
  readonly config: IntegrationConfig;
  /** The library id this came from, absent for an inline config (§10.3). */
  readonly connector?: string | undefined;
}

/** A `{ connector }` whose id the library does not hold. */
export interface DanglingConnectorRef {
  readonly name: string;
  readonly connector: string;
}

export interface ResolvedIntegrations {
  /** Declaration order preserved, so every consumer's rows stay stable. */
  readonly integrations: readonly ResolvedIntegration[];
  readonly dangling: readonly DanglingConnectorRef[];
}

/**
 * Every attachment resolved to a config, plus the refs that did not resolve.
 *
 * Neither throws nor warns: this function reports, and the caller decides what a
 * dangling ref costs — a `SessionCompileError` at launch (`compileIntegrations`),
 * a `missing-connector` chip before one ({@link integrationPreflight}). Both
 * come from this one answer, so the chip and the refusal can never disagree.
 *
 * With no lookup supplied, every ref dangles. That is the honest reading for a
 * caller that has no library to ask — a build without the connector registry
 * cannot resolve `{ connector: "gmail" }`, and treating it as inline-nothing
 * would silently drop the server.
 */
export function resolveIntegrations(
  integrations: Integrations | undefined,
  connectors?: ConnectorLookup,
): ResolvedIntegrations {
  const resolved: ResolvedIntegration[] = [];
  const dangling: DanglingConnectorRef[] = [];

  for (const [name, attachment] of Object.entries(integrations ?? {})) {
    if (!isConnectorRef(attachment)) {
      resolved.push({ name, config: attachment });
      continue;
    }
    const config = connectors?.(attachment.connector);
    if (config === undefined) {
      dangling.push({ name, connector: attachment.connector });
      continue;
    }
    resolved.push({ name, config, connector: attachment.connector });
  }

  return { integrations: resolved, dangling };
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

/**
 * Every `secretRef` in the agent's integrations, in a stable order.
 *
 * Refs are resolved first (§10.3): a library connector's credentials are the
 * referencing agent's credentials, because they are what its launch will
 * resolve. A **dangling** ref contributes nothing — there is no config, so
 * there is nothing to name — and is reported as `missing-connector` by the
 * preflight, which is the projection that exists to say so.
 */
export function integrationSecretRefs(
  definition: Pick<AgentDefinition, 'integrations'>,
  connectors?: ConnectorLookup,
): IntegrationSecretRef[] {
  const out: IntegrationSecretRef[] = [];
  const resolved = resolveIntegrations(definition.integrations, connectors);
  for (const { name: integration, config } of resolved.integrations) {
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
  connectors?: ConnectorLookup,
): Promise<IntegrationCredentialStatus[]> {
  const refs = integrationSecretRefs(definition, connectors);
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
// Preflight (§10, WO6 item 2)
// ---------------------------------------------------------------------------

/** True when this integration authorises the human rather than carrying a key. */
export function isOAuthIntegration(config: IntegrationConfig): boolean {
  return config.transport !== 'stdio' && config.auth === 'oauth';
}

/**
 * The five states Start-work shows per declared integration.
 *
 * | state | means |
 * |---|---|
 * | `ready` | everything this machine can settle before launch is settled |
 * | `needs-auth` | an OAuth grant this build cannot see, or a server the last session reported as `needs-auth`/`failed` |
 * | `missing-secret` | a `secretRef` the store does not hold — the launch will refuse (§10) |
 * | `not-attached` | the task asked for a connector this agent does not declare |
 * | `missing-connector` | a `{ connector }` ref the library does not hold (§10.3) — the launch will refuse, and nothing else about this server is knowable |
 */
export const INTEGRATION_STATES = [
  'ready',
  'needs-auth',
  'missing-secret',
  'not-attached',
  'missing-connector',
] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];

/**
 * One integration as the preflight sees it — **data, never a value**.
 *
 * This is the `{ secretRef, resolved }` projection widened rather than a second
 * one: `credentials` below is literally the same array §10 already specifies,
 * scoped to this server, and everything added is derived from the definition,
 * from booleans, or from a status a session already reported.
 */
export interface IntegrationPreflight {
  readonly integration: string;
  /**
   * The library entry this row was resolved from (§10.3), absent for an inline
   * config — which is what lets the UI say "from the library" and offer the
   * connector page rather than the agent's own editor. Present on a
   * `missing-connector` row too: the id that did not resolve is the one useful
   * thing there is to say about it.
   */
  readonly connector?: string | undefined;
  /** Absent for `not-attached` — there is no declaration to describe. */
  readonly transport?: 'stdio' | 'sse' | 'http' | undefined;
  /** How it authorises: `oauth`, `credentials` (env/headers), or `none`. */
  readonly auth: 'oauth' | 'credentials' | 'none';
  readonly toolPrefix: string;
  readonly state: IntegrationState;
  /** `{ secretRef, resolved }` for this server only (§10). Never a value. */
  readonly credentials: readonly IntegrationCredentialStatus[];
  /** The refs that did not resolve, by name — what `agentmanager secrets set` needs. */
  readonly missingSecretRefs: readonly string[];
  /** True when a task template named it in `requiredIntegrations` (WO5). */
  readonly required: boolean;
  /**
   * The status the most recent session reported for this server, when one is
   * remembered. `undefined` means "nothing has run yet on this build", which is
   * different from "it was fine" and is why the OAuth default below is cautious.
   */
  readonly lastSeenStatus?: string | undefined;
  /** One sentence for the chip's tooltip — the honest reason for `state`. */
  readonly detail: string;
}

export interface IntegrationPreflightInput {
  readonly definition: Pick<AgentDefinition, 'integrations'>;
  readonly secrets: SecretResolver;
  /** WO5's `requiredIntegrations` for the task about to start, when there is one. */
  readonly required?: readonly string[] | undefined;
  /**
   * Server name → the status the last session reported (`connected`, `failed`,
   * `needs-auth`, …), as roster's own `MCP_SERVER_STATUSES` spells them.
   *
   * Supplied by the service from what it heard on `runner.mcp.status`. It is a
   * *memory*, not an authority: the CLI owns the OAuth grant and caches it under
   * `CLAUDE_CONFIG_DIR` in a private shape this element deliberately does not
   * read (see the DESIGN note), so the only honest evidence that an OAuth
   * connector is authorised is that a session on this machine got it connected.
   */
  readonly lastSeen?: Readonly<Record<string, string>> | undefined;
  /**
   * The connector library (§10.3), so a `{ connector }` ref reports the state of
   * what it points at rather than the state of the reference.
   *
   * Absent means no library to ask, and every ref is therefore `missing-connector`
   * — the same "wrong in the alarming direction" stance the missing secret store
   * takes two fields up.
   */
  readonly connectors?: ConnectorLookup | undefined;
}

/**
 * Every declared integration, plus a `not-attached` row per required name the
 * agent does not declare.
 *
 * Ordered as the definition orders them, then the missing required ones — so a
 * chip row is stable across refreshes and the thing that is *wrong* is last,
 * where the eye lands after reading what is right. A dangling `{ connector }`
 * keeps its declared position rather than being sorted to one end: it is the
 * agent's third integration whatever is wrong with it, and a row that moved when
 * a library entry was deleted would look like a different connector.
 */
export async function integrationPreflight(
  input: IntegrationPreflightInput,
): Promise<IntegrationPreflight[]> {
  const declared = input.definition.integrations ?? {};
  const required = new Set(input.required ?? []);
  // Refs first, then everything today's logic already did — on the resolved
  // config, so a library connector is judged exactly as the identical inline
  // one would be (§10.3).
  const resolved = resolveIntegrations(declared, input.connectors);
  const credentials = await integrationCredentialStatus(
    input.definition,
    input.secrets,
    input.connectors,
  );
  const out: IntegrationPreflight[] = [];
  const byName = new Map(resolved.integrations.map((entry) => [entry.name, entry]));
  const danglingByName = new Map(resolved.dangling.map((entry) => [entry.name, entry]));

  for (const name of Object.keys(declared)) {
    const dangling = danglingByName.get(name);
    if (dangling !== undefined) {
      // Outranks everything, `missing-secret` included: §10.3 makes this a
      // launch refusal *and* leaves nothing else knowable — with no config
      // there is no transport, no credential and no auth mode to report, so
      // any other state would be an assertion about a server this build
      // cannot see.
      out.push({
        integration: name,
        connector: dangling.connector,
        auth: 'none',
        toolPrefix: mcpToolPrefix(name),
        state: 'missing-connector',
        credentials: [],
        missingSecretRefs: [],
        required: required.has(name),
        detail:
          `This agent attaches the library connector "${dangling.connector}", and the library ` +
          'does not hold it. Restore it on the connectors page, or replace the reference — a ' +
          'launch that compiles this connector is refused before the session starts.',
      });
      continue;
    }

    const entry = byName.get(name);
    // Unreachable: every declared name is resolved or dangling.
    if (entry === undefined) continue;
    const { config, connector } = entry;
    const mine = credentials.filter((credential) => credential.integration === name);
    const missing = mine.filter((credential) => !credential.resolved).map((one) => one.secretRef);
    const oauth = isOAuthIntegration(config);
    const lastSeen = input.lastSeen?.[name];
    const base = {
      integration: name,
      ...(connector === undefined ? {} : { connector }),
      transport: config.transport,
      auth: oauth
        ? ('oauth' as const)
        : mine.length > 0
          ? ('credentials' as const)
          : ('none' as const),
      toolPrefix: mcpToolPrefix(name),
      credentials: mine,
      missingSecretRefs: missing,
      required: required.has(name),
      ...(lastSeen === undefined ? {} : { lastSeenStatus: lastSeen }),
    };

    // A ref that will not resolve outranks everything else: §10 makes it a
    // *launch refusal*, so a chip that said "needs auth" would understate it.
    if (missing.length > 0) {
      out.push({
        ...base,
        state: 'missing-secret',
        detail:
          `${missing.join(', ')} is not in this machine's secret store, so a launch that ` +
          'compiles this connector is refused before the session starts.',
      });
      continue;
    }

    if (oauth) {
      // The cautious default, and the reason for it: this build cannot read the
      // CLI's OAuth grant, so "connected once" is the only positive evidence
      // there is. Reporting `ready` without it would be reassuring and wrong.
      if (lastSeen === 'connected') {
        out.push({
          ...base,
          state: 'ready',
          detail: 'Authorised — the last session on this machine connected to it.',
        });
        continue;
      }
      out.push({
        ...base,
        state: 'needs-auth',
        detail:
          lastSeen === undefined
            ? 'Authorises by OAuth. No session has connected to it on this machine yet, so the ' +
              'grant is unknown until one runs: the session raises the authorisation link when ' +
              'the server asks for it.'
            : `The last session reported it as "${lastSeen}". Start the session and follow the ` +
              'authorisation link it raises.',
      });
      continue;
    }

    if (lastSeen === 'needs-auth' || lastSeen === 'failed') {
      out.push({
        ...base,
        state: 'needs-auth',
        detail: `The last session reported this server as "${lastSeen}".`,
      });
      continue;
    }

    out.push({
      ...base,
      state: 'ready',
      detail:
        mine.length === 0
          ? 'Needs no credential from this machine.'
          : `${String(mine.length)} credential reference(s), all resolvable.`,
    });
  }

  for (const name of required) {
    if (name in declared) continue;
    out.push({
      integration: name,
      auth: 'none',
      toolPrefix: mcpToolPrefix(name),
      state: 'not-attached',
      credentials: [],
      missingSecretRefs: [],
      required: true,
      detail:
        `This task needs the "${name}" connector and this agent does not declare it. Add it in ` +
        'the agent’s integrations panel.',
    });
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
   * The connector library (§10.3), consulted **before** the secret store.
   *
   * Absent is the same refusal a dangling ref is: a build with no library
   * cannot compile `{ connector: "gmail" }` into anything, and a launch that
   * dropped the server would be a session whose mailbox tools are simply not
   * there.
   */
  readonly connectors?: ConnectorLookup | undefined;
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
 * `integrations` → `options.mcpServers`, with every connector reference and
 * every `secretRef` resolved.
 *
 * The two resolutions happen in that order (§10.3): a ref becomes a config, and
 * only then are that config's credentials looked up — which is what makes a
 * referenced connector compile to *byte-identical* `mcpServers` output to the
 * equivalent inline one, rather than to a second code path that happens to
 * agree today.
 *
 * @throws {SessionCompileError} when a connector reference or a `secretRef`
 * does not resolve. No session is started: §10's whole point is that a 401
 * three turns in is a worse failure than a refusal at launch, and a server that
 * silently failed to mount is the same failure with less to go on.
 */
export async function compileIntegrations(
  input: CompileIntegrationsInput,
): Promise<CompiledIntegrations> {
  const servers: Record<string, CompiledMcpServer> = {};
  const diagnostics: Diagnostic[] = [];

  const resolved = resolveIntegrations(input.integrations, input.connectors);
  const dangling = resolved.dangling[0];
  if (dangling !== undefined) {
    throw new SessionCompileError(
      `agent ${input.agentName} attaches the library connector \`${dangling.connector}\` as ` +
        `"${dangling.name}", and the connector library does not hold it`,
      resolved.dangling.map((ref) => ({
        level: 'error' as const,
        code: 'roster.connector.unresolved',
        message: `connector \`${ref.connector}\` is not in the library (DESIGN §10.3)`,
        agentId: input.agentId,
        path: `integrations.${ref.name}.connector`,
      })),
    );
  }

  for (const { name, config } of resolved.integrations) {
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

    // §10's OAuth mode compiles to *nothing extra*, and that is the design
    // rather than an omission. The SDK's remote server configs have no auth
    // field (`sdk.d.ts:1037`, `:1152`); a remote MCP server that needs OAuth
    // answers the CLI's first request with a challenge, and the CLI runs
    // discovery, dynamic client registration and the authorisation code flow
    // itself, surfacing the browser step as a `mode: "url"` elicitation
    // (`sdk.d.ts:582`, `Options.onElicitation` at `:1568`). So the only thing
    // roster must not do is synthesise an `Authorization` header — which the
    // schema already makes unrepresentable — and any non-credential header the
    // owner declared still travels, because a routing header is not auth.
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
