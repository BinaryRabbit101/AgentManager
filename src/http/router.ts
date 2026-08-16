/**
 * Matching a request onto foundation's one route table (DESIGN §6.4).
 *
 * Deliberately small: patterns are literal segments, `:name` captures and a
 * trailing `*` catch-all. That is everything the v1 surface needs — the SPA
 * fallback is the only catch-all, and it is registered as a route like any
 * other rather than as a special case in the server.
 *
 * Specificity, not registration order, decides a winner: a literal segment beats
 * a `:param`, which beats a `*`. So `GET /api/logs/stream` wins over
 * `GET /api/logs/:name` and both win over the SPA's `GET /*`, no matter which
 * module registered first — which matters because registration order is module
 * topological order, and no element should have to reason about it.
 */
import type { RegisteredRoute } from '../modules/types.js';

import type { RouteSource } from './types.js';

type SegmentKind = 'literal' | 'param' | 'wildcard';

interface Segment {
  readonly kind: SegmentKind;
  /** Literal text, or the capture name for a `:param`. */
  readonly value: string;
}

interface CompiledRoute {
  readonly route: RegisteredRoute;
  readonly segments: readonly Segment[];
  /** Higher wins. Literal segments dominate, then parameters, then length. */
  readonly score: number;
  readonly wildcard: boolean;
}

export interface RouteMatch {
  readonly route: RegisteredRoute;
  readonly params: Readonly<Record<string, string>>;
}

/** Splits `/api/logs/stream` into `['api','logs','stream']`. */
export function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function compile(route: RegisteredRoute): CompiledRoute {
  const segments: Segment[] = [];
  let score = 0;
  let wildcard = false;

  for (const raw of splitPath(route.path)) {
    if (raw === '*') {
      segments.push({ kind: 'wildcard', value: '*' });
      wildcard = true;
      // A catch-all consumes the rest of the path, so nothing after it can match.
      break;
    }
    if (raw.startsWith(':')) {
      segments.push({ kind: 'param', value: raw.slice(1) });
      score += 2;
      continue;
    }
    segments.push({ kind: 'literal', value: raw });
    score += 3;
  }

  return { route, segments, score, wildcard };
}

function methodMatches(routeMethod: string, requestMethod: string): boolean {
  if (routeMethod === 'ALL') return true;
  if (routeMethod === requestMethod) return true;
  // A HEAD is a GET whose body is dropped on the way out (RFC 9110 §9.3.2), so
  // every GET route answers HEAD without registering a second time.
  return routeMethod === 'GET' && requestMethod === 'HEAD';
}

function matchSegments(
  compiled: CompiledRoute,
  parts: readonly string[],
): Record<string, string> | undefined {
  const params: Record<string, string> = {};

  for (let i = 0; i < compiled.segments.length; i += 1) {
    const segment = compiled.segments[i];
    if (segment === undefined) return undefined;

    if (segment.kind === 'wildcard') {
      // Matches the remainder, including nothing at all: `/*` answers `/`.
      params['*'] = parts.slice(i).join('/');
      return params;
    }

    const part = parts[i];
    if (part === undefined) return undefined;
    if (segment.kind === 'literal') {
      if (segment.value !== part) return undefined;
      continue;
    }
    params[segment.value] = decodeSegment(part);
  }

  return compiled.segments.length === parts.length ? params : undefined;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape is data, not a crash: the handler sees it verbatim.
    return value;
  }
}

export class Router {
  readonly #compiled: readonly CompiledRoute[];

  constructor(source: RouteSource) {
    const routes = Array.isArray(source)
      ? (source as readonly RegisteredRoute[])
      : (source as { routes: readonly RegisteredRoute[] }).routes;

    this.#compiled = routes
      .map(compile)
      .sort(
        (a, b) =>
          Number(a.wildcard) - Number(b.wildcard) ||
          b.score - a.score ||
          b.segments.length - a.segments.length,
      );
  }

  get size(): number {
    return this.#compiled.length;
  }

  match(method: string, path: string): RouteMatch | undefined {
    const parts = splitPath(path);
    for (const compiled of this.#compiled) {
      if (!methodMatches(compiled.route.method, method)) continue;
      const params = matchSegments(compiled, parts);
      if (params !== undefined) return { route: compiled.route, params };
    }
    return undefined;
  }

  /**
   * Methods some route accepts at `path`, for the `Allow` header of a 405.
   *
   * Wildcard routes are excluded: the SPA catch-all accepts every path, and
   * letting it contribute would turn every unknown `POST` into "405, try GET"
   * instead of the 404 it is.
   */
  allowedMethods(path: string): string[] {
    const parts = splitPath(path);
    const methods = new Set<string>();
    for (const compiled of this.#compiled) {
      if (compiled.wildcard) continue;
      if (matchSegments(compiled, parts) === undefined) continue;
      methods.add(compiled.route.method);
      if (compiled.route.method === 'GET') methods.add('HEAD');
    }
    return [...methods].sort();
  }
}
