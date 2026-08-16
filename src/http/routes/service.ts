/**
 * `POST /api/service/shutdown` (DESIGN §4.2, §6.4).
 *
 * > "Graceful shutdown on SIGINT/SIGTERM/`POST /api/service/shutdown`: stop
 * > accepting new sessions and HTTP connections → ask the runner to interrupt
 * > in-flight sessions and persist resume state → stop modules in reverse
 * > dependency order […]"
 *
 * Registered **`remote: 'deny'`** — §6.4 names this route as the example: "a
 * remote action that can brick the transport it arrived on needs someone at the
 * machine." Foundation only records the flag; remote is what refuses the request
 * (§6.4: "it enforces nothing itself, because the local listener has no notion
 * of remote").
 *
 * The stop is started only once the response has actually gone out — the request
 * context's `signal` aborts when the response closes, which is the one moment at
 * which tearing down the listener cannot truncate the answer.
 */
import type { RouteDefinition } from '../../modules/types.js';
import type { HttpDeps } from '../deps.js';

export function createServiceRoutes(deps: HttpDeps): RouteDefinition[] {
  return [
    {
      method: 'POST',
      path: '/api/service/shutdown',
      // The one route foundation registers with a non-default policy (§6.4).
      remote: 'deny',
      description: 'Starts the graceful shutdown of §4.2. Never reachable remotely.',
      handler: (req, res) => {
        const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
        const requested = (body as { reason?: unknown }).reason;
        const reason = typeof requested === 'string' && requested !== '' ? requested : 'api';

        deps.logger.warn(
          { requestId: req.requestId, origin: req.origin, reason },
          'graceful shutdown requested through the API',
        );

        req.signal.addEventListener('abort', () => deps.requestShutdown(reason), { once: true });

        return res.json(
          {
            status: 'stopping',
            reason,
            graceSeconds: deps.config.service.shutdownGraceSeconds,
          },
          { status: 202 },
        );
      },
    },
  ];
}
