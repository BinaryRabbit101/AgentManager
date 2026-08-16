/**
 * The `questions` / `question_recommendations` repository (§1.4, §8).
 *
 * Persisted rather than held in memory, for two independent reasons the design
 * states together: "A question that only exists in memory is stranded by a
 * restart, and one that only exists on the desktop is stranded by the user
 * being out." Hence rows, and hence `answered_via` recording which listener the
 * answer arrived on.
 */
import { RecordNotFoundError } from '../errors.js';
import { newId } from '../ids.js';
import type { Database } from '../sqlite.js';
import type { Clock } from '../time.js';
import { isoTimestamp } from '../time.js';
import { fromJsonColumn, orNull, toJsonColumn } from './sql.js';

export type QuestionKind = 'question' | 'approval_gate' | 'budget_halt';
export type QuestionStatus = 'open' | 'answered' | 'cancelled' | 'expired';
export type AnsweredVia = 'local' | 'remote';

export interface QuestionRecord {
  readonly id: string;
  readonly assignmentId: string;
  readonly sessionId: string | null;
  readonly kind: QuestionKind;
  readonly status: QuestionStatus;
  readonly prompt: string;
  readonly optionsJson: string | null;
  readonly createdAt: string;
  readonly answeredAt: string | null;
  readonly answerJson: string | null;
  readonly answeredVia: AnsweredVia | null;
}

export interface QuestionInput {
  readonly id?: string;
  readonly assignmentId: string;
  readonly sessionId?: string | null;
  readonly kind?: QuestionKind;
  readonly prompt: string;
  /** Serialized as JSON. Pass the value, not a string. */
  readonly options?: unknown;
  readonly createdAt?: string;
  readonly recommendations?: readonly RecommendationInput[];
}

export interface RecommendationInput {
  readonly agentId: string;
  readonly stance: string;
  readonly rationale?: string | null;
  /** Shape is orchestrator's call (§1.4); stored as given. */
  readonly strength?: string | null;
}

export interface QuestionRecommendation {
  readonly questionId: string;
  readonly agentId: string;
  readonly stance: string;
  readonly rationale: string | null;
  readonly strength: string | null;
}

export interface AnswerInput {
  /** Serialized into `answer_json`. */
  readonly answer: unknown;
  readonly answeredVia: AnsweredVia;
  readonly at?: string;
}

export interface QuestionsRepository {
  /** Opens a question, with its recommendations, in one transaction. */
  open(input: QuestionInput): QuestionRecord;
  get(id: string): QuestionRecord | undefined;
  /** Open questions, oldest first — the inbox. Backed by a partial index. */
  listOpen(options?: { assignmentId?: string; limit?: number }): readonly QuestionRecord[];
  listByAssignment(assignmentId: string, options?: { limit?: number }): readonly QuestionRecord[];
  /** Answers an open question. Refuses a question that is not open. */
  answer(id: string, input: AnswerInput): QuestionRecord;
  cancel(id: string, at?: string): QuestionRecord;
  expire(id: string, at?: string): QuestionRecord;
  /** The parsed `answer_json`, or `undefined` while unanswered. */
  answerOf<T>(id: string): T | undefined;
  addRecommendation(questionId: string, input: RecommendationInput): QuestionRecommendation;
  listRecommendations(questionId: string): readonly QuestionRecommendation[];
  delete(id: string): boolean;
}

interface QuestionRow {
  readonly id: string;
  readonly assignment_id: string;
  readonly session_id: string | null;
  readonly kind: QuestionKind;
  readonly status: QuestionStatus;
  readonly prompt: string;
  readonly options_json: string | null;
  readonly created_at: string;
  readonly answered_at: string | null;
  readonly answer_json: string | null;
  readonly answered_via: AnsweredVia | null;
}

interface RecommendationRow {
  readonly question_id: string;
  readonly agent_id: string;
  readonly stance: string;
  readonly rationale: string | null;
  readonly strength: string | null;
}

const COLUMNS =
  'id, assignment_id, session_id, kind, status, prompt, options_json, ' +
  'created_at, answered_at, answer_json, answered_via';

function toRecord(row: QuestionRow): QuestionRecord {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    sessionId: row.session_id,
    kind: row.kind,
    status: row.status,
    prompt: row.prompt,
    optionsJson: row.options_json,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    answerJson: row.answer_json,
    answeredVia: row.answered_via,
  };
}

function toRecommendation(row: RecommendationRow): QuestionRecommendation {
  return {
    questionId: row.question_id,
    agentId: row.agent_id,
    stance: row.stance,
    rationale: row.rationale,
    strength: row.strength,
  };
}

