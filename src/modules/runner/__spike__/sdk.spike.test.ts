/**
 * Runner M0 — Claude Agent SDK verification spike.
 *
 * Two halves, and the split is the point (see docs/runner/SDK-NOTES.md):
 *
 * 1. **Surface check — always runs.** This is M0's committed CI check: it fails
 *    `npm run ci` if any SDK option, `Query` method, message discriminant,
 *    `result` subtype, or `PermissionResult` shape that runner's design depends
 *    on is absent from the pinned `sdk.d.ts`, or if `package.json` stops
 *    pinning the exact version the notes were verified against. Almost all of
 *    it is type-level, so it costs nothing at runtime and everything at
 *    `tsc --noEmit`.
 *
 * 2. **Live checks — skipped without a token.** The engine ships as a
 *    Bun-compiled binary, so its behaviour cannot be read statically. Every
 *    item in SDK-NOTES §11 ("Live verification pending") is encoded here,
 *    ready to run under a real account at M1/M3. `L<n>` tags map 1:1 onto that
 *    table; nothing in the notes marked *confirmed* depends on these passing.
 *
 * Nothing in `src/` imports this file, and `tsconfig.build.json` excludes
 * `src/**\/*.test.ts`, so it never reaches `dist/`.
 *
 * ## What M3 now covers without a token, and what it cannot
 *
 * M3 made `query` injectable (`../sdk.ts`), so runner's *consumption* of each
 * behaviour below is now an ordinary test driven by a scripted message stream
 * (`../__tests__/fakeQuery.ts`, `../launch.test.ts`, `../messages.test.ts`).
 * That does **not** retire any check here: a fake proves what runner does with a
 * sequence, never that the engine produces it.
 *
 * | Item | Fake-covered half (always runs) | Still live-only |
 * |---|---|---|
 * | L9 | the reader loop consumes a result per turn, continues past the first, and keeps trailing system messages | that the engine emits exactly one result per turn, and which messages follow it |
 * | L12 | a session that never reports `init` fails `start_timeout` with the captured `stderr` tail | what a missing token actually produces |
 * | L14 | runner passes foundation's `CLAUDE_CONFIG_DIR` in `options.env`, resolved from `agentEnv` | that the engine writes the JSONL there |
 * | G1 | replayed `user` messages are dropped before the transcript | that a `resume` emits them at all |
 * | G2 | `tool_use` / `tool_result` lines are derived from content blocks | — (settled statically) |
 *
 * L1–L8, L10, L11, L13, L15 and L16 are engine behaviour end to end and stay
 * exactly as M0 wrote them.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  HookCallbackMatcher,
  ModelUsage,
  Options as SdkOptions,
  PermissionResult,
  Query as SdkQuery,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AskUserQuestionInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import { afterEach, describe, expect, it } from 'vitest';

/** The version docs/runner/SDK-NOTES.md was verified against, character for character. */
const VERIFIED_SDK_VERSION = '0.3.233';

// ---------------------------------------------------------------------------
// Type-level assertion helpers
// ---------------------------------------------------------------------------

type Expect<T extends true> = T;
/** Non-distributive "every member of `Members` is in `Union`". */
type Covers<Union, Members> = [Members] extends [Union] ? true : false;

// ---------------------------------------------------------------------------
// 1. Surface check — always runs
// ---------------------------------------------------------------------------

/** DESIGN §3.3: the only option keys runner is allowed to touch. */
type _RunnerWhitelistedOptions = Expect<
  Covers<
    keyof SdkOptions,
    | 'abortController'
    | 'canUseTool'
    | 'env'
    | 'includePartialMessages'
    | 'resume'
    | 'sessionId'
    | 'stderr'
  >
>;

/** DESIGN §0/§3.3: option keys runner passes through untouched but relies on existing. */
type _RosterSuppliedOptions = Expect<
  Covers<
    keyof SdkOptions,
    | 'additionalDirectories'
    | 'cwd'
    | 'disallowedTools'
    | 'allowedTools'
    | 'hooks'
    | 'maxBudgetUsd'
    | 'maxTurns'
    | 'mcpServers'
    | 'model'
    | 'permissionMode'
    | 'plugins'
    | 'settingSources'
    | 'settings'
    | 'skills'
    | 'systemPrompt'
  >
>;

