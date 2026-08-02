import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DiscoverySchedule, WatchHandle } from './discovery-scheduler';
import { LogSink, createLogger } from '../log/logger';

const ROOT = 'C:/fake/projects';

// One sink for the file: these tests never assert on log output, and a
// mkdtemp per call left an orphaned directory behind for every test.
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ds-log-'));
function log() {
  return createLogger(new LogSink({ dir: LOG_DIR }), 'discovery');
}

/** A watch we drive by hand: `fire()` is a filesystem event, `fail()` is the
 *  watch dying under us. */
function fakeWatch() {
  const state = {
    fire: (() => {}) as (filename?: string | null) => void,
    fail: (() => {}) as (e: unknown) => void,
    closed: false,
    created: 0,
  };
  const factory = (
    _root: string,
    onChange: (filename?: string | null) => void,
    onError: (e: unknown) => void
  ): WatchHandle => {
    state.created++;
    state.fire = onChange;
    state.fail = onError;
    return { close: () => { state.closed = true; } };
  };
  return { state, factory };
}

describe('DiscoverySchedule — the watch accelerates, the backoff guarantees', () => {
  it('a newly registered root sweeps immediately (binding must not get slower)', () => {
    const { factory } = fakeWatch();
    const s = new DiscoverySchedule({ log: log(), watchFactory: factory });
    s.register(ROOT);
    expect(s.shouldSweep(ROOT, 1000)).toBe(true);
  });

  it('backs off along the ladder while nothing happens, and caps', () => {
    const { factory } = fakeWatch();
    const s = new DiscoverySchedule({ log: log(), watchFactory: factory, backoffMs: [100, 200, 400] });
    s.register(ROOT);
    s.noteSwept(ROOT, 0);

    // idx 1 -> 200ms
    expect(s.shouldSweep(ROOT, 199)).toBe(false);
    expect(s.shouldSweep(ROOT, 200)).toBe(true);
    s.noteSwept(ROOT, 200);

    // idx 2 -> 400ms, and it is the last rung
    expect(s.shouldSweep(ROOT, 599)).toBe(false);
    expect(s.shouldSweep(ROOT, 600)).toBe(true);
    s.noteSwept(ROOT, 600);
    expect(s.stats(ROOT)!.backoffMs).toBe(400);
    s.noteSwept(ROOT, 1000);
    expect(s.stats(ROOT)!.backoffMs).toBe(400); // capped, never grows past the ladder
  });

  it('a NEW path sweeps on the next tick and resets the ladder', () => {
    const { state, factory } = fakeWatch();
    const s = new DiscoverySchedule({ log: log(), watchFactory: factory, backoffMs: [100, 200, 400] });
    s.register(ROOT);
    s.noteSwept(ROOT, 0);
    s.noteSwept(ROOT, 200);
    s.noteSwept(ROOT, 600);
    expect(s.stats(ROOT)!.backoffMs).toBe(400);

    state.fire('native-abc.jsonl'); // a transcript APPEARING
    expect(s.shouldSweep(ROOT, 601)).toBe(true); // immediately, not in 400ms
    s.noteSwept(ROOT, 601);
    expect(s.stats(ROOT)!.backoffMs).toBe(200); // back to the fast end of the ladder
    expect(s.stats(ROOT)!.events).toBe(1);
  });

  it('an event with no filename is treated as urgent — we cannot rule it out', () => {
    const { state, factory } = fakeWatch();
    const s = new DiscoverySchedule({ log: log(), watchFactory: factory, backoffMs: [100, 200] });
    s.register(ROOT);
    s.noteSwept(ROOT, 1000);
    expect(s.shouldSweep(ROOT, 1001)).toBe(false);
    state.fire(null); // the platform did not say which path moved
    expect(s.shouldSweep(ROOT, 1001)).toBe(true);
  });

  it('markDirty does the same for changes no filesystem event describes', () => {
    const { factory } = fakeWatch();
    const s = new DiscoverySchedule({ log: log(), watchFactory: factory, backoffMs: [100, 200, 400] });
    s.register(ROOT);
    s.noteSwept(ROOT, 0);
    s.noteSwept(ROOT, 200);
    expect(s.shouldSweep(ROOT, 300)).toBe(false);
    s.markDirty(ROOT);
    expect(s.shouldSweep(ROOT, 300)).toBe(true);
  });

  // The fail-open half: every guarantee this item makes has to hold with the
  // watch contributing nothing, because recursive fs.watch genuinely does not
  // work everywhere we ship.
  it('a watch that cannot be created falls back to flat timed sweeps, never starvation', () => {
    const s = new DiscoverySchedule({ log: log(), watchFactory: () => null, watchFailedMs: 500 });
    s.register(ROOT);
    expect(s.stats(ROOT)!.watchFailed).toBe(true);
    s.noteSwept(ROOT, 0);
    expect(s.shouldSweep(ROOT, 499)).toBe(false);
    expect(s.shouldSweep(ROOT, 500)).toBe(true);
    // and it stays flat — no ladder, because there is no signal to wait for
    s.noteSwept(ROOT, 500);
    expect(s.shouldSweep(ROOT, 1000)).toBe(true);
    expect(s.stats(ROOT)!.backoffMs).toBe(500);
  });

  it('a watch that dies mid-run downgrades to the same fallback', () => {
    const { state, factory } = fakeWatch();
    const s = new DiscoverySchedule({ log: log(), watchFactory: factory, watchFailedMs: 500 });
    s.register(ROOT);
    expect(s.stats(ROOT)!.watchFailed).toBe(false);
    state.fail(new Error('EPERM: watch handle lost'));
    expect(s.stats(ROOT)!.watchFailed).toBe(true);
    expect(state.closed).toBe(true); // the dead handle is released, not leaked
    s.noteSwept(ROOT, 0);
    expect(s.shouldSweep(ROOT, 500)).toBe(true);
  });

  it('an unknown root never blocks discovery — bookkeeping must fail open', () => {
    const s = new DiscoverySchedule({ log: log(), watchFactory: fakeWatch().factory });
    expect(s.shouldSweep('C:/never/registered', 0)).toBe(true);
  });

  it('registering the same root twice reuses one watch and asks for a sweep', () => {
    const { state, factory } = fakeWatch();
    const s = new DiscoverySchedule({ log: log(), watchFactory: factory, backoffMs: [100, 200] });
    s.register(ROOT);
    s.noteSwept(ROOT, 0);
    expect(s.shouldSweep(ROOT, 50)).toBe(false);
    s.register(ROOT); // a second session on the same root
    expect(state.created).toBe(1);
    expect(s.shouldSweep(ROOT, 50)).toBe(true);
  });

  it('stop() closes the handles', () => {
    const { state, factory } = fakeWatch();
    const s = new DiscoverySchedule({ log: log(), watchFactory: factory });
    s.register(ROOT);
    s.stop();
    expect(state.closed).toBe(true);
    expect(s.stats(ROOT)).toBeNull();
  });
});

