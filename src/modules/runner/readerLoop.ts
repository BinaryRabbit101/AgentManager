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

export interface ReaderLoopDeps {
  readonly session: SdkSession;
  readonly input: SessionInputQueue;
  readonly transcript: SessionTranscript;
  /** §3.2: no `system/init` by then → `failed` / `start_timeout`. */
  readonly startTimeoutMs: number;
  /** Runner owns cancellation (§3.3); the start timeout aborts through it. */
  readonly abort: AbortController;
  /** Fires once, on `system/init`: the `queued → running` transition (§3.1 step 10). */
  readonly onInit: (facts: InitFacts) => void;
  /** Fires per turn `result`, before the input queue is closed. */
  readonly onResult?: (facts: ResultFacts) => void;
  /** Every message, replay-filtered — the seam M4's metering and M10's events use. */
  readonly onMessage?: (message: SDKMessage) => void;
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
          // §2.4 steps 2–3. M3 pushes one prompt and never steers, so `pending`
          // is 0 here; M6's steering is what makes the check do work.
          if (input.pending === 0) input.close();
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
  };
}
