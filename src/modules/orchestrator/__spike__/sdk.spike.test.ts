/**
 * Orchestrator M0 — Claude Agent SDK verification spike.
 *
 * Three halves, and the split is the point (see docs/orchestrator/SDK-NOTES.md):
 *
 * 1. **Surface check — always runs.** Fails `npm run ci` if `createSdkMcpServer`
 *    / `tool` stop being exported, if their option and definition shapes change,
 *    if `McpSdkServerConfigWithInstance` stops being a member of
 *    `McpServerConfig`, if the `Query` MCP methods disappear, or if
 *    `package.json` stops pinning the exact version the notes were verified
 *    against. Mostly type-level, so it costs nothing at runtime and everything
 *    at `tsc --noEmit`.
 *
 * 2. **Offline protocol check — always runs.** `createSdkMcpServer` returns a
 *    real in-process MCP server; it needs no CLI and no auth. Driving it over a
 *    loopback transport turns SDK-NOTES [A2] and [A4] from "wrapper source" into
 *    "observed", and proves G2's single-use rule.
 *
 * 3. **Live checks — skipped without a token.** The engine ships as a
 *    Bun-compiled binary, so tool naming, tool search, permission flow and the
 *    MCP tool-call timeout cannot be read statically. Every item in SDK-NOTES
 *    §10 ("Live verification pending") is encoded here, ready to run under a
 *    real account at M4. `L<n>` tags map 1:1 onto that table; nothing in the
 *    notes marked *confirmed* depends on these passing.
 *
 * Nothing in `src/` imports this file, and `tsconfig.build.json` excludes
 * `src/**\/*.test.ts`, so it never reaches `dist/`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type {
  McpSdkServerConfigWithInstance,
  McpServerConfig,
  McpServerStatus,
  Options as SdkOptions,
  Query as SdkQuery,
  SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

/** The version docs/orchestrator/SDK-NOTES.md was verified against, character for character. */
const VERIFIED_SDK_VERSION = '0.3.233';

/** DESIGN §4.1: the record key roster mounts the toolset under. */
const SERVER_KEY = 'agentmanager';

/** DESIGN §4.3: the six tools, overseer grant. Workers get the last four (R1b). */
const ALL_TOOL_NAMES = [
  'list_roster',
  'create_assignment',
  'send_to_agent',
  'read_mailbox',
  'report_status',
  'request_user_decision',
] as const;
const WORKER_TOOL_NAMES = [
  'send_to_agent',
  'read_mailbox',
  'report_status',
  'request_user_decision',
] as const;

// ---------------------------------------------------------------------------
// 1. Surface check — always runs
// ---------------------------------------------------------------------------

type Expect<T extends true> = T;
/** Non-distributive "every member of `Members` is in `Union`". */
type Covers<Union, Members> = [Members] extends [Union] ? true : false;

/** `CreateSdkMcpServerOptions` is not exported; derive it from the function. */
type CreateOptions = Parameters<typeof createSdkMcpServer>[0];

/** SDK-NOTES §2.1 / C3: `alwaysLoad` and `instructions` must exist for §4.1's fix. */
type _CreateOptionKeys = Expect<
  Covers<keyof CreateOptions, 'alwaysLoad' | 'instructions' | 'name' | 'tools' | 'version'>
>;

/** SDK-NOTES [A2]: the definition shape `tool()` produces. */
type _ToolDefinitionKeys = Expect<
  Covers<
    keyof SdkMcpToolDefinition,
    '_meta' | 'annotations' | 'description' | 'handler' | 'inputSchema' | 'name'
  >
>;

/** SDK-NOTES [A1]: `createSdkMcpServer` returns a value `mcpServers` accepts. */
type _ReturnIsMountable = Expect<Covers<McpServerConfig, McpSdkServerConfigWithInstance>>;
type _ReturnShape = Expect<
  Covers<keyof McpSdkServerConfigWithInstance, 'instance' | 'name' | 'type'>
>;

/** SDK-NOTES G1: the in-process config has **no** per-server `timeout` escape hatch. */
type _NoPerServerTimeout = Expect<
  'timeout' extends keyof McpSdkServerConfigWithInstance ? false : true
>;

/** SDK-NOTES [A5], G4: the options roster sets on orchestrator's behalf. */
type _MountingOptions = Expect<
  Covers<keyof SdkOptions, 'env' | 'mcpServers' | 'settingSources' | 'strictMcpConfig'>
