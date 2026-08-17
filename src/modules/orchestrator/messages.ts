/**
 * The mailbox — DESIGN §5, and the **minimum of IMPLEMENTATION M4-1/M4-7 that
 * M5 and M6 genuinely require**: inter-agent messages with honest delivery
 * semantics, and the prompt-time inlining helper §3.2's section 4 needs.
 *
 * The rest of M4 (the two overseer tools, the per-session call caps as breaker
 * inputs) is deliberately **not** here; see `toolset.ts`'s header for the same
 * note about the tool surface.
 *
 * ## Transport: rows, settled elsewhere
 *
 * Foundation §8 already decided this ("atomic-file hives lose ordering and
 * delivery state under concurrent assignments"), so this file adds only the
 * `kind` vocabulary, `message_reads` for broadcast read-state, and the delivery
 * rules. `store.messages` is the writer of the row; the only SQL here is against
 * `message_reads`, which is orchestrator's own table.
 *
 * ## Delivery is derived, not a fourth column
 *
 * §11.2 pins `delivery` to `inlined | read | undelivered` and §5.1 says
 * "at assignment close, undelivered messages are marked `undeliverable`". Both
 * are answered by the two timestamps the row already has: read (a `read_at`, or a
 * `message_reads` row for a broadcast) → `read`; a `delivered_at` → `inlined`;
 * neither → `undelivered`. A fourth state stored as a column would be a fact that
 * can disagree with the timestamps it is derived from, and the UI's requirement is
 * only that it can *tell the two failures apart* — "I sent it and they ignored
 * me" and "I sent it and they never saw it". Whether an `undelivered` message
 * could still arrive is the assignment's status, which the conversation view
 * carries beside it.
 */
import type { Clock, Database, MessageRecord, MessagesRepository } from '../../storage/index.js';
import { isoTimestamp } from '../../storage/index.js';

import { InvalidRequestError } from './errors.js';

