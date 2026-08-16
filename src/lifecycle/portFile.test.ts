/**
 * `run/core.port` — publication, discovery and staleness (DESIGN §4.2), M9.
 */
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  alreadyRunningMessage,
  PORT_FILENAME,
  probeCore,
  readPortFile,
  removePortFile,
  writePortFile,
  type PortRecord,
} from './portFile.js';

let runDir: string;
let portPath: string;
const servers: Server[] = [];

beforeEach(() => {
  runDir = mkdtempSync(resolve(tmpdir(), 'agentmanager-port-'));
  portPath = join(runDir, PORT_FILENAME);
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((done) => void server.close(() => done()));
  }
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5 });
});

const record: PortRecord = {
  port: 7477,
  pid: 1234,
  startedAt: '2026-08-16T10:00:00.000Z',
  edition: 'work',
};

/** A loopback server answering `body` at `/healthz`, on an ephemeral port. */
async function serveHealthz(body: unknown, status = 200): Promise<number> {
  const server = createServer((request, response) => {
    if (request.url !== '/healthz') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((done) => void server.listen(0, '127.0.0.1', () => done()));
  return (server.address() as { port: number }).port;
}

describe('writePortFile / readPortFile', () => {
  it('round-trips the {port, pid, startedAt, edition} record of §4.2', () => {
    writePortFile(portPath, record);
    expect(readPortFile(portPath)).toEqual(record);
  });

  it('writes readable JSON, since support scripts and Electron parse it', () => {
    writePortFile(portPath, record);
    expect(JSON.parse(readFileSync(portPath, 'utf8'))).toEqual(record);
  });

  it('leaves no temp file behind, so a reader never sees a half-written record', () => {
    writePortFile(portPath, record);
    expect(existsSync(`${portPath}.${String(record.pid)}.tmp`)).toBe(false);
  });

  it('replaces an existing record rather than appending to it', () => {
    writePortFile(portPath, record);
    writePortFile(portPath, { ...record, port: 7500, pid: 99 });
    expect(readPortFile(portPath)?.port).toBe(7500);
  });

  it('reports a missing file as undefined rather than throwing', () => {
    expect(readPortFile(portPath)).toBeUndefined();
  });

  it.each([
    ['not json at all', 'nonsense'],
    ['a truncated write', '{"port":74'],
    ['a missing port', JSON.stringify({ pid: 1, startedAt: 'x', edition: 'work' })],
    ['a port out of range', JSON.stringify({ ...record, port: 70_000 })],
    ['an unknown edition', JSON.stringify({ ...record, edition: 'staging' })],
  ])('treats %s as no record at all', (_name, content) => {
    writeFileSync(portPath, content);
    expect(readPortFile(portPath)).toBeUndefined();
  });
});

describe('removePortFile', () => {
  it('deletes the file on graceful exit', () => {
    writePortFile(portPath, record);
    expect(removePortFile(portPath)).toBe(true);
    expect(existsSync(portPath)).toBe(false);
  });

  it('is a no-op when the file is already gone', () => {
    expect(removePortFile(portPath)).toBe(false);
  });
});

describe('probeCore', () => {
  it('returns the payload when /healthz answers', async () => {
    const port = await serveHealthz({ status: 'ok', version: '0.1.0', edition: 'work' });
    await expect(probeCore(port)).resolves.toMatchObject({ status: 'ok', version: '0.1.0' });
  });

  it('reports a port nothing listens on as not answering — the stale case', async () => {
    // Bound and immediately released, so the port is real and certainly free.
    const port = await serveHealthz({ status: 'ok' });
    await new Promise<void>((done) => void servers.pop()?.close(() => done()));

    await expect(probeCore(port, { timeoutMs: 250 })).resolves.toBeUndefined();
  });

  it('rejects a listener that is not a core, even though something answers', async () => {
    const port = await serveHealthz({ hello: 'not a core' });
    await expect(probeCore(port)).resolves.toBeUndefined();
  });

  it('rejects a non-200 answer', async () => {
    const port = await serveHealthz({ status: 'ok' }, 503);
    await expect(probeCore(port)).resolves.toBeUndefined();
  });

  it('gives up after the timeout rather than hanging a start-up', async () => {
    const server = createServer(() => {
      // Never answers.
    });
    servers.push(server);
    await new Promise<void>((done) => void server.listen(0, '127.0.0.1', () => done()));
    const port = (server.address() as { port: number }).port;

    const started = Date.now();
    await expect(probeCore(port, { timeoutMs: 150 })).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('alreadyRunningMessage', () => {
  it('names the port a second instance should talk to', () => {
    const message = alreadyRunningMessage(record, 'C:\\run\\core.lock');
    expect(message).toContain('7477');
    expect(message).toContain('1234');
    expect(message).toContain('already running');
  });

  it('says so plainly when no port has been published yet', () => {
    const message = alreadyRunningMessage(undefined, 'C:\\run\\core.lock');
    expect(message).toContain('already running');
    expect(message).toContain('C:\\run\\core.lock');
  });
});
