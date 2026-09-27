import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // scripts/ is plain CJS run by `node` before/around the build, so it has no
    // place under src/ — but some of it is load-bearing and has to be tested
    // like anything else, notably `run-electron-node.js`, whose exit code IS the
    // exit code of five `check:*` scripts (#176). It earned the entry as the
    // home of a stderr filter that was allowed to DELETE output; that filter
    // went with node-pty (#952) and the exit-code contract is why it stays.
    // e2e/ holds Playwright SPECS (`*.spec.ts`) — but the fixture they all sit
    // on is ordinary code with branches no spec can reach on purpose, notably
    // `launchApp`'s launch-failure reaping (#230). Those get a vitest `*.test.ts`
    // next to the fixture. The two runners are kept apart by extension, and
    // `playwright.config.ts` pins the other half of that split.
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'scripts/**/*.test.js',
      'e2e/**/*.test.ts',
    ],
    environment: 'node',
    // shims for the jsdom-environment files (see src/test-setup.ts)
    setupFiles: ['src/test-setup.ts'],
    // #354 — once per run, before any worker: delete the leftover `sb-*` temp
    // directories that pre-#213 builds left behind. Time-budgeted, never
    // throws, skippable with SB_SKIP_TEMP_SWEEP=1. See the file's header for
    // why the sweep lives in the test run and not in the app.
    globalSetup: ['scripts/vitest-global-setup.js'],
  },
});
