// P2-E14-07: the service — what gets pushed, when, and what never happens.
//
// Fake timers here, and every case disposes of them (#441): a pending poll
// timeout leaking into the next case would make the suite order-dependent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ServiceHealthStatus } from '../../shared/service-health';
import { StatuspageProbe } from './statuspage';
import { MAX_POLL_MS, MIN_POLL_MS, pollIntervalFor, ServiceHealthService } from './service';

const log = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() });

function ok(over: Partial<StatuspageProbe> = {}): StatuspageProbe {
  return {
    state: 'operational',
    reason: 'ok',
    description: 'All Systems Operational',
    incidents: [],
    checkedAt: '2026-08-11T00:00:00.000Z',
    ...over,
  };
}

const INCIDENT = {
  id: 'i1',
  name: 'Elevated errors',
  status: 'investigating',
  impact: 'major' as const,
};

/** a service with everything injected — no timers of its own until started */
function make(over: Partial<Parameters<typeof buildDeps>[0]> = {}) {
  const pushed: ServiceHealthStatus[] = [];
  const l = log();
  const probe = vi.fn(async () => ok());
  const deps = buildDeps({ pushed, log: l, probe, ...over });
  return { svc: new ServiceHealthService(deps), pushed, log: l, probe, deps };
}

function buildDeps(o: {
  pushed: ServiceHealthStatus[];
  log: ReturnType<typeof log>;
  probe: () => Promise<StatuspageProbe>;
  poll?: boolean;
  isOnline?: () => boolean;
  feedOverride?: string;
  now?: () => number;
  windowMs?: number;
}) {
  return {
    getPrefs: () => ({ poll: o.poll !== false }),
    push: (s: ServiceHealthStatus) => o.pushed.push(s),
    log: o.log,
    probeImpl: o.probe,
    ...(o.isOnline ? { isOnline: o.isOnline } : {}),
    ...(o.feedOverride ? { feedOverride: o.feedOverride } : {}),
    ...(o.now ? { now: o.now } : {}),
    corroboration: { minSessions: 3, windowMs: o.windowMs ?? 60_000 },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the poll interval respects the page, in one direction', () => {
  it('a short max-age does not speed us up', () => {
    // the live page serves max-age=10; five minutes is the floor
    expect(pollIntervalFor(10_000)).toBe(MIN_POLL_MS);
  });
  it('a long one slows us down', () => {
    expect(pollIntervalFor(10 * 60_000)).toBe(10 * 60_000);
  });
  it('an absurd one cannot switch polling off', () => {
    expect(pollIntervalFor(24 * 60 * 60_000)).toBe(MAX_POLL_MS);
  });
  it('no header means the default', () => {
    expect(pollIntervalFor(undefined)).toBe(MIN_POLL_MS);
  });
});

describe('the four states reach the renderer', () => {
  it.each([
    ['none-ish', ok(), 'operational'],
    ['degraded', ok({ state: 'degraded', description: 'Degraded Performance' }), 'degraded'],
    ['outage', ok({ state: 'outage', incidents: [INCIDENT] }), 'outage'],
    ['unreadable', ok({ state: 'unknown', reason: 'bad-response' }), 'unknown'],
  ])('%s', async (_name, probe, state) => {
    const { svc, pushed } = make({ probe: vi.fn(async () => probe) });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    expect(pushed[0].state).toBe(state);
    svc.stop();
  });

  it('carries the incident detail the tooltip and the notice need', async () => {
    const { svc, pushed } = make({ probe: vi.fn(async () => ok({ state: 'outage', incidents: [INCIDENT] })) });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    expect(pushed[0].incidents[0]).toMatchObject({ id: 'i1', name: 'Elevated errors' });
    svc.stop();
  });

  it('does not re-push an answer that has not changed', async () => {
    const { svc, pushed } = make();
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    await svc.refresh();
    expect(pushed).toHaveLength(1);
    svc.stop();
  });
});

