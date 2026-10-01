// #719 — the heartbeat's machine-wide process census.
import { describe, it, expect } from 'vitest';
import {
  ProcessCensus,
  Enumerate,
  namesFromTasklist,
  namesFromPs,
  summarize,
  CENSUS_MS,
  CENSUS_SLOW_MS,
  CENSUS_BACKOFF_STEP,
  CENSUS_MAX_MS,
  CENSUS_TIMEOUT_MS,
} from './process-census';

describe('parsing the platform listers', () => {
  it('reads the image name out of each `tasklist /fo csv /nh` row', () => {
    const out = [
      '"System Idle Process","0","Services","0","8 K"',
      '"node.exe","1234","Console","1","45,000 K"',
      '"node.exe","5678","Console","1","41,000 K"',
      '',
      'INFO: some banner that is not a row',
    ].join('\r\n');
    expect(namesFromTasklist(out)).toEqual(['System Idle Process', 'node.exe', 'node.exe']);
  });

  it('reads `ps -A -o comm=`, reducing a full path to its image name', () => {
    expect(namesFromPs('  launchd\n/usr/bin/node\nnode\n\n')).toEqual(['launchd', 'node', 'node']);
  });
});

describe('summarize', () => {
  it('counts every process, and names the most common first', () => {
    const names = ['node.exe', 'Node.exe', 'node.exe', 'git.exe', 'git.exe', 'svchost.exe'];
    expect(summarize(names, 83.6, 2)).toEqual({
      sysProcs: 6,
      sysEnumMs: 84,
      // case-folded: `Node.exe` is the same population as `node.exe`
      sysTop: { 'node.exe': 3, 'git.exe': 2 },
    });
  });
});

/** An enumerator the test answers by hand, so "still running" is a real state. */
function manual(): { enumerate: Enumerate; calls: number; answer: (err: Error | null, out?: string) => void } {
  let pending: ((err: Error | null, stdout: string) => void) | null = null;
  const m = {
    calls: 0,
    enumerate: ((cb) => {
      m.calls++;
      pending = cb;
    }) as Enumerate,
    answer: (err: Error | null, out = '') => {
      const cb = pending;
      pending = null;
      cb?.(err, out);
    },
  };
  return m;
}

