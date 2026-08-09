import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DiscoverySchedule, DiscoveryScheduleOptions, WatchHandle } from './discovery-scheduler';
import { LogSink, createLogger } from '../log/logger';
import { tempDir } from '../../test-temp-dirs';

const ROOT = 'C:/fake/projects';

// One sink for the file: these tests never assert on log output, and a
// mkdtemp per call left an orphaned directory behind for every test.
// It lives for the whole FILE, so it is tracked and left to `test-setup.ts`'s
// `afterAll` net rather than swept per test (#213).
const LOG_DIR = tempDir('sb-ds-log-');
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

describe('DiscoverySchedule — a root everyone gave up on goes quiet (#129)', () => {
  const LADDER = [100, 200, 400] as const;
  const SLOW = 10_000;

  /** A root sitting at the bottom of the fast ladder, with the reprieve that
   *  `register` grants already spent — i.e. the steady state a session reaches
   *  long before it gives up (45s in). */
  function settled(over: { watchFactory?: DiscoveryScheduleOptions['watchFactory'] } = {}) {
    const s = new DiscoverySchedule({
      log: log(),
      watchFactory: over.watchFactory ?? fakeWatch().factory,
      backoffMs: [...LADDER],
      givenUpMs: SLOW,
      watchFailedMs: 500,
    });
    s.register(ROOT);
    let t = 0;
    for (let i = 0; i < LADDER.length; i++) s.noteSwept(ROOT, (t += 1000));
    return { s, at: t };
  }

  it('drops to the slow rung — the full scan does not run for ever after the UI gave up', () => {
    const { s, at } = settled();
    expect(s.stats(ROOT)!.backoffMs).toBe(400); // the old floor: a scan every 400ms, for ever
    s.setGivenUp(ROOT, true);
    expect(s.stats(ROOT)!.givenUp).toBe(true);
    expect(s.stats(ROOT)!.backoffMs).toBe(SLOW);
    expect(s.shouldSweep(ROOT, at + 9_999)).toBe(false); // 25 sweeps the old ladder would have taken
    expect(s.shouldSweep(ROOT, at + SLOW)).toBe(true);
  });

  it('...and the watch-failed rung, which is the expensive one, goes with it', () => {
    // 500ms flat per unbound session was the measured worst case in the issue.
    const { s, at } = settled({ watchFactory: () => null });
    expect(s.stats(ROOT)!.watchFailed).toBe(true);
    expect(s.stats(ROOT)!.backoffMs).toBe(500);
    s.setGivenUp(ROOT, true);
    expect(s.stats(ROOT)!.backoffMs).toBe(SLOW);
    expect(s.shouldSweep(ROOT, at + 2_000)).toBe(false);
  });

  it('markDirty buys back the WHOLE fast ladder, not one sweep', () => {
    // The other half of the done-when. A give-up must never become a session
    // that can no longer bind: a native id, a turn, a `/clear` or a sibling
    // closing all reach `markDirty`, and binding often needs several sweeps
    // after one of them (the file may not be on disk for another beat).
    const { s, at } = settled();
    s.setGivenUp(ROOT, true);
    expect(s.stats(ROOT)!.backoffMs).toBe(SLOW);

    s.markDirty(ROOT);
    expect(s.shouldSweep(ROOT, at + 1)).toBe(true); // immediately: dirty
    let t = at + 1;
    // One sweep per rung, from the top of the ladder — [100, 200, 400] here,
    // [250, 500, 1000, 2000] in production, so ~3.5s of looking properly.
    for (const rung of [LADDER[1], LADDER[2]]) {
      s.noteSwept(ROOT, t);
      expect(s.stats(ROOT)!.backoffMs).toBe(rung);
      expect(s.shouldSweep(ROOT, t + rung - 1)).toBe(false);
      expect(s.shouldSweep(ROOT, t + rung)).toBe(true);
      t += rung;
    }
    // ...and then it is quiet again, without the watcher having to say so twice.
    s.noteSwept(ROOT, t);
    expect(s.stats(ROOT)!.backoffMs).toBe(SLOW);
  });

  it('a transcript APPEARING buys it back too, and an append to a known file does not', () => {
    const { state, factory } = fakeWatch();
    const s = new DiscoverySchedule({
      log: log(),
      watchFactory: factory,
      backoffMs: [...LADDER],
      givenUpMs: SLOW,
    });
    s.register(ROOT);
    state.fire('native-abc.jsonl'); // the create: now a KNOWN path
    let t = 0;
    for (let i = 0; i < LADDER.length; i++) s.noteSwept(ROOT, (t += 1000));
    s.setGivenUp(ROOT, true);

    // An append storm on a file we already know about is the tail drain's
    // business. Without the slow floor in `shouldSweep`, one busy session
    // anywhere under this root would hold every given-up card at 100ms sweeps
    // on any platform that reports appends (macOS does).
    for (let i = 0; i < 50; i++) state.fire('native-abc.jsonl');
    expect(s.shouldSweep(ROOT, t + 5_000)).toBe(false);
    expect(s.shouldSweep(ROOT, t + SLOW)).toBe(true);

    // A path we have NEVER seen is the one thing that can still rescue this
    // root, so it is immediate and it re-arms the ladder.
    state.fire('native-xyz.jsonl');
    expect(s.shouldSweep(ROOT, t + 1)).toBe(true);
    s.noteSwept(ROOT, t + 1);
    expect(s.stats(ROOT)!.backoffMs).toBe(LADDER[1]);
  });

  it('an event with NO filename buys it back too — the platforms we trust least', () => {
    // A Windows ReadDirectoryChangesW overflow and macOS coalescing both arrive
    // as "something moved, and we will not say what", which on a given-up root
    // reads as "we cannot rule out that the transcript just appeared". One
    // sweep and silence again would be the wrong answer there.
    const { state, factory } = fakeWatch();
    const s = new DiscoverySchedule({
      log: log(),
      watchFactory: factory,
      backoffMs: [...LADDER],
      givenUpMs: SLOW,
    });
    s.register(ROOT);
    let t = 0;
    for (let i = 0; i < LADDER.length; i++) s.noteSwept(ROOT, (t += 1000));
    s.setGivenUp(ROOT, true);
    expect(s.stats(ROOT)!.backoffMs).toBe(SLOW);

    state.fire(null);
    expect(s.shouldSweep(ROOT, t + 1)).toBe(true);
    s.noteSwept(ROOT, t + 1);
    expect(s.stats(ROOT)!.backoffMs).toBe(LADDER[1]); // the ladder, not one look
  });

  it('a session that starts looking again lifts it, with no evidence event at all', () => {
    // The watcher answers this every tick, so a card opening on the root, or a
    // session going back to `searching`, is enough — nothing has to be dirty.
    const { s } = settled();
    s.setGivenUp(ROOT, true);
    expect(s.stats(ROOT)!.backoffMs).toBe(SLOW);
    s.setGivenUp(ROOT, false);
    expect(s.stats(ROOT)!.givenUp).toBe(false);
    expect(s.stats(ROOT)!.backoffMs).toBe(LADDER[LADDER.length - 1]);
  });

  it('an unregistered root is not something to give up on', () => {
    const s = new DiscoverySchedule({ log: log(), watchFactory: fakeWatch().factory });
    expect(() => s.setGivenUp('C:/never/registered', true)).not.toThrow();
    expect(s.shouldSweep('C:/never/registered', 0)).toBe(true);
  });
});