describe('a failure is quiet', () => {
  it('a probe that rejects becomes unknown, not an unhandled rejection', async () => {
    const { svc, pushed, log: l } = make({
      probe: vi.fn(async () => {
        throw new Error('socket died');
      }),
    });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    expect(pushed[0]).toMatchObject({ state: 'unknown', reason: 'network' });
    expect(l.warn).toHaveBeenCalled();
    svc.stop();
  });

  it('a push that throws does not take the poll down', async () => {
    const l = log();
    const svc = new ServiceHealthService({
      getPrefs: () => ({ poll: true }),
      push: () => {
        throw new Error('window is gone');
      },
      log: l,
      probeImpl: async () => ok(),
    });
    await expect(svc.refresh()).resolves.toBeUndefined();
    expect(svc.current().state).toBe('operational');
    svc.stop();
  });

  it('keeps polling after a failure — the dot comes back on its own', async () => {
    let answer: StatuspageProbe = ok({ state: 'unknown', reason: 'network' });
    const probe = vi.fn(async () => answer);
    const { svc, pushed } = make({ probe });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    answer = ok();
    await vi.advanceTimersByTimeAsync(MIN_POLL_MS + 10);
    await vi.waitFor(() => expect(pushed.length).toBe(2));
    expect(pushed[1].state).toBe('operational');
    svc.stop();
  });
});

describe('polling can be off, and off changes nothing else', () => {
  it('never asks when the preference is off', async () => {
    const { svc, probe, pushed } = make({ poll: false });
    svc.start();
    expect(probe).not.toHaveBeenCalled();
    expect(pushed[0]).toMatchObject({ state: 'unknown', reason: 'polling-off' });
    svc.stop();
  });

  it('never asks when the dev seam says off', async () => {
    const { svc, probe } = make({ feedOverride: 'off' });
    svc.start();
    expect(probe).not.toHaveBeenCalled();
    svc.stop();
  });

  it('starts polling the moment the preference comes back on', async () => {
    let poll = false;
    const probe = vi.fn(async () => ok());
    const l = log();
    const pushed: ServiceHealthStatus[] = [];
    const svc = new ServiceHealthService({
      getPrefs: () => ({ poll }),
      push: (s) => pushed.push(s),
      log: l,
      probeImpl: probe,
    });
    svc.start();
    expect(probe).not.toHaveBeenCalled();
    poll = true;
    svc.prefsChanged();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    svc.stop();
  });

  it('still corroborates locally with polling off — that half asks nobody', async () => {
    const { svc, pushed } = make({ poll: false });
    svc.start();
    for (const id of ['a', 'b', 'c']) svc.noteStreamMessage(id, { type: 'result', is_error: true });
    const last = pushed[pushed.length - 1];
    expect(last.reason).toBe('polling-off');
    expect(last.corroboration).toMatchObject({ sessions: 3 });
    svc.stop();
  });
});

describe('offline', () => {
  it('asks nothing and says unknown', async () => {
    const { svc, probe, pushed } = make({ isOnline: () => false });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    expect(probe).not.toHaveBeenCalled();
    expect(pushed[0]).toMatchObject({ state: 'unknown', reason: 'offline' });
    svc.stop();
  });

  it('comes back on its own when the network does', async () => {
    let online = false;
    const { svc, probe, pushed } = make({ isOnline: () => online });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    online = true;
    await vi.advanceTimersByTimeAsync(MIN_POLL_MS + 10);
    await vi.waitFor(() => expect(probe).toHaveBeenCalled());
    expect(pushed[pushed.length - 1].state).toBe('operational');
    svc.stop();
  });

  it('an online check that throws is not evidence of being offline', async () => {
    const { svc, probe } = make({
      isOnline: () => {
        throw new Error('no net module here');
      },
    });
    svc.start();
    await vi.waitFor(() => expect(probe).toHaveBeenCalled());
    svc.stop();
  });
});

