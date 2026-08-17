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
  readonly model?: string;
  /** `message.message.usage` — M4's live per-message delta (§7.1). */
  readonly usage?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheCreation?: number;
  };
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
      model: options.model ?? 'claude-sonnet-4-5',
      content,
      container: null,
      context_management: null,
      diagnostics: null,
      stop_details: null,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: options.usage?.input ?? 120,
        output_tokens: options.usage?.output ?? 30,
        cache_creation_input_tokens: options.usage?.cacheCreation ?? 0,
        cache_read_input_tokens: options.usage?.cacheRead ?? 0,
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

/** Per-model totals, in `ModelUsage`'s own field names (SDK-NOTES §6.1). */
export interface FakeModelUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheCreation?: number;
  readonly costUsd?: number;
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
  /** `result.usage` — main loop only, and genuinely per-turn (C1). */
  readonly usage?: { readonly input: number; readonly output: number };
  /**
   * `result.modelUsage` — cumulative per `query()` call, the reconciliation
   * source of §7.1. Keyed by model name.
   */
  readonly modelUsage?: Readonly<Record<string, FakeModelUsage>>;
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
      input_tokens: options.usage?.input ?? 120,
      output_tokens: options.usage?.output ?? 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      inference_geo: 'us',
      output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: 'standard',
      speed: 'standard',
    },
    modelUsage: Object.fromEntries(
      Object.entries(
        options.modelUsage ?? {
          'claude-sonnet-4-5': { input: 120, output: 30, costUsd: options.costUsd ?? 0.0123 },
        },
      ).map(([model, usage]) => [
        model,
        {
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadInputTokens: usage.cacheRead ?? 0,
          cacheCreationInputTokens: usage.cacheCreation ?? 0,
          webSearchRequests: 0,
          costUSD: usage.costUsd ?? options.costUsd ?? 0.0123,
          contextWindow: 200_000,
          maxOutputTokens: 64_000,
        },
      ]),
    ),
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

/**
 * A `rate_limit_event` (SDK-NOTES §7.1).
 *
 * Declared and typed in this build, though whether the CLI ever emits one is
 * runtime behaviour — which is why runner parses it permissively and acts only
 * on `status: 'rejected'`.
 */
