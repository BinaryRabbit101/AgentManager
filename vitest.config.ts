import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Three suites, one runner. The `server` project is unchanged from before the ui
// element existed — scoped to src/ so sibling agent worktrees under
// .claude/worktrees/ are never picked up when tests run from the main checkout.
// The `web` project runs the frontend's tests in jsdom.
//
// `web-e2e` exists because two ui criteria are explicitly about the **whole
// stack**: the solo launch (ui IMPLEMENTATION §3) and the question answer
// round-trip (§5) are only true if a real core boots, a real session runs and a
// real question row is answered. Those tests boot `src/main.ts` and talk to the
// listener with the *frontend's own* `ApiClient`, so they need node rather than
// jsdom — a browser environment cannot host an HTTP server or `better-sqlite3`.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          include: ['web/**/*.test.ts', 'web/**/*.test.tsx'],
          exclude: ['web/e2e/**'],
          environment: 'jsdom',
          // A real origin, because `localStorage` is per-origin and `about:blank`
          // has none — and because the app is only ever served from the core.
          environmentOptions: { jsdom: { url: 'http://127.0.0.1:7477/' } },
          setupFiles: ['./web/test/setup.ts'],
        },
      },
      {
        // The Electron shell (ui M6). Node, because the shell is a Node program
        // — and *only* the shell: Electron itself needs a downloaded binary and
        // a display, so `host.ts` is the seam every test here drives instead.
        test: {
          name: 'electron',
          include: ['electron/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'web-e2e',
          include: ['web/e2e/**/*.test.ts'],
          environment: 'node',
          // A booted core, a scripted SDK and a real session per test.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
