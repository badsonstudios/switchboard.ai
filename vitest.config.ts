import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // scripts/ is plain CJS run by `node` before/around the build, so it has no
    // place under src/ — but scripts/pty-noise-filter.js is allowed to DELETE
    // stderr (#176) and has to be tested like anything else.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.js'],
    environment: 'node',
    // shims for the jsdom-environment files (see src/test-setup.ts)
    setupFiles: ['src/test-setup.ts'],
  },
});
