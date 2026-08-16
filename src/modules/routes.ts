/**
 * Foundation's one route table (DESIGN §6.4).
 *
 * "Foundation owns one route table and one HTTP/WS framework instance. The
 * local listener binds `http.bind` (127.0.0.1). The remote module, when
 * present, mounts **the same route table** on a second server bound to the
 * Tailscale address with bearer-token middleware in front […]. One API, two
 * listeners."
 *
 * M7 owns the table and nothing else: registration happens during module
 * `init`, M8 mounts the result on the HTTP server, and remote reads
 * {@link RegisteredRoute.remote} to decide what it refuses. Foundation
 * "only records the flag and exposes it on the route table; it enforces
 * nothing itself, because the local listener has no notion of remote".
 */
import { ModuleConflictError } from './errors.js';
import type { RegisteredRoute, RemotePolicy, RouteDefinition, RouteRegistration } from './types.js';

/** §6.4: per-route remote policy metadata, "**defaulting to `allow`**". */
export const DEFAULT_REMOTE_POLICY: RemotePolicy = 'allow';

function toDefinitions(registration: RouteRegistration): readonly RouteDefinition[] {
  if (Array.isArray(registration)) return registration as readonly RouteDefinition[];
  if ('routes' in registration) return registration.routes;
  return [registration as RouteDefinition];
}

export class RouteTable {
  readonly #routes: RegisteredRoute[] = [];
  readonly #keys = new Map<string, string>();

  /**
   * Records a route, an array of routes, or any object with a `routes` array
   * (so M8's router object registers without an adapter).
   *
   * @throws ModuleConflictError when the same method and path are registered
   *   twice. Which handler wins would otherwise depend on module order, and the
   *   symptom is a route that quietly does the wrong thing.
   */
  add(moduleId: string, registration: RouteRegistration): readonly RegisteredRoute[] {
    const added: RegisteredRoute[] = [];
    for (const definition of toDefinitions(registration)) {
      const key = `${definition.method} ${definition.path}`;
      const owner = this.#keys.get(key);
      if (owner !== undefined) {
        throw new ModuleConflictError(
          `Route "${key}" is already registered by module "${owner}"; ` +
            `module "${moduleId}" cannot register it as well.`,
        );
      }

      const route: RegisteredRoute = {
        moduleId,
        method: definition.method,
        path: definition.path,
        handler: definition.handler,
        // Resolved here, once, so no consumer re-implements the default. An
        // allowlist would leave every newly added route silently broken
        // remotely until someone remembered it (§6.4).
        remote: definition.remote ?? DEFAULT_REMOTE_POLICY,
        ...(definition.description === undefined ? {} : { description: definition.description }),
      };
      this.#keys.set(key, moduleId);
      this.#routes.push(route);
      added.push(route);
    }
    return added;
  }

  /** Every route, in registration order (which is module topological order). */
  get routes(): readonly RegisteredRoute[] {
    return [...this.#routes];
  }

  get size(): number {
    return this.#routes.length;
  }

  find(method: string, path: string): RegisteredRoute | undefined {
    return this.#routes.find((route) => route.method === method && route.path === path);
  }

  /** The routes remote must refuse — the audit view of §6.4's metadata. */
  deniedRemotely(): readonly RegisteredRoute[] {
    return this.#routes.filter((route) => route.remote === 'deny');
  }

  byModule(moduleId: string): readonly RegisteredRoute[] {
    return this.#routes.filter((route) => route.moduleId === moduleId);
  }
}
