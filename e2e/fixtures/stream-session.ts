/**
 * Shared setup for the `stream*.spec.ts` family (#626).
 *
 * These two helpers lived in `stream.spec.ts` while that file was the whole
 * transport omnibus. #626 split it by concern, and five files now need them —
 * so they moved here rather than being copied five times. The bodies are
 * unchanged; only the prose below was reworded to stop saying "this file".
 *
 * NOTE the name clash: `fixtures/app.ts` also exports a `tempProjectFolder`.
 * They differ only in the temp-dir prefix, and the stream flavour keeps its own
 * (`sb-stream-e2e-`) deliberately — #180 was diagnosed by counting leaked
 * folders BY PREFIX (502 of them), and folding the two together would have
 * thrown that away for a cosmetic tidy. Import one or the other, never both.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LaunchedApp, registerTempDir, sweepTempDirs } from './app';

export function tempProjectFolder(): string {
  // Registered with the fixture's registry (#213) rather than a list of the
  // spec's own, so `sweepTempDirs()` takes it — see `teardown`.
  const d = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stream-e2e-')));
  fs.writeFileSync(path.join(d, 'README.md'), '# stream\n');
  return d;
}

/**
 * Close the app, THEN delete the folders it was pointed at (#180).
 *
 * Order is the whole point. The session's child process has one of these
 * folders as its cwd, and on Windows a running process holds a lock on its cwd
 * — so an rm issued before the app is reaped is guaranteed to fail with EBUSY.
 * `cleanup()` closes the app and kills the tree first; the kill only *asks*,
 * though, so the rm can still land while the last child is dying. That last
 * race is why the delete has to requeue rather than retry, and why it is
 * `sweepTempDirs()` doing it — the fixture's registry (`fixtures/app.ts`) is
 * where the requeue, the async rm and the never-throw rule live, and
 * `stream.spec.ts` kept a second copy of all three until #360. It also adds a
 * guard that copy did not have: a sweep while an app is still open is deferred,
 * not attempted.
 *
 * `cleanup()` sweeps on its own, so the call below is for the case that has no
 * app: a test that threw before `launchApp` returned still made its folder.
 *
 * Every caller's hooks hand the app over and clear their own `a` FIRST (the
 * diff.spec.ts shape). A test that throws before assigning it otherwise leaves
 * the PREVIOUS test's already-closed app in the variable, and closing it twice
 * means `killTree` issuing `taskkill /T /F` against a dead pid — which Windows
 * may have recycled onto something else entirely.
 *
 * Until this existed the omnibus leaked one folder per test, for ever (502
 * counted in %TEMP% when #180 was filed, ~1,000 by the time it was fixed).
 */
export async function teardown(app?: LaunchedApp): Promise<void> {
  try {
    await app?.cleanup();
  } finally {
    await sweepTempDirs();
  }
}
