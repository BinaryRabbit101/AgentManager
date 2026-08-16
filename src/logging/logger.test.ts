import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogging, formatPretty, type Logging } from './logger.js';
import { REDACTED } from './redaction.js';
import { daysToMs, formatDay } from './rotation.js';
import type { LogRecord, LoggingOptions } from './types.js';

/** OAuth-shaped subscription token and a remote bearer credential. */
const OAUTH_TOKEN = 'sk-ant-oat01-9WQ3ZxLpKq7RtY2mNbV5cX8dF1gH0jK4lZ_aS-eD';
const BEARER_VALUE = 'k3Jd8fQpX1sT4vB7nM0zR2yU6wA9eC5h';

const BASE = new Date('2026-08-16T12:00:00.000Z');
let clockValue = BASE;
const now = (): Date => clockValue;

let dir: string;
let logging: Logging | undefined;

function build(overrides: Partial<LoggingOptions> = {}): Logging {
  const instance = createLogging({ logsDir: dir, pretty: false, now, ...overrides });
  logging = instance;
  return instance;
}

function lines(file: string): string[] {
  return readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean);
}

function records(file: string): LogRecord[] {
  return lines(file).map((line) => JSON.parse(line) as LogRecord);
}

beforeEach(() => {
  clockValue = BASE;
  dir = mkdtempSync(join(tmpdir(), 'agentmanager-logging-'));
});

