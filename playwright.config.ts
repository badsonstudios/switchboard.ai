import { defineConfig } from '@playwright/test';

// Electron e2e. App launches are heavy, so serialize (workers: 1) and don't
// parallelize. Each test gets its own isolated app instance + temp home.
export default defineConfig({
  testDir: './e2e',
  // #329 — the stale-bundle guard, on the one seam no invocation can route
  // around. `npm run e2e` builds; `npx playwright test` builds nothing and used
  // to skip the guard too, so it silently tested an old `out/`. See
  // scripts/e2e-global-setup.js.
  globalSetup: './scripts/e2e-global-setup.js',
  // Specs only. Playwright's DEFAULT testMatch also picks up `*.test.ts`, and
  // `e2e/fixtures/*.test.ts` is vitest's (the fixtures' own unit tests, #230) —
  // without this it would try to run them as Electron specs and fail on the
  // `vitest` import. The suite already names every spec `*.spec.ts`.
  testMatch: '**/zz-probe.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
