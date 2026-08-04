import { afterAll } from 'vitest';
import { cleanupTempDirs } from './test-temp-dirs';

// jsdom gaps that xterm probes while loading. Any test that (transitively)
// imports the view components needs these; they were copy-pasted into two
// files before, and a third was inevitable.
const d = globalThis.document as unknown as Record<string, unknown> | undefined;
if (d) {
  if (typeof d.queryCommandSupported !== 'function') d.queryCommandSupported = () => false;
  if (typeof d.execCommand !== 'function') d.execCommand = () => false;
}

// The net under every temp directory made through `tempDir()` (#213). Setup
// files run once per TEST FILE, in that file's own module registry, so this
// registers a real file-scoped `afterAll` for each of them — and a file that
// forgets its own teardown, or whose teardown could not delete a locked
// directory, still leaves nothing behind. Files that want at-most-one-on-disk
// call `cleanupTempDirs()` from their own `afterEach` as well; this is the last
// pass, not the only one.
//
// It runs AFTER a file's own `afterAll` (which matters for the two files that
// reap live handles there — `transcripts/watcher.test.ts` and
// `transport/stream-service.test.ts`) because vitest's `sequence.hooks`
// defaults to `"stack"`: same-level `afterAll` hooks run in reverse
// registration order, and a setup file registers before the test file is even
// loaded. Load-bearing, and not pinned in `vitest.config.ts`.
afterAll(() => cleanupTempDirs());
