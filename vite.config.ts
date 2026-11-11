import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the build runs from any GitHub Pages sub-path.
  base: './',
  test: { include: ['src/**/*.test.ts'] },
});