/** §5's vocabulary. */
export const MESSAGE_KINDS = ['note', 'handoff', 'question', 'answer', 'status'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export function isMessageKind(value: unknown): value is MessageKind {
  return typeof value === 'string' && (MESSAGE_KINDS as readonly string[]).includes(value);
}

/** §4.3's bounds on `send_to_agent`. */
export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_PAYLOAD_BYTES = 4 * 1024;

export type Delivery = 'inlined' | 'read' | 'undelivered';

export interface MessageView {
  readonly id: string;
  readonly assignmentId: string;
  readonly fromAgentId: string | null;
  /** `null` is a broadcast (§1.4). */
  readonly toAgentId: string | null;
  readonly kind: string;
  readonly body: string | null;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly readAt: string | null;
  /** §11.2's derived value. */
  readonly delivery: Delivery;
}

export interface SendMessageInput {
  readonly assignmentId: string;
  readonly fromAgentId: string;
  /** Omit with `broadcast: true`; otherwise the co-member being written to. */
  readonly toAgentId?: string | undefined;
  readonly broadcast?: boolean | undefined;
  readonly kind: MessageKind;
  readonly body: string;
  readonly payload?: unknown;
}

export interface MailboxQuery {
  readonly assignmentId: string;
  readonly unreadOnly?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly since?: string | undefined;
}

/** What the prompt's section 4 inlines, plus the honest count of the rest. */
export interface InlinedMail {
  readonly messages: readonly MessageView[];
  readonly remaining: number;
}

export interface MailboxRepository {
  send(input: SendMessageInput): MessageView;
  /**
   * One agent's mail inside one assignment, oldest first.
   *
   * Direct messages to the agent **and** broadcasts it has not read; a broadcast
   * the agent sent itself is never in its own mailbox.
   */
  mailbox(agentId: string, query: MailboxQuery): readonly MessageView[];
  unreadCount(agentId: string, assignmentId: string): number;
  /** Marks one message read *by one agent* — the broadcast-safe form. */
  markRead(messageId: string, agentId: string): void;
  /** §5.1: `delivered_at` is set when a message is read **or** inlined. */
  markDelivered(messageId: string): void;
  /**
   * §3.2 section 4: up to `inlineMax` messages and `inlineMaxBytes`, oldest
   * first, with a count of the remainder. Marks what it returns delivered.
   */
  inlineFor(
    agentId: string,
    assignmentId: string,
    limits: { readonly inlineMax: number; readonly inlineMaxBytes: number },
  ): InlinedMail;
  /** Every message of an assignment, oldest first — the conversation view (§11.2). */
  listByAssignment(assignmentId: string): readonly MessageView[];
}

interface ReadRow {
  readonly message_id: string;
  readonly agent_id: string;
}

export interface MailboxRepositoryOptions {
  readonly db: Database;
  readonly messages: MessagesRepository;
  readonly clock: Clock;
}

export function createMailboxRepository(options: MailboxRepositoryOptions): MailboxRepository {
  const { db, messages, clock } = options;

  const insertRead = db.prepare<[string, string, string]>(
    'INSERT OR IGNORE INTO message_reads (message_id, agent_id, read_at) VALUES (?, ?, ?)',
  );
  const readsFor = db.prepare<[string], ReadRow>(
    'SELECT message_id, agent_id FROM message_reads WHERE agent_id = ?',
  );
  const readsOf = db.prepare<[string], ReadRow>(
    'SELECT message_id, agent_id FROM message_reads WHERE message_id = ?',
  );

  function now(): string {
    return isoTimestamp(clock());
  }

  function parsePayload(json: string | null): unknown {
    if (json === null) return undefined;
    try {
      return JSON.parse(json);
    } catch {
      return undefined;
    }
  }

  /**
   * §11.2's three values, from the two timestamps and nothing else.
   *
   * Whether an `undelivered` message still *could* be delivered is the
   * assignment's status, which the conversation view carries anyway — so it is
   * not folded in here. §5.1's "marked undeliverable at close" is that join, not
   * a fourth stored state.
   */
  function deliveryOf(record: MessageRecord): Delivery {
    if (record.readAt !== null) return 'read';
    if (record.toAgentId === null && readsOf.all(record.id).length > 0) return 'read';
    return record.deliveredAt === null ? 'undelivered' : 'inlined';
  }

  function view(record: MessageRecord): MessageView {
    const delivery = deliveryOf(record);
    return {
      id: record.id,
      assignmentId: record.assignmentId,
      fromAgentId: record.fromAgentId,
      toAgentId: record.toAgentId,
      kind: record.kind,
      body: record.body,
      payload: parsePayload(record.payloadJson),
      createdAt: record.createdAt,
      deliveredAt: record.deliveredAt,
      readAt: record.readAt,
      delivery,
    };
  }

  /** Read-state for one agent, covering direct rows and broadcast rows alike. */
  function readByAgent(agentId: string): ReadonlySet<string> {
    return new Set(readsFor.all(agentId).map((row) => row.message_id));
  }

  function inbox(agentId: string, query: MailboxQuery): readonly MessageRecord[] {
    const reads = readByAgent(agentId);
    return messages
      .listByAssignment(query.assignmentId)
      .filter((record) => {
        if (record.fromAgentId === agentId) return false; // never your own post
        if (record.toAgentId !== null && record.toAgentId !== agentId) return false;
        if (query.since !== undefined && record.createdAt <= query.since) return false;
        if (query.unreadOnly === false) return true;
        return record.readAt === null && !reads.has(record.id);
      })
      .slice(0, query.limit ?? Number.MAX_SAFE_INTEGER);
  }

  return {
    send(input) {
      if (input.broadcast !== true && (input.toAgentId ?? '') === '') {
        throw new InvalidRequestError(
          'Name a recipient with "to", or set "broadcast": true.',
          'to',
        );
      }
      if (!isMessageKind(input.kind)) {
        throw new InvalidRequestError(`"kind" must be one of ${MESSAGE_KINDS.join(', ')}.`, 'kind');
      }
      if (Buffer.byteLength(input.body, 'utf8') > MAX_BODY_BYTES) {
        throw new InvalidRequestError(
          `"body" is limited to ${String(MAX_BODY_BYTES)} bytes; put the long form in the artifact.`,
          'body',
        );
      }
      const payloadJson = input.payload === undefined ? null : JSON.stringify(input.payload);
      if (payloadJson !== null && Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
        throw new InvalidRequestError(
          `"payload" is limited to ${String(MAX_PAYLOAD_BYTES)} bytes.`,
          'payload',
        );
      }

      const record = messages.send({
        assignmentId: input.assignmentId,
        fromAgentId: input.fromAgentId,
        toAgentId: input.broadcast === true ? null : (input.toAgentId ?? null),
        kind: input.kind,
        body: input.body,
        payloadJson,
        createdAt: now(),
      });
      return view(record);
    },

    mailbox: (agentId, query) => inbox(agentId, query).map(view),

    unreadCount: (agentId, assignmentId) => inbox(agentId, { assignmentId }).length,

    markRead(messageId, agentId) {
      const at = now();
      const record = messages.get(messageId);
      if (record === undefined) return;
      if (record.toAgentId === agentId) {
        // The direct-message convenience §5 keeps: `messages.read_at` is set when
        // the sole recipient reads it.
        messages.markRead(messageId, at);
        return;
      }
      // A broadcast has no sole recipient, so its read state cannot live on the
      // message row (§2.1). Both stamps land: `delivered_at` too, because being
      // read implies having been delivered.
      insertRead.run(messageId, agentId, at);
      messages.markDelivered(messageId, at);
    },

    markDelivered(messageId) {
      messages.markDelivered(messageId, now());
    },

    inlineFor(agentId, assignmentId, limits) {
      const unread = inbox(agentId, { assignmentId });
      const taken: MessageRecord[] = [];
      let bytes = 0;
      for (const record of unread) {
        if (taken.length >= limits.inlineMax) break;
        const cost = Buffer.byteLength(record.body ?? '', 'utf8');
        // The first message is inlined even when it alone exceeds the byte
        // budget: a mailbox whose oldest item is 9 KB would otherwise report
        // "1 older" forever and the agent would never see it.
        if (taken.length > 0 && bytes + cost > limits.inlineMaxBytes) break;
        bytes += cost;
        taken.push(record);
      }
      const at = now();
      for (const record of taken) messages.markDelivered(record.id, at);
      return {
        messages: taken.map((record) => view(messages.get(record.id) ?? record)),
        remaining: unread.length - taken.length,
      };
    },

    listByAssignment: (assignmentId) => messages.listByAssignment(assignmentId).map(view),
  };
}
