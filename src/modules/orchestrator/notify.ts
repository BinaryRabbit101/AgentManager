/**
 * Notification when the user is away — DESIGN §10, IMPLEMENTATION M8.
 *
 * > "The question inbox is served over the tailnet (D5) and the v1 push channel
 * > is ntfy — one outbound HTTPS POST to a user-configured topic URL."
 *
 * One channel, one `fetch`, no inbound port, no OAuth, no SMTP, no account. The
 * link in the payload is the **tailnet** URL of the card: the notification wakes
 * the user and the tailnet serves the answer, because D5 makes the API
 * Tailscale-only and "a notification is not an authorization".
 *
 * ## What this does not do, on purpose
 *
 * - **It never blocks a question.** M8-3: "a failed send is logged and surfaced
 *   in `/api/health` as a degraded capability — never retried into a loop, and
 *   never blocking the question." Every path here resolves; none throws. A card
 *   that could not be pushed is still open, still listed, still answerable.
 * - **It never sends twice for one question** (§10's rate limit), and it never
 *   sends more than `maxPerHour` overall — the suppressed ones are counted into
 *   a single digest, so a burst tells the user *that* there was a burst rather
 *   than silently vanishing.
 * - **It sends nothing at all when `notify.enabled` is false**, which is the
 *   work edition's default (R5). "Outbound push from a work machine is a policy
 *   question, not a preference", so the check is the first line of `send` rather
 *   than a subscription that is never attached: a build that flips the flag at
 *   runtime behaves the same as one that booted with it.
 *
 * ## Timing
 *
 * §10 fires at `notify.afterMs` (60 s) **for a question still open**, which is
 * "what stops a user sitting at the desk from being pushed for something they
 * answered in ten seconds". The delay is a self-cancelling timer per question,
 * injectable so a test drives it rather than sleeping a minute.
 */
import type { SecretResolver } from '../../secrets/index.js';
import type { AppEvent, EventBus, Unsubscribe } from '../types.js';
import type { Clock } from '../../storage/index.js';

import type { OrchestratorConfig } from './config.js';
import type { QuestionCard, QuestionInbox, QuestionKind } from './questions.js';

/** Injectable timers, the same seam remote's listener uses. */
export interface NotifyTimers {
  /** Runs `fn` after `ms`; the returned function cancels it. */
  after(ms: number, fn: () => void | Promise<void>): () => void;
}

/** The real timers: `unref`ed, so a pending notification holds nothing open. */
export const realNotifyTimers: NotifyTimers = {
  after: (ms, fn) => {
    const handle = setTimeout(() => {
      void (async () => fn())().catch(() => undefined);
    }, ms);
    handle.unref?.();
    return () => {
      clearTimeout(handle);
    };
  },
};

/** What one attempted send did. Every field is what `/api/health` renders. */
export interface NotifyResult {
  readonly sent: boolean;
  readonly reason?:
    'disabled' | 'below_min_level' | 'already_notified' | 'not_open' | 'no_topic' | 'send_failed';
  readonly status?: number;
}

export interface Notifier {
  /** Arms §10's delay for a card. Idempotent per question id. */
  schedule(card: Pick<QuestionCard, 'id' | 'kind'> & { urgency?: string | undefined }): void;
  /** Sends now, skipping the delay — the timer's callback, and the tests' door. */
  notify(questionId: string): Promise<NotifyResult>;
  /**
   * §10's channel with no card behind it (WO8).
   *
   * A background trigger that was blocked, or that disabled itself after three
   * failures, has nothing for a human to *answer* — there is no question, and
   * raising a fake one so the notifier had something to push would put a card in
   * the inbox that no session is waiting on. What it has is news, and §10 is
   * already the way news reaches a user who is away.
   *
   * It shares the enabled flag, the hourly rate limit and the digest with the
   * card path, because those are properties of the *channel* and a second
   * unlimited sender would make `maxPerHour` a number that does not bound
   * anything. It deliberately does **not** share the per-question
   * once-and-once-only memory: two blocked fires of the same trigger a day apart
   * are two pieces of news.
   */
  send(title: string, body: string): Promise<NotifyResult>;
  /** Subscribes to `assignment.question.raised`; the result detaches. */
  attach(): Unsubscribe;
  /** M8-3's degraded capability, as `/api/health` reads it. */
  health(): {
    readonly degraded: boolean;
    readonly lastError: string | null;
    readonly sent: number;
    readonly suppressed: number;
  };
}

