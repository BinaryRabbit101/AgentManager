import { defineConfig } from 'vitest/config';

// Scoped to src/ so sibling agent worktrees under .claude/worktrees/ are
// never picked up when tests run from the main checkout.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
