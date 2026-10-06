// Config for the #1088 probe only — a measurement, never picked up by `npm test`.
//
//   npx vitest run --config spike/probes/1088/vitest.probe.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['spike/probes/1088/*.test.ts'],
    environment: 'node',
    setupFiles: ['src/test-setup.ts'],
  },
});
