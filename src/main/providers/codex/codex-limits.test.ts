// Codex's plan limits (#1290): the measured `account/rateLimits/read` answer
// in, `PlanLimitWindow`s out; one read in flight, a short cache, fail-open.
import { describe, it, expect } from 'vitest';
import { createLimitsReader, parseRateLimits, windowLabel } from './codex-limits';
import type { AppServerAnswer } from './codex-app-server';

/** The `result` of `account/rateLimits/read`, as captured (`d-app-server.jsonl`). */
const MEASURED = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1792178362 },
    secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1792765162 },
    credits: { hasCredits: false, unlimited: false, balance: null },
    individualLimit: null,
    spendControlReached: false,
    planType: 'team',
    rateLimitReachedType: null,
  },
};

describe('parseRateLimits', () => {
  it('primary is the 5-hour window, secondary the weekly; resetsAt from epoch seconds to ISO', () => {
    expect(parseRateLimits(MEASURED)).toEqual([
      {
        id: 'primary',
        label: '5-hour limit',
        usedPercent: 3,
        windowMinutes: 300,
        resetsAt: new Date(1792178362 * 1000).toISOString(),
      },
      {
        id: 'secondary',
        label: 'Weekly limit',
        usedPercent: 0,
        windowMinutes: 10080,
        resetsAt: new Date(1792765162 * 1000).toISOString(),
      },
    ]);
  });

  it('a window with no usable percentage is dropped, not drawn as 0%', () => {
    const got = parseRateLimits({
      rateLimits: { primary: { usedPercent: null, windowDurationMins: 300 }, secondary: { usedPercent: 12 } },
    });
    expect(got).toEqual([{ id: 'secondary', usedPercent: 12 }]);
  });

  it('clamps to 0..100', () => {
    expect(parseRateLimits({ rateLimits: { primary: { usedPercent: 140 } } })?.[0].usedPercent).toBe(100);
    expect(parseRateLimits({ rateLimits: { primary: { usedPercent: -3 } } })?.[0].usedPercent).toBe(0);
  });

  it('nothing usable is undefined', () => {
    expect(parseRateLimits(undefined)).toBeUndefined();
    expect(parseRateLimits({})).toBeUndefined();
    expect(parseRateLimits({ rateLimits: [] })).toBeUndefined();
    expect(parseRateLimits({ rateLimits: { primary: 'x' } })).toBeUndefined();
  });

  it('labels follow the window length', () => {
    expect(windowLabel(300)).toBe('5-hour limit');
    expect(windowLabel(10080)).toBe('Weekly limit');
    expect(windowLabel(2880)).toBe('2-day limit');
    expect(windowLabel(45)).toBe('45-minute limit');
    expect(windowLabel(undefined)).toBeUndefined();
  });
});

describe('createLimitsReader', () => {
  const ok = (result: Record<string, unknown>): AppServerAnswer => ({ ok: true, result });

  it('reads once and caches for the TTL', async () => {
    let calls = 0;
    let t = 0;
    const read = createLimitsReader({
      cliPath: () => 'codex.cmd',
      ask: () => {
        calls += 1;
        return Promise.resolve(ok(MEASURED));
      },
      now: () => t,
      ttlMs: 1000,
    });
    expect((await read())?.map((w) => w.id)).toEqual(['primary', 'secondary']);
    t = 999;
    await read();
    expect(calls).toBe(1);
    t = 1000;
    await read();
    expect(calls).toBe(2);
  });

  it('never more than one read in flight: concurrent callers share it', async () => {
    let calls = 0;
    let release!: (a: AppServerAnswer) => void;
    const read = createLimitsReader({
      cliPath: () => 'codex.cmd',
      ask: () => {
        calls += 1;
        return new Promise((r) => (release = r));
      },
    });
    const a = read();
    const b = read();
    expect(calls).toBe(1);
    release(ok(MEASURED));
    const [x, y] = await Promise.all([a, b]);
    expect(x).toBe(y);
    expect(x).toHaveLength(2);
  });

  it('a CLI installed after a miss is read once the cache runs out (review of #1290)', async () => {
    let t = 0;
    let cli: string | null = null;
    let calls = 0;
    const read = createLimitsReader({
      cliPath: () => cli,
      ask: () => {
        calls += 1;
        return Promise.resolve(ok(MEASURED));
      },
      now: () => t,
      ttlMs: 1000,
    });
    expect(await read()).toBeUndefined();
    cli = 'codex.cmd';
    t = 1000;
    expect(await read()).toHaveLength(2);
    expect(calls).toBe(1);
  });

  it('fail-open: logged out, no CLI, or a throw is undefined, and the failure is cached', async () => {
    let calls = 0;
    const logs: string[] = [];
    const loggedOut = createLimitsReader({
      cliPath: () => 'codex.cmd',
      ask: () => {
        calls += 1;
        return Promise.resolve({
          ok: false,
          reason: 'codex account authentication required to read rate limits (-32600)',
        });
      },
      log: (m) => logs.push(m),
    });
    expect(await loggedOut()).toBeUndefined();
    expect(await loggedOut()).toBeUndefined();
    expect(calls).toBe(1);
    expect(logs[0]).toMatch(/authentication required/);

    let asked = false;
    const missing = createLimitsReader({
      cliPath: () => null,
      ask: () => {
        asked = true;
        return Promise.resolve(ok(MEASURED));
      },
    });
    expect(await missing()).toBeUndefined();
    expect(asked).toBe(false);

    const throwing = createLimitsReader({
      cliPath: () => {
        throw new Error('PATH unreadable');
      },
    });
    expect(await throwing()).toBeUndefined();
  });
});
