/**
 * `/healthz` and `/api/health` (DESIGN §6.4, §4.1).
 *
 * Two endpoints, deliberately different in cost:
 *
 * - **`/healthz`** is the liveness probe Electron polls before deciding whether
 *   to spawn the core (§4.1) and the installer waits on (§4.4). It answers from
 *   in-memory facts only — version, edition, lifecycle phase, uptime — and
 *   **touches no database**, which is what keeps it inside M8's 50 ms budget
 *   even while a migration or a `quick_check` is grinding.
 * - **`/api/health`** is the diagnostic view: M7's aggregate, with every
 *   module's status individually and every raised condition flattened for a UI
 *   banner (§6.2, §3.1's keyfile degradation, §3.5's `ANTHROPIC_API_KEY`
 *   condition).
 */
import type { RouteDefinition } from '../../modules/types.js';
import type { HttpDeps } from '../deps.js';

/** Phases in which the service is up and serving; anything else is a transition. */
const READY_PHASES = new Set(['listener-bind', 'ready']);

export function uptimeSeconds(startedAt: Date, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 10) / 100);
}

export function createHealthRoutes(deps: HttpDeps): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/healthz',
      description: 'Liveness probe: in-memory facts only, no database access.',
      handler: (_req, res) => {
        const phase = deps.phase();
        return res.json({
          status: READY_PHASES.has(phase) ? 'ok' : phase === 'stopping' ? 'stopping' : 'starting',
          version: deps.version,
          edition: deps.config.edition,
          uptime: uptimeSeconds(deps.startedAt, deps.clock()),
          phase,
        });
      },
    },
    {
      method: 'GET',
      path: '/api/health',
      description: 'Aggregated module health, with degraded modules reported individually.',
      handler: async (_req, res) => {
        const aggregate = await deps.health();
        return res.json(
          {
            status: aggregate.status,
            phase: aggregate.phase,
            version: deps.version,
            edition: deps.config.edition,
            uptime: uptimeSeconds(deps.startedAt, deps.clock()),
            modules: aggregate.modules,
            conditions: aggregate.conditions,
          },
          // A degraded service is still answering, so it answers 200 and says so
          // in the body; only a service that cannot serve its own health is a 503.
          { status: aggregate.status === 'failed' ? 503 : 200 },
        );
      },
    },
  ];
}