describe('DiscoverySchedule — lifecycle, clock and recovery (review round 1)', () => {
  it('refcounts: the LAST session off a root closes the watch, not the first', () => {
    const { state, factory } = fakeWatch();
    const s = new DiscoverySchedule({ log: log(), watchFactory: factory });
    s.register(ROOT);
    s.register(ROOT);
    expect(s.stats(ROOT)!.refs).toBe(2);
    s.release(ROOT);
    expect(state.closed).toBe(false); // still one session on it
    expect(s.stats(ROOT)!.refs).toBe(1);
    s.release(ROOT);
    expect(state.closed).toBe(true);
    expect(s.stats(ROOT)).toBeNull(); // and the state is gone, not leaked
  });

  it('a clock that steps BACKWARDS never stalls discovery', () => {
    const s = new DiscoverySchedule({ log: log(), watchFactory: () => null, watchFailedMs: 500 });
    s.register(ROOT);
    s.noteSwept(ROOT, 1_000_000);
    // NTP correction / VM resume: "now" is suddenly an hour earlier.
    expect(s.shouldSweep(ROOT, 1_000_000 - 3_600_000)).toBe(true);
  });

  it('a failed watch is retried, not written off for the life of the process', () => {
    // One ReadDirectoryChangesW buffer overflow must not pin us to flat sweeps
    // for ever. `created` counts factory calls, so a retry is observable.
    let allow = false;
    const state = { created: 0, closed: 0 };
    const factory = (): WatchHandle | null => {
      state.created++;
      if (!allow) return null;
      return { close: () => { state.closed++; } };
    };
    const s = new DiscoverySchedule({ log: log(), watchFactory: factory, watchFailedMs: 500, watchRearmMs: 60_000 });
    s.register(ROOT);
    expect(s.stats(ROOT)!.watchFailed).toBe(true);
    expect(state.created).toBe(1);

    s.noteSwept(ROOT, 30_000); // too soon
    expect(state.created).toBe(1);

    allow = true;
    s.noteSwept(ROOT, 60_000); // re-arm window elapsed
    expect(state.created).toBe(2);
    expect(s.stats(ROOT)!.watchFailed).toBe(false);
    expect(s.stats(ROOT)!.backoffMs).not.toBe(500); // back on the ladder
  });

  it('a watch failure releases the handle exactly once', () => {
    const { state, factory } = fakeWatch();
    const s = new DiscoverySchedule({ log: log(), watchFactory: factory, watchFailedMs: 500 });
    s.register(ROOT);
    state.fail(new Error('EPERM'));
    expect(state.closed).toBe(true);
    // A watcher that errors repeatedly must not re-close a handle we dropped.
    expect(() => state.fail(new Error('EPERM again'))).not.toThrow();
    expect(s.stats(ROOT)!.watchFailed).toBe(true);
  });
});