afterEach(async () => {
  await logging?.flushAndClose();
  logging = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('record shape', () => {
  it('writes valid JSON lines carrying ts, level, component and msg', () => {
    const { logger } = build();
    logger.info('service started');
    logger.warn('missing edition, defaulting to work');

    const written = records('core.log');
    expect(written).toHaveLength(2);
    const [first] = written;
    expect(first?.msg).toBe('service started');
    expect(first?.level).toBe('info');
    expect(first?.component).toBe('core');
    expect(first?.ts).toBe(BASE.toISOString());
    expect(new Date(first?.ts ?? '').toISOString()).toBe(first?.ts);
    expect(written[1]?.level).toBe('warn');
  });

  it('carries the correlation ids of DESIGN §5.1 when they are supplied', () => {
    const { logger } = build();
    logger.info(
      {
        sessionId: 'S1',
        assignmentId: 'A1',
        projectId: 'P1',
        agentId: 'agent-x',
        requestId: 'R1',
      },
      'session queued',
    );

    const [written] = records('core.log');
    expect(written).toMatchObject({
      sessionId: 'S1',
      assignmentId: 'A1',
      projectId: 'P1',
      agentId: 'agent-x',
      requestId: 'R1',
      msg: 'session queued',
    });
  });

  it('omits pino defaults that are not part of the record contract', () => {
    const { logger } = build();
    logger.info('hello');
    const [written] = records('core.log');
    expect(written).not.toHaveProperty('pid');
    expect(written).not.toHaveProperty('hostname');
    expect(written).not.toHaveProperty('time');
  });

  it('tags child loggers by component and keeps bound ids on every line', () => {
    const instance = build();
    const runner = instance.child('runner', { sessionId: 'S9' });
    runner.info('spawning');
    runner.error('failed');

    const written = records('core.log');
    expect(written.map((r) => r.component)).toEqual(['runner', 'runner']);
    expect(written.every((r) => r.sessionId === 'S9')).toBe(true);
  });

  it('puts exactly one component key on every line, on both streams', () => {
    // M7 flagged the duplicate M8 fixed: the root logger's `base` and the
    // child's binding both set `component`, so every child line carried two.
    // Valid JSONL, but `JSON.parse` keeps only the last and another reader may
    // keep either, which makes `component` unreliable as a filter — and
    // `GET /api/logs?component=` is exactly that filter.
    const instance = build();
    instance.logger.info('root line');
    instance.child('runner').info('child line');
    instance.child('storage', { sessionId: 'S1' }).warn('bound child line');
    instance.accessLogger.info({ path: '/healthz' }, 'request');

    for (const file of ['core.log', 'access.log']) {
      for (const line of lines(file)) {
        expect(line.split('"component"')).toHaveLength(2);
      }
    }
    expect(records('core.log').map((r) => r.component)).toEqual(['core', 'runner', 'storage']);
    expect(records('access.log').map((r) => r.component)).toEqual(['access']);
  });

  it('serialises errors without losing the message', () => {
    const { logger } = build();
    logger.error(new Error('storage unavailable'));
    const [written] = records('core.log');
    expect(written?.msg).toBe('storage unavailable');
    expect((written?.['err'] as { type?: string } | undefined)?.type).toBe('Error');
  });
});

describe('streams', () => {
  it('keeps access records out of core.log and vice versa', () => {
    const instance = build();
    instance.logger.info('boot');
    instance.accessLogger.info(
      { method: 'GET', path: '/api/health', status: 200, durationMs: 3, origin: 'local' },
      'request',
    );

    expect(records('core.log').map((r) => r.msg)).toEqual(['boot']);
    const [access] = records('access.log');
    expect(access).toMatchObject({ component: 'access', method: 'GET', status: 200 });
  });

  it('tees both streams into one ring buffer', () => {
    const instance = build();
    instance.logger.info('boot');
    instance.accessLogger.info({ path: '/healthz' }, 'request');

    expect(instance.ring.size).toBe(2);
    expect(instance.ring.query({ component: 'access' }).map((r) => r.msg)).toEqual(['request']);
  });

  it('reports the paths it writes to', () => {
    const instance = build();
    expect(instance.paths).toEqual({
      core: join(dir, 'core.log'),
      access: join(dir, 'access.log'),
    });
  });
});

describe('redaction at write time (DESIGN §5.4)', () => {
  it('redacts an OAuth token and a Bearer header in both the file and the ring', () => {
    const instance = build();
    instance.logger.info(
      {
        env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN },
        headers: { authorization: `Bearer ${BEARER_VALUE}` },
        note: `token is ${OAUTH_TOKEN}`,
      },
      `starting with Bearer ${BEARER_VALUE}`,
    );

    const fileText = readFileSync(join(dir, 'core.log'), 'utf8');
    const ringText = JSON.stringify(instance.ring.toArray());

    expect(fileText).not.toContain(OAUTH_TOKEN);
    expect(fileText).not.toContain(BEARER_VALUE);
    expect(ringText).not.toContain(OAUTH_TOKEN);
    expect(ringText).not.toContain(BEARER_VALUE);
    expect(fileText).toContain(REDACTED);
    expect(ringText).toContain(REDACTED);

    const [written] = records('core.log');
    expect(
      (written?.['env'] as Record<string, string> | undefined)?.['CLAUDE_CODE_OAUTH_TOKEN'],
    ).toBe(REDACTED);
    expect((written?.['headers'] as Record<string, string> | undefined)?.['authorization']).toBe(
      REDACTED,
    );
    expect(written?.['note']).toBe(`token is ${REDACTED}`);
    expect(written?.msg).toBe(`starting with Bearer ${REDACTED}`);
    expect(instance.ring.toArray()[0]?.msg).toBe(`starting with Bearer ${REDACTED}`);
  });

  it('redacts a ticket query parameter from an access record but keeps the name', () => {
    const instance = build();
    instance.accessLogger.info(
      { method: 'GET', path: '/api/logs/stream?ticket=aVerySecretTicket&level=info' },
      'request',
    );
    const [written] = records('access.log');
    expect(written?.['path']).toBe(`/api/logs/stream?ticket=${REDACTED}&level=info`);
  });

  it('keeps tokenId and token counts legible', () => {
    const instance = build();
    instance.accessLogger.info(
      { tokenId: '01JABC', tokenPrefix: 'abc123', inputTokens: 42 },
      'request',
    );
    const [written] = records('access.log');
    expect(written).toMatchObject({ tokenId: '01JABC', tokenPrefix: 'abc123', inputTokens: 42 });
  });

  it('redacts bindings attached to a child logger', () => {
    const instance = build();
    const child = instance.child('roster', { apiKey: OAUTH_TOKEN });
    child.info('compiled');
    const text = readFileSync(join(dir, 'core.log'), 'utf8');
    expect(text).not.toContain(OAUTH_TOKEN);
    expect(text).toContain(REDACTED);
  });

  it('scrubs a credential that reaches the line through a raw pino child binding', () => {
    const instance = build();
    // Bypasses `Logging.child`, so only the destination-level backstop applies.
    instance.logger.child({ trace: `Bearer ${BEARER_VALUE}` }).info('direct child');
    const text = readFileSync(join(dir, 'core.log'), 'utf8');
    expect(text).not.toContain(BEARER_VALUE);
    expect(text).toContain(REDACTED);
  });
});

describe('rotation and retention (DESIGN §5.2)', () => {
  const tinyMB = 400 / (1024 * 1024);

  it('rotates once writes pass maxFileMB and keeps every record across the files', () => {
    const instance = build({ maxFileMB: tinyMB });
    for (let i = 0; i < 12; i += 1) instance.logger.info(`line ${i} ${'x'.repeat(40)}`);

    const rotated = readdirSync(dir).filter((name) => /^core-\d{8}-\d+\.log$/.test(name));
    expect(rotated.length).toBeGreaterThan(0);

    const all = readdirSync(dir)
      .filter((name) => name.startsWith('core'))
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('');
    for (let i = 0; i < 12; i += 1) expect(all).toContain(`line ${i} `);
  });

  it('prunes rotated files beyond maxFiles', () => {
    const instance = build({ maxFileMB: tinyMB, maxFiles: 2 });
    for (let i = 0; i < 40; i += 1) instance.logger.info(`line ${i} ${'x'.repeat(40)}`);

    const rotated = readdirSync(dir).filter((name) => /^core-\d{8}-\d+\.log$/.test(name));
    expect(rotated).toHaveLength(2);
  });

  it('prunes rotated files past retentionDays on boot, and only those', () => {
    const stale = `core-${formatDay(new Date(BASE.getTime() - daysToMs(30)))}-1.log`;
    const staleAccess = `access-${formatDay(new Date(BASE.getTime() - daysToMs(30)))}-1.log`;
    const fresh = `core-${formatDay(new Date(BASE.getTime() - daysToMs(2)))}-1.log`;
    for (const name of [stale, staleAccess, fresh]) writeFileSync(join(dir, name), 'old\n');

    build({ retentionDays: 14 });

    const remaining = readdirSync(dir);
    expect(remaining).not.toContain(stale);
    expect(remaining).not.toContain(staleAccess);
    expect(remaining).toContain(fresh);
  });

  it('exposes an explicit prune pass for a long-running process', () => {
    const instance = build({ retentionDays: 14 });
    const stale = `core-${formatDay(BASE)}-1.log`;
    writeFileSync(join(dir, stale), 'old\n');

    clockValue = new Date(BASE.getTime() + daysToMs(30));
    instance.prune();
    expect(readdirSync(dir)).not.toContain(stale);
  });
});

describe('runtime level change (DESIGN §5.3)', () => {
  it('takes effect without a restart, on the root, the access stream and existing children', () => {
    const instance = build({ level: 'info' });
    const child = instance.child('runner');

    instance.logger.debug('before');
    child.debug('child before');
    instance.accessLogger.debug('access before');
    expect(records('core.log')).toHaveLength(0);

    instance.setLevel('debug');
    expect(instance.getLevel()).toBe('debug');

    instance.logger.debug('after');
    child.debug('child after');
    instance.accessLogger.debug('access after');

    expect(records('core.log').map((r) => r.msg)).toEqual(['after', 'child after']);
    expect(records('access.log').map((r) => r.msg)).toEqual(['access after']);
    expect(instance.ring.query({ level: 'debug' })).toHaveLength(3);
  });

  it('raising the level silences quieter records again', () => {
    const instance = build({ level: 'debug' });
    instance.setLevel('error');
    instance.logger.warn('ignored');
    instance.logger.error('kept');
    expect(records('core.log').map((r) => r.msg)).toEqual(['kept']);
  });

  it('rejects a level that is not part of the vocabulary', () => {
    const instance = build();
    expect(() => instance.setLevel('verbose' as never)).toThrow(RangeError);
  });
});

describe('pretty stream', () => {
  it('is off unless asked for', () => {
    const written: string[] = [];
    const instance = build({ writePretty: (chunk) => void written.push(chunk) });
    instance.logger.info('quiet');
    expect(written).toEqual([]);
  });

  it('writes a human line per record when enabled', () => {
    const written: string[] = [];
    const instance = build({ pretty: true, writePretty: (chunk) => void written.push(chunk) });
    instance.logger.info({ sessionId: 'S1' }, 'hello');

    expect(written).toHaveLength(1);
    expect(written[0]).toContain('12:00:00.000');
    expect(written[0]).toContain('INFO');
    expect(written[0]).toContain('[core]');
    expect(written[0]).toContain('hello');
    expect(written[0]).toContain('sessionId=S1');
  });

  it('formats a record without extra fields', () => {
    expect(
      formatPretty({ ts: BASE.toISOString(), level: 'warn', component: 'core', msg: 'x' }),
    ).toBe('12:00:00.000 WARN  [core] x\n');
  });
});

describe('lifecycle', () => {
  it('stops writing after flushAndClose', async () => {
    const instance = build();
    instance.logger.info('before close');
    await instance.flushAndClose();
    instance.logger.info('after close');
    expect(records('core.log').map((r) => r.msg)).toEqual(['before close']);
  });
});
