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
  const state = { fire: () => {}, fail: (() => {}) as (e: unknown) => void, closed: false, created: 0 };
  const factory = (_root: string, onChange: () => void, onError: (e: unknown) => void): WatchHandle => {
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

  it('a filesystem event sweeps on the next tick and resets the ladder', () => {
    const { state, factory } = fakeWatch();
    const s = new DiscoverySchedule({ log: log(), watchFactory: factory, backoffMs: [100, 200, 400] });
    s.register(ROOT);
    s.noteSwept(ROOT, 0);
    s.noteSwept(ROOT, 200);
    s.noteSwept(ROOT, 600);
    expect(s.stats(ROOT)!.backoffMs).toBe(400);

    state.fire();
    expect(s.shouldSweep(ROOT, 601)).toBe(true); // immediately, not in 400ms
    s.noteSwept(ROOT, 601);
    expect(s.stats(ROOT)!.backoffMs).toBe(200); // back to the fast end of the ladder
    expect(s.stats(ROOT)!.events).toBe(1);
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

describe('DiscoverySchedule — the REAL fs.watch (no injected factory)', () => {
  // Everything above injects a factory, which left the only code that actually
  // runs in production with zero coverage — including the `rename`-only filter
  // that the module calls load-bearing.
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ds-real-'));

  it('fires on a file APPEARING and ignores appends to it', async () => {
    const s = new DiscoverySchedule({ log: log(), backoffMs: [10] });
    try {
      s.register(realRoot);
      if (s.stats(realRoot)!.watchFailed) return; // recursive watch unsupported here
      s.noteSwept(realRoot, 0);

      const f = path.join(realRoot, 'appeared.jsonl');
      fs.writeFileSync(f, '{}\n');
      await new Promise((r) => setTimeout(r, 200));
      const afterCreate = s.stats(realRoot)!.events;
      expect(afterCreate).toBeGreaterThan(0);

      // THE assertion that pins the filter: the CLI appends to a transcript
      // constantly during a turn. If appends marked the root dirty we would
      // have rebuilt the 100ms scan firehose with extra steps.
      s.noteSwept(realRoot, 1);
      fs.appendFileSync(f, '{"more":1}\n');
      fs.appendFileSync(f, '{"more":2}\n');
      await new Promise((r) => setTimeout(r, 200));
      expect(s.stats(realRoot)!.events).toBe(afterCreate);
    } finally {
      s.stop();
    }
  });
});
