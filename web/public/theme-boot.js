/*
 * Stamps the stored theme onto <html> before the first paint (DESIGN §14.2).
 *
 * Kept out of the bundle and loaded synchronously in <head> because the bundle
 * is a deferred module: by the time it runs the browser has already painted, and
 * a light-on-dark flash on every reload is exactly what §14.2 forbids. The whole
 * contract is two lines, so duplicating them here rather than importing is
 * cheaper than the flash.
 *
 * `THEME_STORAGE_KEY` and the accepted values are mirrored in src/theme/theme.ts,
 * which owns the runtime side; a test asserts the two agree.
 */
(function () {
  try {
    var stored = window.localStorage.getItem('agentmanager.theme');
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.setAttribute('data-theme', stored);
      return;
    }
  } catch (error) {
    // A browser with storage disabled still gets a themed app: falling through
    // leaves no data-theme, and the stylesheet's prefers-color-scheme wins.
    void error;
  }
  document.documentElement.removeAttribute('data-theme');
})();
