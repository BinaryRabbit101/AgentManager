/**
 * What remote needs from the services it consumes, expressed as the **narrowest**
 * structural types that express it — orchestrator's `ports.ts` precedent.
 *
 * Foundation §6.1: a module talks to other modules through service interfaces on
 * the registry, not through imports. Remote's one consumed service is `http`
 * (foundation §6.4's mount point), so {@link HttpPort} names the two members
 * remote calls and nothing else. The listener types it hands back are foundation's
 * own and are imported **type-only**, which keeps `src/modules/remote` free of any
 * runtime edge into `src/http`.
 */
import type { HttpListener, ListenerOptions } from '../../http/server.js';
import type { RegisteredRoute } from '../types.js';

export type { HttpListener, ListenerOptions };

/**
 * The slice of foundation's `HttpService` remote uses (§6.4).
 *
 * > "The remote module, when present, mounts **the same route table** on a second
 * > server bound to the Tailscale address with bearer-token middleware in front
 * > and an `origin: 'remote'` marker on the request context. One API, two
 * > listeners."
 */
export interface HttpPort {
  /** Foundation's one route table, as it stands now. */
  routes(): readonly RegisteredRoute[];
  /** Mounts that same table on another listener. Nothing binds until `listen()`. */
  mount(options: ListenerOptions): HttpListener;
}

/** The service name foundation publishes the HTTP mount point under (§6.4). */
export const HTTP_PORT_NAME = 'http';

/** True when this build's `http` service can mount a second listener. */
export function hasMount(http: HttpPort | undefined): http is HttpPort {
  return typeof http?.mount === 'function' && typeof http.routes === 'function';
}
