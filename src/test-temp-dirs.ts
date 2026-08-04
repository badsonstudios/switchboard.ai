// Temp directories for unit tests: make them here, and they get deleted (#213).
//
// WHY THIS EXISTS. Roughly a dozen unit-test files were doing
// `fs.mkdtempSync(path.join(os.tmpdir(), 'sb-...'))` in a `beforeEach` and
// never removing it. Nothing fails when a test leaks a directory, so nothing
// ever noticed: 60,000+ orphaned `sb-*` folders had accumulated in one
// developer's `%TEMP%` by the time #213 was filed, and the suite was still
// adding hundreds a day. `register what you make` is the only shape that
// survives contact with a failing test — a `rmSync` at the end of a test body
// is skipped by the assertion that throws above it, which is exactly when the
// leak happens most.
//
// HOW TO USE IT. Swap the `mkdtempSync` for `tempDir('sb-...')` and the
// directory is tracked. Then either:
//   - let the net take it: `src/test-setup.ts` runs `cleanupTempDirs()` in an
//     `afterAll` for EVERY test file, so a file that only registers is already
//     leak-free; or
//   - call `cleanupTempDirs()` from the file's own `afterEach` when it makes a
//     directory per test, so at most one is on disk at a time. Only do that in
//     files whose tracked directories are ALL per-test — this deletes
//     everything pending, including a `beforeAll`/module-scope directory the
//     remaining tests still need.
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Directories made and not yet deleted.
 *
 * Per test FILE in practice, because vitest's `isolate` defaults to true and
 * gives each file its own module registry — so one file's pending list can
 * never be emptied by another file's teardown. That default is not pinned in
 * `vitest.config.ts`; turning it off would make this list global, and every
 * per-test `cleanupTempDirs()` a cross-file wrecking ball.
 */
const pending = new Set<string>();

/** `fs.mkdtempSync` in the OS temp dir, plus the bookkeeping teardown needs. */
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  pending.add(dir);
  return dir;
}

/** Track a directory made some other way (an `fs.mkdtempSync` you cannot move). */
export function trackTempDir(dir: string): string {
  pending.add(dir);
  return dir;
}

/**
 * Delete every tracked directory. Never throws; requeues what would not go.
 *
 * Both halves are load-bearing, and the first one is a trap worth writing down
 * (measured for #180, PR #212): `maxRetries` does NOT cover a lock on the
 * directory itself. Node's recursive rm only enters its retry loop after the
 * not-empty recursion, so an `EBUSY` off the very first `rmdir` — what a
 * process still holding the folder as its cwd produces on Windows — is
 * rethrown untouched. The REQUEUE is what covers that one: the directory stays
 * pending and the next teardown (or the `afterAll` net) tries again, by which
 * time the holder is gone. `maxRetries` still earns its place — it covers the
 * ENOTEMPTY/EPERM path a scanner or indexer holding one file inside the tree
 * produces.
 *
 * And it never throws, because a throw from a vitest hook is attributed to the
 * FILE: a failed file with zero failing tests, the #167 phantom. Fail-open
 * applies to test infrastructure too — a directory that will not go is a
 * housekeeping problem, not a broken test run.
 */
export function cleanupTempDirs(): void {
  for (const dir of [...pending]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      pending.delete(dir);
    } catch {
      /* stays pending — retried by the next teardown, and by the afterAll net */
    }
  }
}
