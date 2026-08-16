/**
 * Avatars (roster DESIGN §3.2, §9.5).
 *
 * Two halves. Reading — "three kinds so the UI never has to handle a missing
 * image" (§3.2), which means `GET /agents/:id/avatar` must answer with *some*
 * image for an emoji agent, an initials agent, an agent whose file went missing,
 * and an agent with no avatar field at all. Writing — the upload path of §9.5,
 * which "closes the write path for `avatar.kind: 'file'` … which the schema and
 * `GET /agents/:id/avatar` supported but nothing could set".
 *
 * The upload rules are all refusals, and each is here rather than in the route
 * so that the *order* of the checks is visible in one place: an oversize body is
 * refused before it is sniffed, and a non-image is refused before anything is
 * written. Nothing touches the disk until every check has passed, which is what
 * makes "the previous avatar survives" (M3) true by construction rather than by
 * a rollback.
 *
 * **The declared content type is not trusted.** The format is decided by the
 * bytes' own magic numbers, because the declared type is caller-supplied and
 * this is the one route that turns a request body into a file on disk.
 */
import { AVATAR_FILENAME } from './store.js';
import type { AgentDefinition, Avatar } from './schema.js';
import {
  AvatarNotAnImageError,
  AvatarTooLargeError,
  InvalidRosterRequestError,
} from './serviceErrors.js';

/** §9.5's MIME allow-list, as the formats this recognises by their bytes. */
export const ACCEPTED_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AcceptedAvatarType = (typeof ACCEPTED_AVATAR_TYPES)[number];

/**
 * The upload cap.
 *
 * §9.5 says "default 1 MB"; this is deliberately **below** it, because
 * foundation's listener refuses any body over `DEFAULT_MAX_BODY_BYTES` (1 MB)
 * with a flat 413 before a handler is ever called (foundation §6.4). A roster
 * cap of exactly 1 MB would therefore be unreachable — every oversize upload
 * would be refused by the HTTP layer with a message about request bodies rather
 * than by roster with a message about avatars, and the "previous avatar
 * survives" guarantee would be untested. Sitting under the transport limit
 * keeps the refusal, and its explanation, roster's.
 */
export const DEFAULT_AVATAR_MAX_BYTES = 512 * 1024;

/** The name an upload is always stored under — never the caller's (§9.5). */
export { AVATAR_FILENAME };

// ---------------------------------------------------------------------------
// Reading the request
// ---------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * The image format `bytes` actually is, or `undefined`.
 *
 * WebP is a RIFF container: `RIFF` … `WEBP` at offsets 0 and 8, with the file
 * size in between, so both markers have to be checked.
 */