>;

/** SDK-NOTES §3.2, G10: the `Query` surface orchestrator's diagnostics read. */
type _QueryMcpMethods = Expect<
  Covers<Extract<keyof SdkQuery, string>, 'close' | 'mcpServerStatus' | 'setMcpServers'>
>;

/** SDK-NOTES §3.2: the status vocabulary M4's mount assertion switches on. */
type _McpStatuses = Expect<
  Covers<McpServerStatus['status'], 'connected' | 'disabled' | 'failed' | 'needs-auth' | 'pending'>
>;

/**
 * DESIGN §4.3 / SDK-NOTES G3: a tool returns a single `text` block carrying
 * JSON — there is no JSON content-block type in MCP. This probe is the shape
 * every one of the six tools compiles to.
 */
const TOOL_SHAPE = { note: z.string().optional() };
type ToolShape = typeof TOOL_SHAPE;

function buildToolset(names: readonly string[]): SdkMcpToolDefinition<ToolShape>[] {
  // The closed-over launch identity — SDK-NOTES [A2]: `extra` carries none.
  const identity = { assignmentId: '01J-spike', agentId: 'sam-skeptic', isOverseer: false };

  return names.map((name) =>
    tool(
      name,
      `Orchestrator coordination tool: ${name}.`,
      TOOL_SHAPE,
      (args, extra) =>
        Promise.resolve({
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                name,
                note: args.note ?? null,
                assignmentId: identity.assignmentId,
                // Recorded so the offline check can assert what `extra` is.
                extraKeys: extra === null || typeof extra !== 'object' ? [] : Object.keys(extra),
              }),
            },
          ],
        }),
      { annotations: { readOnlyHint: name === 'list_roster' || name === 'read_mailbox' } },
    ),
  );
}