describe('ProcessCensus', () => {
  it('reports the last finished count, with how long it took', () => {
    let t = 1_000;
    const m = manual();
    const c = new ProcessCensus({ enumerate: m.enumerate, parse: (o) => o.split(','), now: () => t });
    c.sample();
    t += 120;
    m.answer(null, 'a,b,a');
    expect(c.fields()).toEqual({ sysProcs: 3, sysEnumMs: 120, sysTop: { a: 2, b: 1 } });
  });

  it('never stacks a second count behind a slow one, and says how late it is', () => {
    // Stacking spawns during an incident is how a diagnostic feeds the thing
    // it is measuring.
    let t = 0;
    const m = manual();
    const c = new ProcessCensus({ enumerate: m.enumerate, parse: () => [], now: () => t });
    c.sample();
    t = 500;
    c.sample();
    expect(m.calls).toBe(1);
    expect(c.fields().sysEnumPendingMs).toBeUndefined(); // not late yet: no noise

    t = 45_000;
    c.sample();
    expect(m.calls).toBe(1);
    expect(c.fields().sysEnumPendingMs).toBe(45_000);

    m.answer(null, '');
    c.sample();
    expect(m.calls).toBe(2); // free again once it lands
  });

  it('reports a failed count as a field, and keeps going', () => {
    const m = manual();
    const c = new ProcessCensus({ enumerate: m.enumerate, parse: () => [] });
    c.sample();
    m.answer(new Error('spawn tasklist ENOENT'));
    expect(c.fields().sysEnumError).toContain('ENOENT');
    c.sample();
    expect(m.calls).toBe(2);
  });

  it('survives an enumerator that THROWS instead of calling back', () => {
    const c = new ProcessCensus({
      enumerate: () => {
        throw new Error('spawn ENOMEM');
      },
    });
    expect(() => c.sample()).not.toThrow();
    expect(c.fields().sysEnumError).toContain('ENOMEM');
  });

  it('does nothing once stopped', () => {
    const m = manual();
    const c = new ProcessCensus({ enumerate: m.enumerate });
    c.stop();
    c.sample();
    c.start();
    expect(m.calls).toBe(0);
  });

  // ── #1031: back off while the machine cannot spawn ───────────────────────
  //
  // In #1007 this census reported 3.4-30.5 SECONDS per count and repeatedly hit
  // its 30s timeout, once a minute, on the machine it was measuring. Asking a
  // struggling machine to spawn that often is the diagnostic feeding the thing
  // it is there to describe.

  it('⭐ counts every tick while counts are FAST — the healthy rate is not halved', () => {
    // THE REGRESSION TEST FOR A MEASURED BUG (review). The first draft paced
    // itself by comparing the clock against a due-time set when a count
    // FINISHED, while the timer fires on fixed boundaries and `setInterval`
    // fires a hair late — so every other tick was skipped and a healthy machine
    // counted every two minutes while `sysEnumEveryMs` stayed absent claiming it
    // was one. The jitter below is the whole point: a real tick never lands
    // exactly on its boundary.
    let t = 0;
    const m = manual();
    const c = new ProcessCensus({ enumerate: m.enumerate, parse: () => [], now: () => t });

    c.start();
    expect(m.calls).toBe(1);
    t += 300; // the count takes a moment, as a real spawn does
    m.answer(null, '');

    for (let i = 1; i <= 4; i += 1) {
      t = i * CENSUS_MS + i * 2; // 2ms of timer slop per tick, always late
      c.tick();
      expect(m.calls, `tick ${i}`).toBe(i + 1);
      t += 300;
      m.answer(null, '');
    }
    expect(c.fields().sysEnumEveryMs).toBeUndefined();
    c.stop();
  });

  it('widens its cadence after a slow count, and says so in the fields', () => {
    let t = 0;
    const m = manual();
    const c = new ProcessCensus({ enumerate: m.enumerate, parse: () => [], now: () => t });

    c.sample();
    t += CENSUS_SLOW_MS; // exactly at the threshold counts as slow
    m.answer(null, '');
    expect(c.fields().sysEnumEveryMs).toBe(CENSUS_MS * CENSUS_BACKOFF_STEP);

    // A tick at the OLD cadence is now too early and must not spawn...
    t += CENSUS_MS;
    c.tick();
    expect(m.calls).toBe(1);

    // ...and at the new one it does.
    t += CENSUS_MS;
    c.tick();
    expect(m.calls).toBe(2);
  });

  it('counts a FAILED count as slow — the failure it guards against is the timeout', () => {
    let t = 0;
    const m = manual();
    const c = new ProcessCensus({ enumerate: m.enumerate, parse: () => [], now: () => t });
    c.sample();
    t += CENSUS_TIMEOUT_MS;
    m.answer(new Error('Command failed: tasklist /fo csv /nh'));
    // A reset to one-a-minute here would keep asking a wedged machine to spawn
    // every minute for ever, which is exactly #1007's shape.
    expect(c.fields().sysEnumEveryMs).toBe(CENSUS_MS * CENSUS_BACKOFF_STEP);
  });

  it('snaps straight back to one a minute on the first fast count', () => {
    let t = 0;
    const m = manual();
    const c = new ProcessCensus({ enumerate: m.enumerate, parse: () => [], now: () => t });

    c.sample();
    t += CENSUS_SLOW_MS;
    m.answer(null, '');
    expect(c.fields().sysEnumEveryMs).toBe(CENSUS_MS * CENSUS_BACKOFF_STEP);

    // Two ticks: the first burns the skip the backoff asked for, the second is
    // the one that counts.
    c.tick();
    c.tick();
    expect(m.calls).toBe(2);
    t += 50; // fast: spawning is cheap again
    m.answer(null, '');
    // Recovery is immediate where backoff is gradual, and the FIELD GOES AWAY —
    // its presence is what tells a reader a steady `sysProcs` is fresh rather
    // than stale.
    expect(c.fields().sysEnumEveryMs).toBeUndefined();
  });

  it('cannot back off for ever', () => {
    let t = 0;
    const m = manual();
    const c = new ProcessCensus({ enumerate: m.enumerate, parse: () => [], now: () => t });
    c.sample();
    for (let i = 0; i < 20; i += 1) {
      t += CENSUS_SLOW_MS * 2; // every count is slow, every time
      m.answer(null, '');
      // Burn whatever skip the backoff just asked for; the tick after it counts.
      for (let k = 0; k <= CENSUS_MAX_MS / CENSUS_MS; k += 1) c.tick();
    }
    expect(c.fields().sysEnumEveryMs).toBe(CENSUS_MAX_MS);
  });

  // The real lister, once, so a platform whose output the parser misreads
  // fails here rather than as a silent zero on the owner's laptop.
  it('counts this machine for real', async () => {
    const c = new ProcessCensus();
    c.sample();
    const t0 = Date.now();
    while (c.fields().sysProcs === undefined && c.fields().sysEnumError === undefined) {
      if (Date.now() - t0 > 20_000) throw new Error('census never finished');
      await new Promise((r) => setTimeout(r, 50));
    }
    c.stop();
    const f = c.fields();
    expect(f.sysEnumError).toBeUndefined();
    expect(f.sysProcs as number).toBeGreaterThan(3);
    expect(Object.keys(f.sysTop as object).length).toBeGreaterThan(0);
  }, 30_000);
});
