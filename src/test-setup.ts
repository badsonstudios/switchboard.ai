import { afterAll, afterEach, vi } from 'vitest';
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
// It runs AFTER a file's own `afterAll` (which matters for the one file that
// reaps live handles there — `transport/stream-service.test.ts`, which kills
// its children and only then deletes the directory they had as their cwd)
// because vitest's `sequence.hooks`
// defaults to `"stack"`: same-level `afterAll` hooks run in reverse
// registration order, and a setup file registers before the test file is even
// loaded. Load-bearing, and not pinned in `vitest.config.ts`.
afterAll(() => cleanupTempDirs());

// ---------------------------------------------------------------------------
// FAKE TIMERS: the convention, and the net that enforces it (#441)
//
// THE CONVENTION — install fake timers wherever you need them (`vi.useFakeTimers()`
// in a test, or in a `beforeEach`); you do NOT have to hand the clock back for
// the next test's sake. The `afterEach` below does it for every test in the run.
// Restore inside a test only when THAT test needs a real clock again — e.g.
// `transcripts/watcher.test.ts`, which freezes `Date` for the first half of a
// case and then wants real time for the second.
//
// WHY IT EXISTS — `vi.useFakeTimers()` is a NO-OP when a clock is already
// installed (vitest's `FakeTimers.useFakeTimers` guards on `_fakingTime`), so a
// `beforeEach` that only installs re-uses the previous test's clock, pending
// queue and all. Those timers then fire into the NEXT test. That is #439:
// `composer.test.ts` scheduled its 75ms CR, ended without flushing, and the
// stray write landed in an unrelated case three tests later. Measured on the
// guardless file: up to SEVEN pending timers carried across a single boundary.
//
// WHAT THIS DOES — `clearAllTimers()` empties the queue, `useRealTimers()`
// uninstalls the clock (and undoes a lone `vi.setSystemTime`, which mocks
// `Date` without faking timers). Both are no-ops when nothing was faked, so
// every test pays a branch and nothing else.
//
// ORDERING — a setup file registers before the test file is loaded and
// `sequence.hooks` defaults to `"stack"` (same-level `afterEach` hooks run in
// reverse registration order), so this runs LAST: a file's own teardown still
// has the fake clock if it needs it, and this is the final thing before the
// next test's hooks. Pinned by `src/test-fake-timers.test.ts`.
afterEach(() => {
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
});
