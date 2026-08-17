/**
 * The system/light/dark toggle (DESIGN §14.2).
 *
 * A real `<select>` rather than a cycling button: three choices where one of
 * them is "follow the system" is a choice, not a switch, and a cycling button
 * cannot say what the other two are without being read three times.
 */

import { useEffect, type ReactElement } from 'react';

import { useAppStore } from '../state/store';
import {
  applyTheme,
  isThemeChoice,
  readStoredTheme,
  THEME_CHOICES,
  THEME_LABELS,
} from '../theme/theme';

export function ThemeToggle(): ReactElement {
  const theme = useAppStore((store) => store.theme);
  const setTheme = useAppStore((store) => store.setTheme);

  // The stored choice was already stamped onto <html> by `theme-boot.js` before
  // the first paint; this only teaches the store what it said, so the select
  // shows the right option.
  useEffect(() => {
    setTheme(readStoredTheme());
  }, [setTheme]);

  return (
    <label className="connection">
      <span className="visually-hidden">Theme</span>
      <select
        value={theme}
        aria-label="Theme"
        onChange={(event) => {
          const next = event.target.value;
          if (!isThemeChoice(next)) return;
          setTheme(next);
          applyTheme(next);
        }}
      >
        {THEME_CHOICES.map((choice) => (
          <option key={choice} value={choice}>
            {THEME_LABELS[choice]}
          </option>
        ))}
      </select>
    </label>
  );
}
