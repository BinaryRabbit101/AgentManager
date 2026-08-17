/**
 * The QR encoder, verified by decoding its own output (DESIGN §13.2).
 *
 * A generated QR is only useful if a phone camera can read it, and nothing in
 * this repository has a camera. So the encoder is checked three ways, and
 * together they cover every stage of the pipeline:
 *
 *  1. **Published constants.** The Reed–Solomon generator polynomial for 7 EC
 *     codewords and the format bits for level L / mask 0 are fixed by
 *     ISO/IEC 18004 and are asserted literally. If the field arithmetic or the
 *     BCH code were wrong, these would not match.
 *  2. **Structure.** Finder patterns, timing patterns, the dark module and the
 *     size for each version are asserted against the spec's own rules.
 *  3. **A round trip.** The test below re-reads the matrix the way a scanner
 *     does — recover the format bits, undo the mask, walk the zigzag,
 *     de-interleave the blocks, decode the byte segment — and gets the original
 *     string back. That is what proves placement, masking and interleaving
 *     agree with each other, which is the half a constant cannot check.
 */

import { describe, expect, it } from 'vitest';

import {
  encodeQr,
  errorCorrection,
  formatBits,
  generatorPolynomial,
  MAX_QR_BYTES,
  qrPath,
  versionBits,
} from './qr';

const PAIRING_URL = 'http://workstation.jackal-hippocampus.ts.net:7478/#t=BQZ3xk9Rk2fW7aA0';

describe('the published constants (ISO/IEC 18004)', () => {
  it('builds the generator polynomial for 7 EC codewords', () => {
    // g(x) for 7 error-correction codewords, as coefficients in GF(256).
    expect([...generatorPolynomial(7)]).toEqual([1, 127, 122, 154, 164, 11, 68, 117]);
  });

  it('produces the published format bits for level L', () => {
    expect(formatBits(0)).toBe(0x77c4);
    expect(formatBits(1)).toBe(0x72f3);
    expect(formatBits(7)).toBe(0x6976);
  });

  it('produces the published version bits for the versions that carry them', () => {
    expect(versionBits(7)).toBe(0x07c94);
    expect(versionBits(10)).toBe(0x0a4d3);
  });

  it('returns exactly the requested number of EC codewords', () => {
    expect(errorCorrection(Uint8Array.from([32, 91, 11, 120, 209, 114, 220]), 10)).toHaveLength(10);
  });
});

describe('the matrix structure', () => {
  it('sizes itself 4×version + 17 and picks the smallest version that fits', () => {
    expect(encodeQr('hi').size).toBe(21);
    expect(encodeQr('hi').version).toBe(1);
    // 20 bytes no longer fits version 1 (17 bytes at level L).
    expect(encodeQr('x'.repeat(20)).version).toBe(2);
    expect(encodeQr(PAIRING_URL).size).toBe(encodeQr(PAIRING_URL).version * 4 + 17);
  });

  it('places the three finder patterns and the dark module', () => {
    const code = encodeQr(PAIRING_URL);
    const at = (row: number, column: number): boolean => code.modules[row * code.size + column]!;
    for (const [row, column] of [
      [0, 0],
      [0, code.size - 7],
      [code.size - 7, 0],
    ] as const) {
      expect(at(row, column)).toBe(true);
      expect(at(row + 1, column + 1)).toBe(false);
      expect(at(row + 3, column + 3)).toBe(true);
    }
    // The dark module is always set, whatever the mask.
    expect(at(code.size - 8, 8)).toBe(true);
  });

  it('alternates the timing patterns', () => {
    const code = encodeQr(PAIRING_URL);
    for (let index = 8; index < code.size - 8; index += 1) {
      expect(code.modules[6 * code.size + index]).toBe(index % 2 === 0);
      expect(code.modules[index * code.size + 6]).toBe(index % 2 === 0);
    }
  });

  it('refuses a payload beyond what it can encode, rather than guessing', () => {
    expect(() => encodeQr('x'.repeat(MAX_QR_BYTES + 1))).toThrow(/version above 10/u);
  });
});

// ---------------------------------------------------------------------------
// The round trip — a scanner, in about forty lines
// ---------------------------------------------------------------------------

const VERSION_SPECS: Record<number, { ec: number; groups: [number, number][] }> = {
  1: { ec: 7, groups: [[1, 19]] },
  2: { ec: 10, groups: [[1, 34]] },
  3: { ec: 15, groups: [[1, 55]] },
  4: { ec: 20, groups: [[1, 80]] },
  5: { ec: 26, groups: [[1, 108]] },
  6: { ec: 18, groups: [[2, 68]] },
};

function maskAt(mask: number, row: number, column: number): boolean {
  switch (mask) {
    case 0:
      return (row + column) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return column % 3 === 0;
    case 3:
      return (row + column) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5:
      return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6:
      return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    default:
      return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
  }
}

