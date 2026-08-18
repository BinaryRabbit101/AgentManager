/**
 * `GET /api/widget` — DESIGN §11.5's one route.
 *
 * Its own file for the reason `questionRoutes.ts` and `engineRoutes.ts` are
 * their own: a surface arriving beside a closed one rather than inside it keeps
 * "which milestone owns this" readable in the diff. There is exactly one route
 * here and there is meant to stay exactly one — §11.5's "no parameters, and no
 * route of its own to keep working" is a design property, not an omission, so a
 * second widget-shaped endpoint is a signal that the projection is wrong rather
 * than that the file needs a sibling.
 *
 * It registers with the default `remote: 'allow'`: reading it from a phone over
 * the tailnet is the entire point (D5), and the payload carries no file
 * contents, no secret, no token, and no tool input.
 */
import type { Logger } from 'pino';

import type { RouteDefinition } from '../types.js';

import type { WidgetFeed } from './widget.js';

export interface WidgetRoutesDeps {
  readonly widgetFeed: () => WidgetFeed;
  readonly logger: Logger;
}

export function createWidgetRoutes(deps: WidgetRoutesDeps): readonly RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/api/widget',
      description: 'Is anything waiting on me: the one-request glance (§11.5)',
      handler: (req, res) => {
        try {
          return Promise.resolve(res.json(deps.widgetFeed()));
        } catch (error) {
          // A widget that renders a stale cache is a better outcome than one
          // that renders an error, so this answers 500 and lets the client fall
          // back — the same contract every other read route here has.
          deps.logger.error({ err: error, path: req.path }, 'the widget feed could not be built');
          return Promise.resolve(
            res.error(500, 'internal_error', 'The request could not be completed.'),
          );
        }
      },
    },
  ];
}
