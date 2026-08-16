import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { createZip } from './zip.js';

/**
 * Reads an archive back with nothing but `node:zlib`, so the test proves the
 * container is real rather than that the writer agrees with itself: every entry
 * is located through the central directory, its payload decompressed, and its
 * bytes compared to the input.
 */
function readZip(archive: Buffer): Map<string, Buffer> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(-1);
  const entries = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);

  const files = new Map<string, Buffer>();
  for (let i = 0; i < entries; i += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    expect(archive.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const extraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + extraLength;
    const payload = archive.subarray(dataStart, dataStart + compressedSize);

    files.set(name, method === 8 ? inflateRawSync(payload) : Buffer.from(payload));
    cursor += 46 + nameLength;
  }
  return files;
}

describe('createZip', () => {
  it('round-trips several entries through a readable archive', () => {
    const core = Buffer.from('{"ts":"2026-08-16T12:00:00.000Z","msg":"boot"}\n'.repeat(200));
    const access = Buffer.from('{"ts":"2026-08-16T12:00:01.000Z","path":"/healthz"}\n');

    const archive = createZip([
      { name: 'core.log', data: core },
      { name: 'access.log', data: access },
    ]);

    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    const read = readZip(archive);
    expect([...read.keys()]).toEqual(['core.log', 'access.log']);
    expect(read.get('core.log')?.equals(core)).toBe(true);
    expect(read.get('access.log')?.equals(access)).toBe(true);
  });

  it('deflates compressible data and stores what deflate would grow', () => {
    const compressible = Buffer.from('a'.repeat(5000));
    const tiny = Buffer.from('x');
    const archive = createZip([
      { name: 'big.log', data: compressible },
      { name: 'tiny.log', data: tiny },
    ]);

    expect(archive.byteLength).toBeLessThan(compressible.byteLength);
    const read = readZip(archive);
    expect(read.get('big.log')?.equals(compressible)).toBe(true);
    expect(read.get('tiny.log')?.equals(tiny)).toBe(true);
  });

  it('writes a valid empty archive', () => {
    const archive = createZip([]);
    expect(archive).toHaveLength(22);
    expect(readZip(archive).size).toBe(0);
  });
});