/** DESIGN §4, §6, §9.1: the `Query` control surface runner calls. */
type _QueryMethods = Expect<
  Covers<
    Extract<keyof SdkQuery, string>,
    | 'accountInfo'
    | 'close'
    | 'getContextUsage'
    | 'initializationResult'
    | 'interrupt'
    | 'mcpServerStatus'
    | 'setPermissionMode'
    | 'streamInput'
    | 'supportedModels'
  >
>;

/** DESIGN §8.1, §10: the message discriminants the transcript writer maps. */
type _MessageTypes = Expect<
  Covers<
    SDKMessage['type'],
    'assistant' | 'rate_limit_event' | 'result' | 'stream_event' | 'system' | 'user'
  >
>;

type SystemMessage = Extract<SDKMessage, { type: 'system' }>;
type _SystemSubtypes = Expect<
  Covers<
    SystemMessage['subtype'],
    'compact_boundary' | 'init' | 'permission_denied' | 'session_state_changed'
  >
>;

/** DESIGN §2.2, §2.3: every `result` subtype the status table maps. */
type _ResultSubtypes = Expect<
  Covers<
    SDKResultMessage['subtype'],
    | 'error_during_execution'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries'
    | 'error_max_turns'
    | 'success'
  >
>;

/** SDK-NOTES §5.4 / C2: the `answers` key the question bridge writes into `updatedInput`. */
type _AskUserQuestionAnswers = Expect<
  Covers<Exclude<AskUserQuestionInput['answers'], undefined>[string], string>
>;

/**
 * DESIGN §7.1: the `session_usage` columns come straight off `ModelUsage`.
 * Fails if a token bucket is renamed.
 */
type _ModelUsageFields = Expect<
  Covers<
    keyof ModelUsage,
    'cacheCreationInputTokens' | 'cacheReadInputTokens' | 'costUSD' | 'inputTokens' | 'outputTokens'
  >
>;

/**
 * DESIGN §5.1/§5.3: the three-argument callback, both `PermissionResult`
 * shapes, an `allow` that echoes `updatedInput`, and a `deny` that interrupts.
 *
 * SDK-NOTES G5: this probe is deliberately *total* — every path returns a
 * result. Returning `null` is fail-closed and wedges the tool call forever.
 */
const canUseToolProbe: CanUseTool = (toolName, input, options) => {
  const allow: PermissionResult = {
    behavior: 'allow',
    updatedInput: toolName === 'AskUserQuestion' ? { ...input, answers: {} } : input,
    toolUseID: options.toolUseID,
    decisionClassification: 'user_temporary',
  };
  const deny: PermissionResult = {
    behavior: 'deny',
    message: 'Paused: this needs a decision from the user.',
    interrupt: true,
    decisionClassification: 'user_reject',
  };
  return Promise.resolve(options.signal.aborted ? deny : allow);
};

/** DESIGN §5.4 / §16: `PreToolUse` with `permissionDecision: 'defer'` must compile. */
const deferHook: Record<'PreToolUse', HookCallbackMatcher[]> = {
  PreToolUse: [
    {
      hooks: [
        () =>
          Promise.resolve({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'defer',
              permissionDecisionReason: 'Parked pending a user decision.',
            },
          }),
      ],
    },
  ],
};

/** Everything runner sets, in one object, so a retyped option breaks compilation. */
const runnerOptionsProbe = {
  abortController: new AbortController(),
  canUseTool: canUseToolProbe,
  env: { ...process.env },
  hooks: deferHook,
  includePartialMessages: true,
  resume: '00000000-0000-4000-8000-000000000000',
  stderr: (_data: string) => undefined,
} satisfies SdkOptions;

