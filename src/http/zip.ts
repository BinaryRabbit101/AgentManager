/**
 * A minimal ZIP writer, for `GET /api/logs/download` (DESIGN §5.3: "returns a
 * zip of the current log files for support, and is the only file-shaped
 * endpoint").
 *
 * ## Why not a dependency
 *
 * The ZIP container is a length-prefixed record format, and Node already ships
 * both halves of the hard part: `zlib.deflateRawSync` produces exactly the
 * method-8 bitstream a ZIP entry holds, and `zlib.crc32` (Node ≥ 20.15) the
 * checksum each entry header carries. What is left is ~70 lines of little-endian
 * field packing, written once, against a format frozen since 1993 — set against
 * `archiver`/`jszip` and their transitive trees, in a non-admin desktop install
 * that must stay auditable, for one support endpoint. The same reasoning DESIGN
 * §5.1 applies to pino.
 *
 * Scope is deliberately narrow: no ZIP64, no encryption, no streaming, no
 * directories. The inputs are a handful of log files bounded by §5.2's rotation
 * policy, and everything is assembled in memory.
 *
 * ## The reader
 *
 * {@link readZip} is the inverse, added for roster's `.agentpack` import (roster
 * DESIGN §9.4). It lives here rather than in that element for the reason the
 * writer gives: the container is one format, and two implementations of the same
 * length-prefixed record layout in one repository is one implementation too many
 * — a reader that disagreed with the writer about, say, whether the local header
 * or the central directory is authoritative would produce archives that only
 * round-trip through themselves.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

/** Deflate (8) unless storing the bytes verbatim is smaller (0). */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** PKZIP 2.0 — the feature level this writer emits and requires to read. */
const VERSION = 20;

export interface ZipEntry {
  /** Path inside the archive. Forward slashes, no leading slash. */
  readonly name: string;
  readonly data: Buffer;
  /** Modification time. Defaults to the epoch, so archives are reproducible. */
  readonly modified?: Date;
}

/** MS-DOS time/date, the only timestamp the base ZIP format has. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (Math.floor(date.getSeconds() / 2) & 0x1f) |
      ((date.getMinutes() & 0x3f) << 5) |
      ((date.getHours() & 0x1f) << 11),
    date: (date.getDate() & 0x1f) | (((date.getMonth() + 1) & 0x0f) << 5) | ((year - 1980) << 9),
  };
}

/**
 * Builds a complete `.zip` in memory.
 *
 * @throws RangeError when an entry name is not representable, which for this
 *   caller would mean a log filename it did not generate.
 */
export function createZip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (name.byteLength > 0xffff) {
      throw new RangeError(`zip entry name is too long: ${entry.name}`);
    }

    const deflated = deflateRawSync(entry.data);
    const stored = deflated.byteLength < entry.data.byteLength;
    const payload = stored ? deflated : entry.data;
    const method = stored ? METHOD_DEFLATE : METHOD_STORE;
    const checksum = crc32(entry.data);
    const stamp = dosDateTime(entry.modified ?? new Date(0));

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28); // extra field length

    parts.push(local, name, payload);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    directory.writeUInt16LE(VERSION, 4); // version made by
    directory.writeUInt16LE(VERSION, 6); // version needed
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt16LE(stamp.time, 12);
    directory.writeUInt16LE(stamp.date, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(payload.byteLength, 20);
    directory.writeUInt32LE(entry.data.byteLength, 24);
    directory.writeUInt16LE(name.byteLength, 28);
    directory.writeUInt16LE(0, 30); // extra
    directory.writeUInt16LE(0, 32); // comment
    directory.writeUInt16LE(0, 34); // disk number start
    directory.writeUInt16LE(0, 36); // internal attributes
    directory.writeUInt32LE(0, 38); // external attributes
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);

    offset += local.byteLength + name.byteLength + payload.byteLength;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, directory, end]);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The archive is not a zip, or is a zip this reader will not accept. */
export class ZipReadError extends Error {
  override readonly name = 'ZipReadError';
}

/**
 * The central directory is authoritative.
 *
 * A zip carries every entry's metadata twice — once in the local header ahead of
 * the payload, once in the central directory at the end — and the two are allowed
 * to disagree (streaming writers put zeroes in the local header and the truth in
 * the directory). Reading names, sizes and checksums from the directory and using
 * the local header only to find where the payload starts is the standard
 * resolution, and it is also the one that cannot be fooled by a crafted local
 * header naming a different file from the one the directory lists.
 */
export function readZip(archive: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(archive);
  const count = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (
      cursor + 46 > archive.byteLength ||
      archive.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE
    ) {
      throw new ZipReadError(
        `the zip central directory is truncated at entry ${String(index + 1)}`,
      );
    }
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;

    if (
      localOffset + 30 > archive.byteLength ||
      archive.readUInt32LE(localOffset) !== LOCAL_HEADER_SIGNATURE
    ) {
      throw new ZipReadError(`"${name}" does not begin with a local file header`);
    }
    // The local header's own name and extra lengths, not the directory's: the
    // extra field is routinely a different length in the two places.
    const payloadStart =
      localOffset +
      30 +
      archive.readUInt16LE(localOffset + 26) +
      archive.readUInt16LE(localOffset + 28);
    const payloadEnd = payloadStart + compressedSize;
    if (payloadEnd > archive.byteLength) {
      throw new ZipReadError(`"${name}" runs past the end of the archive`);
    }
    const payload = archive.subarray(payloadStart, payloadEnd);

    let data: Buffer;
    if (method === METHOD_STORE) {
      data = Buffer.from(payload);
    } else if (method === METHOD_DEFLATE) {
      try {
        data = inflateRawSync(payload);
      } catch (cause) {
        throw new ZipReadError(`"${name}" could not be decompressed`, { cause });
      }
    } else {
      throw new ZipReadError(
        `"${name}" uses compression method ${String(method)}; only store (0) and deflate (8) are supported`,
      );
    }

    // Both checks are cheap and both catch a corrupted download, which is the
    // realistic way a hand-shared `.agentpack` goes wrong.
    if (data.byteLength !== uncompressedSize) {
      throw new ZipReadError(
        `"${name}" is ${String(data.byteLength)} bytes, not the declared ${String(uncompressedSize)}`,
      );
    }
    if (crc32(data) !== checksum) throw new ZipReadError(`"${name}" failed its CRC check`);

    entries.push({ name, data });
  }

  return entries;
}

/**
 * The end-of-central-directory record, found by scanning backwards.
 *
 * There is no other way: the record is last, it is variable-length because of its
 * trailing comment, and the comment may itself contain the signature. Scanning
 * from the end finds the *last* plausible record, and the comment length is
 * checked against the remaining bytes so a signature that happens to sit inside a
 * comment is rejected rather than believed.
 */
function findEndOfCentralDirectory(archive: Buffer): number {
  const earliest = Math.max(0, archive.byteLength - 22 - 0xffff);
  for (let at = archive.byteLength - 22; at >= earliest; at -= 1) {
    if (archive.readUInt32LE(at) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    if (at + 22 + archive.readUInt16LE(at + 20) === archive.byteLength) return at;
  }
  throw new ZipReadError('this is not a zip archive: no end-of-central-directory record');
}
