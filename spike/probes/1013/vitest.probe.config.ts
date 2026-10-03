// Config for the #1013 probe only. The probe lives outside the root config's
// `include` on purpose — it is a measurement, not a CI test, and it must never
// be picked up by `npm test`. Run it by name:
//
//   npx vitest run --config spike/probes/1013/vitest.probe.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['spike/probes/1013/*.test.ts'],
    environment: 'node',
    setupFiles: ['src/test-setup.ts'],
  },
});