export function fakeRateLimitEvent(
  info: Record<string, unknown> = { status: 'rejected', rateLimitType: 'five_hour' },
): SDKMessage {
  return {
    type: 'rate_limit_event',
    rate_limit_info: info,
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

// ---------------------------------------------------------------------------
// The gated query — M5's scheduler needs sessions that stay running
// ---------------------------------------------------------------------------

/** One live session under {@link gatedQuery}'s control. */
export interface GatedSession {
  readonly index: number;
  /** The SDK session id this call reports in `system/init`. */
  readonly sdkSessionId: string;
  /** Yields a tail and lets the generator complete. Idempotent. */
  finish(tail?: readonly SDKMessage[]): void;
}

export interface GatedQuery {
  readonly query: QueryFn;
  /** One entry per `query()` call, in call order. */
  readonly sessions: readonly GatedSession[];
  /**
   * Resolves once `count` sessions have reported `system/init` **and the reader
   * loop has processed it** — so the `queued → running` transition has already
   * been written when the promise settles.
   */
  started(count: number): Promise<void>;
  finishAll(tail?: readonly SDKMessage[]): void;
  /**
   * Finishes every session, now and hereafter.
   *
   * The drain a test needs at the end: sessions the scheduler admits *because*
   * the ones ahead finished do not exist yet when `finishAll` is called, and a
   * gated session nobody finishes holds the suite open until the timeout.
   */
  autoFinish(tail?: readonly SDKMessage[]): void;
}

/**
 * A `query()` whose sessions stay running until the test says otherwise.
 *
 * `scriptedQuery` replays a fixed list and completes, which proves everything
 * about *one* session and nothing about two. Concurrency, priority bands and the
 * cool-down are all statements about sessions that overlap in time, so the
 * scheduler's tests need a session they can hold open — held here by awaiting a
 * deferred inside the generator, which is exactly where a real session waits
 * (between `init` and its first `result`).
 */
export function gatedQuery(): GatedQuery {
  const sessions: GatedSession[] = [];
  let startedCount = 0;
  let auto: { tail: readonly SDKMessage[] | undefined } | undefined;
  const startWaiters: { count: number; resolve: () => void }[] = [];

  function noteStarted(): void {
    startedCount += 1;
    for (const waiter of [...startWaiters]) {
      if (startedCount < waiter.count) continue;
      startWaiters.splice(startWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  }

  const query: QueryFn = (args) => {
    const index = sessions.length;
    const sdkSessionId = `9f2a2b64-1f3e-4a6b-9a41-00000000${String(index).padStart(4, '0')}`;
    let release: ((tail: readonly SDKMessage[]) => void) | undefined;
    const gate = new Promise<readonly SDKMessage[]>((resolve) => {
      release = resolve;
    });
    let finished = false;

    const handle: GatedSession = {
      index,
      sdkSessionId,
      finish(tail) {
        if (finished) return;
        finished = true;
        release?.(tail ?? [fakeResult({ sessionId: sdkSessionId }), fakeSessionStateChanged()]);
      },
    };
    sessions.push(handle);
    if (auto !== undefined) handle.finish(auto.tail);

    void (async () => {
      try {
        for await (const _message of args.prompt) {
          // Drained for the same reason `scriptedQuery` drains it: the real
          // wrapper pumps the input iterable lazily, and a queue nobody reads
          // never delivers its prompt.
        }
      } catch {
        // The queue never throws (§4.2).
      }
    })();

    async function* replay(): AsyncGenerator<SDKMessage, void> {
      yield fakeInit({ sessionId: sdkSessionId });
      // Resuming here means the consumer has already processed `init` — which
      // is the moment the row becomes `running`.
      noteStarted();
      for (const message of await gate) yield message;
    }

    const generator = replay();
    return {
      [Symbol.asyncIterator]: () => generator[Symbol.asyncIterator](),
      interrupt: () => Promise.resolve(undefined),
      close: () => Promise.resolve(),
    };
  };

  return {
    query,
    sessions,
    started(count) {
      if (startedCount >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        startWaiters.push({ count, resolve });
      });
    },
    finishAll(tail) {
      for (const session of sessions) session.finish(tail);
    },
    autoFinish(tail) {
      auto = { tail };
      for (const session of sessions) session.finish(tail);
    },
  };
}

// ---------------------------------------------------------------------------
// The controllable query — M6's session-control verbs
// ---------------------------------------------------------------------------

/**
 * One live session under {@link controllableQuery}'s control.
 *
 * `gatedQuery` proves things about sessions that *overlap*; this proves things
 * about a session the test drives **turn by turn**, which is what every M6
 * criterion is: a steer lands between two turns, a pause happens during one, a
 * guard fires because nothing happened for a while.
 */
export interface ControllableSession {
  readonly index: number;
  readonly sdkSessionId: string;
  /** `options.resume` this call was given — `null` on a fresh launch (§9.4). */
  readonly resume: string | null;
  /** Every user message runner pushed, in the order the pump took them. */
  readonly received: readonly SDKUserMessage[];
  /**
   * An ordered log of what runner did to this session: `input:<text>`,
   * `interrupt`, `close`, `abort`.
   *
   * The order is the assertion for §4.3's interrupting steer — "the current turn
   * stops… and the steered message is the next thing the agent sees" is a claim
   * about sequence, and a counter cannot express it.
   */
  readonly log: readonly string[];
  /** Resolves once `count` input messages have been pumped out of the queue. */
  awaitInput(count: number): Promise<void>;
  /** Resolves once the consumer has processed `system/init` — the row is `running`. */
  started(): Promise<void>;
  /** Yields messages into the live stream, in order, one microtask apart. */
  emit(...messages: readonly SDKMessage[]): Promise<void>;
  /** Completes the generator. Idempotent. */
  end(): void;
  readonly interrupts: number;
  readonly closes: number;
  readonly aborted: boolean;
}

export interface ControllableQueryOptions {
  /** `system/init.capabilities` — SDK-NOTES §4.2 / G4. */
  readonly capabilities?: readonly string[];
  /** What `interrupt()` resolves with. Omit for `undefined` (an older CLI). */
  readonly interruptReceipt?: (index: number) => unknown;
  /**
   * A session that ignores `interrupt()` and `close()` — §9.1 step 3's
   * straggler, which only the `AbortController` can end.
   */
  readonly ignoreControl?: boolean;
  readonly onCall?: (args: { prompt: AsyncIterable<SDKUserMessage>; options: SdkOptions }) => void;
}

export interface ControllableQuery {
  readonly query: QueryFn;
  readonly sessions: readonly ControllableSession[];
  /** Resolves once `count` calls have reported `system/init`. */
  started(count: number): Promise<void>;
  /** Ends every session, now and hereafter — the drain at the end of a test. */
  endAll(): void;
}

export function controllableQuery(options: ControllableQueryOptions = {}): ControllableQuery {
  const sessions: ControllableSession[] = [];
  let startedCount = 0;
  const startWaiters: { count: number; resolve: () => void }[] = [];
  let draining = false;

  function noteStarted(): void {
    startedCount += 1;
    for (const waiter of [...startWaiters]) {
      if (startedCount < waiter.count) continue;
      startWaiters.splice(startWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  }

  const query: QueryFn = (args) => {
    options.onCall?.(args);
    const index = sessions.length;
    const sdkSessionId =
      args.options.resume ?? `9f2a2b64-1f3e-4a6b-9a41-00000000${String(index).padStart(4, '0')}`;

    const outbound: SDKMessage[] = [];
    const received: SDKUserMessage[] = [];
    const log: string[] = [];
    const inputWaiters: { count: number; resolve: () => void }[] = [];
    let ended = false;
    let wake: (() => void) | undefined;

    function pump(): void {
      const waiter = wake;
      wake = undefined;
      waiter?.();
    }

    function end(): void {
      if (ended) return;
      ended = true;
      pump();
    }

    const signal = args.options.abortController?.signal;
    signal?.addEventListener('abort', () => {
      log.push('abort');
      end();
    });

    void (async () => {
      try {
        for await (const message of args.prompt) {
          received.push(message);
          log.push(`input:${firstText(message)}`);
          for (const waiter of [...inputWaiters]) {
            if (received.length < waiter.count) continue;
            inputWaiters.splice(inputWaiters.indexOf(waiter), 1);
            waiter.resolve();
          }
        }
      } catch {
        // The queue never throws (§4.2); if it ever did, the SDK would abort.
      }
      // SDK-NOTES §2.2: "closing the queue closes the child's stdin… the
      // documented, correct way to wind a session down, and it is one-way". A
      // fake whose generator outlived its own stdin would make §9.1's graceful
      // window untestable — every pause would look like a straggler.
      if (options.ignoreControl !== true) end();
    })();

    async function* replay(): AsyncGenerator<SDKMessage, void> {
      yield fakeInit({
        sessionId: sdkSessionId,
        ...(options.capabilities === undefined ? {} : { capabilities: [...options.capabilities] }),
      });
      noteStarted();
      for (;;) {
        const next = outbound.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }

    const handle: ControllableSession = {
      index,
      sdkSessionId,
      resume: args.options.resume ?? null,
      received,
      log,
      awaitInput(count) {
        if (received.length >= count) return Promise.resolve();
        return new Promise<void>((resolve) => {
          inputWaiters.push({ count, resolve });
        });
      },
      started: () => started(index + 1),
      async emit(...messages) {
        for (const message of messages) {
          outbound.push(message);
          pump();
          // Two turns of the microtask queue: one for the generator to wake,
          // one for the reader loop to have written what it read.
          await Promise.resolve();
          await Promise.resolve();
        }
      },
      end,
      get interrupts(): number {
        return log.filter((entry) => entry === 'interrupt').length;
      },
      get closes(): number {
        return log.filter((entry) => entry === 'close').length;
      },
      get aborted(): boolean {
        return log.includes('abort');
      },
    };
    sessions.push(handle);
    if (draining) end();

    const generator = replay();
    return {
      [Symbol.asyncIterator]: () => generator[Symbol.asyncIterator](),
      interrupt: () => {
        log.push('interrupt');
        return Promise.resolve(options.interruptReceipt?.(index));
      },
      close: () => {
        log.push('close');
        // SDK-NOTES §4.3: "forcefully ends the query… After calling `close()`,
        // no further messages will be received." A session flagged
        // `ignoreControl` is the one that does not, so only the abort ends it.
        if (options.ignoreControl !== true) end();
        return Promise.resolve();
      },
    };
  };

  function started(count: number): Promise<void> {
    if (startedCount >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      startWaiters.push({ count, resolve });
    });
  }

  return {
    query,
    sessions,
    started,
    endAll() {
      draining = true;
      for (const session of sessions) session.end();
    },
  };
}

/** The text of a pushed user message, for the ordered log. */
function firstText(message: SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === 'string') return content;
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: string }).type === 'text'
    ) {
      const text = (block as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    }
  }
  return '';
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