/**
 * Wait for `check`, up to `ms`. Resolves either way — callers decide whether a
 * timeout means anything, because for the real-fs.watch tests it is often a
 * legitimate platform answer ("this OS does not fire that event") rather than a
 * failure.
 */
async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return check();
}

describe('DiscoverySchedule — the REAL fs.watch (no injected factory)', () => {
  // Everything above injects a factory, which left the only code that actually
  // runs in production with zero coverage — including the `rename`-only filter
  // that the module calls load-bearing.
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ds-real-'));

  it('fires on a file APPEARING', async () => {
    const s = new DiscoverySchedule({ log: log(), backoffMs: [10] });
    try {
      s.register(realRoot);
      if (s.stats(realRoot)!.watchFailed) return; // recursive watch unsupported here
      s.noteSwept(realRoot, 0);

      fs.writeFileSync(path.join(realRoot, 'appeared.jsonl'), '{}\n');
      // Wait for the CONDITION, not a guessed duration. This was a fixed 200ms
      // sleep and it flaked on macOS CI under load (P2-E18-08b) — the sibling
      // of the race fixed in P2-E18-03, in the same file, which I fixed and
      // then left this one alone. A fixed sleep standing in for "wait until the
      // thing actually happened" is the defect shape; both instances had it.
      await waitFor(() => s.stats(realRoot)!.events > 0, 10_000);
      expect(s.stats(realRoot)!.events).toBeGreaterThan(0);
    } finally {
      s.stop();
    }
    // 15s, because the wait above budgets 10 and vitest's default is FIVE.
    //
    // Without this the fix above could never work: the test was killed at 5s,
    // so the "wait up to 10s" was a fiction and a slow macOS runner produced a
    // TIMEOUT rather than this test's own assertion. That is what it did on
    // #157's CI. The fixed sleep was correctly replaced by a wait-for-the-
    // condition, and the replacement was then capped below its own budget by a
    // default nobody looked at — the sibling at the end of this describe block
    // got its `}, 20_000)` and this one did not.
    //
    // Rule for anything of this shape: a wait budget that exceeds the enclosing
    // test timeout is not a generous wait, it is a shorter wait with a worse
    // failure message.
  }, 15_000);

  it('appends to a known file do not earn a sweep, on every platform', async () => {
    // Asserts the BEHAVIOUR, not the event count. The first version of this
    // counted events and passed on Windows and Linux while failing on macOS,
    // because FSEvents reports an append as `rename` and the event-type filter
    // does not hold it back there. Windows/Linux reach the same conclusion by
    // never firing at all; macOS reaches it because the path is already known
    // and known paths are floored. One assertion, three platforms, and it is
    // the property that actually matters.
    const s = new DiscoverySchedule({ log: log(), backoffMs: [400, 800] });
    try {
      const f = path.join(realRoot, 'appended.jsonl');
      fs.writeFileSync(f, '{}\n');
      s.register(realRoot);
      if (s.stats(realRoot)!.watchFailed) return; // recursive watch unsupported here

      // Make the path KNOWN by construction (P2-E18-03: this was a fixed 150 ms
      // sleep and it raced). `seenNames` starts EMPTY at register and is only
      // ever populated by an observed event — it is never seeded from the
      // directory — so a file created BEFORE register is unknown until some
      // event names it. The old sleep was hoping macOS would deliver an event
      // for the pre-existing file within 150 ms; under load it does not, the
      // first append below is then a NEW path, the root goes immediately dirty,
      // and the assertion inverts. Windows and Linux never fire on appends at
      // all, so they reached the right answer by another road and the race was
      // invisible there — it surfaced on macOS CI the first time the suite got
      // heavy enough to slow the runner down.
      fs.appendFileSync(f, '{"seed":1}\n');
      const seeded = await waitFor(() => s.stats(realRoot)!.events > 0, 10_000);

      // On Windows and Linux no event EVER fires for an append, so `seeded` is
      // false by design and the test proceeds: there the property holds for a
      // different reason (nothing dirties the root in the first place).
      //
      // On macOS it fires, and `seeded === false` means the SETUP failed, not
      // that the property is broken. That distinction is the whole fix. The
      // wait used to be 2 s and non-asserting, so a slow runner silently
      // reached the measurement with an UNKNOWN path — the next append then
      // looked like a new file, the root went dirty, and the assertion
      // inverted. #157's macOS CI did exactly that, and the failure read
      // "expected true to be false", which points at the property rather than
      // at the setup that never happened.
      //
      // Fail LOUDLY instead. A test that cannot establish its own precondition
      // must say so, not measure something else and report the answer.
      if (process.platform === 'darwin' && !seeded) {
        throw new Error(
          'setup failed: macOS delivered no event in 10s, so the path is not KNOWN — ' +
            'this test would be measuring an unknown path, not the property it claims'
        );
      }

      const t = 100_000; // synthetic clock: the sweep just happened
      s.noteSwept(realRoot, t);
      const before = s.stats(realRoot)!.events;
      fs.appendFileSync(f, '{"more":1}\n');
      fs.appendFileSync(f, '{"more":2}\n');
      // Wait for the appends to be OBSERVED rather than for 200ms and a hope.
      // Bounded and non-asserting on purpose: on Windows and Linux these
      // produce no events at all, so the wait legitimately runs out. The
      // difference from the old fixed sleep is the failure it prevents — a
      // blind sleep that is too SHORT lets the assertion run before the events
      // land, which passes for the wrong reason.
      await waitFor(() => s.stats(realRoot)!.events > before, 2000);
      expect(s.shouldSweep(realRoot, t + 399)).toBe(false);
    } finally {
      s.stop();
    }
    // Explicit timeout: on Windows and Linux the waitFor above always runs its
    // full 2 s (no append events exist to observe there), which sits too close
    // to vitest's 5 s default on a loaded runner.
  }, 20_000);

  it('an append STORM on a known path never sweeps faster than the fastest rung', () => {
    // The guarantee that does not depend on any platform's event semantics.
    // macOS reports appends as `rename`, so the event-type filter does not hold
    // them back there; without this, a busy turn would have restored the 100ms
    // firehose on macOS while Windows and Linux looked fine.
    const { state, factory } = fakeWatch();
    const s = new DiscoverySchedule({ log: log(), watchFactory: factory, backoffMs: [100, 200, 400] });
    s.register(ROOT);

    state.fire('native-abc.jsonl'); // seen once — this is the create
    s.noteSwept(ROOT, 1000);

    for (let i = 0; i < 50; i++) state.fire('native-abc.jsonl'); // the turn appending
    expect(s.stats(ROOT)!.events).toBe(51);
    expect(s.shouldSweep(ROOT, 1000)).toBe(false); // same instant
    expect(s.shouldSweep(ROOT, 1099)).toBe(false); // still inside the floor
    expect(s.shouldSweep(ROOT, 1100)).toBe(true); // one rung later, exactly once

    // ...and a DIFFERENT path appearing during the storm is still immediate,
    // because that is the one thing discovery exists to notice.
    s.noteSwept(ROOT, 1100);
    state.fire('native-xyz.jsonl');
    expect(s.shouldSweep(ROOT, 1101)).toBe(true);
  });
});
