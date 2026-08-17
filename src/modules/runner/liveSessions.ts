/**
 * The live-session registry and the wind-down sequence (runner DESIGN §4.3,
 * §9.1) — milestone M6.
 *
 * A control verb needs three things a session row cannot carry: the
 * {@link SessionInputQueue} to steer into, the `Query` handle to `interrupt()`
 * and `close()`, and the `AbortController` that ends the subprocess when neither
 * worked. This file is where they live for exactly as long as the session does.
 *
 * ## The wind-down is §9.1's, verbatim, and it is one sequence for two verbs
 *
 * > "`interrupt()`, wait up to `runner.gracefulInterruptMs` (default 10 s) for
 * > the turn to wind down, `close()`… Any session that does not wind down in
 * > time: abort its `AbortController`."
 *
 * Pause and Stop differ **only** in the status the launch chain settles
 * afterwards — a paused session is "stop with intent to continue" (§2.2) and a
 * stopped one is not. Making them one function is what guarantees Stop cannot
 * leave a subprocess that Pause would have cleaned up.
 *
 * ## SDK-NOTES **G4**: a queued steer can outlive the interrupt meant to supersede it
 *
 * `interrupt()` resolves to a receipt whose `still_queued` lists "uuids of async
 * user messages that **WILL** still run unless cancelled first", advertised by
 * the `interrupt_receipt_v1` capability on `system/init`. Two consequences are
 * encoded here rather than commented:
 *
 * - **The capability is read, not assumed.** An older CLI resolves `undefined`,
 *   which is indistinguishable from "nothing survived" unless you know whether a
 *   receipt was on offer at all. {@link InterruptReceipt.supported} is that
 *   distinction, and it reaches the transcript and the `session.steered` event —
 *   so "an earlier steer may still run" is something the UI can *say* rather
 *   than something the user discovers from the agent's next message.
 * - **Nothing is silently dropped.** The public `Query.interrupt()` of this
 *   pinned build takes **no arguments**, so `interrupt_cancel_queued_v1`'s
 *   `cancel_queued: true` is not reachable through the SDK's own surface;
 *   runner therefore cannot cancel a survivor, and pretending otherwise would be
 *   worse than reporting it. The uuids are surfaced, and runner's own queue —
 *   whose messages it stamped with those uuids (`inputQueue.ts`) — is left
 *   intact, because discarding a message the user typed is not runner's call.
 */
import type { SessionInputQueue } from './inputQueue.js';
import type { SdkSession } from './sdk.js';
import type { ExitReason } from './status.js';
import type { SessionTranscript } from './transcript.js';

/** SDK-NOTES §4.2: the `system/init` capability that makes the receipt real. */
export const INTERRUPT_RECEIPT_CAPABILITY = 'interrupt_receipt_v1';

/** Why a live session is being wound down. The status it settles to differs. */
export type ControlIntent = 'pause' | 'stop';

/** What `Query.interrupt()` told us, and whether it was able to tell us anything. */
export interface InterruptReceipt {
  /** True when `init.capabilities` advertised `interrupt_receipt_v1` (G4). */
  readonly supported: boolean;
  /** Uuids of queued user messages that survive this interrupt and WILL run. */
  readonly stillQueued: readonly string[];
  /** The interrupt itself failed — recorded rather than thrown (§4.2's rule). */
  readonly error?: string | undefined;
}

export interface LiveSessionInit {
  readonly sessionId: string;
  readonly input: SessionInputQueue;
  readonly sdk: SdkSession;
  readonly transcript: SessionTranscript;
  readonly abort: AbortController;
}

export interface LiveSession extends LiveSessionInit {
  /** From `system/init`; empty until it arrives (§3.1 step 10). */
  capabilities: readonly string[];
  /** Set by a control verb, read by the launch chain's settle. */
  intent: ControlIntent | undefined;
  /** §2.3's reason the settle will write for {@link intent}. */
  exitReason: ExitReason | undefined;
  /** True when the graceful window expired and the abort was used instead. */
  forced: boolean;
  /** Resolves when the reader loop has completed. */
  readonly finished: Promise<void>;
  /** Resolves once the row has reached its post-control status. */
  readonly settled: Promise<void>;
  markFinished(): void;
  markSettled(): void;
  /** Fired by the reader loop at each turn `result`. */
  noteTurnEnd(): void;
  /** Resolves `true` at the next turn boundary, `false` once `timeoutMs` passes. */
  awaitTurnBoundary(timeoutMs: number): Promise<boolean>;
  /** `Query.interrupt()` plus G4's receipt reading. Never throws. */
  interrupt(): Promise<InterruptReceipt>;
  /** `Query.close()`. Never throws — §9.1 has an abort behind it. */
  close(): Promise<void>;
}

export interface LiveSessions {
  /** Registers a session that has just been handed to `query()`. */
  open(init: LiveSessionInit): LiveSession;
  get(sessionId: string): LiveSession | undefined;
  /** Removes the handle and resolves both of its promises. Idempotent. */
  release(sessionId: string): LiveSession | undefined;
  ids(): readonly string[];
  readonly size: number;
}