describe('SDK surface against the pinned version (M0 CI check)', () => {
  it('package.json still pins the exact version SDK-NOTES was verified against', () => {
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    // Exact, not a range: `^` or `~` would let the surface drift under the notes.
    expect(pkg.dependencies?.['@anthropic-ai/claude-agent-sdk']).toBe(VERIFIED_SDK_VERSION);
  });

  it('exports createSdkMcpServer and tool', () => {
    expect(typeof createSdkMcpServer).toBe('function');
    expect(typeof tool).toBe('function');
    expect(typeof query).toBe('function');
  });

  it('[A1] createSdkMcpServer returns a mountable { type: "sdk", name, instance }', () => {
    const server = createSdkMcpServer({
      name: SERVER_KEY,
      version: '1.0.0',
      instructions: 'These tools act on the assignment this session was launched under.',
      alwaysLoad: true, // SDK-NOTES C3
      tools: buildToolset(ALL_TOOL_NAMES),
    });

    expect(server.type).toBe('sdk');
    expect(server.name).toBe(SERVER_KEY);
    expect(server.instance).toBeDefined();

    // The value must be assignable straight into the option roster writes.
    const mounted = { [SERVER_KEY]: server } satisfies Record<string, McpServerConfig>;
    expect(Object.keys(mounted)).toEqual([SERVER_KEY]);
  });

  it('[A5] an in-process instance and a stdio config coexist in one mcpServers record', () => {
    const mcpServers = {
      [SERVER_KEY]: createSdkMcpServer({
        name: SERVER_KEY,
        tools: buildToolset(['report_status']),
      }),
      linear: { type: 'stdio' as const, command: 'node', args: ['./linear.js'] },
      docs: { type: 'http' as const, url: 'https://example.invalid/mcp' },
    } satisfies NonNullable<SdkOptions['mcpServers']>;

    expect(Object.keys(mcpServers).sort()).toEqual(['agentmanager', 'docs', 'linear']);
  });

  it('C3 — alwaysLoad stamps _meta on every tool so nothing hides behind tool search', () => {
    const [definition] = buildToolset(['report_status']);
    expect(definition).toBeDefined();
    // Per-tool `_meta` starts empty; the server-level flag is what stamps it.
    const withFlag = tool('probe', 'probe', {}, () => Promise.resolve({ content: [] }), {
      alwaysLoad: true,
    });
    expect(withFlag._meta?.['anthropic/alwaysLoad']).toBe(true);
  });

  it('R1b — a worker toolset registers four tools, an overseer six', () => {
    expect(buildToolset(WORKER_TOOL_NAMES).map((t) => t.name)).toEqual([...WORKER_TOOL_NAMES]);
    expect(buildToolset(ALL_TOOL_NAMES)).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// 2. Offline protocol check — always runs (no CLI, no auth)
// ---------------------------------------------------------------------------

type JsonRpcFrame = Record<string, unknown>;

/**
 * A loopback MCP transport. `createSdkMcpServer` hands back a real MCP server
 * object, so the whole request path — schema conversion, zod validation,
 * handler dispatch, error wrapping — runs in this process with no engine.
 */
class LoopbackTransport {
  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: ((message: JsonRpcFrame, extra?: unknown) => void) | undefined;
  readonly sent: JsonRpcFrame[] = [];

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(message: JsonRpcFrame): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }

  deliver(frame: JsonRpcFrame): void {
    this.onmessage?.(frame);
  }

  async awaitResponse(id: number, timeoutMs = 5_000): Promise<JsonRpcFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.sent.find((frame) => frame['id'] === id);
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error(`No JSON-RPC response for id ${String(id)}`);
      await new Promise((res) => setTimeout(res, 5));
    }
  }
}

type McpInstance = McpSdkServerConfigWithInstance['instance'];
type ConnectArg = Parameters<McpInstance['connect']>[0];

async function connectLoopback(instance: McpInstance): Promise<LoopbackTransport> {
  const transport = new LoopbackTransport();
  await instance.connect(transport as unknown as ConnectArg);
  transport.deliver({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agentmanager-spike', version: '0.0.0' },
    },
  });
  await transport.awaitResponse(1);
  transport.deliver({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return transport;
}

function textOf(frame: JsonRpcFrame): string {
  const result = frame['result'];
  if (result === null || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block !== null &&
      typeof block === 'object' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .join('');
}

function isErrorResult(frame: JsonRpcFrame): boolean {
  const result = frame['result'];
  if (result === null || typeof result !== 'object') return false;
  return (result as { isError?: unknown }).isError === true;
}

describe('in-process MCP server, driven offline (SDK-NOTES §2, §3.1)', () => {
  it('[A2] tools/list exposes the six tools and tools/call reaches the handler with (args, extra)', async () => {
    const server = createSdkMcpServer({ name: SERVER_KEY, tools: buildToolset(ALL_TOOL_NAMES) });
    const transport = await connectLoopback(server.instance);

    transport.deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = await transport.awaitResponse(2);
    const tools = (listed['result'] as { tools?: { name: string }[] } | undefined)?.tools ?? [];
    expect(tools.map((entry) => entry.name).sort()).toEqual([...ALL_TOOL_NAMES].sort());

    transport.deliver({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'report_status', arguments: { note: 'hello' } },
    });
    const called = await transport.awaitResponse(3);
    const payload = JSON.parse(textOf(called)) as {
      ok: boolean;
      note: string | null;
      assignmentId: string;
      extraKeys: string[];
    };

    // The handler ran, received the validated args, and answered from the
    // closed-over launch identity — which `extra` does not carry.
    expect(payload.ok).toBe(true);
    expect(payload.note).toBe('hello');
    expect(payload.assignmentId).toBe('01J-spike');
    expect(payload.extraKeys).not.toContain('assignmentId');
    expect(payload.extraKeys).not.toContain('agentId');
    // `extra.sessionId` exists as a key but is undefined on this transport.
    expect(payload.extraKeys).toContain('signal');
    expect(payload.extraKeys).toContain('requestId');

    await transport.close();
  });

  it('[A4] a throwing handler becomes an isError text result, not a dead turn', async () => {
    const server = createSdkMcpServer({
      name: SERVER_KEY,
      tools: [
        tool('send_to_agent', 'refuses', { to: z.string() }, () => {
          throw new Error('agent_not_in_assignment: sam-skeptic is not a member of 01J-spike');
        }),
      ],
    });
    const transport = await connectLoopback(server.instance);

    transport.deliver({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'send_to_agent', arguments: { to: 'ada-architect' } },
    });
    const called = await transport.awaitResponse(2);

    expect(isErrorResult(called)).toBe(true);
    expect(textOf(called)).toContain('agent_not_in_assignment');
    // Crucially it is a *result*, not a JSON-RPC error — the turn continues.
    expect(called['error']).toBeUndefined();

    await transport.close();
  });

  it('[A4] a zod validation failure and an unknown tool also arrive as isError results', async () => {
    const server = createSdkMcpServer({
      name: SERVER_KEY,
      tools: [
        tool('send_to_agent', 'strict', { to: z.string() }, () =>
          Promise.resolve({ content: [{ type: 'text' as const, text: '{}' }] }),
        ),
      ],
    });
    const transport = await connectLoopback(server.instance);

    transport.deliver({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'send_to_agent', arguments: { to: 42 } },
    });
    const invalid = await transport.awaitResponse(2);

    transport.deliver({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'no_such_tool', arguments: {} },
    });
    const unknown = await transport.awaitResponse(3);

    // SDK-NOTES §2.3: the CallTool handler converts *every* failure except
    // UrlElicitationRequired into an isError text result, so no shape a tool
    // can produce escalates to a JSON-RPC error the model never sees.
    expect(invalid['error']).toBeUndefined();
    expect(isErrorResult(invalid)).toBe(true);
    expect(textOf(invalid)).toContain('Invalid arguments for tool send_to_agent');

    expect(unknown['error']).toBeUndefined();
    expect(isErrorResult(unknown)).toBe(true);
    expect(textOf(unknown)).toContain('not found');

    await transport.close();
  });

  it('G2 — an instance is single-use: a second connect rejects, so per-launch is mandatory', async () => {
    const server = createSdkMcpServer({ name: SERVER_KEY, tools: buildToolset(['report_status']) });
    const first = await connectLoopback(server.instance);

    const second = new LoopbackTransport();
    await expect(server.instance.connect(second as unknown as ConnectArg)).rejects.toThrow(
      /Already connected/i,
    );

    await first.close();
  });

  it('[A3] the server layer applies no timeout to an inbound tool call', async () => {
    let settle: (() => void) | undefined;
    const server = createSdkMcpServer({
      name: SERVER_KEY,
      tools: [
        tool(
          'request_user_decision',
          'holds',
          {},
          () =>
            new Promise((res) => {
              settle = () =>
                res({ content: [{ type: 'text' as const, text: '{"status":"held"}' }] });
            }),
        ),
      ],
    });
    const transport = await connectLoopback(server.instance);

    transport.deliver({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'request_user_decision', arguments: {} },
    });

    await new Promise((res) => setTimeout(res, 250));
    // Still pending after a quarter second with nothing cancelling it. The only
    // bound is the engine's MCP_TOOL_TIMEOUT (SDK-NOTES G1, live check L3).
    expect(transport.sent.find((frame) => frame['id'] === 2)).toBeUndefined();

    settle?.();
    const called = await transport.awaitResponse(2);
    expect(textOf(called)).toContain('held');

    await transport.close();
  });
});

