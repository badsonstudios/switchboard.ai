// The POLICY half of P2-E19-03: when a check runs, when it prompts, and what
// a quit mid-flight does. `checker.test.ts` covers the question; this covers
// who asks it and who hears the answer.
import { describe, it, expect, vi } from 'vitest';
import {
  AUTO_COALESCE_MS,
  DAILY_MS,
  isAllowedReleaseUrl,
  shouldPrompt,
  TICK_MS,
  UpdateService,
} from './service';
import type { UpdateCheckResult, UpdatePrefs } from '../../shared/update';

const CURRENT = '0.1.0';

function result(over: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    ok: true,
    state: 'available',
    currentVersion: CURRENT,
    latestVersion: '0.2.0',
    notes: 'stuff',
    url: 'https://github.com/badsonstudios/switchboard.ai/releases/tag/v0.2.0',
    checkedAt: '2026-08-05T10:00:00.000Z',
    ...over,
  };
}

/** A service with an in-memory prefs store and a scripted checker. */
function harness(
  opts: {
    prefs?: Partial<UpdatePrefs>;
    results?: UpdateCheckResult[];
    feedOverride?: string;
    now?: () => number;
  } = {}
) {
  let prefs: UpdatePrefs = { autoCheck: true, ...opts.prefs };
  const pushed: unknown[] = [];
  const results = [...(opts.results ?? [result()])];
  const checkImpl = vi.fn(async () => results.shift() ?? result());
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const service = new UpdateService({
    currentVersion: CURRENT,
    getPrefs: () => ({ ...prefs }),
    setPrefs: (patch) => {
      prefs = { ...prefs, ...patch };
    },
    push: (s) => pushed.push(s),
    log,
    feedOverride: opts.feedOverride,
    checkImpl,
    now: opts.now,
  });
  return { service, checkImpl, pushed, log, prefsNow: () => prefs };
}

describe('shouldPrompt (the decision the renderer obeys)', () => {
  const prefs: UpdatePrefs = { autoCheck: true };

  it('prompts for a new release nobody has skipped', () => {
    expect(shouldPrompt(result(), prefs, false)).toBe(true);
  });

  it('does NOT prompt automatically for a skipped version', () => {
    expect(shouldPrompt(result(), { ...prefs, skippedVersion: '0.2.0' }, false)).toBe(false);
  });

  it('still prompts for a skipped version on a MANUAL check', () => {
    // "Check for updates…" that silently does nothing is worse than no button.
    expect(shouldPrompt(result(), { ...prefs, skippedVersion: '0.2.0' }, true)).toBe(true);
  });

  it('skip is PER VERSION — a newer release prompts again (the done-when)', () => {
    const skipped: UpdatePrefs = { autoCheck: true, skippedVersion: '0.2.0' };
    expect(shouldPrompt(result({ latestVersion: '0.2.0' }), skipped, false)).toBe(false);
    expect(shouldPrompt(result({ latestVersion: '0.3.0' }), skipped, false)).toBe(true);
  });

  it('is silent for every automatic non-offer — up to date, disabled, failed', () => {
    for (const r of [
      result({ state: 'up-to-date', latestVersion: '0.1.0' }),
      result({ state: 'disabled', ok: false, reason: 'no-token', latestVersion: undefined }),
      result({ state: 'failed', ok: false, reason: 'auth', latestVersion: undefined }),
    ]) {
      expect(shouldPrompt(r, prefs, false)).toBe(false);
      // …and shows all of them when a human asked
      expect(shouldPrompt(r, prefs, true)).toBe(true);
    }
  });
});

