/**
 * The session-start assertion (roster DESIGN §7.1, §10; IMPLEMENTATION M5, M6).
 *
 * §7.1: "a nonexistent plugin path is **silently skipped**, and `~` is not
 * expanded. The compiler therefore uses absolute paths and **the runner asserts
 * that the `system`/`init` message's `plugins` and `skills` arrays contain what
 * was requested**, raising a session-start diagnostic if not." SDK-NOTES §7
 * lists that assertion as the standing guard for the two plugin-loader claims
 * static reading could not settle, so it is the difference between an agent that
 * quietly has no skills and one that says so.
 *
 * The same message is where §10's MCP server statuses arrive
 * (`mcp_servers: { name, status }[]`), so the mapping of `pending` /
 * `needs-auth` / `failed` onto distinct diagnostic kinds lives here too rather
 * than in a second reader of the same object. §10: "roster exposes the mapping
 * so the runner can surface `needs-auth` as an actionable card rather than a
 * generic failure."
 *
 * **This function is pure and takes plain data.** The runner passes the init
 * message it received; a test passes a literal. That is deliberate — the helper
 * is the part of M5's acceptance that can be proven without a token, and a
 * helper that could only be exercised against a live session would be the one
 * piece of the launch path with no test at all.
 */
import type { Diagnostic } from './contracts.js';

/** MCP server statuses the SDK declares (`sdk.d.ts:1085`), matching §10's list. */
export const MCP_SERVER_STATUSES = [
  'connected',
  'failed',
  'needs-auth',
  'pending',
  'disabled',
] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

/**
 * What the compiler asked the session for.
 *
 * Built by `compileSession` and carried alongside the options, so the runner
 * does not re-derive it from an option object it is not supposed to inspect.
 */
export interface RequestedSessionSurface {
  readonly agentId: string;
  /** Absolute plugin paths, from `options.plugins` (§7.1). */
  readonly pluginPaths: readonly string[];
  /** `options.skills` verbatim: the exact names, `'all'`, or `[]` (§7.2). */
  readonly skills: readonly string[] | 'all';
  /** Integration names, which are also the `mcp__<server>__` prefixes (§10). */
  readonly mcpServers: readonly string[];
}

/**
 * The fields of the SDK's `system`/`init` message this assertion reads.
 *
 * Structural rather than the SDK's `SDKSystemMessage`, for the same reason the
 * plugin config is structural in `skills.ts`: §13 keeps SDK type imports in two
 * files, and every field named here is optional so a version that stops emitting
 * one degrades to "cannot tell" rather than to a false alarm.
 */
export interface SessionInitFacts {
  readonly plugins?: readonly { readonly name: string; readonly path: string }[] | undefined;
  readonly skills?: readonly string[] | undefined;
  readonly mcp_servers?: readonly { readonly name: string; readonly status: string }[] | undefined;
}

function sameFile(a: string, b: string): boolean {
  // Path comparison only, never a filesystem call: this runs on the hot path of
  // every launch and the two strings both come from us. Case-insensitive and
  // separator-insensitive because Windows answers to both spellings and the CLI
  // echoes back whatever form it resolved to.
  const normalise = (value: string): string =>
    value
      .replace(/[\\/]+/g, '/')
      .replace(/\/$/, '')
      .toLowerCase();
  return normalise(a) === normalise(b);
}

/**
 * Compare a started session against what was asked for.
 *
 * Returns `[]` when everything requested is present — the common case, and the
 * one that must not cost the runner anything to check.
 */
