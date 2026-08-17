/**
 * A scripted `query()` — the fake behind every M3 session-mechanics test.
 *
 * The seam is `RunnerModuleOptions.query` / `LaunchChainDeps.query` (`sdk.ts`):
 * production passes the real `query`, a test passes {@link scriptedQuery}. What
 * it yields is not invented — every message shape here is the one SDK-NOTES
 * records against the pinned SDK 0.3.233, and each is built as a real
 * `SDKMessage` so a change to the union breaks this file at `tsc` rather than
 * at runtime:
 *
 * - `system/init` carries the full §3.2 field set, including
 *   `claude_code_version`, `apiKeySource` and `capabilities`;
 * - an `assistant` message is a `BetaMessage` with content blocks — a
 *   `tool_use` block is how a tool call arrives, because SDK-NOTES G2 is
 *   explicit that there is no `tool_use` *message* type;
 * - a `tool_result` comes back as a `user` message with the structured twin on
 *   `tool_use_result`;
 * - a **replayed** history line is a `user` message with `isReplay: true`
 *   (SDK-NOTES G1), which the reader loop must drop;
 * - every turn ends with its own `result` (§2.4, L9), and trailing system
 *   messages arrive *after* it (`session_state_changed`, SDK-NOTES §3.2).
 *
 * The generator honours `options.abortController`, because that is how runner's
 * start timeout and §9.1's shutdown actually end a session — a fake that
 * ignored the signal would make the timeout untestable.
 */
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type { SdkOptions } from '../contracts.js';
import type { QueryFn, SdkSession } from '../sdk.js';

const SESSION_ID = '9f2a2b64-1f3e-4a6b-9a41-000000000001';

let uuidCounter = 0;
function uuid(): `${string}-${string}-${string}-${string}-${string}` {
  uuidCounter += 1;
  const tail = String(uuidCounter).padStart(12, '0');
  return `00000000-0000-4000-8000-${tail}`;
}

export interface FakeInitOptions {
  readonly sessionId?: string;
  readonly model?: string;
  readonly permissionMode?: SDKSystemMessage['permissionMode'];
  readonly tools?: string[];
  readonly mcpServers?: { name: string; status: string }[];
  readonly capabilities?: string[];
}

export function fakeInit(options: FakeInitOptions = {}): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'oauth',
    claude_code_version: '2.1.233',
    cwd: 'C:\\workspace',
    tools: options.tools ?? ['Read', 'Write', 'Bash'],
    mcp_servers: options.mcpServers ?? [],
    model: options.model ?? 'claude-sonnet-4-5',
    permissionMode: options.permissionMode ?? 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    capabilities: options.capabilities ?? ['interrupt_receipt_v1'],
    uuid: uuid(),
    session_id: options.sessionId ?? SESSION_ID,
  };
}

export interface FakeAssistantOptions {
  readonly text?: string;
  readonly toolUse?: { readonly id: string; readonly name: string; readonly input: unknown };
  readonly messageId?: string;
  readonly sessionId?: string;
}

export function fakeAssistant(options: FakeAssistantOptions = {}): SDKAssistantMessage {
  const content: SDKAssistantMessage['message']['content'] = [];
  if (options.text !== undefined) content.push({ type: 'text', text: options.text, citations: [] });
  if (options.toolUse !== undefined) {
    content.push({
      type: 'tool_use',
      id: options.toolUse.id,
      name: options.toolUse.name,
      input: options.toolUse.input,
    });
  }

  return {
    type: 'assistant',
    message: {
      id: options.messageId ?? 'msg_01FAKE',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content,
      container: null,
      context_management: null,
      diagnostics: null,
      stop_details: null,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: null,
        fallback_credit: null,
        inference_geo: null,
        iterations: null,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
        speed: null,
      },
    },
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: options.sessionId ?? SESSION_ID,
  };
}

export interface FakeToolResultOptions {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError?: boolean;
  /** The structured twin the SDK puts on `tool_use_result` (SDK-NOTES §3.2). */
  readonly output?: unknown;
  readonly sessionId?: string;
}

export function fakeToolResult(options: FakeToolResultOptions): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: options.toolUseId,
          content: options.content,
          is_error: options.isError ?? false,
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: options.sessionId ?? SESSION_ID,
    ...(options.output === undefined ? {} : { tool_use_result: options.output }),
  };
}

/**
 * A replayed history line — SDK-NOTES G1's `SDKUserMessageReplay`.
 *
 * Cast because `isReplay: true` selects a *different* union member whose other
 * fields runner never reads; what matters for the filter under test is the
 * discriminating flag.
 */
export function fakeReplay(text: string): SDKMessage {
  return {
    type: 'user',
    isReplay: true,
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: SESSION_ID,
  } as unknown as SDKMessage;
}

export interface FakeResultOptions {
  readonly subtype?: SDKResultMessage['subtype'];
  readonly text?: string;
  readonly errors?: string[];
  readonly costUsd?: number;
  readonly turns?: number;
  readonly permissionDenials?: SDKResultMessage['permission_denials'];
  readonly terminalReason?: SDKResultMessage['terminal_reason'];
  readonly sessionId?: string;
}

