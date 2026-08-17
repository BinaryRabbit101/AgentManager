/**
 * A QR encoder, in the app, in about 200 lines (DESIGN §13.2, §1.4).
 *
 * > "shows the plaintext **once**, as copyable text and as a **QR rendered
 * > client-side** from the returned `qrUrl` into inline SVG"
 *
 * and IMPLEMENTATION §10 makes the second half literal: "renders a QR generated
 * client-side (**no network request during generation**)".
 *
 * Why hand-rolled rather than a dependency: §1.4 forbids a CDN outright, so the
 * only alternative was another npm package in the bundle, and the encoder a
 * pairing URL needs is a *small* subset of the format — **byte mode, error
 * correction level L, versions 1–10**, which covers 271 bytes and therefore any
 * `http://<magicdns>:<port>/#t=<43-char token>` by a wide margin. That subset is
 * the file below. Anything longer throws rather than guessing, and the dialog
 * still shows the copyable text, which is the path that always works.
 *
 * The parts are all standard (ISO/IEC 18004) and each is verifiable on its own,
 * which is what the tests do: the Reed–Solomon generator polynomial for 7 EC
 * codewords is a published constant, the format bits for L/mask 0 are a
 * published constant, and the whole pipeline is proved by **reading the matrix
 * back**: the test un-masks it, de-interleaves the blocks and decodes the byte
 * segment, so placement, masking and interleaving cannot silently disagree.
 */

/** Version → (EC codewords per block, [block count, data codewords] groups) for level L. */
interface VersionSpec {
  readonly totalCodewords: number;
  readonly ecPerBlock: number;
  /** `[blocks, dataCodewordsPerBlock]`, one or two groups. */
  readonly groups: readonly (readonly [number, number])[];
  /** Alignment pattern centre coordinates (empty for version 1). */
  readonly alignment: readonly number[];
}

const VERSIONS: readonly VersionSpec[] = [
  { totalCodewords: 26, ecPerBlock: 7, groups: [[1, 19]], alignment: [] },
  { totalCodewords: 44, ecPerBlock: 10, groups: [[1, 34]], alignment: [6, 18] },
  { totalCodewords: 70, ecPerBlock: 15, groups: [[1, 55]], alignment: [6, 22] },
  { totalCodewords: 100, ecPerBlock: 20, groups: [[1, 80]], alignment: [6, 26] },
  { totalCodewords: 134, ecPerBlock: 26, groups: [[1, 108]], alignment: [6, 30] },
  { totalCodewords: 172, ecPerBlock: 18, groups: [[2, 68]], alignment: [6, 34] },
  { totalCodewords: 196, ecPerBlock: 20, groups: [[2, 78]], alignment: [6, 22, 38] },
  { totalCodewords: 242, ecPerBlock: 24, groups: [[2, 97]], alignment: [6, 24, 42] },
  { totalCodewords: 292, ecPerBlock: 30, groups: [[2, 116]], alignment: [6, 26, 46] },
  {
    totalCodewords: 346,
    ecPerBlock: 18,
    groups: [
      [2, 68],
      [2, 69],
    ],
    alignment: [6, 28, 50],
  },
];

/** The largest payload this encoder will take, in bytes (version 10, level L). */
export const MAX_QR_BYTES = 271;

// ---------------------------------------------------------------------------
// GF(256), and Reed–Solomon over it
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    // x^8 + x^4 + x^3 + x^2 + 1 — the field polynomial QR uses.
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255]!;
}

function multiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return EXP[LOG[left]! + LOG[right]!]!;
}

/** The generator polynomial for `degree` EC codewords, as coefficients. */
export function generatorPolynomial(degree: number): Uint8Array {
  let poly = Uint8Array.from([1]);
  for (let index = 0; index < degree; index += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let position = 0; position < poly.length; position += 1) {
      next[position] = (next[position] ?? 0) ^ poly[position]!;
      next[position + 1] = (next[position + 1] ?? 0) ^ multiply(poly[position]!, EXP[index]!);
    }
    poly = next;
  }
  return poly;
}

