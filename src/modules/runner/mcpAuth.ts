/**
 * Remote MCP authorisation — the `needs-auth` card's other half (WO6 item 3).
 *
 * ## What the pinned SDK actually offers, and what it does not
 *
 * Verified against `@anthropic-ai/claude-agent-sdk` **0.3.233** (`sdk.d.ts`,
 * 8043 lines), by the method `docs/orchestrator/SDK-NOTES.md` fixes — static
 * reading of the shipped declarations plus an offline probe:
 *
 * - **There is no auth field to declare.** `McpHttpServerConfig` (`:1037`) and
 *   `McpSSEServerConfig` (`:1152`) carry `url`, `headers`, `tools`, `timeout`
 *   and `alwaysLoad`. `McpServerConfig` (`:1070`) is the union of those two with
 *   stdio and sdk servers. The one config that names a Claude-hosted connector,
 *   `McpClaudeAIProxyServerConfig` (`:1027`, `type: 'claudeai-proxy'`), appears
 *   **only** in `McpServerStatusConfig` (`:1120`) — the read side. It is not in
 *   `McpServerConfig`, so a claude.ai connector cannot be *declared*
 *   programmatically at all on this version; it can only be observed.
 * - **The authorize flow is in-session, and it is an elicitation.**
 *   `Options.onElicitation` (`:1568`) receives an `ElicitationRequest` (`:582`)
 *   whose `mode: 'url'` means "browser-based auth" and whose `url` is the page
 *   the human must open. Completion arrives as a message, not a return value:
 *   `SDKElicitationCompleteMessage` (`system` / `elicitation_complete`,
 *   `:4111`), correlated by `elicitation_id`. The same fact shows up in the
 *   `mcp_call` control request's own docs (`:3758`): *"UrlElicitationRequired
 *   (-32042) tries Elicitation hooks; if no hook resolves, the call errors with
 *   the URL in the message — open it out-of-band, then retry"*.
 * - **Reconnection exists.** `Query.reconnectMcpServer(serverName)` (`:2592`)
 *   and `Query.mcpServerStatus()` (`:2502`).
 * - **Headless, pre-launch authorisation does not exist.** No exported function
 *   in `sdk.d.ts` authorises an MCP server outside a `query()`; every entry
 *   point above hangs off a live `Query`. Consequence, stated plainly rather
 *   than worked around: Start-work's integration preflight can say an OAuth
 *   connector's grant is unknown, and cannot obtain one. The authorisation link
 *   is raised by the session, which is what this file makes happen.
 *
 * Token storage needs no new mechanism and gets none. The CLI caches MCP OAuth
 * grants itself, under its config directory, and runner already pins that
 * directory inside our own data root — `CLAUDE_CONFIG_DIR = <dataRoot>\state\
 * claude-config` (`agentEnv.ts`, foundation §2.3). So the grant lands beside the
 * rest of the SDK's state, outside git and outside any export, which is exactly
 * the posture foundation §3.1 asks for and the same one `CLAUDE_CODE_OAUTH_TOKEN`
 * already has. Nothing here reads that cache: it is an undocumented shape that
 * holds live access tokens, and a parser for it would be a third `.reveal()`
 * site in all but name (foundation §3.2).
 *
 * ## The handler
 *
 * One `onElicitation` callback with three behaviours, and each is a decision:
 *
 * 1. **`mode: 'url'` is surfaced and then waited on.** The URL goes out as a
 *    session diagnostic the UI turns into an **Authenticate…** action, and the
 *    promise stays open until the *server* confirms the grant
 *    (`elicitation_complete`) or the session aborts. Answering `accept`
 *    immediately would tell the MCP server the human had finished before they
 *    had opened the page.
 * 2. **`mode: 'form'` is declined, out loud.** There is no form UI, and the
 *    documented default for an unhandled elicitation is a silent decline
 *    (`sdk.d.ts:1553`). Declining with a diagnostic turns "the connector did
 *    nothing" into "the connector asked something this build cannot ask you".
 * 3. **Nothing is left pending on shutdown.** `OnElicitation`'s contract warns
 *    that returning `null` by accident leaves the elicitation open "until the
 *    server times it out" (`sdk.d.ts:1305`), so the abort signal settles every
 *    waiter with a `cancel` rather than dropping it.
 */