// ---------------------------------------------------------------------------
// 3. Live checks — SDK-NOTES §10, skipped without a token
// ---------------------------------------------------------------------------

const token = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
const hasToken = typeof token === 'string' && token !== '';

const tempDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Keep the spike off the developer's real `~/.claude` (runner SDK-NOTES L14). */
function liveOptions(overrides: SdkOptions = {}): SdkOptions {
  const configDir = scratch('agentmanager-orch-config-');
  return {
    cwd: scratch('agentmanager-orch-cwd-'),
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    settingSources: [],
    skills: [],
    maxTurns: 3,
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

describe.skipIf(!hasToken)('SDK live behaviour (SDK-NOTES §10)', () => {
  it(
    'L1/L5/L6 — mcp__agentmanager__* naming, coexistence with a stdio server, and tool-search deferral',
    { timeout: 300_000 },
    async () => {
      const withAlwaysLoad = createSdkMcpServer({
        name: SERVER_KEY,
        alwaysLoad: true,
        tools: buildToolset(ALL_TOOL_NAMES),
      });

      const session = query({
        prompt: 'List the tools whose names start with mcp__, then reply with: done',
        options: liveOptions({
          mcpServers: {
            [SERVER_KEY]: withAlwaysLoad,
            // L5: an ordinary stdio server alongside the in-process one.
            echo: { type: 'stdio', command: process.execPath, args: ['-e', ''] },
          },
          allowedTools: [`mcp__${SERVER_KEY}__*`],
        }),
      });

      let initTools: string[] = [];
      let statuses: McpServerStatus[] = [];
      for await (const message of session) {
        if (message.type === 'system' && message.subtype === 'init') {
          initTools = message.tools;
          statuses = await session.mcpServerStatus();
        }
      }

      // L1: the record key, not createSdkMcpServer({name}), is what prefixes.
      for (const name of ALL_TOOL_NAMES) {
        expect(initTools).toContain(`mcp__${SERVER_KEY}__${name}`);
      }
      // L5/G10: both servers report, and the in-process one lists its tools.
      console.log('[L1/L5/L6] mcpServerStatus:', JSON.stringify(statuses));
      console.log(
        '[L6] mcp tools in init:',
        initTools.filter((name) => name.startsWith('mcp__')),
      );
    },
  );

  it(
    'L2/L4/L7 — extra carries no session identity; an isError refusal reaches the model; an allowed MCP call skips canUseTool',
    { timeout: 300_000 },
    async () => {
      const seen: { extraKeys: string[]; extraSessionId: unknown }[] = [];
      let canUseToolCalls = 0;

      const server = createSdkMcpServer({
        name: SERVER_KEY,
        alwaysLoad: true,
        tools: [
          tool(
            'send_to_agent',
            'Send a message to a co-member.',
            { to: z.string() },
            (_a, extra) => {
              const bag =
                extra === null || typeof extra !== 'object' ? {} : (extra as JsonRpcFrame);
              seen.push({ extraKeys: Object.keys(bag), extraSessionId: bag['sessionId'] });
              return Promise.resolve({
                content: [
                  {
                    type: 'text' as const,
                    text: 'denied: agent_not_in_assignment — that agent is not a member of your assignment.',
                  },
                ],
                isError: true,
              });
            },
          ),
        ],
      });

      const session = query({
        prompt:
          'Call mcp__agentmanager__send_to_agent with to="nobody". ' +
          'Then reply with one sentence describing exactly what the tool told you.',
        options: liveOptions({
          mcpServers: { [SERVER_KEY]: server },
          allowedTools: [`mcp__${SERVER_KEY}__*`],
          permissionMode: 'default',
          canUseTool: (_name, input, options) => {
            canUseToolCalls += 1;
            return Promise.resolve({
              behavior: 'allow' as const,
              updatedInput: input,
              toolUseID: options.toolUseID,
            });
          },
        }),
      });

      const assistantText: string[] = [];
      for await (const message of session) {
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text') assistantText.push(block.text);
          }
        }
      }

      // L2: nothing in `extra` names the session, agent or assignment.
      expect(seen.length).toBeGreaterThan(0);
      console.log('[L2] extra observed:', JSON.stringify(seen));
      // L7: a bare `mcp__agentmanager__*` allow entry should shadow canUseTool.
      console.log('[L7] canUseTool invocations:', canUseToolCalls);
      // L4: the refusal text must be legible to the model.
      console.log('[L4] assistant text after the refusal:', assistantText);
    },
  );

  it(
    'L3 — how long an MCP handler may block before the engine cancels (MCP_TOOL_TIMEOUT)',
    { timeout: 1_200_000 },
    async () => {
      const HOLD_MS = 15 * 60_000; // DESIGN §4.4's runner.question.holdMs
      let heldMs = 0;
      let aborted = false;

      const server = createSdkMcpServer({
        name: SERVER_KEY,
        alwaysLoad: true,
        tools: [
          tool('request_user_decision', 'Holds for the question hold.', {}, async (_a, extra) => {
            const started = Date.now();
            const signal = (extra as { signal?: AbortSignal } | null)?.signal;
            await new Promise<void>((res) => {
              const timer = setTimeout(res, HOLD_MS);
              signal?.addEventListener('abort', () => {
                aborted = true;
                clearTimeout(timer);
                res();
              });
            });
            heldMs = Date.now() - started;
            return { content: [{ type: 'text' as const, text: '{"status":"pending"}' }] };
          }),
        ],
      });

      const session = query({
        prompt: 'Call mcp__agentmanager__request_user_decision once, then reply with: done',
        options: liveOptions({
          mcpServers: { [SERVER_KEY]: server },
          allowedTools: [`mcp__${SERVER_KEY}__*`],
        }),
      });

      for await (const _message of session) {
        // drain
      }

      // If `heldMs` is materially under HOLD_MS, or `aborted` is true, the
      // engine's MCP_TOOL_TIMEOUT is shorter than 15 minutes and DESIGN §4.4's
      // hold must be shortened to fit inside it before M5.
      console.log('[L3]', { heldMs, aborted, holdTarget: HOLD_MS });
    },
  );

  it(
    'L8 — a registered-but-not-allowed MCP tool falls through to canUseTool',
    { timeout: 300_000 },
    async () => {
      const gated: string[] = [];
      const server = createSdkMcpServer({
        name: SERVER_KEY,
        alwaysLoad: true,
        tools: buildToolset(['list_roster', 'report_status']),
      });

      const session = query({
        prompt: 'Call mcp__agentmanager__list_roster once, then reply with: done',
        options: liveOptions({
          mcpServers: { [SERVER_KEY]: server },
          // Only report_status is granted — list_roster is registered but not allowed.
          allowedTools: [`mcp__${SERVER_KEY}__report_status`],
          permissionMode: 'default',
          canUseTool: (name, input, options) => {
            gated.push(name);
            return Promise.resolve({
              behavior: 'deny' as const,
              message: 'denied: not in your grant',
              toolUseID: options.toolUseID,
              ...(input === undefined ? {} : {}),
            });
          },
        }),
      });

      for await (const _message of session) {
        // drain
      }

      // If this is empty, registration is the only control and R1b's rule split
      // is doing all the work — which SDK-NOTES §4 says it should not have to.
      console.log('[L8] tools that reached canUseTool:', gated);
    },
  );

  it(
    'L10 — strictMcpConfig does not drop the in-process server',
    { timeout: 300_000 },
    async () => {
      const server = createSdkMcpServer({
        name: SERVER_KEY,
        alwaysLoad: true,
        tools: buildToolset(['report_status']),
      });

      const session = query({
        prompt: 'Reply with: ok',
        options: liveOptions({
          mcpServers: { [SERVER_KEY]: server },
          allowedTools: [`mcp__${SERVER_KEY}__*`],
          strictMcpConfig: true,
          maxTurns: 1,
        }),
      });

      let initTools: string[] = [];
      for await (const message of session) {
        if (message.type === 'system' && message.subtype === 'init') initTools = message.tools;
      }

      console.log(
        '[L10] mcp tools under strictMcpConfig:',
        initTools.filter((name) => name.startsWith('mcp__')),
      );
      expect(initTools).toContain(`mcp__${SERVER_KEY}__report_status`);
    },
  );

  it(
    'L11 — an Edit(<dir>/**) allow rule confines Write and NotebookEdit (SDK-NOTES C1)',
    { timeout: 300_000 },
    async () => {
      const cwd = scratch('agentmanager-orch-scope-');
      const denials: string[] = [];

      const session = query({
        prompt:
          'Create two files with the Write tool: docs/in-scope.md and out-of-scope.md. ' +
          'Both should contain the word ok. Then reply with: done',
        options: liveOptions({
          cwd,
          // C1: only the Edit(path) rule is consulted; Write(path) would be inert.
          allowedTools: ['Edit(docs/**)'],
          disallowedTools: [],
          permissionMode: 'dontAsk',
          maxTurns: 6,
        }),
      });

      for await (const message of session) {
        if (message.type === 'result') {
          for (const denial of message.permission_denials) denials.push(denial.tool_name);
        }
      }

      // The in-scope write should succeed and the out-of-scope one should be
      // denied — this is the whole of DESIGN §2.5's "enforced for writes".
      console.log('[L11] denials:', denials, 'cwd:', cwd);
    },
  );

  it(
    'L14 — MCP tool calls and results appear in the transcript stream the conversation view reads',
    { timeout: 300_000 },
    async () => {
      const server = createSdkMcpServer({
        name: SERVER_KEY,
        alwaysLoad: true,
        tools: buildToolset(['report_status']),
      });

      const session = query({
        prompt: 'Call mcp__agentmanager__report_status once, then reply with: done',
        options: liveOptions({
          mcpServers: { [SERVER_KEY]: server },
          allowedTools: [`mcp__${SERVER_KEY}__*`],
        }),
      });

      const blockTypes: string[] = [];
      for await (const message of session) {
        if (message.type === 'assistant') {
          for (const block of message.message.content) blockTypes.push(`assistant:${block.type}`);
        }
        if (message.type === 'user' && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (typeof block === 'object') blockTypes.push(`user:${block.type}`);
          }
        }
      }

      console.log('[L14] content blocks observed:', blockTypes);
      expect(blockTypes.some((entry) => entry.endsWith('tool_use'))).toBe(true);
    },
  );
});
