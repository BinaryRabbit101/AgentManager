/**
 * The contrast audit (DESIGN §15, §14.2; IMPLEMENTATION §11).
 *
 * > "**Contrast** meets WCAG AA (4.5:1 body, 3:1 large and UI) in **both**
 * > themes; the token file carries the measured ratios and **the check runs in
 * > CI**."
 *
 * So this is not a helper for a component — nothing at runtime calls it. It is
 * the machinery `contrast.test.ts` uses to read `theme/tokens.css`, measure
 * every pair, and fail the build when one drifts. Recording the ratio beside
 * the token in the stylesheet is the other half: a number in a comment that
 * disagrees with the measurement is itself a failure, so the comments cannot rot
 * into decoration.
 */

/** WCAG 2.1 thresholds. Body text, then large text and UI boundaries. */
export const AA_TEXT = 4.5;
export const AA_LARGE = 3;

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export function parseHex(value: string): Rgb | undefined {
  const hex = value.trim().replace('#', '');
  const expanded =
    hex.length === 3
      ? hex
          .split('')
          .map((char) => char + char)
          .join('')
      : hex;
  if (!/^[0-9a-f]{6}$/iu.test(expanded)) return undefined;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

/** WCAG relative luminance. */
export function luminance(colour: Rgb): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b);
}

export function contrastRatio(foreground: string, background: string): number {
  const first = parseHex(foreground);
  const second = parseHex(background);
  if (first === undefined || second === undefined) {
    throw new Error(`Not a hex colour: ${foreground} on ${background}`);
  }
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

/** Rounded the way the recorded comments are written, so they can be compared. */
export function recordedRatio(value: number): string {
  return `${value.toFixed(1)}:1`;
}

export interface TokenTable {
  /** `--token` → the hex value, for one theme. */
  readonly values: Readonly<Record<string, string>>;
  /** `--token` → the ratio written beside it in the stylesheet, if any. */
  readonly recorded: Readonly<Record<string, string>>;
}

/**
 * Reads one theme's block out of `tokens.css`.
 *
 * The blocks are found by their **selector with its brace**, never by prose:
 * the file's header comment names all three selectors, and a search that
 * matched the comment would slice an empty block and pass for nothing.
 */
export function readTheme(css: string, selector: string, until: string): TokenTable {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`tokens.css has no ${selector}`);
  const end = css.indexOf(until, start + selector.length);
  const block = css.slice(start, end === -1 ? css.length : end);

  const values: Record<string, string> = {};
  const recorded: Record<string, string> = {};
  const line = /--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;(?:\s*\/\*\s*([^*]*?)\s*\*\/)?/gu;
  let match: RegExpExecArray | null;
  while ((match = line.exec(block)) !== null) {
    const [, name, hex, comment] = match;
    if (name === undefined || hex === undefined) continue;
    values[name] = hex;
    const ratio = comment === undefined ? undefined : /(\d+\.\d+):1/u.exec(comment)?.[0];
    if (ratio !== undefined) recorded[name] = ratio;
  }
  return { values, recorded };
}

/** One pair to check: a foreground token over a background token. */
export interface Pair {
  readonly foreground: string;
  readonly background: string;
  readonly minimum: number;
}

/**
 * Every pair the app actually paints, per theme.
 *
 * Built from the token names rather than listed by hand, so a specialty or
 * status token added later is audited the moment it exists — which is the only
 * way "every token pair" can stay true.
 */
export function pairsFor(values: Readonly<Record<string, string>>): readonly Pair[] {
  const names = Object.keys(values);
  const onSurfaces = (token: string, minimum: number): Pair[] =>
    ['surface', 'surface-raised'].map((background) => ({
      foreground: token,
      background,
      minimum,
    }));

  const text = [
    'text',
    'text-muted',
    'accent',
    'danger',
    'warn',
    'ok',
    ...names.filter((name) => name.startsWith('status-')),
    ...names.filter((name) => name.startsWith('specialty-')),
    ...names.filter((name) => name.startsWith('ansi-')),
  ].filter((name) => name in values);

  return [
    ...text.flatMap((token) => onSurfaces(token, AA_TEXT)),
    // The label on a filled accent button — text on a *coloured* ground.
    { foreground: 'accent-contrast', background: 'accent', minimum: AA_TEXT },
    // UI boundaries and the focus ring: 3:1 is the bar, and the focus ring is
    // the one non-negotiable of them (§15's "visible focus ring").
    { foreground: 'border-strong', background: 'surface', minimum: AA_LARGE },
    { foreground: 'focus-ring', background: 'surface', minimum: AA_LARGE },
    { foreground: 'focus-ring', background: 'surface-raised', minimum: AA_LARGE },
  ].filter((pair) => pair.foreground in values && pair.background in values);
}
