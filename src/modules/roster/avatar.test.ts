/**
 * Avatar uploads and generated placeholders (roster DESIGN §3.2, §9.5).
 *
 * The refusals are the interesting half: §9.5 caps the upload by size and MIME
 * type, and M3 requires that "an oversize or non-image upload is refused and the
 * previous avatar survives". Nothing here writes, so the second clause is proven
 * structurally — the checks run before the service is ever called — and again
 * end-to-end in `service.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_AVATAR_TYPES,
  DEFAULT_AVATAR_MAX_BYTES,
  firstFilePart,
  initialsAvatarFor,
  initialsFor,
  multipartBoundary,
  placeholderAvatar,
  placeholderColour,
  readAvatarUpload,
  sniffImageType,
} from './avatar.js';
import { loadFixture } from './__tests__/fixtures.js';
import { TINY_JPEG, TINY_PNG, TINY_WEBP, multipartBody } from './__tests__/helpers.js';
import { AvatarNotAnImageError, AvatarTooLargeError } from './serviceErrors.js';

describe('sniffing the bytes rather than the declared type', () => {
  it('recognises PNG, JPEG and WebP', () => {
    expect(sniffImageType(TINY_PNG)).toBe('image/png');
    expect(sniffImageType(TINY_JPEG)).toBe('image/jpeg');
    expect(sniffImageType(TINY_WEBP)).toBe('image/webp');
    expect(ACCEPTED_AVATAR_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp']);
  });

  it('rejects anything else, however it is labelled', () => {
    expect(sniffImageType(Buffer.from('<svg>not really</svg>', 'utf8'))).toBeUndefined();
    expect(sniffImageType(Buffer.from('MZ', 'latin1'))).toBeUndefined();
    expect(sniffImageType(Buffer.alloc(0))).toBeUndefined();
    // A RIFF container that is not WebP (a .wav, say) is not an image.
    expect(sniffImageType(Buffer.from('RIFF....WAVEfmt ', 'latin1'))).toBeUndefined();
  });
});

describe('multipart parsing', () => {
  it('reads the boundary, quoted or bare', () => {
    expect(multipartBoundary('multipart/form-data; boundary=--x1')).toBe('--x1');
    expect(multipartBoundary('multipart/form-data; boundary="--x1"')).toBe('--x1');
    expect(multipartBoundary('image/png')).toBeUndefined();
    expect(multipartBoundary(undefined)).toBeUndefined();
  });

  it('extracts the first file part byte-for-byte', () => {
    const body = multipartBody('BOUND', TINY_PNG);
    expect(firstFilePart(body, 'BOUND')?.equals(TINY_PNG)).toBe(true);
  });

  it('skips text fields and finds the file after them', () => {
    const text = Buffer.from(
      '--B\r\ncontent-disposition: form-data; name="note"\r\n\r\nhello\r\n',
      'latin1',
    );
    const file = multipartBody('B', TINY_PNG);
    const body = Buffer.concat([text, file]);
    expect(firstFilePart(body, 'B')?.equals(TINY_PNG)).toBe(true);
  });
});

describe('readAvatarUpload', () => {
  it('accepts a raw image body', () => {
    const upload = readAvatarUpload({ body: TINY_PNG, contentType: 'image/png' });
    expect(upload.contentType).toBe('image/png');
    expect(upload.bytes.equals(TINY_PNG)).toBe(true);
  });

  it('accepts a multipart upload and ignores the declared part type', () => {
    const body = multipartBody('B', TINY_PNG, { contentType: 'application/octet-stream' });
    const upload = readAvatarUpload({
      body,
      contentType: 'multipart/form-data; boundary=B',
    });
    expect(upload.bytes.equals(TINY_PNG)).toBe(true);
    expect(upload.contentType).toBe('image/png');
  });

  it('refuses an oversize upload before looking at it', () => {
    const huge = Buffer.concat([TINY_PNG, Buffer.alloc(DEFAULT_AVATAR_MAX_BYTES)]);
    expect(() => readAvatarUpload({ body: huge, contentType: 'image/png' })).toThrowError(
      AvatarTooLargeError,
    );
  });

  it('refuses a non-image that claims to be one', () => {
    const lying = Buffer.from('#!/bin/sh\nrm -rf /\n', 'utf8');
    expect(() => readAvatarUpload({ body: lying, contentType: 'image/png' })).toThrowError(
      AvatarNotAnImageError,
    );
  });

  it('refuses a JSON body, which is what a confused client sends', () => {
    expect(() =>
      readAvatarUpload({
        body: { avatar: 'data:image/png;base64,…' },
        contentType: 'application/json',
      }),
    ).toThrowError(/multipart|request body/i);
  });

  it('refuses an empty upload', () => {
    expect(() =>
      readAvatarUpload({ body: Buffer.alloc(0), contentType: 'image/png' }),
    ).toThrowError(/no file part/);
  });

  it('sits under foundation’s 1 MB request-body cap, so the refusal is roster’s', () => {
    // Foundation's listener answers 413 above 1 MB before a handler runs; a
    // roster cap at exactly 1 MB would therefore never fire (avatar.ts).
    expect(DEFAULT_AVATAR_MAX_BYTES).toBeLessThan(1024 * 1024);
  });
});

describe('generated placeholders (§3.2)', () => {
  it('renders the emoji for an emoji avatar', () => {
    const image = placeholderAvatar(loadFixture('coder'));
    expect(image.contentType).toBe('image/svg+xml');
    expect(image.bytes.toString('utf8')).toContain('🐛');
  });

  it('renders the declared initials and colour', () => {
    const image = placeholderAvatar(loadFixture('email-responder')).bytes.toString('utf8');
    expect(image).toContain('>MI<');
    expect(image).toContain('#7c5cff');
  });

  it('falls back to initials derived from the name', () => {
    const minimal = loadFixture('minimal');
    expect(placeholderAvatar(minimal).bytes.toString('utf8')).toContain('>NI<');
    expect(initialsFor('Priya Bug Fixes')).toBe('PB');
    expect(initialsFor('  ')).toBe('?');
  });

  it('escapes a name that would otherwise break the SVG', () => {
    const definition = { ...loadFixture('minimal'), name: 'Nils & <script>' };
    const svg = placeholderAvatar(definition).bytes.toString('utf8');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&amp;');
  });

  it('gives an agent the same colour on every machine', () => {
    expect(placeholderColour('priya-bugfix')).toBe(placeholderColour('priya-bugfix'));
    expect(placeholderColour('priya-bugfix')).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('reverting to initials on delete (§9.5)', () => {
  it('produces an avatar the schema will accept, even from an unpronounceable name', () => {
    const definition = { ...loadFixture('minimal'), name: '🐛 🚀' };
    const avatar = initialsAvatarFor(definition);

    expect(avatar.kind).toBe('initials');
    expect(avatar.kind === 'initials' && avatar.value).toMatch(/^[A-Za-z0-9]{1,3}$/);
    expect(avatar.kind === 'initials' && avatar.color).toMatch(/^#[0-9a-f]{6}$/);
  });
});
