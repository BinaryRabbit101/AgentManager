/**
 * The SDK seam (runner DESIGN §4.1, §11.3).
 *
 * Runner is the element that calls `query()` — §1: "Calling the SDK: `query()`,
 * streaming input, `interrupt()`, `resume`" — so this is where the package is
 * imported and the only place a real subprocess can be spawned from.
 *
 * ## Why `query` is injectable
 *
 * Every session mechanic this element owns — the reader loop of §2.4, the
 * status mapping of §2.2, the transcript vocabulary of §8.1, the replay filter
 * of SDK-NOTES G1, the start timeout of §3.2 — is a property of *how runner
 * consumes the message stream*, not of the model. Pinning them to a live
 * subscription would mean a test suite that needs a token, costs money, and
 * proves the least interesting half. So `query` arrives as a
 * {@link QueryFn} on the module's options: production passes
 * {@link realQuery}, tests pass a scripted async generator that yields the
 * `SDKMessage` sequences SDK-NOTES documents. The live checks that genuinely
 * need the engine stay where M0 put them, token-gated
 * (`__spike__/sdk.spike.test.ts`, SDK-NOTES §11).
 *
 * ## Why the seam is narrower than `Query`
 *
 * The SDK's `Query` is an `AsyncGenerator<SDKMessage, void>` with fifteen
 * control methods. Runner's M3 reader loop needs the iteration and, for later
 * milestones, `interrupt()` / `close()`. Declaring the seam as "async-iterable
 * of messages, with those two optional" is what keeps a fake to a dozen lines;
 * the real `Query` satisfies it structurally, which is asserted by
 * {@link realQuery} type-checking at all.
 */
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { SdkOptions } from './contracts.js';

export type { SDKMessage, SDKUserMessage };

/** The live session object, narrowed to what runner calls. */
export interface SdkSession extends AsyncIterable<SDKMessage> {
  /** §4.3, §9.1. Streaming-input mode only, which is the only mode runner uses. */
  interrupt?(): Promise<unknown>;
  /** §9.1: "forcefully ends the query… no further messages will be received". */
  close?(): Promise<void> | void;
}

/** The one SDK entry point runner calls (§4.1: streaming input, always). */
export type QueryFn = (args: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: SdkOptions;
}) => SdkSession;

/**
 * The real thing.
 *
 * That this assignment compiles is the standing check that
 * {@link QueryFn}/{@link SdkSession} still describe the pinned SDK — the same
 * job the type-level assertions in `__spike__/sdk.spike.test.ts` do for the
 * option and message shapes.
 */
export const realQuery: QueryFn = (args) => sdkQuery(args);

/**
 * SDK-NOTES **G1** — the replayed history a `resume` re-emits.
 *
 * > "`SDKUserMessageReplay` is a **separate union member** with
 * > `isReplay: true`… on a `resume`, the replayed history arrives as
 * > `type: 'user'` messages carrying `isReplay`. **The transcript writer and
 * > the event mapper must filter on `isReplay`** or a resumed session will
 * > re-emit its whole prior conversation as new `user` lines."
 *
 * Filtered in one predicate rather than at each call site, because there are
 * three consumers (the transcript, the `session.message` mapper, and — from M4
 * — the usage reconciler) and the failure of any one of them is the same
 * duplicated history.
 */
export function isReplayMessage(message: SDKMessage): boolean {
  if (message.type !== 'user') return false;
  return (message as { isReplay?: boolean }).isReplay === true;
}