/** The Reed–Solomon remainder — the EC codewords for one block. */
export function errorCorrection(data: Uint8Array, ecLength: number): Uint8Array {
  const generator = generatorPolynomial(ecLength);
  const remainder = new Uint8Array(ecLength);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.copyWithin(0, 1);
    remainder[ecLength - 1] = 0;
    if (factor !== 0) {
      for (let index = 0; index < ecLength; index += 1) {
        remainder[index] = remainder[index]! ^ multiply(generator[index + 1]!, factor);
      }
    }
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// BCH — the format and version information blocks
// ---------------------------------------------------------------------------

function bch(value: number, generator: number, bits: number): number {
  let result = value << bits;
  const generatorBits = 32 - Math.clz32(generator);
  for (
    let length = 32 - Math.clz32(result);
    length >= generatorBits;
    length = 32 - Math.clz32(result)
  ) {
    result ^= generator << (length - generatorBits);
  }
  return (value << bits) | result;
}

/** 15 bits: EC level L (`01`) and the mask, BCH-protected and XOR-masked. */
export function formatBits(mask: number): number {
  return bch((0b01 << 3) | mask, 0b10100110111, 10) ^ 0b101010000010010;
}

/** 18 bits: the version, BCH-protected. Only versions 7 and up carry it. */
export function versionBits(version: number): number {
  // G(18,6) is 0x1F25 — thirteen bits, twelve of check. (The format code's
  // G(15,5) is the ten-bit 0x537 above; they are different polynomials.)
  return bch(version, 0b1111100100101, 12);
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

export interface QrCode {
  readonly size: number;
  /** Row-major, `true` where a module is dark. */
  readonly modules: readonly boolean[];
  readonly version: number;
  readonly mask: number;
}

function smallestVersion(byteLength: number): number {
  for (let index = 0; index < VERSIONS.length; index += 1) {
    const spec = VERSIONS[index]!;
    const dataCodewords = spec.groups.reduce((sum, [blocks, size]) => sum + blocks * size, 0);
    // Mode (4 bits) + length (8 bits below version 10, else 16) + the payload.
    const overhead = index + 1 >= 10 ? 3 : 2;
    if (dataCodewords >= byteLength + overhead) return index + 1;
  }
  throw new Error(
    `A QR of ${String(byteLength)} bytes needs a version above 10; this encoder stops there (§13.2).`,
  );
}

/** The data codewords — mode, length, payload, terminator, pad — interleaved. */
function codewords(bytes: Uint8Array, version: number): Uint8Array {
  const spec = VERSIONS[version - 1]!;
  const lengthBits = version >= 10 ? 16 : 8;
  const bits: number[] = [];
  const push = (value: number, count: number): void => {
    for (let index = count - 1; index >= 0; index -= 1) bits.push((value >> index) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, lengthBits);
  for (const byte of bytes) push(byte, 8);

  const dataCodewords = spec.groups.reduce((sum, [blocks, size]) => sum + blocks * size, 0);
  const capacity = dataCodewords * 8;
  // The terminator is up to four zero bits, then the stream is byte-aligned.
  for (let index = 0; index < 4 && bits.length < capacity; index += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(dataCodewords);
  for (let index = 0; index < bits.length / 8; index += 1) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | bits[index * 8 + bit]!;
    data[index] = byte;
  }
  // The two pad codewords, alternating, for the rest of the capacity.
  for (let index = bits.length / 8; index < dataCodewords; index += 1) {
    data[index] = (index - bits.length / 8) % 2 === 0 ? 0xec : 0x11;
  }

  // Split into blocks, compute EC per block, then interleave both halves.
  const blocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [count, size] of spec.groups) {
    for (let index = 0; index < count; index += 1) {
      const block = data.slice(offset, offset + size);
      offset += size;
      blocks.push(block);
      ecBlocks.push(errorCorrection(block, spec.ecPerBlock));
    }
  }

  const out = new Uint8Array(spec.totalCodewords);
  let position = 0;
  const longest = Math.max(...blocks.map((block) => block.length));
  for (let index = 0; index < longest; index += 1) {
    for (const block of blocks) if (index < block.length) out[position++] = block[index]!;
  }
  for (let index = 0; index < spec.ecPerBlock; index += 1) {
    for (const block of ecBlocks) out[position++] = block[index]!;
  }
  return out;
}

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

/** Encodes `text` as UTF-8 in byte mode. Throws above {@link MAX_QR_BYTES}. */
export function encodeQr(text: string, forcedMask?: number): QrCode {
  const bytes = new TextEncoder().encode(text);
  const version = smallestVersion(bytes.length);
  const spec = VERSIONS[version - 1]!;
  const size = version * 4 + 17;

  const modules = new Array<boolean>(size * size).fill(false);
  const reserved = new Array<boolean>(size * size).fill(false);
  const set = (row: number, column: number, dark: boolean): void => {
    modules[row * size + column] = dark;
    reserved[row * size + column] = true;
  };

  // Finder patterns and their separators.
  for (const [baseRow, baseColumn] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as const) {
    for (let row = -1; row <= 7; row += 1) {
      for (let column = -1; column <= 7; column += 1) {
        const y = baseRow + row;
        const x = baseColumn + column;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const inRing =
          (row >= 0 && row <= 6 && (column === 0 || column === 6)) ||
          (column >= 0 && column <= 6 && (row === 0 || row === 6));
        const inCore = row >= 2 && row <= 4 && column >= 2 && column <= 4;
        set(y, x, inRing || inCore);
      }
    }
  }

  // Timing patterns.
  for (let index = 8; index < size - 8; index += 1) {
    set(6, index, index % 2 === 0);
    set(index, 6, index % 2 === 0);
  }

  // Alignment patterns, skipping the three that would sit on a finder.
  for (const row of spec.alignment) {
    for (const column of spec.alignment) {
      const onFinder =
        (row <= 8 && column <= 8) ||
        (row <= 8 && column >= size - 9) ||
        (row >= size - 9 && column <= 8);
      if (onFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          set(row + dy, column + dx, Math.max(Math.abs(dy), Math.abs(dx)) !== 1);
        }
      }
    }
  }

  // The dark module, and the reserved format areas.
  set(size - 8, 8, true);
  for (let index = 0; index < 9; index += 1) {
    if (!reserved[8 * size + index]) set(8, index, false);
    if (!reserved[index * size + 8]) set(index, 8, false);
  }
  for (let index = 0; index < 8; index += 1) {
    if (!reserved[8 * size + (size - 1 - index)]) set(8, size - 1 - index, false);
    if (!reserved[(size - 1 - index) * size + 8]) set(size - 1 - index, 8, false);
  }
  if (version >= 7) {
    const bits = versionBits(version);
    for (let index = 0; index < 18; index += 1) {
      const dark = ((bits >> index) & 1) === 1;
      const row = Math.floor(index / 3);
      const column = index % 3;
      set(row, size - 11 + column, dark);
      set(size - 11 + column, row, dark);
    }
  }

  // The data, in the standard two-wide zigzag from the bottom right.
  const data = codewords(bytes, version);
  let bitIndex = 0;
  const dataAt = (): boolean => {
    const bit = (data[bitIndex >> 3] ?? 0) >> (7 - (bitIndex & 7));
    bitIndex += 1;
    return (bit & 1) === 1;
  };
  let upward = true;
  for (let column = size - 1; column >= 1; column -= 2) {
    // Column 6 is the vertical timing pattern: the pair steps left past it, and
    // the *stride* continues from the shifted column — 20, 18, … 8, 5, 3, 1 —
    // rather than from where it would have been. Getting this wrong produces a
    // code that still looks like a QR and does not scan.
    if (column === 6) column = 5;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const offset of [0, 1]) {
        const x = column - offset;
        if (reserved[row * size + x]) continue;
        modules[row * size + x] = bitIndex < data.length * 8 ? dataAt() : false;
      }
    }
    upward = !upward;
  }

  const chosen = forcedMask ?? bestMask(modules, reserved, size);
  const masked = modules.map((dark, index) =>
    reserved[index] ? dark : dark !== maskAt(chosen, Math.floor(index / size), index % size),
  );

  // Format information, twice, in the standard's own placement. Bit 0 is the
  // least significant, and the two copies are *not* transposes of each other —
  // the pair below is the one a scanner reads.
  const format = formatBits(chosen);
  for (let index = 0; index < 15; index += 1) {
    const dark = ((format >> index) & 1) === 1;
    // Copy one: down column 8, past the timing module at row 6.
    const row = index < 6 ? index : index < 8 ? index + 1 : size - 15 + index;
    masked[row * size + 8] = dark;
    // Copy two: along row 8, from the right, past the timing module at column 6.
    const column = index < 8 ? size - 1 - index : index === 8 ? 7 : 14 - index;
    masked[8 * size + column] = dark;
  }
  masked[(size - 8) * size + 8] = true;

  return { size, modules: masked, version, mask: chosen };
}

