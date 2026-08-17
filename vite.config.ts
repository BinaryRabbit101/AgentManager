/**
 * The frontend build (ui DESIGN §1.1, IMPLEMENTATION §1).
 *
 * Two facts decide everything here:
 *
 * 1. **The core serves the bundle** (§1.3, foundation §6.4). `resolveWebRoot`
 *    looks for `<install>/app/web/index.html` first and `<install>/web` second,
 *    so the production build is emitted into `app/web/` — the installed layout,
 *    reached without touching foundation's static route at all. `web/` stays the
 *    *source* tree, and its `index.html` doubles as the honest "nothing is built
 *    yet" page for anyone who runs the core from a fresh checkout.
 * 2. **There is one build** (§1.3). No Electron flag, no browser flag, no base
 *    URL: every request the app makes is relative, so the same bytes work from
 *    Electron's window and from the tailnet browser.
 *
 * `dev:web` runs Vite with a proxy to the core so the frontend is developed
 * against a real server rather than a mock; `AGENTMANAGER_HTTP_PORT` overrides
 * the shipped default of 7477.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const corePort = process.env['AGENTMANAGER_HTTP_PORT'] ?? '7477';
const coreOrigin = `http://127.0.0.1:${corePort}`;

export default defineConfig({
  root: 'web',
  // Relative-only (§1.3): the app is always served from the origin's root.
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../app/web',
    emptyOutDir: true,
    assetsDir: 'assets',
    // Self-contained: no source-map sidecars to fetch, no module-preload
    // polyfill injected as a separate request.
    sourcemap: false,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 700,
  },
  server: {
    proxy: {
      '/api': { target: coreOrigin, changeOrigin: false },
      '/healthz': { target: coreOrigin, changeOrigin: false },
    },
  },
});