export function createLiveSessions(): LiveSessions {
  const live = new Map<string, LiveSession>();

  return {
    open(init) {
      const session = createLiveSession(init);
      live.set(init.sessionId, session);
      return session;
    },
    get: (sessionId) => live.get(sessionId),
    release(sessionId) {
      const session = live.get(sessionId);
      if (session === undefined) return undefined;
      live.delete(sessionId);
      session.markFinished();
      session.markSettled();
      return session;
    },
    ids: () => [...live.keys()],
    get size(): number {
      return live.size;
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createLiveSession(init: LiveSessionInit): LiveSession {
  const finished = deferred();
  const settled = deferred();
  let turnWaiters: Array<(ended: boolean) => void> = [];

  const session: LiveSession = {
    ...init,
    capabilities: [],
    intent: undefined,
    exitReason: undefined,
    forced: false,
    finished: finished.promise,
    settled: settled.promise,

    markFinished: finished.resolve,
    markSettled() {
      // A settle also ends every wait: a turn boundary that will never arrive
      // must not hold a control verb open past the session it was steering.
      finished.resolve();
      settled.resolve();
      const waiting = turnWaiters;
      turnWaiters = [];
      for (const waiter of waiting) waiter(false);
    },

    noteTurnEnd() {
      const waiting = turnWaiters;
      turnWaiters = [];
      for (const waiter of waiting) waiter(true);
    },

    awaitTurnBoundary(timeoutMs) {
      return new Promise<boolean>((resolve) => {
        let done = false;
        const settle = (ended: boolean): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(ended);
        };
        const timer = setTimeout(
          () => {
            settle(false);
          },
          Math.max(timeoutMs, 0),
        );
        timer.unref?.();
        turnWaiters.push(settle);
      });
    },

    async interrupt() {
      const supported = session.capabilities.includes(INTERRUPT_RECEIPT_CAPABILITY);
      try {
        const receipt = await init.sdk.interrupt?.();
        return { supported, stillQueued: readStillQueued(receipt) };
      } catch (error) {
        // §9.1 has `close()` and the abort behind this; an interrupt that
        // failed is a fact to record, never a reason to leave a subprocess up.
        return {
          supported,
          stillQueued: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async close() {
      try {
        await init.sdk.close?.();
      } catch {
        // Same reason: the abort is the backstop.
      }
    },
  };

  return session;
}

/** G4's receipt, read defensively — "ignore unknown uuids rather than erroring". */
export function readStillQueued(receipt: unknown): readonly string[] {
  if (typeof receipt !== 'object' || receipt === null) return [];
  const value = (receipt as { still_queued?: unknown }).still_queued;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export interface WindDownOptions {
  readonly intent: ControlIntent;
  /** §12's `gracefulInterruptMs`, which §9.1 sizes to fit inside shutdown grace. */
  readonly gracefulInterruptMs: number;
  readonly exitReason: ExitReason;
  /**
   * What the session settles as when the graceful window expires and the abort
   * had to be used instead (§9.1 step 3).
   *
   * Shutdown is the case this exists for: a session that winds down is `paused`
   * / `service_shutdown` and can be resumed; one that ignored the interrupt is
   * `interrupted` / `shutdown_forced`, "honest labelling — that one may have
   * died mid-tool-call". Omitted, a forced wind-down keeps its original intent
   * and reason, which is what a user-pressed Pause or Stop wants: the verb
   * asked for a status and got it, slowly.
   */
  readonly forced?: { readonly intent: ControlIntent; readonly exitReason: ExitReason } | undefined;
}

export interface WindDownOutcome {
  /** True when the generator completed inside the graceful window. */
  readonly clean: boolean;
  readonly receipt: InterruptReceipt;
}

/**
 * §9.1 step 2 and step 3, for one session.
 *
 * Resolves once the reader loop has completed — never before — so a caller can
 * then wait on {@link LiveSession.settled} and answer with a status that is
 * already written. A control verb that returned while the row still said
 * `running` is a control verb whose retry would race it, which is precisely what
 * §11.1's idempotency rule exists to make safe.
 */
export async function windDown(
  live: LiveSession,
  options: WindDownOptions,
): Promise<WindDownOutcome> {
  live.intent = options.intent;
  live.exitReason = options.exitReason;

  const receipt = await live.interrupt();
  // Ending the input stream is the documented way to wind a session down
  // (SDK-NOTES §2.2), and the pump waits for the in-flight turn's first result
  // before it acts, so this does not truncate the turn being interrupted.
  live.input.close();

  const clean = await raceFinished(live.finished, options.gracefulInterruptMs);
  await live.close();

  if (!clean) {
    live.forced = true;
    if (options.forced !== undefined) {
      live.intent = options.forced.intent;
      live.exitReason = options.forced.exitReason;
    }
    live.abort.abort(
      new Error(
        `Session ${live.sessionId} did not wind down within ${String(options.gracefulInterruptMs)} ms; ` +
          'its subprocess was aborted (DESIGN §9.1 step 3).',
      ),
    );
    await live.finished;
  }

  return { clean, receipt };
}

function raceFinished(finished: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(
      () => {
        resolve(false);
      },
      Math.max(timeoutMs, 0),
    );
    timer.unref?.();
    void finished.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