describe('UpdateService.check', () => {
  it('an automatic check is skipped when auto-check is off, without a network call', async () => {
    const h = harness({ prefs: { autoCheck: false } });
    const s = await h.service.check(false);
    expect(h.checkImpl).not.toHaveBeenCalled();
    expect(s.result.state).toBe('disabled');
    expect(s.result.reason).toBe('auto-check-off');
    expect(s.prompt).toBe(false);
  });

  it('a MANUAL check runs even with auto-check off', async () => {
    const h = harness({ prefs: { autoCheck: false } });
    const s = await h.service.check(true);
    expect(h.checkImpl).toHaveBeenCalledTimes(1);
    expect(s.manual).toBe(true);
    expect(s.prompt).toBe(true);
  });

  it('coalesces automatic checks (two windows, one API call)', async () => {
    let t = 1_000_000;
    const h = harness({ now: () => t });
    await h.service.check(false);
    t += AUTO_COALESCE_MS - 1;
    const second = await h.service.check(false);
    expect(h.checkImpl).toHaveBeenCalledTimes(1);
    expect(second.result.state).toBe('available');
    t += 2;
    await h.service.check(false);
    expect(h.checkImpl).toHaveBeenCalledTimes(2);
  });

  it('re-decides prompt on a coalesced answer, so a skip mid-window takes effect', async () => {
    const t = 1_000_000;
    const h = harness({ now: () => t });
    expect((await h.service.check(false)).prompt).toBe(true);
    h.service.skip('0.2.0');
    expect((await h.service.check(false)).prompt).toBe(false);
    expect(h.checkImpl).toHaveBeenCalledTimes(1); // still coalesced
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.service.check(true), h.service.check(true)]);
    expect(h.checkImpl).toHaveBeenCalledTimes(1);
    expect(a.result.latestVersion).toBe(b.result.latestVersion);
  });

  it('pushes only when asked to — the IPC caller gets its answer as a return', async () => {
    const h = harness();
    await h.service.check(true, { push: false });
    expect(h.pushed).toHaveLength(0);
    await h.service.check(true, { push: true });
    expect(h.pushed).toHaveLength(1);
  });

  it('records lastCheck even when the check FAILED — the timer is a budget', async () => {
    const h = harness({
      results: [result({ ok: false, state: 'failed', reason: 'auth', latestVersion: undefined })],
      now: () => Date.parse('2026-08-05T12:00:00.000Z'),
    });
    await h.service.check(true);
    expect(h.prefsNow().lastCheck).toBe('2026-08-05T12:00:00.000Z');
  });

  it('a checker that THROWS becomes a failed record, never an escape', async () => {
    const h = harness();
    const service = new UpdateService({
      currentVersion: CURRENT,
      getPrefs: () => ({ autoCheck: true }),
      setPrefs: () => {},
      push: () => {},
      log: h.log,
      checkImpl: () => Promise.reject(new Error('boom')),
    });
    const s = await service.check(true);
    expect(s.result.state).toBe('failed');
    expect(h.log.warn).toHaveBeenCalled();
  });
});

describe('UpdateService — the feed override (dev/test only)', () => {
  it('`off` disables checks entirely and makes no call', async () => {
    const h = harness({ feedOverride: 'off' });
    const s = await h.service.check(true);
    expect(h.checkImpl).not.toHaveBeenCalled();
    expect(s.result.state).toBe('disabled');
    expect(s.result.reason).toBe('overridden-off');
  });

  it('a URL becomes the endpoint AND turns token resolution off', async () => {
    const h = harness({ feedOverride: 'http://127.0.0.1:4321/releases' });
    await h.service.check(true);
    expect(h.checkImpl).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'http://127.0.0.1:4321/releases', skipToken: true })
    );
  });
});