export function sniffImageType(bytes: Uint8Array): AcceptedAvatarType | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.byteLength >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (buffer.byteLength >= 3 && buffer.subarray(0, 3).equals(JPEG_MAGIC)) return 'image/jpeg';
  if (
    buffer.byteLength >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

/** The `boundary=` parameter of a `multipart/form-data` content type. */
export function multipartBoundary(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined;
  const [type, ...parameters] = contentType.split(';');
  if (type?.trim().toLowerCase() !== 'multipart/form-data') return undefined;
  for (const parameter of parameters) {
    const [name, ...rest] = parameter.split('=');
    if (name?.trim().toLowerCase() !== 'boundary') continue;
    const value = rest.join('=').trim();
    return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  }
  return undefined;
}

/**
 * The first file part of a multipart body.
 *
 * A deliberately small parser rather than a dependency: the only multipart
 * request in the whole API is this one, it has exactly one interesting part, and
 * the alternative is a package on the critical path of an upload that writes to
 * disk. Parts without a filename or an image content type are skipped, so a form
 * that also carries text fields still works.
 */
export function firstFilePart(body: Buffer, boundary: string): Buffer | undefined {
  const delimiter = Buffer.from(`--${boundary}`);
  const sections: Buffer[] = [];
  let cursor = body.indexOf(delimiter);
  while (cursor !== -1) {
    const start = cursor + delimiter.byteLength;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    // Trim the CRLF that opens the section and the CRLF that closes it.
    sections.push(body.subarray(start, next).subarray(2, next - start - 2));
    cursor = next;
  }

  for (const section of sections) {
    const split = section.indexOf('\r\n\r\n');
    if (split === -1) continue;
    const headers = section.subarray(0, split).toString('latin1').toLowerCase();
    const content = section.subarray(split + 4);
    if (headers.includes('filename=') || headers.includes('content-type: image/')) return content;
  }
  return undefined;
}

export interface AvatarUpload {
  readonly bytes: Buffer;
  readonly contentType: AcceptedAvatarType;
}

export interface ReadAvatarUploadOptions {
  /** The parsed body: a `Buffer` for any non-JSON content type (foundation §6.4). */
  readonly body: unknown;
  readonly contentType: string | undefined;
  readonly limit?: number;
}

/**
 * Turns a request body into the bytes to store, or refuses it.
 *
 * The order is the guarantee: size, then shape, then format. Nothing here
 * writes, and nothing here reads the existing avatar, so a refusal cannot
 * disturb what is already on disk.
 */
export function readAvatarUpload(options: ReadAvatarUploadOptions): AvatarUpload {
  const limit = options.limit ?? DEFAULT_AVATAR_MAX_BYTES;

  if (!Buffer.isBuffer(options.body)) {
    throw new InvalidRosterRequestError(
      'Send the image as the request body (content-type image/png, image/jpeg or image/webp) ' +
        'or as a multipart/form-data file part.',
    );
  }

  const boundary = multipartBoundary(options.contentType);
  const bytes = boundary === undefined ? options.body : firstFilePart(options.body, boundary);
  if (bytes === undefined || bytes.byteLength === 0) {
    throw new InvalidRosterRequestError('The upload carried no file part.');
  }
  if (bytes.byteLength > limit) throw new AvatarTooLargeError(bytes.byteLength, limit);

  const contentType = sniffImageType(bytes);
  if (contentType === undefined) throw new AvatarNotAnImageError([...ACCEPTED_AVATAR_TYPES]);

  return { bytes, contentType };
}

// ---------------------------------------------------------------------------
// Serving one
// ---------------------------------------------------------------------------

export interface AvatarImage {
  readonly bytes: Buffer;
  readonly contentType: string;
}

/**
 * The palette a generated avatar picks from, chosen by hashing the id so the
 * same agent is the same colour on every machine and after every restart.
 */
const PLACEHOLDER_COLOURS = [
  '#7c5cff',
  '#0f9d58',
  '#d93025',
  '#1a73e8',
  '#e37400',
  '#8430ce',
  '#00838f',
  '#c2185b',
] as const;

export function placeholderColour(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return PLACEHOLDER_COLOURS[hash % PLACEHOLDER_COLOURS.length] ?? '#7c5cff';
}

/** `Priya Bug Fixes` → `PB`; a single word gives its first two letters. */
export function initialsFor(name: string): string {
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .slice(0, 2);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase();
  return words.map((word) => word.slice(0, 1).toUpperCase()).join('');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The generated image for an agent with no stored file.
 *
 * SVG rather than a rasterised PNG for one reason: it needs no image library,
 * and an emoji or two letters on a coloured square is exactly the thing SVG
 * renders identically everywhere. It is generated per request and never
 * written to the library — the library holds only what the owner authored.
 */
export function placeholderAvatar(definition: AgentDefinition): AvatarImage {
  const avatar: Avatar | undefined = definition.avatar;
  const colour = avatar?.kind === 'initials' ? avatar.color : placeholderColour(definition.id);
  const glyph =
    avatar?.kind === 'emoji'
      ? avatar.value
      : avatar?.kind === 'initials'
        ? avatar.value
        : initialsFor(definition.name);
  // Emoji render at their own size; two letters need to fill the square.
  const fontSize = avatar?.kind === 'emoji' ? 64 : glyph.length > 2 ? 44 : 52;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" ` +
    `role="img" aria-label="${escapeXml(definition.name)}">` +
    `<rect width="128" height="128" rx="28" fill="${escapeXml(colour)}"/>` +
    `<text x="64" y="70" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" ` +
    `font-family="Segoe UI Emoji, Segoe UI, system-ui, sans-serif" font-size="${String(fontSize)}" ` +
    `font-weight="600">${escapeXml(glyph)}</text>` +
    `</svg>\n`;

  return { bytes: Buffer.from(svg, 'utf8'), contentType: 'image/svg+xml' };
}

/**
 * What `DELETE /agents/:id/avatar` leaves behind.
 *
 * §9.5: "removes the file and reverts the definition to its emoji or initials."
 * The emoji it *used* to have is not recoverable — replacing it with a file is
 * what overwrote it — so the revert is to initials, which §3.2 lists as a first
 * class kind and which is derived from the name the agent already has.
 */
export function initialsAvatarFor(definition: AgentDefinition): Avatar {
  // The schema constrains `initials` to one to three ASCII alphanumerics
  // (§3.2), which a display-only rendering does not have to respect and this
  // does: a name of "Ω" or "🐛" still has to produce a storable definition.
  const ascii = initialsFor(definition.name).replace(/[^A-Za-z0-9]/g, '');
  const fromId = definition.id.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const value = (ascii.length > 0 ? ascii : fromId.length > 0 ? fromId : 'A').slice(0, 3);
  return { kind: 'initials', value, color: placeholderColour(definition.id) };
}