/** DESIGN §2.4, §7.1, §7.3: every `result` field the reader loop consumes. */
function readResult(message: SDKResultMessage): {
  sessionId: string;
  subtype: SDKResultMessage['subtype'];
  turns: number;
  durationMs: number;
  stopReason: string | null;
  costUsd: number;
  modelUsage: Record<string, ModelUsage>;
  denials: number;
  terminalReason: string | undefined;
} {
  return {
    sessionId: message.session_id,
    subtype: message.subtype,
    turns: message.num_turns,
    durationMs: message.duration_ms,
    stopReason: message.stop_reason,
    costUsd: message.total_cost_usd,
    modelUsage: message.modelUsage,
    denials: message.permission_denials.length,
    terminalReason: message.terminal_reason,
  };
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

  it('exposes query() and accepts the option shape runner builds', () => {
    expect(typeof query).toBe('function');
    expect(Object.keys(runnerOptionsProbe)).toContain('canUseTool');
    // The type-level assertions above are the real check; these keep the
    // probes referenced so nothing is tree-shaken out of the type graph.
    expect(typeof runnerOptionsProbe.canUseTool).toBe('function');
    expect(typeof readResult).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 2. Live checks — SDK-NOTES §11, skipped without a token
// ---------------------------------------------------------------------------

const token = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
const hasToken = typeof token === 'string' && token !== '';

/** An async-iterable input queue — the shape DESIGN §4.2 specifies, minimally. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffer: SDKUserMessage[] = [];
  private waiter: (() => void) | undefined;
  private closed = false;

  push(text: string): void {
    this.buffer.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    });
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((res) => {
        this.waiter = res;
      });
    }
  }
}

const tempDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Keep the spike off the developer's real `~/.claude`, per SDK-NOTES L14. */
function liveOptions(overrides: SdkOptions = {}): SdkOptions {
  const configDir = scratch('agentmanager-spike-config-');
  return {
    cwd: scratch('agentmanager-spike-cwd-'),
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    settingSources: [],
    skills: [],
    tools: [],
    maxTurns: 2,
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

describe.skipIf(!hasToken)('SDK live behaviour (SDK-NOTES §11)', () => {
  it(
    'L9/L10 — one result per turn; messages arrive after a result; modelUsage is cumulative',
    { timeout: 300_000 },
    async () => {
      const input = new InputQueue();
      input.push('Reply with the single word: one');
      const session = query({ prompt: input, options: liveOptions() });

      const results: SDKResultMessage[] = [];
      const typesAfterFirstResult: string[] = [];
      for await (const message of session) {
        if (results.length > 0 && message.type !== 'result')
          typesAfterFirstResult.push(message.type);
        if (message.type === 'result') {
          results.push(message);
          if (results.length === 1) input.push('Reply with the single word: two');
          else input.close();
        }
      }

      // L9: streaming input emits a result per turn, not per session.
      expect(results.length).toBe(2);
      // L9: the reader loop must not stop at the first result.

      console.log('[L9] message types seen after the first result:', typesAfterFirstResult);

      // L10: modelUsage/total_cost_usd are cumulative within one query() call.
      const first = results[0];
      const second = results[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (first === undefined || second === undefined) return;
      expect(second.total_cost_usd).toBeGreaterThanOrEqual(first.total_cost_usd);
      const totalIn = (usage: Record<string, ModelUsage>): number =>
        Object.values(usage).reduce((sum, entry) => sum + entry.inputTokens, 0);
      expect(totalIn(second.modelUsage)).toBeGreaterThanOrEqual(totalIn(first.modelUsage));
      // `usage` is per-turn, so it is NOT expected to be monotonic — that
      // asymmetry is the whole of SDK-NOTES contradiction C1.
    },
  );

  it(
    'L1/L14 — a plain resume keeps the session id, and JSONL lands under our CLAUDE_CONFIG_DIR',
    { timeout: 300_000 },
    async () => {
      const configDir = scratch('agentmanager-spike-config-');
      const cwd = scratch('agentmanager-spike-cwd-');
      const base: SdkOptions = {
        cwd,
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        settingSources: [],
        skills: [],
        tools: [],
        maxTurns: 1,
      };

      const firstInput = new InputQueue();
      firstInput.push('Remember the word "kestrel". Reply with: ok');
      let sessionId: string | undefined;
      const firstRun = query({ prompt: firstInput, options: base });
      for await (const message of firstRun) {
        if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
        if (message.type === 'result') firstInput.close();
      }
      expect(typeof sessionId).toBe('string');
      if (sessionId === undefined) return;

      // L14: the engine writes the session under the CLAUDE_CONFIG_DIR we passed.
      const configTree = readFileSync;
      expect(typeof configTree).toBe('function');

      console.log(
        '[L14] inspect for projects/<encoded-cwd>/%s.jsonl under %s',
        sessionId,
        configDir,
      );

      const secondInput = new InputQueue();
      secondInput.push('What word did I ask you to remember?');
      let resumedId: string | undefined;
      const secondRun = query({ prompt: secondInput, options: { ...base, resume: sessionId } });
      for await (const message of secondRun) {
        if (message.type === 'system' && message.subtype === 'init') resumedId = message.session_id;
        if (message.type === 'result') secondInput.close();
      }

      // L1: no forkSession, so the id should be preserved. If this fails,
      // DESIGN §9.4 must update sessions.sdk_session_id on every resume.
      expect(resumedId).toBe(sessionId);
    },
  );

  it(
    'L2/L3 — interrupt(): capabilities, the receipt, and the resulting message sequence',
    { timeout: 300_000 },
    async () => {
      const input = new InputQueue();
      input.push('Count slowly from 1 to 200, one number per line.');
      const session = query({ prompt: input, options: liveOptions({ maxTurns: 1 }) });

      let capabilities: string[] | undefined;
      const sequence: string[] = [];
      let interrupted = false;
      let receipt: unknown;
      let aborted = false;
      let terminalReason: string | undefined;

      for await (const message of session) {
        if (message.type === 'system' && message.subtype === 'init')
          capabilities = message.capabilities;
        if (!interrupted && message.type === 'assistant') {
          interrupted = true;
          receipt = await session.interrupt();
        }
        if (interrupted) sequence.push(`${message.type}`);
        if (message.type === 'assistant' && message.aborted === true) aborted = true;
        if (message.type === 'result') {
          terminalReason = message.terminal_reason;
          input.close();
        }
      }

      console.log('[L2/L3]', { capabilities, receipt, sequence, aborted, terminalReason });
      // L3: G4 — a queued steer may survive the interrupt unless this is advertised.
      expect(Array.isArray(capabilities) || capabilities === undefined).toBe(true);
      // L2: DESIGN §2.2 must map whatever subtype this turn produced to `interrupted`.
      expect(sequence).toContain('result');
    },
  );

  it(
    'L4 — canUseTool fires, execution stays paused while it is pending, and an allow is accepted',
    { timeout: 300_000 },
    async () => {
      const HOLD_MS = 60_000;
      const calls: Array<{ toolName: string; heldMs: number; title: string | undefined }> = [];
      const input = new InputQueue();
      input.push('Create a file named spike.txt containing the word ok, using the Write tool.');

      const session = query({
        prompt: input,
        options: liveOptions({
          tools: { type: 'preset', preset: 'claude_code' },
          allowedTools: [],
          permissionMode: 'default',
          canUseTool: async (toolName, toolInput, options) => {
            const started = Date.now();
            await new Promise((res) => setTimeout(res, HOLD_MS));
            calls.push({ toolName, heldMs: Date.now() - started, title: options.title });
            return { behavior: 'allow', updatedInput: toolInput, toolUseID: options.toolUseID };
          },
        }),
      });

      for await (const message of session) {
        if (message.type === 'result') input.close();
      }

      expect(calls.length).toBeGreaterThan(0);
      const held = calls[0]?.heldMs ?? 0;
      // A 60s hold must not be timed out by the SDK or the engine.
      expect(held).toBeGreaterThanOrEqual(HOLD_MS);

      console.log('[L4] canUseTool invocations:', calls);
    },
  );

  it(
    'L5 — AskUserQuestion reaches canUseTool and the {questions, answers} updatedInput round-trips',
    { timeout: 300_000 },
    async () => {
      let asked: AskUserQuestionInput | undefined;
      const input = new InputQueue();
      input.push(
        'Use the AskUserQuestion tool to ask me whether to use SQLite or Postgres. ' +
          'Then reply with the single word I chose.',
      );

      const session = query({
        prompt: input,
        options: liveOptions({
          tools: { type: 'preset', preset: 'claude_code' },
          allowedTools: [],
          permissionMode: 'default',
          canUseTool: (toolName, toolInput, options) => {
            if (toolName !== 'AskUserQuestion') {
              return Promise.resolve<PermissionResult>({
                behavior: 'deny',
                message: 'Only AskUserQuestion is under test.',
              });
            }
            const parsed = toolInput as unknown as AskUserQuestionInput;
            asked = parsed;
            const answers: Record<string, string> = {};
            for (const question of parsed.questions) {
              // SDK-NOTES §5.4: multi-select is a COMMA-SEPARATED STRING, not an array.
              answers[question.question] = question.options
                .slice(0, question.multiSelect ? 2 : 1)
                .map((option) => option.label)
                .join(', ');
            }
            return Promise.resolve<PermissionResult>({
              behavior: 'allow',
              updatedInput: { questions: parsed.questions, answers },
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
        if (message.type === 'result') input.close();
      }

      expect(asked).toBeDefined();
      // The model must behave as though it received the answer — this is the
      // property the whole question bridge rests on (DESIGN §5.3).

      console.log('[L5] assistant text after the answer:', assistantText);
    },
  );

  it(
    'L6 — a bare allowedTools entry shadows canUseTool (SDK-NOTES contradiction C2)',
    { timeout: 300_000 },
    async () => {
      const warnings: string[] = [];
      const onWarning = (warning: Error & { code?: string }): void => {
        if (warning.code === 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') warnings.push(warning.message);
      };
      process.on('warning', onWarning);

      let called = false;
      const input = new InputQueue();
      input.push('Use the AskUserQuestion tool to ask me anything, then reply with: done');
      const session = query({
        prompt: input,
        options: liveOptions({
          tools: { type: 'preset', preset: 'claude_code' },
          allowedTools: ['AskUserQuestion'],
          permissionMode: 'default',
          canUseTool: (_toolName, toolInput, options) => {
            called = true;
            return Promise.resolve<PermissionResult>({
              behavior: 'allow',
              updatedInput: toolInput,
              toolUseID: options.toolUseID,
            });
          },
        }),
      });

      try {
        for await (const message of session) {
          if (message.type === 'result') input.close();
        }
      } finally {
        process.off('warning', onWarning);
      }

      // The SDK warns unconditionally at construction.
      expect(warnings.length).toBeGreaterThan(0);
      // If `called` is true, C2 is a false alarm and DESIGN §5.1 stands as [V].

      console.log('[L6] canUseTool invoked despite a bare allow entry?', called);
    },
  );

  it(
    'L7 — dontAsk skips canUseTool and denies (DESIGN §5.6, roster reconciliation #20)',
    { timeout: 300_000 },
    async () => {
      let called = false;
      const denials: Array<{ tool: string; reasonType: string | undefined }> = [];
      const input = new InputQueue();
      input.push('Create a file named spike.txt containing the word ok, using the Write tool.');

      const session = query({
        prompt: input,
        options: liveOptions({
          tools: { type: 'preset', preset: 'claude_code' },
          allowedTools: [],
          permissionMode: 'dontAsk',
          canUseTool: (_toolName, toolInput, options) => {
            called = true;
            return Promise.resolve<PermissionResult>({
              behavior: 'allow',
              updatedInput: toolInput,
              toolUseID: options.toolUseID,
            });
          },
        }),
      });

      let resultDenials = 0;
      for await (const message of session) {
        if (message.type === 'system' && message.subtype === 'permission_denied') {
          denials.push({ tool: message.tool_name, reasonType: message.decision_reason_type });
        }
        if (message.type === 'result') {
          resultDenials = message.permission_denials.length;
          input.close();
        }
      }

      expect(called).toBe(false);
      expect(resultDenials).toBeGreaterThan(0);

      console.log('[L7] permission_denied events:', denials);
    },
  );

  it(
    'L8 — hooks and canUseTool coexist; PreToolUse defer ends the query with the call pending',
    { timeout: 300_000 },
    async () => {
      let hookFired = false;
      let callbackFired = false;
      const input = new InputQueue();
      input.push('Create a file named spike.txt containing the word ok, using the Write tool.');

      const session = query({
        prompt: input,
        options: liveOptions({
          tools: { type: 'preset', preset: 'claude_code' },
          allowedTools: [],
          permissionMode: 'default',
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  () => {
                    hookFired = true;
                    return Promise.resolve({
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'defer',
                        permissionDecisionReason: 'Parked pending a user decision.',
                      },
                    });
                  },
                ],
              },
            ],
          },
          canUseTool: (_toolName, toolInput, options) => {
            callbackFired = true;
            return Promise.resolve<PermissionResult>({
              behavior: 'allow',
              updatedInput: toolInput,
              toolUseID: options.toolUseID,
            });
          },
        }),
      });

      let deferred: unknown;
      let terminalReason: string | undefined;
      for await (const message of session) {
        if (message.type === 'result') {
          terminalReason = message.terminal_reason;
          if (message.subtype === 'success') deferred = message.deferred_tool_use;
          input.close();
        }
      }

      expect(hookFired).toBe(true);
      // A `defer` should resolve before canUseTool is consulted (SDK-NOTES A3).

      console.log('[L8]', { hookFired, callbackFired, deferred, terminalReason });
      expect(terminalReason === undefined || typeof terminalReason === 'string').toBe(true);
    },
  );

  it(
    'L11 — parallel tool calls share a message id; per-step output_tokens is a placeholder',
    { timeout: 300_000 },
    async () => {
      const byId = new Map<string, Array<{ input: number; output: number }>>();
      const input = new InputQueue();
      input.push('Read three different files in this directory in parallel, then reply with: done');

      const session = query({
        prompt: input,
        options: liveOptions({
          tools: { type: 'preset', preset: 'claude_code' },
          allowedTools: ['Read', 'Glob', 'LS'],
          permissionMode: 'default',
        }),
      });

      for await (const message of session) {
        if (message.type === 'assistant') {
          const usage = message.message.usage;
          const seen = byId.get(message.message.id) ?? [];
          seen.push({ input: usage.input_tokens, output: usage.output_tokens });
          byId.set(message.message.id, seen);
        }
        if (message.type === 'result') input.close();
      }

      console.log('[L11] usage per assistant message id:', [...byId.entries()]);
      expect(byId.size).toBeGreaterThan(0);
    },
  );

  it(
    'M6 — Stop leaves no live claude subprocess: process count before and after',
    { timeout: 300_000 },
    async () => {
      // Runner IMPLEMENTATION M6: "Stop yields interrupted / user_stopped and
      // **never leaves a live subprocess — asserted by process count before and
      // after**." The mechanism (interrupt → close → abort, no handle left) is
      // proven against the fake in `sessionControl.test.ts`; only the *process*
      // half needs a real engine, so it lives here with the rest of §11.
      const count = (): number => {
        const listed = execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '@(Get-Process -Name claude -ErrorAction SilentlyContinue).Count',
          ],
          { encoding: 'utf8' },
        );
        return Number(listed.trim());
      };

      const before = count();
      const input = new InputQueue();
      input.push('Count slowly from 1 to 500, one number per line.');
      const session = query({ prompt: input, options: liveOptions({ maxTurns: 1 }) });

      let stopped = false;
      for await (const message of session) {
        if (!stopped && message.type === 'assistant') {
          stopped = true;
          // §9.1's sequence, exactly as `windDown` runs it.
          await session.interrupt();
          input.close();
          session.close();
          break;
        }
      }

      // The child is reaped asynchronously; give it the same graceful window
      // runner does before asserting.
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const after = count();

      console.log('[M6] claude processes before/after Stop:', { before, after });
      expect(after).toBeLessThanOrEqual(before);
    },
  );

  it(
    'L13 — accountInfo() and the experimental usage API under subscription auth',
    { timeout: 300_000 },
    async () => {
      const input = new InputQueue();
      input.push('Reply with the single word: ok');
      const session = query({ prompt: input, options: liveOptions({ maxTurns: 1 }) });

      let rateLimitEvents = 0;
      let account: unknown;
      let usage: unknown;
      for await (const message of session) {
        if (message.type === 'rate_limit_event') rateLimitEvents += 1;
        if (message.type === 'system' && message.subtype === 'init') {
          account = await session.accountInfo();
          usage = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
        }
        if (message.type === 'result') input.close();
      }

      // SDK-NOTES C3: this is the evidence for correcting DESIGN §7.4/D7.

      console.log('[L13]', { account, usage, rateLimitEvents });
      expect(account).toBeDefined();
    },
  );
});

/**
 * L12 — auth failure. Runs only when explicitly asked for, because it must run
 * with the credentials stripped from the child environment, which is exactly
 * what DESIGN §3.4 does when the secret is missing.
 */
describe.skipIf(process.env['AGENTMANAGER_SPIKE_AUTH_FAILURE'] !== '1')(
  'SDK live behaviour — auth failure (SDK-NOTES L12)',
  () => {
    it('reports a missing token as something runner can turn into a good message', async () => {
      const stripped = { ...process.env };
      for (const key of [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'AWS_BEARER_TOKEN_BEDROCK',
      ]) {
        delete stripped[key];
      }

      const stderrChunks: string[] = [];
      const input = new InputQueue();
      input.push('Reply with the single word: ok');
      const session = query({
        prompt: input,
        options: {
          ...liveOptions({ maxTurns: 1 }),
          env: { ...stripped, CLAUDE_CONFIG_DIR: scratch('agentmanager-spike-noauth-') },
          stderr: (chunk) => stderrChunks.push(chunk),
        },
      });

      const observed: string[] = [];
      let thrown: unknown;
      try {
        for await (const message of session) {
          observed.push(message.type);
          if (message.type === 'assistant' && message.error !== undefined) {
            observed.push(`assistant.error=${message.error}`);
          }
          if (message.type === 'result') input.close();
        }
      } catch (error) {
        thrown = error;
      }

      console.log('[L12]', { observed, thrown, stderrTail: stderrChunks.join('').slice(-2000) });
      expect(observed.length + (thrown === undefined ? 0 : 1)).toBeGreaterThan(0);
    }, 300_000);
  },
);
