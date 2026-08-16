/**
 * The `messages` repository — the mailbox (§1.4, §8).
 *
 * "A mailbox is a query: `to_agent_id = ? AND read_at IS NULL ORDER BY
 * created_at`." {@link MessagesRepository.mailbox} is that query and nothing
 * else, backed by `messages(to_agent_id, read_at, created_at)` so the ordering
 * comes out of the index rather than a sort.
 *
 * Chosen over an atomic-file hive because file hives "lose ordering and
 * delivery state under concurrent assignments; a table gives both for less
 * code".
 */
import { RecordNotFoundError } from '../errors.js';
import { newId } from '../ids.js';
import type { Database } from '../sqlite.js';
import type { Clock } from '../time.js';
import { isoTimestamp } from '../time.js';
import { orNull } from './sql.js';

export interface MessageRecord {
  readonly id: string;
  readonly assignmentId: string;
  readonly fromAgentId: string | null;
  /** NULL means broadcast (§1.4). */
  readonly toAgentId: string | null;
  readonly kind: string;
  readonly body: string | null;
  readonly payloadJson: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly readAt: string | null;
}

export interface MessageInput {
  readonly id?: string;
  readonly assignmentId: string;
  readonly fromAgentId?: string | null;
  readonly toAgentId?: string | null;
  readonly kind: string;
  readonly body?: string | null;
  readonly payloadJson?: string | null;
  readonly createdAt?: string;
  readonly deliveredAt?: string | null;
  readonly readAt?: string | null;
}

export interface MailboxOptions {
  readonly limit?: number;
  /** Restrict the mailbox to one assignment, which is how agent scoping works. */
  readonly assignmentId?: string;
}

export interface MessagesRepository {
  send(input: MessageInput): MessageRecord;
  get(id: string): MessageRecord | undefined;
  /** Undelivered mail for one agent, oldest first. The mailbox query of §1.4. */
  mailbox(agentId: string, options?: MailboxOptions): readonly MessageRecord[];
  /** Count only, for the "N older" line an inlined mailbox ends with. */
  unreadCount(agentId: string): number;
  /** Every message in an assignment, oldest first — the conversation view. */
  listByAssignment(assignmentId: string, options?: { limit?: number }): readonly MessageRecord[];
  markDelivered(id: string, at?: string): MessageRecord;
  markRead(id: string, at?: string): MessageRecord;
  delete(id: string): boolean;
}

interface MessageRow {
  readonly id: string;
  readonly assignment_id: string;
  readonly from_agent_id: string | null;
  readonly to_agent_id: string | null;
  readonly kind: string;
  readonly body: string | null;
  readonly payload_json: string | null;
  readonly created_at: string;
  readonly delivered_at: string | null;
  readonly read_at: string | null;
}

const COLUMNS =
  'id, assignment_id, from_agent_id, to_agent_id, kind, body, payload_json, ' +
  'created_at, delivered_at, read_at';

function toRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    kind: row.kind,
    body: row.body,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
  };
}

export function createMessagesRepository(db: Database, clock: Clock): MessagesRepository {
  const insert = db.prepare(
    `INSERT INTO messages (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getStatement = db.prepare<[string], MessageRow>(
    `SELECT ${COLUMNS} FROM messages WHERE id = ?`,
  );

  // The mailbox, exactly as §1.4 states it. The optional assignment scope keeps
  // the scoped and unscoped forms one prepared statement.
  const mailbox = db.prepare<
    { agentId: string; assignmentId: string | null; limit: number },
    MessageRow
  >(
    `SELECT ${COLUMNS} FROM messages
     WHERE to_agent_id = :agentId AND read_at IS NULL
       AND (:assignmentId IS NULL OR assignment_id = :assignmentId)
     ORDER BY created_at
     LIMIT :limit`,
  );
  const unreadCount = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) AS n FROM messages WHERE to_agent_id = ? AND read_at IS NULL',
  );
  const byAssignment = db.prepare<[string, number], MessageRow>(
    `SELECT ${COLUMNS} FROM messages WHERE assignment_id = ? ORDER BY created_at, id LIMIT ?`,
  );
  // `COALESCE` so a re-delivery does not rewrite the first delivery's time —
  // "when did this first reach the agent" is the question the column answers.
  const setDelivered = db.prepare<[string, string]>(
    'UPDATE messages SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?',
  );
  // Being read implies having been delivered, so both stamps land together: a
  // read message with a NULL `delivered_at` would be a state nothing produces.
  const setRead = db.prepare<[string, string, string]>(
    'UPDATE messages SET read_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?',
  );
  const deleteStatement = db.prepare<[string]>('DELETE FROM messages WHERE id = ?');

  function mustGet(id: string): MessageRecord {
    const row = getStatement.get(id);
    if (row === undefined) throw new RecordNotFoundError('messages', id);
    return toRecord(row);
  }

  return {
    send(input) {
      const id = input.id ?? newId();
      insert.run(
        id,
        input.assignmentId,
        orNull(input.fromAgentId),
        orNull(input.toAgentId),
        input.kind,
        orNull(input.body),
        orNull(input.payloadJson),
        input.createdAt ?? isoTimestamp(clock()),
        orNull(input.deliveredAt),
        orNull(input.readAt),
      );
      return mustGet(id);
    },

    get: (id) => {
      const row = getStatement.get(id);
      return row === undefined ? undefined : toRecord(row);
    },

    mailbox: (agentId, options = {}) =>
      mailbox
        .all({
          agentId,
          assignmentId: options.assignmentId ?? null,
          limit: options.limit ?? -1,
        })
        .map(toRecord),

    unreadCount: (agentId) => unreadCount.get(agentId)?.n ?? 0,

    listByAssignment: (assignmentId, options = {}) =>
      byAssignment.all(assignmentId, options.limit ?? -1).map(toRecord),

    markDelivered(id, at) {
      const now = at ?? isoTimestamp(clock());
      if (setDelivered.run(now, id).changes === 0) throw new RecordNotFoundError('messages', id);
      return mustGet(id);
    },

    markRead(id, at) {
      const now = at ?? isoTimestamp(clock());
      if (setRead.run(now, now, id).changes === 0) throw new RecordNotFoundError('messages', id);
      return mustGet(id);
    },

    delete: (id) => deleteStatement.run(id).changes > 0,
  };
}
