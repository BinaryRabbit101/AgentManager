/**
 * The reader loop of runner DESIGN §2.4 — "one `result` per turn, not per
 * session".
 *
 * ```
 * 1. Consume messages until a `result` arrives. Record turn-level usage and
 *    `permission_denials`.
 * 2. If the input queue holds an unsent steer message, keep going.
 * 3. Otherwise close the input queue.
 * 4. Keep iterating until the generator completes — trailing system events
 *    arrive after `result`.
 * 5. Then settle the terminal status.
 * ```
 *
 * Steps 1–4 are here; step 5 belongs to `launch.ts`, because settling a status
 * needs the repository and this file deliberately has neither.
 *
 * ## Why the loop cannot stop at the first `result`
 *
 * SDK-NOTES §2.2 (wrapper source): only a *string* prompt sets
 * `isSingleUserTurn`, and only that flag makes the wrapper call
 * `transport.endInput()` on a result. Runner always streams, so the generator
 * keeps yielding after the first result — and `session_state_changed` is
 * documented as arriving *after* it. A loop that returned on the first result
 * would truncate every transcript by exactly the messages that say how the turn
 * ended.
 *
 * ## The three filters
 *
 * - **`isReplay`** (SDK-NOTES G1) — dropped before anything else. A resumed
 *   session replays its whole prior conversation as `user` messages; writing
 *   them would duplicate the transcript history it already contains.
 * - **`stream_event`** (§8.1, D11) — never written. Partial text exists for the
 *   UI's live typing; the `assistant` line already carries the content in full.
 * - **everything unrecognised** — counted and ignored. §7.4: "the reader loop
 *   tolerates unknown message types by construction", which this version's
 *   38-member open union makes a requirement rather than a courtesy.
 *
 * ## The two guards runner owns because the SDK has none (M6, §12)
 *
 * SDK-NOTES §9.1: "**No top-level session timeout** — confirmed by absence:
 * `Options` has no timeout field". So both live here:
 *
 * - **`idleTimeoutMs`** — rearmed on **every** message, which is what makes
 *   §12's "a legitimate long `Bash` call produces no SDK messages at all while
 *   it runs" survivable: the window is *between* messages, not from the start of
 *   the turn.
 * - **`wallClockMs`** — armed once, never rearmed. A session that keeps talking
 *   forever is exactly the one this exists for.
 *
 * Either firing aborts the controller and closes the input queue, which is how
 * the generator actually ends; the guard name travels out on
 * {@link ReaderLoopOutcome.guard} so `launch.ts` can settle §2.3's matching
 * `exit_reason` rather than the result subtype's.
 */
import type { SessionTranscript } from './transcript.js';
import type { SessionInputQueue } from './inputQueue.js';
import type { SdkSession, SDKMessage } from './sdk.js';
import { isReplayMessage } from './sdk.js';
import {
  isInitMessage,
  readAssistant,
  readInitFacts,
  readResult,
  readUser,
  type InitFacts,
  type ResultFacts,
} from './messages.js';

/** §12's two runner-owned deadlines, named as §2.3 names their `exit_reason`. */
export type GuardReason = 'idle_timeout' | 'wall_clock_timeout';

export interface ReaderLoopDeps {
  readonly session: SdkSession;
  readonly input: SessionInputQueue;
  readonly transcript: SessionTranscript;
  /** §3.2: no `system/init` by then → `failed` / `start_timeout`. */
  readonly startTimeoutMs: number;
  /** §12: no SDK message of any kind for this long → `failed` / `idle_timeout`. */
  readonly idleTimeoutMs?: number | undefined;
  /** §12's `wallClockMaxMinutes`, in milliseconds → `failed` / `wall_clock_timeout`. */
  readonly wallClockMs?: number | undefined;
  /** Runner owns cancellation (§3.3); the start timeout aborts through it. */
  readonly abort: AbortController;
  /** Fires once, on `system/init`: the `queued → running` transition (§3.1 step 10). */
  readonly onInit: (facts: InitFacts) => void;
  /** Fires per turn `result`, before the input queue is closed. */
  readonly onResult?: (facts: ResultFacts) => void;
  /** Every message, replay-filtered — the seam M4's metering and M10's events use. */
  readonly onMessage?: (message: SDKMessage) => void;
  /**
   * A turn ended (§4.3): the edge `steer({interrupt:true})` waits for, bounded
   * by `gracefulInterruptMs`. Fires after {@link onResult}.
   */
  readonly onTurnEnd?: () => void;
  /** One of §12's deadlines tripped. Fires once, before the abort lands. */
  readonly onGuard?: (guard: GuardReason) => void;
}

export interface ReaderLoopOutcome {
  readonly sawInit: boolean;
  readonly init: InitFacts | undefined;
  /** The latest `result`; §2.2's status is mapped from its subtype. */
  readonly lastResult: ResultFacts | undefined;
  /** §8.3's `lastAssistantText`. */
  readonly lastAssistantText: string | null;
  /** How many `result` messages arrived — one per turn. */
  readonly turns: number;
  /** Messages that arrived **after** the first result (§2.4 step 4's evidence). */
  readonly afterFirstResult: number;
  /** Replayed history dropped by G1's filter. */
  readonly replaysFiltered: number;
  /** Message types the mapping has no opinion about (§7.4). */
  readonly unmapped: number;
  /** The error the generator threw, if it threw. */
  readonly error: unknown;
  /** True when `startTimeoutMs` elapsed with no `init`. */
  readonly startTimedOut: boolean;
  /** Which of §12's deadlines ended this session, if either did. */
  readonly guard: GuardReason | undefined;
}

