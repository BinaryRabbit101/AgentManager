/**
 * The static SPA route and its history fallback (DESIGN §6.4).
 *
 * > "The web bundle shipped in `<install>\app\` is served by this same HTTP
 * > server, on **both** listeners, as one registered static route: the bundle's
 * > files at their own paths […] plus an **SPA history fallback** — any `GET`
 * > outside `/api/**` that matches no static file returns `index.html` with a
 * > 200. Registered `remote: 'allow'`. `/api/**` never falls through to the
 * > fallback; an unknown API path stays a JSON 404."
 *
 * The fallback is load-bearing rather than cosmetic: orchestrator's ntfy deep
 * link (`…/questions/:id`) and every bookmarked client-side route arrive as a
 * cold `GET` of a path only the SPA router knows.
 *
 * One catch-all route, registered at `GET /*`, does both jobs. The router
 * scores literal segments above a wildcard, so every real route — `/healthz`,
 * `/api/**`, and every route a feature module adds later — wins the match
 * before this one is considered, whatever order modules registered in.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import type { RouteDefinition } from '../../modules/types.js';
import type { HttpDeps } from '../deps.js';
import { notFound } from '../response.js';
import type { HttpResult, ResponseTools } from '../types.js';

/** The prefix that never falls through to the SPA (§6.4). */
export const API_PREFIX = '/api/';

/**
 * Served when no bundle is installed, so the route answers rather than 500s.
 *
 * The real bundle arrives with the ui element and is emitted by its build into
 * the install root; until then a shipped placeholder at `<root>/web/index.html`
 * stands in, and this string is the last resort if even that is missing.
 */
export const PLACEHOLDER_INDEX_HTML = [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>AgentManager</title></head>',
  '<body><h1>AgentManager</h1>',
  '<p>The core service is running. No web bundle is installed yet.</p>',
  '<p><a href="/api/health">/api/health</a></p>',
  '</body></html>',
  '',
].join('\n');

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
});

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  const extension = dot === -1 ? '' : path.slice(dot).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

/**
 * Candidate bundle locations, in order.
 *
 * `<root>/app/web` is the installed layout of §1.2 (`app\` holds "built core +
 * web bundle"); `<root>/web` is where the repository keeps the placeholder, so a
 * developer running from source gets the same route with no extra configuration.
 */
export function resolveWebRoot(installRoot: string, override?: string): string | undefined {
  const candidates = [
    ...(override === undefined ? [] : [override]),
    join(installRoot, 'app', 'web'),
    join(installRoot, 'web'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return resolve(candidate);
  }
  return undefined;
}

/** Resolves a request path inside `root`, or `undefined` if it escapes it. */
export function safeJoin(root: string, requestPath: string): string | undefined {
  const target = resolve(root, `.${requestPath}`);
  const inside = relative(root, target);
  if (inside === '') return target;
  if (inside.startsWith('..') || inside.startsWith(`..${sep}`)) return undefined;
  return target;
}

function readFile(path: string): Buffer | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

export function createSpaRoutes(deps: HttpDeps): RouteDefinition[] {
  const root = deps.webRoot;

  const indexResult = (res: ResponseTools): HttpResult => {
    const file = root === undefined ? undefined : readFile(join(root, 'index.html'));
    return res.bytes(file ?? Buffer.from(PLACEHOLDER_INDEX_HTML, 'utf8'), CONTENT_TYPES['.html']!, {
      // The shell must never be cached: it is what names the current asset
      // hashes, and a stale one points at files a redeploy has removed.
      headers: { 'cache-control': 'no-cache' },
    });
  };

  return [
    {
      method: 'GET',
      path: '/*',
      remote: 'allow',
      description: 'Static web bundle plus the SPA history fallback (§6.4).',
      handler: (req, res): HttpResult => {
        // §6.4: "/api/** never falls through to the fallback; an unknown API
        // path stays a JSON 404, so a typo'd endpoint fails as an API error
        // rather than as a page."
        if (req.path === '/api' || req.path.startsWith(API_PREFIX)) {
          return notFound(req.path);
        }

        if (req.path === '/') return indexResult(res);

        if (root !== undefined) {
          const target = safeJoin(root, req.path);
          if (target !== undefined) {
            const file = readFile(target);
            if (file !== undefined) {
              return res.bytes(file, contentTypeFor(target), {
                headers: {
                  // Build output is content-hashed, so assets are immutable;
                  // anything else is served conservatively.
                  'cache-control': req.path.startsWith('/assets/')
                    ? 'public, max-age=31536000, immutable'
                    : 'no-cache',
                },
              });
            }
          }
        }

        // The history fallback, applied literally as §6.4 states it: any GET
        // outside /api/** that matches no static file gets index.html and a 200,
        // because only the SPA router knows whether the path is a real view.
        return indexResult(res);
      },
    },
  ];
}
