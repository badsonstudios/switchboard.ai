// Detection (#1291): the done-when's four answers — installed, not installed,
// logged out, probe timeout — plus the fail-open cases and the runner's
// "never blocks" proof: a probe that NEVER settles still lets a run finish
// within the timeout.
import { describe, expect, it, vi } from 'vitest';
import { DetectionRunner, normalizeAnswer, pathProbe, runProbe, type Probe } from './detection';

const never: Probe = () => new Promise(() => {});

describe('runProbe: one AI, under a hard timeout', () => {
  it('installed, with version and sign-in', async () => {
    const r = await runProbe(() => Promise.resolve({ installed: true, version: '2.1.288', login: 'logged-in', account: 'a@b.c', plan: 'max' }), 1000);
    expect(r).toMatchObject({ installed: true, version: '2.1.288', login: 'logged-in', account: 'a@b.c', plan: 'max' });
    expect(r.probedAt).toBeTypeOf('number');
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('not installed', async () => {
    expect(await runProbe(() => Promise.resolve({ installed: false, login: 'unknown' }), 1000)).toMatchObject({
      installed: false,
      login: 'unknown',
    });
  });

  it('installed but logged out', async () => {
    expect(await runProbe(() => Promise.resolve({ installed: true, login: 'logged-out' }), 1000)).toMatchObject({
      installed: true,
      login: 'logged-out',
    });
  });

  it('a probe that never answers is "unknown" at the deadline, and its signal is aborted', async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const p = runProbe((signal) => {
        seen = signal;
        return new Promise(() => {});
      }, 5000);
      await vi.advanceTimersByTimeAsync(4999);
      expect(seen?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const r = await p;
      expect(r).toMatchObject({ installed: 'unknown', login: 'unknown' });
      expect(r.detail).toMatch(/did not answer within 5 s/);
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a probe that throws, rejects, or answers nonsense is "unknown" with the reason', async () => {
    const threw = await runProbe(() => {
      throw new Error('boom');
    }, 1000);
    expect(threw).toMatchObject({ installed: 'unknown', login: 'unknown' });
    expect(threw.detail).toMatch(/boom/);
    const rejected = await runProbe(() => Promise.reject(new Error('nope')), 1000);
    expect(rejected.detail).toMatch(/nope/);
    const nonsense = await runProbe(() => Promise.resolve({ installed: 'maybe' } as never), 1000);
    expect(nonsense).toMatchObject({ installed: 'unknown', detail: 'the check answered something unreadable' });
  });

  it('a late answer after the deadline changes nothing', async () => {
    vi.useFakeTimers();
    try {
      let answer: ((v: { installed: true; login: 'logged-in' }) => void) | undefined;
      const p = runProbe(() => new Promise((r) => (answer = r)), 100);
      await vi.advanceTimersByTimeAsync(100);
      answer?.({ installed: true, login: 'logged-in' });
      expect((await p).installed).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runProbe: cancel (app quit)', () => {
  it('settles at once, aborting the probe so it can kill what it started', async () => {
    let seen: AbortSignal | undefined;
    const cancel = new AbortController();
    const p = runProbe((signal) => {
      seen = signal;
      return new Promise(() => {});
    }, 60_000, Date.now, cancel.signal);
    cancel.abort();
    expect(await p).toMatchObject({ installed: 'unknown', detail: 'the check was cancelled' });
    expect(seen?.aborted).toBe(true);
  });

  it('an already-cancelled signal never starts the probe', async () => {
    const cancel = new AbortController();
    cancel.abort();
    const probe = vi.fn(never);
    expect((await runProbe(probe, 1000, Date.now, cancel.signal)).detail).toBe('the check was cancelled');
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('normalizeAnswer', () => {
  it('keeps known fields, trims, caps, and drops an unknown login to "unknown"', () => {
    expect(normalizeAnswer({ installed: true, login: 'weird', version: '  1.2  ', account: '', extra: 1 })).toEqual({
      installed: true,
      login: 'unknown',
      version: '1.2',
    });
    expect(normalizeAnswer(null)).toBeNull();
    expect(normalizeAnswer({ login: 'logged-in' })).toBeNull();
  });
});

describe('pathProbe: the fallback for an AI with no probe of its own', () => {
  it('asks the PATH scan and starts nothing', async () => {
    const find = vi.fn((c: string) => (c === 'gemini' ? '/usr/bin/gemini' : null));
    expect(await pathProbe('gemini', find)(new AbortController().signal)).toEqual({ installed: true, login: 'unknown' });
    expect(await pathProbe('qwen', find)(new AbortController().signal)).toEqual({ installed: false, login: 'unknown' });
  });
});

describe('DetectionRunner', () => {
  it('a probe that never resolves still lets the run finish within the timeout (startup never waits on it)', async () => {
    vi.useFakeTimers();
    try {
      const onDone = vi.fn();
      const runner = new DetectionRunner({
        timeoutMs: 5000,
        targets: () => [
          { id: 'claude-code', probe: () => Promise.resolve({ installed: true, login: 'logged-in' }) },
          { id: 'stuck', probe: never },
        ],
        onDone,
      });
      let finished = false;
      void runner.run('startup').then(() => (finished = true));
      expect(runner.running).toBe(true);
      await vi.advanceTimersByTimeAsync(4999);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(finished).toBe(true);
      expect(runner.running).toBe(false);
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(runner.result('claude-code')).toMatchObject({ installed: true, login: 'logged-in' });
      expect(runner.result('stuck')).toMatchObject({ installed: 'unknown' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('probes run concurrently: N slow AIs cost one timeout, not N', async () => {
    vi.useFakeTimers();
    try {
      const runner = new DetectionRunner({
        timeoutMs: 1000,
        targets: () => ['a', 'b', 'c', 'd'].map((id) => ({ id, probe: never })),
      });
      let finished = false;
      void runner.run('startup').then(() => (finished = true));
      await vi.advanceTimersByTimeAsync(1000);
      expect(finished).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a run already in flight is shared ("Look again" during the startup run)', async () => {
    const probe = vi.fn(() => Promise.resolve({ installed: true as const, login: 'unknown' as const }));
    const runner = new DetectionRunner({ targets: () => [{ id: 'x', probe }] });
    const a = runner.run('startup');
    const b = runner.run('look again');
    expect(b).toBe(a);
    await Promise.all([a, b]);
    expect(probe).toHaveBeenCalledTimes(1);
    await runner.run('look again');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('abort() ends the run in flight at once and refuses new runs', async () => {
    let seen: AbortSignal | undefined;
    const runner = new DetectionRunner({
      timeoutMs: 60_000,
      targets: () => [
        {
          id: 'claude-code',
          probe: (signal) => {
            seen = signal;
            return new Promise(() => {});
          },
        },
      ],
    });
    const p = runner.run('startup');
    runner.abort();
    await p;
    expect(seen?.aborted).toBe(true);
    expect(runner.result('claude-code')?.detail).toBe('the check was cancelled');
    const probe = vi.fn(never);
    const after = new DetectionRunner({ targets: () => [{ id: 'x', probe }] });
    after.abort();
    await after.run('look again');
    expect(probe).not.toHaveBeenCalled();
  });

  it('adopt: a newer answer is never overwritten by an older one', () => {
    const runner = new DetectionRunner({ targets: () => [] });
    runner.adopt('x', { installed: true, login: 'logged-in', probedAt: 200 });
    runner.adopt('x', { installed: true, login: 'logged-out', probedAt: 100 });
    expect(runner.result('x')?.login).toBe('logged-in');
    runner.adopt('x', { installed: true, login: 'logged-out', probedAt: 300 });
    expect(runner.result('x')?.login).toBe('logged-out');
  });

  it('logs the total time at the end of a run', async () => {
    const log = vi.fn();
    const runner = new DetectionRunner({
      targets: () => [{ id: 'x', probe: () => Promise.resolve({ installed: false, login: 'unknown' }) }],
      log,
    });
    await runner.run('startup');
    expect(log).toHaveBeenCalledWith('AI detection finished', expect.objectContaining({ reason: 'startup', checked: 1, ms: expect.any(Number) as unknown }));
  });

  it('a targets() that throws costs the run, not the app', async () => {
    const log = vi.fn();
    const runner = new DetectionRunner({
      targets: () => {
        throw new Error('broken');
      },
      log,
    });
    await expect(runner.run('startup')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('AI detection could not list what to check', { error: 'Error: broken' });
  });
});

describe('reason codes beside the English (#1365)', () => {
  it('normalizeAnswer keeps a readable detailCode with its detail, and drops anything else', () => {
    const code = { code: 'reports-at-session-start' };
    expect(normalizeAnswer({ installed: true, login: 'unknown', detail: 'why', detailCode: code })).toEqual({
      installed: true,
      login: 'unknown',
      detail: 'why',
      detailCode: code,
    });
    // no English beside it, an unknown code, or values it cannot read: dropped
    expect(normalizeAnswer({ installed: true, login: 'unknown', detailCode: code })).not.toHaveProperty('detailCode');
    expect(normalizeAnswer({ installed: true, login: 'unknown', detail: 'why', detailCode: { code: 'nope' } })).not.toHaveProperty('detailCode');
    expect(normalizeAnswer({ installed: true, login: 'unknown', detail: 'why', detailCode: { code: 'check-failed' } })).not.toHaveProperty('detailCode');
  });

  it('the runner codes its own answers: a throw, and something unreadable', async () => {
    const thrown = await runProbe(() => {
      throw new Error('boom');
    });
    expect(thrown).toMatchObject({ detail: 'the check failed: Error: boom', detailCode: { code: 'check-failed', params: { message: 'Error: boom' } } });
    const junk = await runProbe(() => Promise.resolve('junk' as never));
    expect(junk).toMatchObject({ installed: 'unknown', detailCode: { code: 'check-unreadable' } });
  });
});
