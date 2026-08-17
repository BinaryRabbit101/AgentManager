/**
 * The ANSI-SGR formatter — a formatter, not a terminal (DESIGN §9.1, §18 #3).
 *
 * > "The one narrow exception: `Bash` tool *results* can legitimately contain
 * > ANSI colour codes, because they are captured program output. Those are
 * > rendered inside a monospace `<pre>` by a ~2KB ANSI-SGR-to-`<span>` converter
 * > that handles colour and bold and **discards** cursor movement, alternate
 * > screens and everything else."
 *
 * So the scope is deliberately tiny and the rules are:
 *
 * - **SGR (`ESC [ … m`) is interpreted**: reset, bold, dim, italic, underline,
 *   inverse, the 8 + 8 bright colours, `38;5;n` / `48;5;n` and `38;2;r;g;b`.
 * - **Every other escape is dropped, not printed.** That is the whole of "renders
 *   without artefacts": a `ESC [ 2K` or a `ESC [ 1 A` leaves no `[2K` behind.
 * - **A bare carriage return resets the current line**, which is the one cursor
 *   behaviour whose absence is visible — a progress bar would otherwise render as
 *   one line of concatenated garbage. It is three lines of code and it is where
 *   the emulation stops.
 *
 * Colours resolve to CSS custom properties rather than to hex, so the palette is
 * theme-aware like everything else (§14.2) and this file names no raw colour.
 */

export interface AnsiStyle {
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly inverse?: boolean;
  /** A CSS colour: a `var(--ansi-*)` token, or an `rgb()` for 256/true colour. */
  readonly color?: string;
  readonly background?: string;
}

export interface AnsiSpan extends AnsiStyle {
  readonly text: string;
}

/** The 16 names, in code order — `30..37` then `90..97`. */
export const ANSI_COLOR_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
] as const;

function token(index: number, bright: boolean): string {
  const name = ANSI_COLOR_NAMES[index] ?? 'white';
  return `var(--ansi-${bright ? 'bright-' : ''}${name})`;
}

/** xterm's 256-colour cube and greyscale ramp, as plain `rgb()`. */
function palette256(code: number): string {
  if (code < 16) return token(code % 8, code >= 8);
  if (code < 232) {
    const offset = code - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(offset / 36) % 6] ?? 0;
    const g = steps[Math.floor(offset / 6) % 6] ?? 0;
    const b = steps[offset % 6] ?? 0;
    return `rgb(${String(r)} ${String(g)} ${String(b)})`;
  }
  const grey = 8 + (code - 232) * 10;
  return `rgb(${String(grey)} ${String(grey)} ${String(grey)})`;
}

function applySgr(style: AnsiStyle, params: readonly number[]): AnsiStyle {
  let next: AnsiStyle = style;
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index] ?? 0;
    if (code === 0) {
      next = {};
    } else if (code === 1) next = { ...next, bold: true };
    else if (code === 2) next = { ...next, dim: true };
    else if (code === 3) next = { ...next, italic: true };
    else if (code === 4) next = { ...next, underline: true };
    else if (code === 7) next = { ...next, inverse: true };
    else if (code === 22) next = withoutKeys(next, ['bold', 'dim']);
    else if (code === 23) next = withoutKeys(next, ['italic']);
    else if (code === 24) next = withoutKeys(next, ['underline']);
    else if (code === 27) next = withoutKeys(next, ['inverse']);
    else if (code >= 30 && code <= 37) next = { ...next, color: token(code - 30, false) };
    else if (code === 39) next = withoutKeys(next, ['color']);
    else if (code >= 40 && code <= 47) next = { ...next, background: token(code - 40, false) };
    else if (code === 49) next = withoutKeys(next, ['background']);
    else if (code >= 90 && code <= 97) next = { ...next, color: token(code - 90, true) };
    else if (code >= 100 && code <= 107) next = { ...next, background: token(code - 100, true) };
    else if (code === 38 || code === 48) {
      const kind = params[index + 1];
      const key = code === 38 ? 'color' : 'background';
      if (kind === 5) {
        const value = params[index + 2];
        if (value !== undefined) next = { ...next, [key]: palette256(value) };
        index += 2;
      } else if (kind === 2) {
        const r = params[index + 2] ?? 0;
        const g = params[index + 3] ?? 0;
        const b = params[index + 4] ?? 0;
        next = { ...next, [key]: `rgb(${String(r)} ${String(g)} ${String(b)})` };
        index += 4;
      }
    }
    // Everything else is a code this formatter does not claim to handle, and
    // dropping it is the point: it is not a terminal.
  }
  return next;
}

function withoutKeys(style: AnsiStyle, keys: readonly (keyof AnsiStyle)[]): AnsiStyle {
  const next: Record<string, unknown> = { ...style };
  for (const key of keys) delete next[key];
  return next;
}

/** Written as escapes rather than as literals so the file stays copy-safe. */
const ESC = '\u001B';
const BEL = '\u0007';

/**
 * Splits captured program output into styled spans.
 *
 * Never throws and never returns markup: the caller renders the spans, which is
 * what keeps agent output out of `innerHTML` (§1.4's "agent output is untrusted
 * text").
 */
export function parseAnsi(input: string): readonly AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let style: AnsiStyle = {};
  let text = '';
  /** Where the current output line begins, for the carriage-return reset. */
  let lineStartSpan = 0;
  let index = 0;

  const flush = (): void => {
    if (text !== '') {
      spans.push({ ...style, text });
      text = '';
    }
  };

  while (index < input.length) {
    const char = input[index] ?? '';

    if (char === '\r') {
      // `\r\n` is a line ending; a lone `\r` rewrites the line.
      if (input[index + 1] === '\n') {
        index += 1;
        continue;
      }
      text = '';
      spans.length = lineStartSpan;
      index += 1;
      continue;
    }

    if (char === '\n') {
      text += '\n';
      flush();
      lineStartSpan = spans.length;
      index += 1;
      continue;
    }

    if (char !== ESC) {
      text += char;
      index += 1;
      continue;
    }

    const next = input[index + 1];

    if (next === '[') {
      // CSI: parameters, then one final byte in 0x40..0x7E.
      let cursor = index + 2;
      while (cursor < input.length) {
        const code = input.charCodeAt(cursor);
        if (code >= 0x40 && code <= 0x7e) break;
        cursor += 1;
      }
      const final = input[cursor];
      if (final === 'm') {
        flush();
        const raw = input.slice(index + 2, cursor);
        const params =
          raw === ''
            ? [0]
            : raw.split(';').map((part) => (part === '' ? 0 : Number.parseInt(part, 10) || 0));
        style = applySgr(style, params);
      }
      // Any other final byte — cursor movement, erase, scroll — is discarded.
      index = cursor + 1;
      continue;
    }

    if (next === ']') {
      // OSC: runs to BEL or to ST (`ESC \`).
      let cursor = index + 2;
      while (cursor < input.length) {
        if (input[cursor] === BEL) break;
        if (input[cursor] === ESC && input[cursor + 1] === '\\') {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      index = cursor + 1;
      continue;
    }

    // A two-byte escape (`ESC (B`, `ESC =`, `ESC 7`, …). Dropped whole.
    index += next === undefined ? 1 : next === '(' || next === ')' || next === '#' ? 3 : 2;
  }

  flush();
  return spans;
}

/** True when the text carries anything this formatter would act on or drop. */
export function hasAnsi(input: string): boolean {
  return input.includes(ESC) || input.includes('\r');
}
