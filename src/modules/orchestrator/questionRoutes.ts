/**
 * The question inbox's HTTP surface (orchestrator DESIGN §11.1, M2-6).
 *
 * ```
 * GET    /api/questions            ?status=&assignmentId=&limit=   the inbox
 * GET    /api/questions/:id        the same card plus the full answer record
 * POST   /api/questions/:id/answer { optionIds?, labels?, text? }
 * ```
 *
 * Two properties are the whole point of the milestone and are visible here:
 *
 * - **One answer path, local and remote alike** (§16-3). `answered_via` is taken
 *   from foundation's request context (`req.origin`) and never from the body —
 *   a client that could claim `local` would be forging the audit trail on the
 *   one action a human takes.
 * - **The list projection is pinned** (§11.1, ui R5): the inbox is the screen a
 *   phone loads cold, and it must cost exactly one request, so each item already
 *   carries its recommendations and its assignment/project/session ids.
 *
 * These routes register with the default `remote: 'allow'`, because "answer it
 * from my phone over the tailnet" is the product (D3, D5). Nothing here returns
 * a file's contents, a secret, or a token.
 */
import type { Logger } from 'pino';

import type { HttpResult, RequestContext, ResponseTools } from '../../http/types.js';
import type { QuestionStatus } from '../../storage/index.js';
import type { RouteDefinition } from '../types.js';

import { InvalidRequestError, OrchestratorError } from './errors.js';
import type { AnswerQuestionInput, ListQuestionsQuery, QuestionInbox } from './questions.js';

export interface QuestionRoutesDeps {
  readonly inbox: QuestionInbox;
  readonly logger: Logger;
}

const STATUSES: readonly QuestionStatus[] = ['open', 'answered', 'cancelled', 'expired'];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalStringArray(
  record: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new InvalidRequestError(`"${field}" must be an array of strings.`, field);
  }
  return value as readonly string[];
}

function readListQuery(req: RequestContext): ListQuestionsQuery {
  const status = req.query.get('status');
  if (status !== null && !(STATUSES as readonly string[]).includes(status)) {
    throw new InvalidRequestError(`"status" must be one of ${STATUSES.join(', ')}.`, 'status');
  }
  const limitRaw = req.query.get('limit');
  const limit = limitRaw === null ? undefined : Number.parseInt(limitRaw, 10);
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new InvalidRequestError('"limit" must be a positive integer.', 'limit');
  }
  const assignmentId = req.query.get('assignmentId');
  return {
    ...(status === null ? {} : { status: status as QuestionStatus }),
    ...(assignmentId === null ? {} : { assignmentId }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function readAnswer(req: RequestContext): AnswerQuestionInput {
  const record = asRecord(req.body) ?? {};
  const text = record['text'];
  if (text !== undefined && text !== null && typeof text !== 'string') {
    throw new InvalidRequestError('"text" must be a string.', 'text');
  }
  return {
    ...(optionalStringArray(record, 'optionIds') === undefined
      ? {}
      : { optionIds: optionalStringArray(record, 'optionIds') }),
    ...(optionalStringArray(record, 'labels') === undefined
      ? {}
      : { labels: optionalStringArray(record, 'labels') }),
    ...(typeof text === 'string' ? { text } : {}),
    // §16-3: recorded from the listener the request arrived on, never the body.
    answeredVia: req.origin,
  };
}

async function answering(
  logger: Logger,
  req: RequestContext,
  res: ResponseTools,
  handler: () => Promise<HttpResult>,
): Promise<HttpResult> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof OrchestratorError) {
      req.logger.debug(
        { code: error.code, status: error.status },
        `question request refused: ${error.message}`,
      );
      return res.error(error.status, error.code, error.message, { ...error.details });
    }
    logger.error({ err: error, path: req.path }, 'unhandled error in a question route');
    return res.error(500, 'internal_error', 'The request could not be completed.');
  }
}

export function createQuestionRoutes(deps: QuestionRoutesDeps): readonly RouteDefinition[] {
  const { inbox, logger } = deps;

  return [
    {
      method: 'GET',
      path: '/api/questions',
      description: 'The question inbox',
      handler: (req, res) =>
        answering(logger, req, res, () =>
          Promise.resolve(res.json({ questions: inbox.list(readListQuery(req)) })),
        ),
    },
    {
      method: 'GET',
      path: '/api/questions/:id',
      description: 'One question card with its recommendations',
      handler: (req, res) =>
        answering(logger, req, res, () =>
          Promise.resolve(res.json(inbox.get(req.params['id'] ?? ''))),
        ),
    },
    {
      method: 'POST',
      path: '/api/questions/:id/answer',
      description: 'Answer a question — the one path, local and remote alike',
      handler: (req, res) =>
        answering(logger, req, res, () =>
          Promise.resolve(res.json(inbox.answer(req.params['id'] ?? '', readAnswer(req)))),
        ),
    },
  ];
}
