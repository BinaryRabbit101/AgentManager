import { describe, expect, it } from 'vitest';

import { RouteTable } from '../modules/index.js';
import type { RegisteredRoute, RouteDefinition } from '../modules/types.js';

import { Router, splitPath } from './router.js';
import { json } from './response.js';

const handler = (): ReturnType<typeof json> => json({});

function table(...definitions: RouteDefinition[]): readonly RegisteredRoute[] {
  const routes = new RouteTable();
  routes.add('fixture', definitions);
  return routes.routes;
}

describe('splitPath', () => {
  it('drops empty segments so // and a trailing slash do not change a path', () => {
    expect(splitPath('/api//logs/')).toEqual(['api', 'logs']);
    expect(splitPath('/')).toEqual([]);
  });
});

describe('Router', () => {
  it('matches a literal path', () => {
    const router = new Router(table({ method: 'GET', path: '/healthz', handler }));
    expect(router.match('GET', '/healthz')?.route.path).toBe('/healthz');
    expect(router.match('GET', '/nope')).toBeUndefined();
  });

  it('captures :param segments and decodes them', () => {
    const router = new Router(table({ method: 'GET', path: '/api/sessions/:id', handler }));
    expect(router.match('GET', '/api/sessions/01J%20X')?.params).toEqual({ id: '01J X' });
  });

  it('prefers a literal segment over a parameter, whatever the registration order', () => {
    const router = new Router(
      table(
        { method: 'GET', path: '/api/logs/:name', handler },
        { method: 'GET', path: '/api/logs/stream', handler },
      ),
    );
    expect(router.match('GET', '/api/logs/stream')?.route.path).toBe('/api/logs/stream');
    expect(router.match('GET', '/api/logs/other')?.route.path).toBe('/api/logs/:name');
  });

  it('considers the catch-all last, and lets it match the root', () => {
    const router = new Router(
      table({ method: 'GET', path: '/*', handler }, { method: 'GET', path: '/healthz', handler }),
    );
    expect(router.match('GET', '/healthz')?.route.path).toBe('/healthz');
    expect(router.match('GET', '/questions/abc')?.route.path).toBe('/*');
    expect(router.match('GET', '/questions/abc')?.params).toEqual({ '*': 'questions/abc' });
    expect(router.match('GET', '/')?.route.path).toBe('/*');
  });

  it('answers HEAD from a GET route, and ALL from anything', () => {
    const router = new Router(
      table(
        { method: 'GET', path: '/healthz', handler },
        { method: 'ALL', path: '/api/anything', handler },
      ),
    );
    expect(router.match('HEAD', '/healthz')?.route.method).toBe('GET');
    expect(router.match('DELETE', '/api/anything')?.route.method).toBe('ALL');
    expect(router.match('POST', '/healthz')).toBeUndefined();
  });

  it('reports the methods a path does accept, ignoring the catch-all', () => {
    const router = new Router(
      table(
        { method: 'GET', path: '/*', handler },
        { method: 'PUT', path: '/api/logs/level', handler },
      ),
    );
    expect(router.allowedMethods('/api/logs/level')).toEqual(['PUT']);
    // The SPA route accepts every path, but "try GET" is the wrong answer to an
    // unknown POST — that is a 404.
    expect(router.allowedMethods('/api/nope')).toEqual([]);
  });
});
