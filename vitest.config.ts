import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    // shims for the jsdom-environment files (see src/test-setup.ts)
    setupFiles: ['src/test-setup.ts'],
  },
});