export async function runReaderLoop(deps: ReaderLoopDeps): Promise<ReaderLoopOutcome> {
  const { session, input, transcript } = deps;

  let init: InitFacts | undefined;
  let lastResult: ResultFacts | undefined;
  let lastAssistantText: string | null = null;
  let turns = 0;
  let afterFirstResult = 0;
  let replaysFiltered = 0;
  let unmapped = 0;
  let error: unknown;
  let startTimedOut = false;
  let guard: GuardReason | undefined;

  /**
   * §12's deadlines, both ending the session the same way the start timeout
   * does: abort the controller (the SDK transport closes on the signal) and end
   * the input stream, so the generator completes and `launch.ts` settles.
   */
  function trip(reason: GuardReason, message: string): void {
    if (guard !== undefined) return;
    guard = reason;
    deps.onGuard?.(reason);
    transcript.append('error', { stage: 'guard', code: reason, message });
    deps.abort.abort(new Error(message));
    input.close();
  }

  const wallClockMs = deps.wallClockMs;
  const wallTimer =
    wallClockMs !== undefined && wallClockMs > 0
      ? setTimeout(() => {
          trip(
            'wall_clock_timeout',
            `This session ran for longer than runner.wallClockMaxMinutes (${String(wallClockMs)} ms) ` +
              'and was stopped. The SDK has no session timeout, so this one is AgentManager’s.',
          );
        }, wallClockMs)
      : undefined;
  wallTimer?.unref?.();

  const idleTimeoutMs = deps.idleTimeoutMs;
  let idleTimer: NodeJS.Timeout | undefined;
  /** Rearmed on every message — the window is *between* messages (§12). */
  function armIdle(): void {
    if (idleTimeoutMs === undefined || idleTimeoutMs <= 0) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      trip(
        'idle_timeout',
        `This session produced no SDK message for ${String(idleTimeoutMs)} ms and was stopped ` +
          '(runner.idleTimeoutMs).',
      );
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }
  armIdle();

  const startTimer = setTimeout(() => {
    if (init !== undefined) return;
    startTimedOut = true;
    // Aborting is what actually ends the wait: the SDK's transport closes on the
    // signal, so the generator completes and the loop below falls through to
    // the settle in `launch.ts`.
    deps.abort.abort(new Error('no system/init within runner.startTimeoutMs'));
    input.close();
  }, deps.startTimeoutMs);
  // A durability timer must never hold the process open (foundation §4.2).
  startTimer.unref?.();

  try {
    for await (const message of session) {
      if (isReplayMessage(message)) {
        replaysFiltered += 1;
        continue;
      }
      armIdle();
      if (turns > 0) afterFirstResult += 1;
      deps.onMessage?.(message);

      if (isInitMessage(message)) {
        clearTimeout(startTimer);
        init = readInitFacts(message);
        transcript.append('system', { subtype: 'init', ...init });
        deps.onInit(init);
        continue;
      }

      switch (message.type) {
        case 'system': {
          transcript.append('system', { subtype: message.subtype, detail: message });
          break;
        }
        case 'assistant': {
          const parts = readAssistant(message);
          transcript.append('assistant', {
            messageId: parts.messageId,
            content: parts.content,
            ...(parts.text === '' ? {} : { text: parts.text }),
          });
          if (parts.text !== '') lastAssistantText = parts.text;
          for (const call of parts.toolUses) {
            // G2: derived by runner from content blocks; the SDK has no such
            // message type.
            transcript.append('tool_use', {
              toolUseId: call.toolUseId,
              name: call.name,
              input: call.input,
            });
          }
          break;
        }
        case 'user': {
          const parts = readUser(message);
          transcript.append('user', { content: parts.content });
          for (const result of parts.toolResults) {
            transcript.append('tool_result', { ...result });
          }
          break;
        }
        case 'result': {
          const facts = readResult(message);
          lastResult = facts;
          turns += 1;
          transcript.append('usage', {
            subtype: facts.subtype,
            turns: facts.turns,
            durationMs: facts.durationMs,
            stopReason: facts.stopReason,
            terminalReason: facts.terminalReason,
            costUsdEstimate: facts.costUsd,
            usage: facts.usage,
            modelUsage: facts.modelUsage,
            permissionDenials: facts.permissionDenials,
          });
          if (facts.resultText !== null && facts.resultText.trim() !== '') {
            // SDK-NOTES §6.1: `result.result` is "a free, exact source" for
            // §8.3's last assistant text, and it survives a turn whose text
            // arrived only in partial messages.
            lastAssistantText = facts.resultText;
          }
          deps.onResult?.(facts);
          deps.onTurnEnd?.();
          // §2.4 steps 2–3, as M6 has to state them. `pending` is the wrong
          // question — SDK-NOTES §2.2's pump hands a pushed message to the child
          // on the next microtask, so a steer is "pending: 0" while its turn has
          // not started. The right question is whether every message pushed has
          // had its turn, plus the hold §4.3's interrupting steer takes while it
          // waits for this very boundary.
          if (input.holds === 0 && input.pushed <= turns) input.close();
          break;
        }
        case 'stream_event':
          // D11: deltas are a WebSocket concern, never a transcript line.
          break;
        default:
          unmapped += 1;
          break;
      }
    }
  } catch (caught) {
    error = caught;
  } finally {
    clearTimeout(startTimer);
    if (wallTimer !== undefined) clearTimeout(wallTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    input.close();
  }

  return {
    sawInit: init !== undefined,
    init,
    lastResult,
    lastAssistantText,
    turns,
    afterFirstResult,
    replaysFiltered,
    unmapped,
    error,
    startTimedOut,
    guard,
  };
}