describe('DiscoverySchedule — the per-SESSION half of the throttle (#388)', () => {
  // #129 made the RUNG per root; the scan cost is per session, so the watcher
  // also has to decide WHICH sessions a sweep is run for. This module supplies
  // the two answers it needs and nothing else: whether the sweep it is consuming
  // was one the root still owed to its last evidence, and how long a session
  // that has stopped looking waits between looks of its own.
  const LADDER = [100, 200, 400] as const;
  const SLOW = 10_000;

  function sched(over: Partial<DiscoveryScheduleOptions> = {}) {
    return new DiscoverySchedule({
      log: log(),
      watchFactory: fakeWatch().factory,
      backoffMs: [...LADDER],
      givenUpMs: SLOW,
      ...over,
    });
  }

  it('noteSwept reports the reprieve it is spending, one per rung, then stops', () => {
    // The count IS the reprieve: `register` grants a full pass down the ladder,
    // and the answer has to go false on the sweep after the last rung, not
    // before it — a session that has stopped looking takes exactly the sweeps
    // the root still owed, which is what makes "evidence buys a proper look"
    // mean the same thing per session as it does per root.
    const s = sched();
    s.register(ROOT);
    expect(s.noteSwept(ROOT, 100)).toBe(true);
    expect(s.noteSwept(ROOT, 200)).toBe(true);
    expect(s.noteSwept(ROOT, 300)).toBe(true);
    expect(s.noteSwept(ROOT, 400)).toBe(false); // spent: the root is quiet again
    expect(s.noteSwept(ROOT, 500)).toBe(false);
  });

  it('markDirty buys the reprieve back — every evidence site restores a session', () => {
    // The recovery half, per session. `markDirty` is reached by a turn, a native
    // id, a `/clear`, a sibling binding and a sibling closing, so this is the
    // single point every one of them has to arrive at.
    const s = sched();
    s.register(ROOT);
    for (let i = 0; i < LADDER.length + 1; i++) s.noteSwept(ROOT, 100 * i);
    expect(s.noteSwept(ROOT, 1_000)).toBe(false);

    s.markDirty(ROOT);
    expect(s.noteSwept(ROOT, 1_100)).toBe(true);
  });

  it('a transcript APPEARING buys it back; an append to a known file does not', () => {
    // Same split the rung makes (#129), and it has to be the same one: an append
    // storm from a busy neighbour must not drag a session that stopped looking
    // back into full scans, or this item's defect returns through the watch.
    const { state, factory } = fakeWatch();
    const s = sched({ watchFactory: factory });
    s.register(ROOT);
    state.fire('native-abc.jsonl'); // the create: now a KNOWN path
    for (let i = 0; i < LADDER.length + 1; i++) s.noteSwept(ROOT, 100 * i);
    expect(s.noteSwept(ROOT, 1_000)).toBe(false);

    for (let i = 0; i < 50; i++) state.fire('native-abc.jsonl');
    expect(s.noteSwept(ROOT, 1_100)).toBe(false);

    state.fire('native-xyz.jsonl');
    expect(s.noteSwept(ROOT, 1_200)).toBe(true);
  });

  it('an unregistered root reports a reprieve — bookkeeping never narrows discovery', () => {
    const s = sched();
    expect(s.noteSwept('C:/never/registered', 0)).toBe(true);
  });

  it('the quiet rung is the same interval a root gets, and a session waits it out', () => {
    const s = sched();
    expect(s.quietRungDue(1_000, 1_000 + SLOW - 1)).toBe(false);
    expect(s.quietRungDue(1_000, 1_000 + SLOW)).toBe(true);
    // 0 is "has never taken part in a sweep". Every caller passes wall-clock
    // milliseconds, so that always reads as due — a card must not wait out a
    // rung before anyone has ever looked for its transcript.
    expect(s.quietRungDue(0, Date.now())).toBe(true);
  });

  it('...and a clock that steps BACKWARDS does not lock a session out of every sweep', () => {
    // An NTP correction or a VM resume would otherwise make the subtraction
    // negative and stop this session taking part in ANY sweep until real time
    // caught up — for an hour-sized jump, an hour in which it cannot bind, while
    // its root sweeps on around it. `shouldSweep` guards the root's own clock
    // the same way; this is that guard one level down.
    const s = sched();
    expect(s.quietRungDue(10_000_000, 9_999_000)).toBe(true);
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
  // Shared by every test in this block (each one registers a REAL `fs.watch` on
  // it and stops it in its own `finally`), so it goes at `afterAll` too (#213).
  const realRoot = tempDir('sb-ds-real-');

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
