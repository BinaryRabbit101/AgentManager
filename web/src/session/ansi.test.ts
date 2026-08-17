/**
 * The ANSI-SGR formatter (DESIGN §9.1, §18 #3; IMPLEMENTATION §4).
 *
 * Two halves of one acceptance criterion: "a `Bash` result containing ANSI colour
 * renders coloured, and one containing cursor-movement escapes renders **without
 * artefacts**". The second half is the interesting one — the failure mode is not
 * a missing colour, it is a `[2K` printed on the page.
 */

import { describe, expect, it } from 'vitest';

import { hasAnsi, parseAnsi } from './ansi';

const ESC = '\u001B';
const csi = (body: string): string => `${ESC}[${body}`;

describe('colour and weight (§9.1’s "handles colour and bold")', () => {
  it('splits into styled spans and resets on 0', () => {
    const spans = parseAnsi(`${csi('31m')}broken${csi('0m')} fine`);
    expect(spans.map((span) => span.text)).toEqual(['broken', ' fine']);
    expect(spans[0]?.color).toBe('var(--ansi-red)');
    expect(spans[1]?.color).toBeUndefined();
  });

  it('handles bold, dim, italic, underline and inverse, and turns them off again', () => {
    const spans = parseAnsi(`${csi('1;4m')}loud${csi('22;24m')}quiet`);
    expect(spans[0]).toMatchObject({ text: 'loud', bold: true, underline: true });
    expect(spans[1]?.bold).toBeUndefined();
    expect(spans[1]?.underline).toBeUndefined();
  });

  it('resolves the 16 colours to theme tokens rather than to hex (§14.2)', () => {
    expect(parseAnsi(`${csi('32m')}ok`)[0]?.color).toBe('var(--ansi-green)');
    expect(parseAnsi(`${csi('91m')}loud`)[0]?.color).toBe('var(--ansi-bright-red)');
    expect(parseAnsi(`${csi('44m')}bg`)[0]?.background).toBe('var(--ansi-blue)');
    // No component may reference a raw colour, so nothing here emits one.
    expect(parseAnsi(`${csi('32m')}ok`)[0]?.color).not.toMatch(/#/u);
  });

  it('reads 256-colour and true-colour forms', () => {
    expect(parseAnsi(`${csi('38;5;40m')}x`)[0]?.color).toMatch(/^rgb\(/u);
    expect(parseAnsi(`${csi('38;5;9m')}x`)[0]?.color).toBe('var(--ansi-bright-red)');
    expect(parseAnsi(`${csi('38;2;10;20;30m')}x`)[0]?.color).toBe('rgb(10 20 30)');
    expect(parseAnsi(`${csi('48;5;236m')}x`)[0]?.background).toMatch(/^rgb\(/u);
  });

  it('treats a bare ESC[m as a reset, as terminals do', () => {
    const spans = parseAnsi(`${csi('1m')}bold${csi('m')}plain`);
    expect(spans[1]?.bold).toBeUndefined();
  });
});

describe('everything else is discarded, not printed (§9.1)', () => {
  it('leaves no artefact from cursor movement, erases or scrolls', () => {
    const noisy = `${csi('2J')}${csi('1;1H')}Building${csi('K')}...${csi('3A')}${csi('?25l')}done${csi('?25h')}`;
    const text = parseAnsi(noisy)
      .map((span) => span.text)
      .join('');
    expect(text).toBe('Building...done');
    expect(text).not.toContain('[');
    expect(text).not.toContain(ESC);
  });

  it('drops an OSC title sequence whole, both BEL- and ST-terminated', () => {
    const bel = parseAnsi(`${ESC}]0;a title\u0007after`)
      .map((span) => span.text)
      .join('');
    expect(bel).toBe('after');
    const st = parseAnsi(`${ESC}]0;a title${ESC}\\after`)
      .map((span) => span.text)
      .join('');
    expect(st).toBe('after');
  });

  it('drops two- and three-byte escapes without eating the text after them', () => {
    expect(
      parseAnsi(`${ESC}(Bplain${ESC}=more`)
        .map((span) => span.text)
        .join(''),
    ).toBe('plainmore');
  });

  it('never throws on a truncated sequence, which a streamed tail can hand it', () => {
    expect(() => parseAnsi(`${csi('3')}`)).not.toThrow();
    expect(() => parseAnsi(ESC)).not.toThrow();
    expect(() => parseAnsi(`${ESC}]0;unterminated`)).not.toThrow();
  });
});

describe('the one cursor behaviour it keeps: a line-rewriting \\r', () => {
  it('renders a progress bar as its final state, not as concatenated garbage', () => {
    const progress = 'Building 10%\rBuilding 50%\rBuilding 100%\ndone\n';
    const text = parseAnsi(progress)
      .map((span) => span.text)
      .join('');
    expect(text).toBe('Building 100%\ndone\n');
  });

  it('treats CRLF as a plain line ending', () => {
    const text = parseAnsi('one\r\ntwo\r\n')
      .map((span) => span.text)
      .join('');
    expect(text).toBe('one\ntwo\n');
  });
});

describe('plain text', () => {
  it('is one span, unchanged, and reports carrying no escapes', () => {
    expect(parseAnsi('nothing special')).toEqual([{ text: 'nothing special' }]);
    expect(hasAnsi('nothing special')).toBe(false);
    expect(hasAnsi(`${csi('31m')}red`)).toBe(true);
    expect(hasAnsi('progress\r')).toBe(true);
  });

  it('is empty for empty input', () => {
    expect(parseAnsi('')).toEqual([]);
  });
});