export function createQuestionsRepository(db: Database, clock: Clock): QuestionsRepository {
  const insert = db.prepare(
    `INSERT INTO questions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getStatement = db.prepare<[string], QuestionRow>(
    `SELECT ${COLUMNS} FROM questions WHERE id = ?`,
  );
  const listOpen = db.prepare<{ assignmentId: string | null; limit: number }, QuestionRow>(
    `SELECT ${COLUMNS} FROM questions
     WHERE status = 'open' AND (:assignmentId IS NULL OR assignment_id = :assignmentId)
     ORDER BY created_at, id LIMIT :limit`,
  );
  const byAssignment = db.prepare<[string, number], QuestionRow>(
    `SELECT ${COLUMNS} FROM questions WHERE assignment_id = ? ORDER BY created_at, id LIMIT ?`,
  );
  // `AND status = 'open'` in the WHERE clause rather than a read-then-write:
  // two answers racing from the local and the remote listener must not both
  // succeed, and the second one changing zero rows is how that is detected.
  const answerStatement = db.prepare<[string, string | null, string, string]>(
    `UPDATE questions SET status = 'answered', answered_at = ?, answer_json = ?, answered_via = ?
     WHERE id = ? AND status = 'open'`,
  );
  const terminate = db.prepare<[string, string, string]>(
    `UPDATE questions SET status = ?, answered_at = ? WHERE id = ? AND status = 'open'`,
  );
  const insertRecommendation = db.prepare<[string, string, string, string | null, string | null]>(
    `INSERT INTO question_recommendations (question_id, agent_id, stance, rationale, strength)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(question_id, agent_id) DO UPDATE SET
       stance = excluded.stance, rationale = excluded.rationale, strength = excluded.strength`,
  );
  const listRecommendations = db.prepare<[string], RecommendationRow>(
    `SELECT question_id, agent_id, stance, rationale, strength
     FROM question_recommendations WHERE question_id = ? ORDER BY agent_id`,
  );
  const deleteStatement = db.prepare<[string]>('DELETE FROM questions WHERE id = ?');

  function mustGet(id: string): QuestionRecord {
    const row = getStatement.get(id);
    if (row === undefined) throw new RecordNotFoundError('questions', id);
    return toRecord(row);
  }

  const openTransaction = db.transaction((input: QuestionInput): string => {
    const id = input.id ?? newId();
    insert.run(
      id,
      input.assignmentId,
      orNull(input.sessionId),
      input.kind ?? 'question',
      'open',
      input.prompt,
      toJsonColumn(input.options),
      input.createdAt ?? isoTimestamp(clock()),
      null,
      null,
      null,
    );
    for (const recommendation of input.recommendations ?? []) {
      insertRecommendation.run(
        id,
        recommendation.agentId,
        recommendation.stance,
        orNull(recommendation.rationale),
        orNull(recommendation.strength),
      );
    }
    return id;
  });

  function terminateWith(id: string, status: QuestionStatus, at?: string): QuestionRecord {
    const changes = terminate.run(status, at ?? isoTimestamp(clock()), id).changes;
    if (changes === 0) {
      const existing = getStatement.get(id);
      if (existing === undefined) throw new RecordNotFoundError('questions', id);
      throw new Error(
        `Question ${id} is ${existing.status}, not open; only an open question can be ${status}.`,
      );
    }
    return mustGet(id);
  }

  return {
    open: (input) => mustGet(openTransaction(input)),

    get: (id) => {
      const row = getStatement.get(id);
      return row === undefined ? undefined : toRecord(row);
    },

    listOpen: (options = {}) =>
      listOpen
        .all({ assignmentId: options.assignmentId ?? null, limit: options.limit ?? -1 })
        .map(toRecord),

    listByAssignment: (assignmentId, options = {}) =>
      byAssignment.all(assignmentId, options.limit ?? -1).map(toRecord),

    answer(id, input) {
      const changes = answerStatement.run(
        input.at ?? isoTimestamp(clock()),
        toJsonColumn(input.answer),
        input.answeredVia,
        id,
      ).changes;
      if (changes === 0) {
        const existing = getStatement.get(id);
        if (existing === undefined) throw new RecordNotFoundError('questions', id);
        throw new Error(
          `Question ${id} is already ${existing.status}; it cannot be answered again.`,
        );
      }
      return mustGet(id);
    },

    cancel: (id, at) => terminateWith(id, 'cancelled', at),
    expire: (id, at) => terminateWith(id, 'expired', at),

    answerOf: <T>(id: string) => {
      const row = getStatement.get(id);
      if (row === undefined) throw new RecordNotFoundError('questions', id);
      return fromJsonColumn<T>(row.answer_json);
    },

    addRecommendation(questionId, input) {
      insertRecommendation.run(
        questionId,
        input.agentId,
        input.stance,
        orNull(input.rationale),
        orNull(input.strength),
      );
      return {
        questionId,
        agentId: input.agentId,
        stance: input.stance,
        rationale: input.rationale ?? null,
        strength: input.strength ?? null,
      };
    },

    listRecommendations: (questionId) => listRecommendations.all(questionId).map(toRecommendation),

    delete: (id) => deleteStatement.run(id).changes > 0,
  };
}