/** Re-reads a code the way a scanner does, and returns the decoded string. */
function decode(text: string): string {
  const code = encodeQr(text);
  const { size } = code;
  const at = (row: number, column: number): boolean => code.modules[row * size + column]!;

  // Which modules are function patterns, recomputed independently of the encoder.
  const reserved = new Set<number>();
  const reserve = (row: number, column: number): void => {
    reserved.add(row * size + column);
  };
  for (const [baseRow, baseColumn] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as const) {
    for (let row = -1; row <= 7; row += 1) {
      for (let column = -1; column <= 7; column += 1) {
        const y = baseRow + row;
        const x = baseColumn + column;
        if (y >= 0 && y < size && x >= 0 && x < size) reserve(y, x);
      }
    }
  }
  for (let index = 0; index < size; index += 1) {
    reserve(6, index);
    reserve(index, 6);
  }
  for (let index = 0; index < 9; index += 1) {
    reserve(8, index);
    reserve(index, 8);
  }
  // Eight, not nine: format copy two is eight modules along row 8 from the
  // right, and column 8 carries seven format modules plus the dark module.
  for (let index = 0; index < 8; index += 1) {
    reserve(8, size - 1 - index);
    reserve(size - 1 - index, 8);
  }
  const alignment: Record<number, number[]> = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
  };
  for (const row of alignment[code.version] ?? []) {
    for (const column of alignment[code.version] ?? []) {
      const onFinder =
        (row <= 8 && column <= 8) ||
        (row <= 8 && column >= size - 9) ||
        (row >= size - 9 && column <= 8);
      if (onFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) reserve(row + dy, column + dx);
      }
    }
  }

  // The mask is read back out of the format information, not taken from the
  // code — and out of the *second* copy, so the two copies are proved to agree.
  let format = 0;
  for (let index = 0; index < 15; index += 1) {
    const column = index < 8 ? size - 1 - index : index === 8 ? 7 : 14 - index;
    if (at(8, column)) format |= 1 << index;
  }
  const unmasked = (format ^ 0b101010000010010) >> 10;
  const mask = unmasked & 0b111;
  expect((unmasked >> 3) & 0b11).toBe(0b01); // level L
  expect(mask).toBe(code.mask);

  // The zigzag, unmasked, into a bit stream.
  const bits: number[] = [];
  let upward = true;
  for (let column = size - 1; column >= 1; column -= 2) {
    if (column === 6) column = 5;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const offset of [0, 1]) {
        const x = column - offset;
        if (reserved.has(row * size + x)) continue;
        bits.push(at(row, x) !== maskAt(mask, row, x) ? 1 : 0);
      }
    }
    upward = !upward;
  }

  const stream = new Uint8Array(Math.floor(bits.length / 8));
  for (let index = 0; index < stream.length; index += 1) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | bits[index * 8 + bit]!;
    stream[index] = byte;
  }

  // De-interleave: the data codewords were written block by block, round robin.
  const spec = VERSION_SPECS[code.version]!;
  const blockSizes = spec.groups.flatMap(([count, length]) => Array<number>(count).fill(length));
  const blocks = blockSizes.map((length) => new Uint8Array(length));
  let position = 0;
  const longest = Math.max(...blockSizes);
  for (let index = 0; index < longest; index += 1) {
    for (const [blockIndex, block] of blocks.entries()) {
      if (index < blockSizes[blockIndex]!) block[index] = stream[position++]!;
    }
  }
  const data = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    data.set(block, offset);
    offset += block.length;
  }

  // The byte-mode segment: 4 bits of mode, 8 bits of length, then the payload.
  const dataBits: number[] = [];
  for (const byte of data) {
    for (let bit = 7; bit >= 0; bit -= 1) dataBits.push((byte >> bit) & 1);
  }
  const read = (start: number, count: number): number => {
    let value = 0;
    for (let index = 0; index < count; index += 1) value = (value << 1) | dataBits[start + index]!;
    return value;
  };
  expect(read(0, 4)).toBe(0b0100); // byte mode
  const length = read(4, 8);
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = read(12 + index * 8, 8);
  return new TextDecoder().decode(bytes);
}

describe('the round trip — the matrix decodes back to what went in', () => {
  it('reads back a pairing URL', () => {
    expect(decode(PAIRING_URL)).toBe(PAIRING_URL);
  });

  it('reads back a short string, a long one, and one with non-ASCII bytes', () => {
    expect(decode('hi')).toBe('hi');
    expect(decode('http://127.0.0.1:7478/#t=' + 'a'.repeat(43))).toBe(
      'http://127.0.0.1:7478/#t=' + 'a'.repeat(43),
    );
    expect(decode('café — naïve')).toBe('café — naïve');
  });

  it('reads back a payload that needs two interleaved blocks (version 6)', () => {
    const long = `http://box.tailnet.ts.net:7478/#t=${'z'.repeat(90)}`;
    expect(encodeQr(long).version).toBeGreaterThanOrEqual(6);
    expect(decode(long)).toBe(long);
  });
});

describe('the SVG path', () => {
  it('emits one square per dark module and nothing else', () => {
    const code = encodeQr('hi');
    const path = qrPath(code);
    const squares = path.match(/M\d+ \d+h1v1h-1z/gu) ?? [];
    expect(squares).toHaveLength(code.modules.filter(Boolean).length);
    expect(path).not.toMatch(/http|url\(/u);
  });
});