export function fakeResult(options: FakeResultOptions = {}): SDKResultMessage {
  const subtype = options.subtype ?? 'success';
  const common = {
    duration_ms: 1234,
    duration_api_ms: 900,
    num_turns: options.turns ?? 1,
    session_id: options.sessionId ?? SESSION_ID,
    total_cost_usd: options.costUsd ?? 0.0123,
    // `SDKResultMessage.usage` is `NonNullableUsage` — every `BetaUsage` field
    // present and non-null. Only the token counts matter to runner, so the rest
    // are the zero/`standard` values a real turn reports.
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      inference_geo: 'us',
      output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: 'standard',
      speed: 'standard',
    },
    modelUsage: {
      'claude-sonnet-4-5': {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: options.costUsd ?? 0.0123,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      },
    },
    permission_denials: options.permissionDenials ?? [],
    stop_reason: 'end_turn',
    uuid: uuid(),
    ...(options.terminalReason === undefined ? {} : { terminal_reason: options.terminalReason }),
  };

  if (subtype === 'success') {
    return {
      ...common,
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: options.text ?? 'Done.',
    } as unknown as SDKResultMessage;
  }

  return {
    ...common,
    type: 'result',
    subtype,
    is_error: true,
    errors: options.errors ?? ['the turn failed'],
  } as unknown as SDKResultMessage;
}

/** A trailing system message — SDK-NOTES §3.2's "authoritative turn-over signal". */
export function fakeSessionStateChanged(
  state: 'idle' | 'running' | 'requires_action' = 'idle',
): SDKMessage {
  return {
    type: 'system',
    subtype: 'session_state_changed',
    state,
    uuid: uuid(),
    session_id: SESSION_ID,
  } as unknown as SDKMessage;
}

/** A message type this build has never heard of (§7.4's tolerance requirement). */
export function fakeUnknownMessage(): SDKMessage {
  return {
    type: 'a_message_type_from_a_future_sdk',
    uuid: uuid(),
    session_id: SESSION_ID,
  } as unknown as SDKMessage;
}

export interface ScriptedQueryOptions {
  /** The messages to yield, in order. */
  readonly messages: readonly SDKMessage[];
  /** Thrown out of the generator after the last message — SDK-NOTES §9.3. */
  readonly throwAfter?: unknown;
  /** Never yields anything and waits for the abort signal (§3.2's start timeout). */
  readonly hang?: boolean;
  /** Called with what runner actually passed to `query()`. */
  readonly onCall?: (args: { prompt: AsyncIterable<SDKUserMessage>; options: SdkOptions }) => void;
  /** Writes to `options.stderr` before yielding, for the failure-message tests. */
  readonly stderr?: string;
}

export interface ScriptedQuery {
  readonly query: QueryFn;
  /** Every call's options, for the §3.3 immutability assertion. */
  readonly calls: { prompt: AsyncIterable<SDKUserMessage>; options: SdkOptions }[];
  /** The user messages runner pushed onto the input queue. */
  readonly pushed: SDKUserMessage[];
  readonly interrupts: number;
  readonly closes: number;
}

/**
 * Builds a `query` that replays `messages` and then completes — the streaming
 * session's generator ending, which is what §2.4 step 4 waits for.
 */
export function scriptedQuery(options: ScriptedQueryOptions): ScriptedQuery {
  const state: {
    calls: { prompt: AsyncIterable<SDKUserMessage>; options: SdkOptions }[];
    pushed: SDKUserMessage[];
    interrupts: number;
    closes: number;
  } = { calls: [], pushed: [], interrupts: 0, closes: 0 };

  const query: QueryFn = (args) => {
    state.calls.push(args);
    options.onCall?.(args);

    // The real wrapper pumps the input iterable lazily and one message per
    // iteration (SDK-NOTES §2.2); draining it in the background is what makes
    // "the prompt reached the SDK" observable.
    void (async () => {
      try {
        for await (const message of args.prompt) state.pushed.push(message);
      } catch {
        // The queue never throws (§4.2); if it ever did, the SDK would abort.
      }
    })();

    const signal = args.options.abortController?.signal;

    async function* replay(): AsyncGenerator<SDKMessage, void> {
      if (options.stderr !== undefined) args.options.stderr?.(options.stderr);

      if (options.hang === true) {
        await new Promise<void>((resolve) => {
          if (signal === undefined) return;
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => {
            resolve();
          });
        });
        return;
      }

      for (const message of options.messages) {
        if (signal?.aborted === true) return;
        // A tick between messages, so the loop under test really is
        // asynchronous rather than a synchronous array walk.
        await Promise.resolve();
        yield message;
      }
      if (options.throwAfter !== undefined) {
        // Whatever the caller supplied, Error or not: SDK-NOTES §9.3 shows the
        // wrapper *replacing* the thrown value, so runner has to survive both.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw options.throwAfter;
      }
    }

    const generator = replay();
    const session: SdkSession = {
      [Symbol.asyncIterator]: () => generator[Symbol.asyncIterator](),
      interrupt: () => {
        state.interrupts += 1;
        return Promise.resolve(undefined);
      },
      close: () => {
        state.closes += 1;
        return Promise.resolve();
      },
    };
    return session;
  };

  return {
    query,
    get calls() {
      return state.calls;
    },
    get pushed() {
      return state.pushed;
    },
    get interrupts() {
      return state.interrupts;
    },
    get closes() {
      return state.closes;
    },
  };
}

/** The happy path: init, one assistant turn, a success result, a trailing system line. */
export function successScript(text = 'All done.'): SDKMessage[] {
  return [
    fakeInit(),
    fakeAssistant({ text }),
    fakeResult({ text }),
    fakeSessionStateChanged('idle'),
  ];
}
