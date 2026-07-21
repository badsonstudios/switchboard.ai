import { defineConfig } from '@playwright/test';

// Electron e2e. App launches are heavy, so serialize (workers: 1) and don't
// parallelize. Each test gets its own isolated app instance + temp home.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