export function assertSessionStart(
  requested: RequestedSessionSurface,
  init: SessionInitFacts,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { agentId } = requested;

  // --- plugins (§7.1) ------------------------------------------------------
  if (requested.pluginPaths.length > 0 && init.plugins !== undefined) {
    const loaded = init.plugins;
    for (const path of requested.pluginPaths) {
      if (loaded.some((plugin) => sameFile(plugin.path, path))) continue;
      diagnostics.push({
        level: 'error',
        code: 'roster.session.plugin-not-loaded',
        message:
          `the session did not load the agent's plugin folder "${path}" — the SDK silently skips ` +
          'a plugin path it cannot resolve, so none of this agent’s skills are available ' +
          '(DESIGN §7.1)',
        agentId,
        path,
      });
    }
  }

  // --- skills (§7.2) -------------------------------------------------------
  if (requested.skills !== 'all' && init.skills !== undefined) {
    const loaded = new Set(init.skills);
    // The engine namespaces a plugin's skills `<plugin>:<skill>` (§7.1), so a
    // requested bare name matches either spelling.
    const has = (name: string): boolean =>
      loaded.has(name) || init.skills?.some((entry) => entry.endsWith(`:${name}`)) === true;

    for (const name of requested.skills) {
      if (has(name)) continue;
      diagnostics.push({
        level: 'error',
        code: 'roster.session.skill-not-loaded',
        message:
          `skill "${name}" was requested but is not in the session's skills list; the agent will ` +
          'behave as though it does not have it (DESIGN §7.1, §7.2)',
        agentId,
        path: 'skills.names',
      });
    }

    if (requested.skills.length === 0 && init.skills.length > 0) {
      diagnostics.push({
        level: 'warn',
        code: 'roster.session.unexpected-skills',
        message:
          `this agent requested no skills, but the session loaded ${String(init.skills.length)}: ` +
          `${init.skills.join(', ')}. Skills are a context filter, not a sandbox (DESIGN §7.2).`,
        agentId,
        path: 'skills.mode',
      });
    }
  }

  // --- MCP servers (§10) ---------------------------------------------------
  diagnostics.push(...mcpServerDiagnostics(requested, init.mcp_servers));

  return diagnostics;
}

/**
 * §10's status mapping.
 *
 * `needs-auth` is deliberately its own code and its own message: it is the one
 * status a human can *fix*, and the failure mode §10 names is exactly a session
 * that reports it as a generic failure and so gets treated as a bug rather than
 * as a credential the owner has to supply.
 */
export function mcpServerDiagnostics(
  requested: Pick<RequestedSessionSurface, 'agentId' | 'mcpServers'>,
  servers: readonly { readonly name: string; readonly status: string }[] | undefined,
): Diagnostic[] {
  if (servers === undefined) return [];
  const diagnostics: Diagnostic[] = [];
  const { agentId } = requested;
  const seen = new Set<string>();

  for (const server of servers) {
    seen.add(server.name);
    const path = `integrations.${server.name}`;
    switch (server.status) {
      case 'connected':
        break;
      case 'needs-auth':
        diagnostics.push({
          level: 'warn',
          code: 'roster.mcp.needs-auth',
          message:
            `the "${server.name}" integration is connected but not authorised: it needs a ` +
            'credential before its tools will answer (DESIGN §10)',
          agentId,
          path,
        });
        break;
      case 'failed':
        diagnostics.push({
          level: 'error',
          code: 'roster.mcp.failed',
          message: `the "${server.name}" integration failed to start; its tools are unavailable for this session (DESIGN §10)`,
          agentId,
          path,
        });
        break;
      case 'pending':
        diagnostics.push({
          level: 'info',
          code: 'roster.mcp.pending',
          message: `the "${server.name}" integration was still connecting when the session started (DESIGN §10)`,
          agentId,
          path,
        });
        break;
      case 'disabled':
        diagnostics.push({
          level: 'warn',
          code: 'roster.mcp.disabled',
          message: `the "${server.name}" integration is disabled in this session; the agent was configured to use it (DESIGN §10)`,
          agentId,
          path,
        });
        break;
      default:
        diagnostics.push({
          level: 'warn',
          code: 'roster.mcp.unknown-status',
          message:
            `the "${server.name}" integration reported status "${server.status}", which this ` +
            `build does not know (expected one of ${MCP_SERVER_STATUSES.join(', ')})`,
          agentId,
          path,
        });
    }
  }

  for (const name of requested.mcpServers) {
    if (seen.has(name)) continue;
    diagnostics.push({
      level: 'error',
      code: 'roster.mcp.not-mounted',
      message:
        `the "${name}" integration was compiled into this session but the session reports no such ` +
        'MCP server; every `mcp__' +
        `${name}__*` +
        '` tool will be missing (DESIGN §10)',
      agentId,
      path: `integrations.${name}`,
    });
  }

  return diagnostics;
}
