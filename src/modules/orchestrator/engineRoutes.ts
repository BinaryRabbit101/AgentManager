/**
 * The four routes the pattern engine adds to §11.1's table.
 *
 * ```
 * GET  /api/patterns                       pattern definitions, seats, defaults  (M5-1)
 * POST /api/assignments/:id/advance        plan the next turn now                (M5-2)
 * GET  /api/assignments/:id/conversation   the readable pair transcript          (M6-6)
 * GET  /api/orchestrator/status            the fleet view                        (M9-1)
 * ```
 *
 * A separate file from `routes.ts` for the reason `questionRoutes.ts` is separate:
 * M1's six assignment routes are complete and closed, and a milestone's routes
 * arriving beside it rather than inside it keeps "which milestone owns this
 * surface" readable in the diff.
 *
 * `/advance` is a **manual** advance — §11.1 calls it "plan the next turn now
 * (manual kick after a halt)", so it clears a halt and drives the loop from
 * `planned`, `halted` or `awaiting_user`, which an event-driven advance never
 * does. That is the whole difference between the two callers, and it is a
 * parameter rather than two code paths.
 */
import type { Logger } from 'pino';

import type { HttpResult, RequestContext, ResponseTools } from '../../http/types.js';
import type { RouteDefinition } from '../types.js';

import type { ConversationView } from './conversation.js';
import type { PatternEngine } from './engine.js';
import { OrchestratorError } from './errors.js';
import type { FleetStatus } from './status.js';
import type { AssignmentService } from './types.js';

export interface EngineRoutesDeps {
  readonly engine: PatternEngine;
  readonly service: AssignmentService;
  readonly conversation: (assignmentId: string) => ConversationView;
  /** §11.3's fleet view (M9-1). */
  readonly fleetStatus: () => FleetStatus;
  readonly logger: Logger;
}

export function createEngineRoutes(deps: EngineRoutesDeps): readonly RouteDefinition[] {
  const { engine, service, logger } = deps;

  async function answering(
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
          `engine request refused: ${error.message}`,
        );
        return res.error(error.status, error.code, error.message, { ...error.details });
      }
      logger.error({ err: error, path: req.path }, 'unhandled error in a pattern-engine route');
      return res.error(500, 'internal_error', 'The request could not be completed.');
    }
  }

  return [
    {
      method: 'GET',
      path: '/api/patterns',
      description: 'Pattern definitions, seats and defaults (drives the create dialog)',
      handler: (req, res) =>
        answering(req, res, () => Promise.resolve(res.json({ patterns: engine.patterns() }))),
    },
    {
      method: 'POST',
      path: '/api/assignments/:id/advance',
      description: 'Plan the next turn now — the manual kick after a halt',
      handler: (req, res) =>
        answering(req, res, async () => {
          const id = req.params['id'] ?? '';
          const outcome = await engine.advance(id, { manual: true });
          // The assignment as it now stands goes back with the outcome, so a
          // caller never has to follow up with a second GET to learn the phase
          // its own request produced.
          return res.json({ outcome, assignment: service.get(id) });
        }),
    },
    {
      method: 'GET',
      path: '/api/orchestrator/status',
      description: 'What every agent is doing: the fleet view (§11.3)',
      handler: (req, res) =>
        answering(req, res, () => Promise.resolve(res.json(deps.fleetStatus()))),
    },
    {
      method: 'GET',
      path: '/api/assignments/:id/conversation',
      description: 'The assignment as a readable conversation: rounds of turns, mail and cards',
      handler: (req, res) =>
        answering(req, res, () =>
          Promise.resolve(res.json(deps.conversation(req.params['id'] ?? ''))),
        ),
    },
  ];
}