/** The four penalty rules, applied to each candidate mask. Lowest wins. */
function bestMask(modules: readonly boolean[], reserved: readonly boolean[], size: number): number {
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map((dark, index) =>
      reserved[index] ? dark : dark !== maskAt(mask, Math.floor(index / size), index % size),
    );
    const score = penalty(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
  }
  return best;
}

export function penalty(modules: readonly boolean[], size: number): number {
  const at = (row: number, column: number): boolean => modules[row * size + column]!;
  let score = 0;

  // Rule 1 — runs of five or more of the same colour, in both directions.
  for (let line = 0; line < size; line += 1) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let index = 1; index < size; index += 1) {
        const previous = horizontal ? at(line, index - 1) : at(index - 1, line);
        const current = horizontal ? at(line, index) : at(index, line);
        if (current === previous) {
          run += 1;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
  }

  // Rule 2 — 2×2 blocks of one colour.
  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const first = at(row, column);
      if (
        first === at(row, column + 1) &&
        first === at(row + 1, column) &&
        first === at(row + 1, column + 1)
      ) {
        score += 3;
      }
    }
  }

  // Rule 3 — the finder-like 1:1:3:1:1 pattern with four light modules beside it.
  const pattern = [true, false, true, true, true, false, true];
  for (let line = 0; line < size; line += 1) {
    for (let index = 0; index + 11 < size; index += 1) {
      for (const horizontal of [true, false]) {
        const read = (offset: number): boolean =>
          horizontal ? at(line, index + offset) : at(index + offset, line);
        const matches = (start: number): boolean =>
          pattern.every((wanted, offset) => read(start + offset) === wanted);
        const light = (start: number): boolean =>
          [0, 1, 2, 3].every((offset) => !read(start + offset));
        if (matches(0) && light(7)) score += 40;
        if (light(0) && matches(4)) score += 40;
      }
    }
  }

  // Rule 4 — the proportion of dark modules, away from half.
  const dark = modules.filter(Boolean).length;
  const percent = (dark * 100) / modules.length;
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/**
 * The matrix as an SVG path, for inline rendering.
 *
 * One path of rectangles rather than a `<rect>` per module: a version-5 code is
 * 1369 modules, and 1369 elements is a page a phone browser has to lay out.
 */
export function qrPath(code: QrCode): string {
  const parts: string[] = [];
  for (let row = 0; row < code.size; row += 1) {
    for (let column = 0; column < code.size; column += 1) {
      if (code.modules[row * code.size + column]) {
        parts.push(`M${String(column)} ${String(row)}h1v1h-1z`);
      }
    }
  }
  return parts.join('');
}