describe('local corroboration rides the same record', () => {
  it('raises at three errored sessions and clears when one recovers', async () => {
    const { svc, pushed } = make();
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    svc.noteStreamMessage('a', { type: 'result', is_error: true });
    svc.noteStreamMessage('b', { type: 'result', is_error: true });
    expect(pushed[pushed.length - 1].corroboration).toBeNull();
    svc.noteStreamMessage('c', { type: 'result', is_error: true });
    expect(pushed[pushed.length - 1].corroboration).toMatchObject({ sessions: 3 });
    svc.noteStreamMessage('b', { type: 'result', subtype: 'success' });
    expect(pushed[pushed.length - 1].corroboration).toBeNull();
    svc.stop();
  });

  it('a closed session stops corroborating', async () => {
    const { svc, pushed } = make();
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    for (const id of ['a', 'b', 'c']) svc.noteStreamMessage(id, { type: 'result', is_error: true });
    expect(pushed[pushed.length - 1].corroboration).not.toBeNull();
    svc.forgetSession('a');
    expect(pushed[pushed.length - 1].corroboration).toBeNull();
    svc.stop();
  });

  it('survives a poll — the page and the machine are independent halves', async () => {
    // a window longer than the poll interval, so the evidence is still inside
    // it when the next poll lands and overwrites the page half of the record
    const { svc, pushed } = make({ windowMs: 10 * 60_000 });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    for (const id of ['a', 'b', 'c']) svc.noteStreamMessage(id, { type: 'result', is_error: true });
    await vi.advanceTimersByTimeAsync(MIN_POLL_MS + 10);
    await vi.waitFor(() => expect(svc.current().checkedAt).toBeDefined());
    expect(svc.current().corroboration).toMatchObject({ sessions: 3 });
    svc.stop();
  });

  it('clears itself when the window passes with nothing more happening', async () => {
    const { svc, pushed } = make();
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    for (const id of ['a', 'b', 'c']) svc.noteStreamMessage(id, { type: 'result', is_error: true });
    expect(pushed[pushed.length - 1].corroboration).not.toBeNull();
    // the injected window is a minute; the sweep runs every 30s
    await vi.advanceTimersByTimeAsync(90_000);
    expect(svc.current().corroboration).toBeNull();
    svc.stop();
  });
});

describe('incident transitions', () => {
  it('logs an incident opening and resolving', async () => {
    let answer = ok({ state: 'outage', incidents: [INCIDENT] });
    const { svc, log: l } = make({ probe: vi.fn(async () => answer) });
    svc.start();
    await vi.waitFor(() => expect(l.info).toHaveBeenCalledWith('provider incident opened', expect.anything()));
    answer = ok();
    await vi.advanceTimersByTimeAsync(MIN_POLL_MS + 10);
    await vi.waitFor(() =>
      expect(l.info).toHaveBeenCalledWith('provider incident resolved', { id: 'i1' })
    );
    svc.stop();
  });

  it('a failed poll is not a resolution', async () => {
    let answer = ok({ state: 'outage', incidents: [INCIDENT] });
    const { svc, log: l } = make({ probe: vi.fn(async () => answer) });
    svc.start();
    await vi.waitFor(() => expect(l.info).toHaveBeenCalled());
    answer = ok({ state: 'unknown', reason: 'network', incidents: [] });
    await vi.advanceTimersByTimeAsync(MIN_POLL_MS + 10);
    await vi.waitFor(() => expect(svc.current().state).toBe('unknown'));
    expect(l.info).not.toHaveBeenCalledWith('provider incident resolved', expect.anything());
    svc.stop();
  });
});

describe('stopping', () => {
  it('a stopped service polls no more', async () => {
    const { svc, probe } = make();
    svc.start();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    svc.stop();
    await vi.advanceTimersByTimeAsync(MIN_POLL_MS * 3);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