/** The elicitation shape runner reads, structurally (SDK `ElicitationRequest`). */
export interface McpElicitation {
  readonly serverName: string;
  readonly message: string;
  readonly mode?: 'form' | 'url' | undefined;
  readonly url?: string | undefined;
  readonly elicitationId?: string | undefined;
}

/**
 * The SDK's `ElicitResult`, narrowed to the one field runner ever sets.
 *
 * No `content`: runner answers `url`-mode elicitations, which carry no form
 * payload, and declines `form`-mode ones — so a content field here would be a
 * shape nothing writes and the MCP SDK's own value union to keep in step with.
 */
export interface McpElicitationAnswer {
  readonly action: 'accept' | 'decline' | 'cancel';
  /** The MCP SDK's `ElicitResult` is open-ended; runner writes nothing into it. */
  readonly [key: string]: unknown;
}

export interface McpAuthEvent {
  /** `mcp_authorize_url` when a link was raised, `mcp_elicitation_declined` otherwise. */
  readonly code: 'mcp_authorize_url' | 'mcp_elicitation_declined' | 'mcp_authorized';
  readonly severity: 'info' | 'warn';
  readonly server: string;
  readonly message: string;
  /** Present only on `mcp_authorize_url`. The page the human opens. */
  readonly url?: string | undefined;
}

export interface McpAuthCoordinatorDeps {
  /** Where a raised link or a decline goes — `session.diagnostic`, in `launch.ts`. */
  readonly emit: (event: McpAuthEvent) => void;
  /** Ends every waiter when the session does (§3.3: runner owns cancellation). */
  readonly signal: AbortSignal;
  /** Optional: called after a grant completes, to re-check and reconnect. */
  readonly onAuthorized?: (server: string) => void;
}

export interface McpAuthCoordinator {
  /** The `Options.onElicitation` callback. */
  readonly onElicitation: (request: McpElicitation) => Promise<McpElicitationAnswer>;
  /**
   * Feed every SDK message here; a `system` / `elicitation_complete` settles the
   * matching waiter. Returns true when this message settled one, so the caller
   * can log the fact rather than infer it.
   */
  readonly noteMessage: (message: unknown) => boolean;
  /** Servers that raised a URL and have not completed — what a card can offer. */
  readonly pendingServers: () => readonly { server: string; url: string }[];
}

/** One outstanding URL-mode elicitation. */
interface Waiter {
  readonly server: string;
  readonly url: string;
  readonly settle: (answer: McpElicitationAnswer) => void;
}

