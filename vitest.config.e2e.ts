import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // The suite asserts behaviour, not logs; keep the output readable.
    env: { LOG_LEVEL: 'silent' },
  },
});
