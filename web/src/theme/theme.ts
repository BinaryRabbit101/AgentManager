/**
 * Theme choice and how it reaches the document (DESIGN §14.2).
 *
 * "Default is **system**; the toggle (system/light/dark) persists in
 * `localStorage` and applies with a `data-theme` attribute on the root, so there
 * is no flash on load."
 *
 * The no-flash half is not done here — by the time this module runs the browser
 * has painted. `public/theme-boot.js` stamps the attribute in `<head>`; this
 * file owns the runtime toggle and must agree with it about the storage key and
 * the accepted values. A test asserts they do.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'agentmanager.theme';

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readStoredTheme(storage?: Pick<Storage, 'getItem'>): ThemeChoice {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(THEME_STORAGE_KEY);
    // Anything else — including a hand-edited value — is `system`, which is the
    // default and is also what `theme-boot.js` falls through to.
    return isThemeChoice(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Applies a choice: `data-theme` for an explicit one, **no attribute at all**
 * for `system`.
 *
 * The absence is deliberate. `system` means "let `prefers-color-scheme` decide",
 * and the stylesheet expresses that with a media query; writing
 * `data-theme="system"` would need a third branch in every rule for no gain.
 */
export function applyTheme(
  choice: ThemeChoice,
  root: HTMLElement = globalThis.document.documentElement,
  storage?: Pick<Storage, 'setItem'>,
): void {
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    (storage ?? globalThis.localStorage).setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage refused: the theme still applies for this page. Persisting it is
    // a convenience, not a requirement.
  }
}

/** The label the toggle shows for each choice. */
export const THEME_LABELS: Readonly<Record<ThemeChoice, string>> = Object.freeze({
  system: 'System',
  light: 'Light',
  dark: 'Dark',
});
