import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Two suites, one runner. The `server` project is unchanged from before the ui
// element existed — scoped to src/ so sibling agent worktrees under
// .claude/worktrees/ are never picked up when tests run from the main checkout.
// The `web` project runs the frontend's tests in jsdom.
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
          environment: 'jsdom',
          // A real origin, because `localStorage` is per-origin and `about:blank`
          // has none — and because the app is only ever served from the core.
          environmentOptions: { jsdom: { url: 'http://127.0.0.1:7477/' } },
          setupFiles: ['./web/test/setup.ts'],
        },
      },
    ],
  },
});
