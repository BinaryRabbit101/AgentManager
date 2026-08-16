/**
 * The pieces the routes are built from, tested without a socket — which is the
 * property the handler contract exists to give (see `./types.ts`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bytes, empty, error, json, notFound, text } from './response.js';
import { normalisePath, parseBody, InvalidBodyError } from './request.js';
import { uptimeSeconds } from './routes/health.js';
import { parseLogQuery, MAX_LOG_LIMIT } from './routes/logs.js';
import { parseTypes } from './routes/events.js';
import { sanitiseOrigin } from './routes/config.js';
import { contentTypeFor, resolveWebRoot, safeJoin } from './routes/spa.js';

describe('response helpers', () => {
  it('serialises JSON with a content length and a default status', () => {
    const result = json({ ok: true });
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(result.headers['content-length']).toBe('11');
    expect(result.body?.toString('utf8')).toBe('{"ok":true}');
  });

  it('never answers JSON with zero bytes', () => {
    expect(json(undefined).body?.toString('utf8')).toBe('null');
  });

  it('lowercases caller headers so nothing is set twice under two spellings', () => {
    const result = text('hi', { status: 201, headers: { 'Cache-Control': 'no-store' } });
    expect(result.status).toBe(201);
    expect(result.headers['cache-control']).toBe('no-store');
  });

  it('gives every error one shape', () => {
    const result = error(400, 'invalid_request', 'nope', { parameter: 'level' });
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body?.toString('utf8') ?? '')).toEqual({
      error: 'invalid_request',
      message: 'nope',
      parameter: 'level',
    });
  });

  it('shares one 404 body between the router and the SPA route', () => {
    const result = notFound('/api/nope');
    expect(result.status).toBe(404);
    expect(JSON.parse(result.body?.toString('utf8') ?? '')).toMatchObject({
      error: 'not_found',
      path: '/api/nope',
    });
  });

  it('writes a body-less 204 by default', () => {
    expect(empty()).toMatchObject({ status: 204, body: undefined });
    expect(bytes(Buffer.from('x'), 'application/zip').headers['content-type']).toBe(
      'application/zip',
    );
  });
});

describe('request parsing', () => {
  it('collapses repeated and trailing slashes', () => {
    expect(normalisePath('//api//logs/')).toBe('/api/logs');
    expect(normalisePath('/')).toBe('/');
  });

  it('parses JSON bodies and refuses malformed ones', () => {
    expect(parseBody(Buffer.from('{"level":"debug"}'), 'application/json')).toEqual({
      level: 'debug',
    });
    expect(parseBody(Buffer.alloc(0), 'application/json')).toBeUndefined();
    expect(() => parseBody(Buffer.from('{'), 'application/json')).toThrow(InvalidBodyError);
    // A non-JSON type is handed on verbatim rather than guessed at.
    expect(parseBody(Buffer.from('raw'), 'application/octet-stream')).toBeInstanceOf(Buffer);
  });
});

describe('uptimeSeconds', () => {
  it('reports seconds to two decimals and never goes negative', () => {
    const start = new Date('2026-08-16T12:00:00.000Z');
    expect(uptimeSeconds(start, new Date('2026-08-16T12:00:01.500Z'))).toBe(1.5);
    expect(uptimeSeconds(start, new Date('2026-08-16T11:59:59.000Z'))).toBe(0);
  });
});

describe('parseLogQuery', () => {
  it('accepts the documented filters and caps the limit', () => {
    const parsed = parseLogQuery(
      new URLSearchParams({
        level: 'warn',
        component: 'runner',
        sessionId: 'S1',
        since: '2026-08-16T12:00:00.000Z',
        limit: '99999',
      }),
    );
    expect(parsed.failure).toBeUndefined();
    expect(parsed.query).toEqual({
      level: 'warn',
      component: 'runner',
      sessionId: 'S1',
      since: '2026-08-16T12:00:00.000Z',
      limit: MAX_LOG_LIMIT,
    });
  });

  it('names the parameter it could not use', () => {
    expect(parseLogQuery(new URLSearchParams({ level: 'loud' })).failure?.parameter).toBe('level');
    expect(parseLogQuery(new URLSearchParams({ since: 'yesterday' })).failure?.parameter).toBe(
      'since',
    );
    expect(parseLogQuery(new URLSearchParams({ limit: '-1' })).failure?.parameter).toBe('limit');
  });
});

describe('parseTypes', () => {
  it('splits, trims, and treats an empty list as no filter', () => {
    expect(parseTypes('session.started, question.*')).toEqual(['session.started', 'question.*']);
    expect(parseTypes(null)).toBeUndefined();
    expect(parseTypes(' , ')).toBeUndefined();
  });
});

describe('sanitiseOrigin', () => {
  it('keeps the key of a --set flag and drops its value', () => {
    expect(sanitiseOrigin('cli:--set agentEnv.TOKEN=secret-value')).toBe(
      'cli:--set agentEnv.TOKEN',
    );
    expect(sanitiseOrigin('env:AGENTMANAGER_HTTP_PORT')).toBe('env:AGENTMANAGER_HTTP_PORT');
    expect(sanitiseOrigin('C:\\install\\config\\defaults.json')).toBe(
      'C:\\install\\config\\defaults.json',
    );
  });
});

describe('static bundle resolution', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentmanager-web-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('prefers the installed layout, then the repository one, then nothing', () => {
    expect(resolveWebRoot(root)).toBeUndefined();

    mkdirSync(join(root, 'web'), { recursive: true });
    writeFileSync(join(root, 'web', 'index.html'), '<html>repo</html>');
    expect(resolveWebRoot(root)).toBe(join(root, 'web'));

    mkdirSync(join(root, 'app', 'web'), { recursive: true });
    writeFileSync(join(root, 'app', 'web', 'index.html'), '<html>installed</html>');
    expect(resolveWebRoot(root)).toBe(join(root, 'app', 'web'));
  });

  it('honours an explicit override above both', () => {
    mkdirSync(join(root, 'custom'), { recursive: true });
    writeFileSync(join(root, 'custom', 'index.html'), '<html>custom</html>');
    expect(resolveWebRoot(root, join(root, 'custom'))).toBe(join(root, 'custom'));
  });

  it('refuses a path that escapes the bundle root', () => {
    expect(safeJoin(root, '/assets/app.js')).toBe(join(root, 'assets', 'app.js'));
    expect(safeJoin(root, '/../../secrets.json')).toBeUndefined();
    expect(safeJoin(root, '/')).toBe(root);
  });

  it('names content types from the extension, defaulting to octet-stream', () => {
    expect(contentTypeFor('/assets/app.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('/index.HTML')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('/favicon.ico')).toBe('image/x-icon');
    expect(contentTypeFor('/unknown.bin')).toBe('application/octet-stream');
  });
});