export interface NotifierOptions {
  readonly config: OrchestratorConfig;
  readonly inbox: () => QuestionInbox | undefined;
  readonly secrets: SecretResolver;
  readonly bus: EventBus;
  readonly clock: Clock;
  /**
   * The tailnet base URL the link is built on, resolved at *send* time.
   *
   * A function because remote may not have bound yet when this is constructed,
   * and `undefined` in the work edition — where the notifier is disabled anyway,
   * and where a link to a listener that never starts would be a lie.
   */
  readonly baseUrl?: (() => string | undefined) | undefined;
  readonly timers?: NotifyTimers | undefined;
  /** Injectable for the same reason `probeCore` injects it: tests do not POST. */
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly log?: (
    level: 'debug' | 'info' | 'warn',
    message: string,
    detail?: Record<string, unknown>,
  ) => void;
}

/** The kinds §10 always pushes: "a human check nobody sees is worthless". */
const ALWAYS_NOTIFY: readonly QuestionKind[] = ['approval_gate', 'budget_halt'];

const SEND_TIMEOUT_MS = 5_000;

export function createNotifier(options: NotifierOptions): Notifier {
  const { config, bus } = options;
  const timers = options.timers ?? realNotifyTimers;

  /** One timer per question, so a second `schedule` for one card is a no-op. */
  const armed = new Map<string, () => void>();
  /** §10: "at most one notification per question". */
  const notified = new Set<string>();
  /** Send timestamps inside the rolling hour, for `maxPerHour`. */
  const sentAt: number[] = [];
  /** Suppressed sends waiting to be told about in one digest. */
  let suppressed = 0;
  let lastError: string | null = null;
  let sent = 0;

  function log(
    level: 'debug' | 'info' | 'warn',
    message: string,
    detail?: Record<string, unknown>,
  ): void {
    options.log?.(level, message, detail);
  }

  /** §10's `minLevel`, which is about the *card*, not the channel. */
  function meetsMinLevel(kind: QuestionKind, urgency: string | undefined): boolean {
    if (config.notify.minLevel === 'all') return true;
    if (ALWAYS_NOTIFY.includes(kind)) return true;
    // "plain `question` only when `urgency: 'blocking'`."
    return urgency === 'blocking';
  }

  function withinRateLimit(nowMs: number): boolean {
    const hourAgo = nowMs - 3_600_000;
    while (sentAt.length > 0 && (sentAt[0] ?? 0) < hourAgo) sentAt.shift();
    return sentAt.length < config.notify.maxPerHour;
  }

  function linkTo(questionId: string): string | undefined {
    const base = options.baseUrl?.();
    if (base === undefined || base === '') return undefined;
    return `${base.replace(/\/+$/, '')}/questions/${questionId}`;
  }

  async function post(
    title: string,
    body: string,
    link: string | undefined,
  ): Promise<NotifyResult> {
    // A capability URL, therefore a secret (R5, foundation §3.3). Absent is not
    // an error worth throwing over — it is an unconfigured channel, which is the
    // normal state of a fresh install.
    const topic = await options.secrets.get(config.notify.topicSecretRef).catch(() => undefined);
    if (topic === undefined) {
      lastError = `no secret at ${config.notify.topicSecretRef}`;
      return { sent: false, reason: 'no_topic' };
    }

    const request = options.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, SEND_TIMEOUT_MS);
    try {
      const response = await request(topic.reveal(), {
        method: 'POST',
        body,
        headers: {
          Title: title,
          // ntfy reads these as plain headers; both are advisory and neither
          // carries anything from the card's text.
          Priority: 'default',
          Tags: 'robot',
          ...(link === undefined ? {} : { Click: link }),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        lastError = `ntfy answered ${String(response.status)}`;
        return { sent: false, reason: 'send_failed', status: response.status };
      }
      lastError = null;
      return { sent: true, status: response.status };
    } catch (error) {
      // Refused, timed out, DNS-failed, aborted — one reason, because the user's
      // action is the same for all of them: fix the topic URL.
      lastError = String(error);
      return { sent: false, reason: 'send_failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function notify(questionId: string): Promise<NotifyResult> {
    armed.delete(questionId);
    if (!config.notify.enabled) return { sent: false, reason: 'disabled' };
    if (notified.has(questionId)) return { sent: false, reason: 'already_notified' };

    const card = options
      .inbox()
      ?.list()
      .find((one) => one.id === questionId);
    // "Answering inside `afterMs` produces none" — the check is the card's live
    // status, not a flag set when the timer was armed.
    if (card === undefined || card.status !== 'open') return { sent: false, reason: 'not_open' };

    const nowMs = options.clock().getTime();
    if (!withinRateLimit(nowMs)) {
      suppressed += 1;
      log('info', 'a notification was suppressed by the hourly rate limit', {
        questionId,
        maxPerHour: config.notify.maxPerHour,
        suppressed,
      });
      return { sent: false, reason: 'send_failed' };
    }

    notified.add(questionId);
    const result = await sendThrough(titleFor(card), card.prompt, linkTo(questionId), nowMs);
    if (!result.sent) {
      log('warn', 'a notification could not be sent', { questionId, reason: result.reason });
    }

    bus.emit({
      type: 'orchestrator.notify.sent',
      ids: { assignmentId: card.assignmentId },
      persist: true,
      payload: { questionId, channel: config.notify.channel, ok: result.sent },
    });
    return result;
  }

  /**
   * The card path's tail, factored out so the plain sender shares the hourly
   * limit and the digest rather than reimplementing them beside it.
   */
  async function sendThrough(
    title: string,
    body: string,
    link: string | undefined,
    nowMs: number,
  ): Promise<NotifyResult> {
    if (!withinRateLimit(nowMs)) {
      suppressed += 1;
      log('info', 'a notification was suppressed by the hourly rate limit', {
        maxPerHour: config.notify.maxPerHour,
        suppressed,
      });
      return { sent: false, reason: 'send_failed' };
    }
    const digest =
      suppressed === 0
        ? ''
        : `\n\n(+${String(suppressed)} other card(s) were not pushed — the inbox has them.)`;
    const result = await post(
      title,
      `${body}${link === undefined ? '' : `\n\n${link}`}${digest}`,
      link,
    );
    if (result.sent) {
      sent += 1;
      sentAt.push(nowMs);
      suppressed = 0;
    }
    return result;
  }

  async function send(title: string, body: string): Promise<NotifyResult> {
    if (!config.notify.enabled) return { sent: false, reason: 'disabled' };
    const result = await sendThrough(title, body, undefined, options.clock().getTime());
    if (!result.sent) {
      log('warn', 'a notification could not be sent', { title, reason: result.reason });
    }
    bus.emit({
      type: 'orchestrator.notify.sent',
      persist: true,
      payload: { questionId: null, channel: config.notify.channel, ok: result.sent },
    });
    return result;
  }

  function schedule(
    card: Pick<QuestionCard, 'id' | 'kind'> & { urgency?: string | undefined },
  ): void {
    if (!config.notify.enabled) return;
    if (armed.has(card.id) || notified.has(card.id)) return;
    if (!meetsMinLevel(card.kind, card.urgency)) return;
    armed.set(
      card.id,
      timers.after(config.notify.afterMs, async () => {
        await notify(card.id);
      }),
    );
  }

  function attach(): Unsubscribe {
    const unsubscribes: Unsubscribe[] = [
      bus.subscribe(['assignment.question.raised'], (event: AppEvent) => {
        const payload = (event.payload ?? {}) as { questionId?: unknown; kind?: unknown };
        if (typeof payload.questionId !== 'string') return;
        schedule({
          id: payload.questionId,
          kind: (typeof payload.kind === 'string' ? payload.kind : 'question') as QuestionKind,
          // A plain question is pushed only when the asker called it blocking;
          // the flag rides on the card's own envelope, read at send time.
          urgency: urgencyOf(
            options
              .inbox()
              ?.list()
              .find((one) => one.id === payload.questionId),
          ),
        });
      }),
      // A card answered, cancelled or expired inside the delay is a card nobody
      // needs to be woken for.
      bus.subscribe(['question.answered', 'question.cancelled', 'question.expired'], (event) => {
        const payload = (event.payload ?? {}) as { questionId?: unknown };
        if (typeof payload.questionId !== 'string') return;
        armed.get(payload.questionId)?.();
        armed.delete(payload.questionId);
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      for (const cancel of armed.values()) cancel();
      armed.clear();
    };
  }

  return {
    schedule,
    notify,
    send,
    attach,
    health: () => ({
      // A channel that is switched off is not degraded — it is off. Degraded
      // means "configured and not working", which is the only state a human has
      // anything to do about (M8-3).
      degraded: config.notify.enabled && lastError !== null,
      lastError,
      sent,
      suppressed,
    }),
  };
}

function titleFor(card: QuestionCard): string {
  switch (card.kind) {
    case 'approval_gate':
      return 'AgentManager: approval needed';
    case 'budget_halt':
      return 'AgentManager: budget reached';
    default:
      return 'AgentManager: a decision is waiting';
  }
}

/** `blocking` when the asking tool said so — `request_user_decision`'s urgency. */
function urgencyOf(card: QuestionCard | undefined): string | undefined {
  const input = card?.context?.toolInput;
  if (typeof input !== 'object' || input === null) return undefined;
  const urgency = (input as { urgency?: unknown }).urgency;
  return typeof urgency === 'string' ? urgency : undefined;
}