export function createMcpAuthCoordinator(deps: McpAuthCoordinatorDeps): McpAuthCoordinator {
  /**
   * Keyed by `elicitationId` when the SDK supplied one, and by server name when
   * it did not.
   *
   * `elicitationId` is documented as present for URL mode (`sdk.d.ts:592`) and
   * is what `elicitation_complete` correlates on, but it is optional in the type
   * — so the server name is the fallback key rather than a reason to refuse the
   * flow. Two concurrent grants for the same server would collide under that
   * fallback; one server asking twice at once is not a thing that happens, and
   * settling the wrong one of two would still settle a real waiter.
   */
  const waiters = new Map<string, Waiter>();

  function settleAll(action: 'cancel'): void {
    for (const [key, waiter] of waiters) {
      waiters.delete(key);
      waiter.settle({ action });
    }
  }

  deps.signal.addEventListener('abort', () => {
    settleAll('cancel');
  });

  function settle(key: string, answer: McpElicitationAnswer): boolean {
    const waiter = waiters.get(key);
    if (waiter === undefined) return false;
    waiters.delete(key);
    waiter.settle(answer);
    return true;
  }

  return {
    async onElicitation(request) {
      if (request.mode !== 'url' || request.url === undefined || request.url === '') {
        // Behaviour 2. A `form` elicitation is declined either way; saying so is
        // the difference between a connector that looks broken and one that
        // asked a question this build has no screen for.
        deps.emit({
          code: 'mcp_elicitation_declined',
          severity: 'warn',
          server: request.serverName,
          message:
            `The "${request.serverName}" MCP server asked for input this session cannot collect ` +
            `(“${request.message}”). It was declined, so any tool call that depended on it will ` +
            'fail. Report it as blocked rather than working around it.',
        });
        return { action: 'decline' };
      }

      const key = request.elicitationId ?? request.serverName;
      const url = request.url;
      deps.emit({
        code: 'mcp_authorize_url',
        severity: 'warn',
        server: request.serverName,
        url,
        message:
          `The "${request.serverName}" MCP server needs you to authorise it. Open the ` +
          'authorisation link, sign in, and this session picks the connector up as soon as the ' +
          'server confirms the grant — no credential is stored on this machine by AgentManager.',
      });

      if (deps.signal.aborted) return { action: 'cancel' };

      return new Promise<McpElicitationAnswer>((resolve) => {
        waiters.set(key, { server: request.serverName, url, settle: resolve });
      });
    },

    noteMessage(message) {
      const record = message as
        | {
            type?: unknown;
            subtype?: unknown;
            mcp_server_name?: unknown;
            elicitation_id?: unknown;
          }
        | null
        | undefined;
      if (record?.type !== 'system' || record.subtype !== 'elicitation_complete') return false;
      const id = typeof record.elicitation_id === 'string' ? record.elicitation_id : undefined;
      const server =
        typeof record.mcp_server_name === 'string' ? record.mcp_server_name : undefined;
      // The id first, because it is what the SDK says correlates; the server
      // name second, for the build that omitted one.
      const settled =
        (id !== undefined && settle(id, { action: 'accept' })) ||
        (server !== undefined && settle(server, { action: 'accept' }));
      if (!settled) return false;
      if (server !== undefined) {
        deps.emit({
          code: 'mcp_authorized',
          severity: 'info',
          server,
          message: `The "${server}" MCP server was authorised; its tools are being reconnected.`,
        });
        deps.onAuthorized?.(server);
      }
      return true;
    },

    pendingServers() {
      return [...waiters.values()].map((waiter) => ({ server: waiter.server, url: waiter.url }));
    },
  };
}

/**
 * The system-reminder line injected when a declared connector is down at launch
 * (WO6 item 4's second bullet).
 *
 * The incident's shape was an agent *discovering* a dead connector by calling
 * it, then improvising. A session that is told at the start has no discovery to
 * do — and the sentence deliberately names the sanctioned next move in the same
 * breath, for the reason `TOOLING_GUARDRAIL` does: a prohibition with no exit is
 * an invitation to improvise.
 */
export function mcpLaunchContextNote(
  servers: readonly { readonly name: string; readonly status: string }[],
): string | undefined {
  const down = servers.filter(
    (server) => server.status === 'failed' || server.status === 'needs-auth',
  );
  if (down.length === 0) return undefined;
  const lines = down.map(
    (server) =>
      `  - ${server.name} (mcp__${server.name}__*): ${
        server.status === 'needs-auth'
          ? 'not authorised — its tools will refuse until someone completes the OAuth grant'
          : 'failed to start — its tools are not mounted in this session'
      }`,
  );
  return [
    '<system-reminder>',
    'Connector status for this session, known before you start:',
    ...lines,
    '',
    'Do not attempt to work around these. If the work needs one of them, call ' +
      'mcp__agentmanager__report_status with state "blocked" naming the connector. Do not search ' +
      'the filesystem, environment, or configuration for credentials or API keys.',
    '</system-reminder>',
  ].join('\n');
}