describe('UpdateService — the timer', () => {
  it('start() is idempotent, and the handle is unref\'d so it never holds the app open', () => {
    const h = harness();
    const spy = vi.spyOn(globalThis, 'setInterval');
    h.service.start();
    h.service.start();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(TICK_MS);
    h.service.stop();
    // …and stop() is final: a service that has seen quit never arms again.
    h.service.start();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('unrefs the interval it arms', () => {
    const real = globalThis.setInterval;
    const unref = vi.fn();
    const fake = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(((fn: () => void, ms: number) => {
        const handle = real(fn, ms) as NodeJS.Timeout;
        clearInterval(handle); // nothing must actually fire in this test
        return { unref, ref: () => {} } as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval);
    const h = harness();
    h.service.start();
    expect(unref).toHaveBeenCalledTimes(1);
    h.service.stop();
    fake.mockRestore();
  });

  it('a THROWING tick is swallowed — an interval that throws in main is an error modal', () => {
    vi.useFakeTimers();
    try {
      const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
      const service = new UpdateService({
        currentVersion: CURRENT,
        getPrefs: () => {
          throw new Error('workspace store exploded');
        },
        setPrefs: () => {},
        push: () => {},
        log,
        checkImpl: async () => result(),
      });
      service.start();
      expect(() => vi.advanceTimersByTime(TICK_MS)).not.toThrow();
      expect(log.warn).toHaveBeenCalled();
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ticks hourly but only CHECKS once a day', async () => {
    vi.useFakeTimers();
    try {
      let t = Date.parse('2026-08-05T00:00:00.000Z');
      const h = harness({ prefs: { lastCheck: new Date(t).toISOString() }, now: () => t });
      h.service.start();
      // 23 hours of ticks: nothing is due
      for (let i = 0; i < 23; i++) {
        t += TICK_MS;
        await vi.advanceTimersByTimeAsync(TICK_MS);
      }
      expect(h.checkImpl).not.toHaveBeenCalled();
      t += TICK_MS;
      await vi.advanceTimersByTimeAsync(TICK_MS);
      expect(h.checkImpl).toHaveBeenCalledTimes(1);
      expect(h.pushed).toHaveLength(1); // the timer has no caller, so it pushes
      h.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hand-edited or missing lastCheck counts as DUE, not as never again', async () => {
    vi.useFakeTimers();
    try {
      const t = Date.parse('2026-08-05T00:00:00.000Z');
      for (const lastCheck of [undefined, 'not a date', new Date(t + DAILY_MS * 9).toISOString()]) {
        const h = harness({ prefs: { lastCheck }, now: () => t });
        h.service.start();
        await vi.advanceTimersByTimeAsync(TICK_MS);
        expect(h.checkImpl, String(lastCheck)).toHaveBeenCalledTimes(1);
        h.service.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() silences the timer, and a check in flight at quit writes and pushes NOTHING', async () => {
    let release!: (r: UpdateCheckResult) => void;
    const pushed: unknown[] = [];
    const writes: unknown[] = [];
    const service = new UpdateService({
      currentVersion: CURRENT,
      getPrefs: () => ({ autoCheck: true }),
      setPrefs: (p) => writes.push(p),
      push: (s) => pushed.push(s),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      checkImpl: () => new Promise<UpdateCheckResult>((res) => (release = res)),
    });
    service.start();
    const inFlight = service.check(true, { push: true });
    service.stop(); // app.on('quit')
    release(result());
    const s = await inFlight;
    // The caller still gets an answer — something may be awaiting it — but the
    // store is on its way out and the window is gone.
    expect(s.result.state).toBe('available');
    expect(writes).toHaveLength(0);
    expect(pushed).toHaveLength(0);

    // …and a check started AFTER quit says so honestly, rather than blaming a
    // preference the user never touched
    const after = await service.check(true);
    expect(after.result.reason).toBe('quitting');
  });
});

describe('isAllowedReleaseUrl (what may reach the user\'s browser)', () => {
  it('allows https GitHub URLs', () => {
    expect(
      isAllowedReleaseUrl('https://github.com/badsonstudios/switchboard.ai/releases/tag/v0.2.0')
    ).toBe(true);
    expect(isAllowedReleaseUrl('https://gist.github.com/someone/abc')).toBe(true);
  });

  it('refuses plaintext http, even to GitHub', () => {
    expect(isAllowedReleaseUrl('http://github.com/x')).toBe(false);
  });

  it('refuses every other host, including look-alikes', () => {
    for (const bad of [
      'https://evil.example.com/x',
      'https://github.com.evil.example.com/x',
      'https://notgithub.com/x',
      'file:///C:/Windows/System32/cmd.exe',
      'javascript:alert(1)',
      'not a url',
      '',
      null,
      undefined,
      42,
    ]) {
      expect(isAllowedReleaseUrl(bad), String(bad)).toBe(false);
    }
  });
});
