// P2-E14-07: the service — what gets pushed, when, and what never happens.
//
// Fake timers here, and every case disposes of them (#441): a pending poll
// timeout leaking into the next case would make the suite order-dependent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ServiceHealthStatus } from '../../shared/service-health';
import { StatuspageProbe } from './statuspage';
import {
  MAX_POLL_MS,
  MIN_POLL_MS,
  pollIntervalFor,
  ServiceHealthService,
  type ServiceHealthDeps,
} from './service';
import { translateClaudeFrame } from '../providers/claude-events';

// The service takes neutral events (#1286). These tests keep the real Claude
// `result` frames they were written with and translate them as the pump does.
const noteFrame = (svc: ServiceHealthService, id: string, frame: Record<string, unknown>): void => {
  for (const ev of translateClaudeFrame(frame) ?? []) svc.noteEvent(id, ev);
};

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

/** any Statuspage host: the probe is injected, so nothing is fetched */
const PAGE = 'https://status.example.test';

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
  statusPage?: ServiceHealthDeps['statusPage'];
}) {
  return {
    statusPage: o.statusPage ?? (() => ({ base: PAGE })),
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
      statusPage: () => ({ base: PAGE }),
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
      statusPage: () => ({ base: PAGE }),
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

  it('drops an incident card it will never refresh again', async () => {
    // turning the check off must not leave an incident notice standing for the
    // rest of the run with nothing able to clear it
    let poll = true;
    const pushed: ServiceHealthStatus[] = [];
    const svc = new ServiceHealthService({
      statusPage: () => ({ base: PAGE }),
      getPrefs: () => ({ poll }),
      push: (s) => pushed.push(s),
      log: log(),
      probeImpl: vi.fn(async () => ok({ state: 'outage', incidents: [INCIDENT] })),
    });
    svc.start();
    await vi.waitFor(() => expect(svc.current().incidents).toHaveLength(1));
    poll = false;
    svc.prefsChanged();
    expect(svc.current()).toMatchObject({ state: 'unknown', reason: 'polling-off', incidents: [] });
    expect(svc.current().checkedAt).toBeUndefined();
    svc.stop();
  });

  it('going offline KEEPS what the page already told us', async () => {
    // the other way round: we still believe it, we just cannot ask again
    let online = true;
    const { svc } = make({
      isOnline: () => online,
      probe: vi.fn(async () => ok({ state: 'outage', incidents: [INCIDENT] })),
    });
    svc.start();
    await vi.waitFor(() => expect(svc.current().incidents).toHaveLength(1));
    online = false;
    await vi.advanceTimersByTimeAsync(MIN_POLL_MS + 10);
    await vi.waitFor(() => expect(svc.current().reason).toBe('offline'));
    expect(svc.current().incidents).toHaveLength(1);
    svc.stop();
  });

  it('still corroborates locally with polling off — that half asks nobody', async () => {
    const { svc, pushed } = make({ poll: false });
    svc.start();
    for (const id of ['a', 'b', 'c']) noteFrame(svc, id, { type: 'result', is_error: true });
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

describe('whose page it is (#1316)', () => {
  it('carries the page owner on the record, so the words can name it', async () => {
    const { svc, pushed } = make({ statusPage: () => ({ base: PAGE, name: 'Anthropic' }) });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    expect(pushed[0]).toMatchObject({ reason: 'ok', pageName: 'Anthropic' });
    svc.stop();
  });

  it('names nobody when the provider did not say', async () => {
    const { svc, pushed } = make({ statusPage: () => ({ base: PAGE }) });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    expect(pushed[0].pageName).toBeUndefined();
    svc.stop();
  });

  it('polling off still names the page, read fresh — nothing is fetched', async () => {
    const { svc, pushed, probe } = make({ statusPage: () => ({ base: PAGE, name: 'Anthropic' }), poll: false });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    expect(probe).not.toHaveBeenCalled();
    expect(pushed[0]).toMatchObject({ reason: 'polling-off', pageName: 'Anthropic' });
    svc.stop();
  });

  it('the dev seam moves where we ask, not whose page it stands for', async () => {
    const { svc, pushed } = make({
      statusPage: () => ({ none: true as const, providerName: 'Codex' }),
      feedOverride: 'http://127.0.0.1:9/stub',
    });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    expect(pushed[0]).toMatchObject({ reason: 'ok', pageName: 'Codex' });
    svc.stop();
  });
});

describe('an AI with no status page (#1288)', () => {
  const none = () => ({ none: true as const, providerName: 'Codex' });

  it('asks nothing, and says which AI has no page', async () => {
    const { svc, pushed, probe } = make({ statusPage: none });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    expect(probe).not.toHaveBeenCalled();
    expect(pushed[0]).toMatchObject({ state: 'unknown', reason: 'no-status-page', providerName: 'Codex' });
    // ...and a re-check is cheap and silent: still nothing fetched, no re-push
    await vi.advanceTimersByTimeAsync(MIN_POLL_MS + 10);
    expect(probe).not.toHaveBeenCalled();
    expect(pushed).toHaveLength(1);
    svc.stop();
  });

  it('polls the page the provider names', async () => {
    const seen: string[] = [];
    const probe = vi.fn(async (d: { base: string }) => {
      seen.push(d.base);
      return ok();
    });
    const { svc, pushed } = make({
      probe: probe as unknown as () => Promise<StatuspageProbe>,
      statusPage: () => ({ base: 'https://status.other.test' }),
    });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    expect(seen).toEqual(['https://status.other.test']);
    svc.stop();
  });

  it('the dev seam still wins, so a test stub is polled whatever the provider says', async () => {
    const { svc, probe, pushed } = make({ statusPage: none, feedOverride: 'http://127.0.0.1:9/stub' });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(pushed[0].reason).toBe('ok');
    svc.stop();
  });

  it('a lookup that THROWS is "no page", logged, never a rejection', async () => {
    const { svc, pushed, probe, log: l } = make({
      statusPage: () => {
        throw new Error('registry exploded');
      },
    });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    expect(probe).not.toHaveBeenCalled();
    expect(pushed[0].reason).toBe('no-status-page');
    expect(l.warn).toHaveBeenCalled();
    svc.stop();
  });

  it('the local half still works: sessions here failing together needs no page', async () => {
    const { svc, pushed } = make({ statusPage: none });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    for (const id of ['a', 'b', 'c']) noteFrame(svc, id, { type: 'result', is_error: true });
    expect(pushed[pushed.length - 1]).toMatchObject({
      reason: 'no-status-page',
      corroboration: { sessions: 3 },
    });
    svc.stop();
  });

  it('polling off still wins over everything: the user said stop', async () => {
    const { svc, pushed } = make({ statusPage: none, poll: false });
    svc.start();
    expect(pushed.at(-1)?.reason).toBe('polling-off');
    svc.stop();
  });
});

describe('local corroboration rides the same record', () => {
  it('raises at three errored sessions and clears when one recovers', async () => {
    const { svc, pushed } = make();
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    noteFrame(svc, 'a', { type: 'result', is_error: true });
    noteFrame(svc, 'b', { type: 'result', is_error: true });
    expect(pushed[pushed.length - 1].corroboration).toBeNull();
    noteFrame(svc, 'c', { type: 'result', is_error: true });
    expect(pushed[pushed.length - 1].corroboration).toMatchObject({ sessions: 3 });
    noteFrame(svc, 'b', { type: 'result', subtype: 'success' });
    expect(pushed[pushed.length - 1].corroboration).toBeNull();
    svc.stop();
  });

  it('a closed session stops corroborating', async () => {
    const { svc, pushed } = make();
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    for (const id of ['a', 'b', 'c']) noteFrame(svc, id, { type: 'result', is_error: true });
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
    for (const id of ['a', 'b', 'c']) noteFrame(svc, id, { type: 'result', is_error: true });
    await vi.advanceTimersByTimeAsync(MIN_POLL_MS + 10);
    await vi.waitFor(() => expect(svc.current().checkedAt).toBeDefined());
    expect(svc.current().corroboration).toMatchObject({ sessions: 3 });
    svc.stop();
  });

  it('clears itself when the window passes with nothing more happening', async () => {
    const { svc, pushed } = make();
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    for (const id of ['a', 'b', 'c']) noteFrame(svc, id, { type: 'result', is_error: true });
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

describe('an answer that arrives too late', () => {
  /** a probe that resolves only when the test says so */
  function deferred() {
    let release: (p: StatuspageProbe) => void = () => {};
    const probe = vi.fn(
      () =>
        new Promise<StatuspageProbe>((r) => {
          release = r;
        })
    );
    return { probe, release: (p: StatuspageProbe) => release(p) };
  }

  it('does not undo polling being switched off', async () => {
    // the shape of the bug: untick the box while a poll is on the wire, and the
    // answer puts the dot back to green — and re-arms the timer that was killed
    const d = deferred();
    let poll = true;
    const pushed: ServiceHealthStatus[] = [];
    const svc = new ServiceHealthService({
      statusPage: () => ({ base: PAGE }),
      getPrefs: () => ({ poll }),
      push: (s) => pushed.push(s),
      log: log(),
      probeImpl: d.probe,
    });
    svc.start();
    await vi.waitFor(() => expect(d.probe).toHaveBeenCalled());
    poll = false;
    svc.prefsChanged();
    expect(svc.current().reason).toBe('polling-off');
    d.release(ok());
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.current().reason).toBe('polling-off');
    // …and nothing was scheduled: five minutes later it has still not asked again
    await vi.advanceTimersByTimeAsync(MIN_POLL_MS * 2);
    expect(d.probe).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  it('does not speak after the service has stopped', async () => {
    const d = deferred();
    const pushed: ServiceHealthStatus[] = [];
    const svc = new ServiceHealthService({
      statusPage: () => ({ base: PAGE }),
      getPrefs: () => ({ poll: true }),
      push: (s) => pushed.push(s),
      log: log(),
      probeImpl: d.probe,
    });
    svc.start();
    await vi.waitFor(() => expect(d.probe).toHaveBeenCalled());
    svc.stop();
    const before = pushed.length;
    d.release(ok());
    await vi.advanceTimersByTimeAsync(MIN_POLL_MS * 2);
    expect(pushed).toHaveLength(before);
    expect(d.probe).toHaveBeenCalledTimes(1);
  });
});

describe('a failed poll loses nothing it did not learn', () => {
  it('keeps the incident it already knew about', async () => {
    // one lost packet in the middle of a real outage must not make the Events
    // card and the tooltip's incident list blink out of existence
    let answer = ok({ state: 'outage', incidents: [INCIDENT] });
    const { svc } = make({ probe: vi.fn(async () => answer) });
    svc.start();
    await vi.waitFor(() => expect(svc.current().incidents).toHaveLength(1));
    answer = ok({ state: 'unknown', reason: 'network', incidents: [] });
    await vi.advanceTimersByTimeAsync(MIN_POLL_MS + 10);
    await vi.waitFor(() => expect(svc.current().state).toBe('unknown'));
    expect(svc.current().incidents).toHaveLength(1);
    svc.stop();
  });

  it('does not move "checked at" for a check that never happened', async () => {
    let answer = ok({ checkedAt: '2026-08-11T09:00:00.000Z' });
    const { svc } = make({ probe: vi.fn(async () => answer) });
    svc.start();
    await vi.waitFor(() => expect(svc.current().checkedAt).toBe('2026-08-11T09:00:00.000Z'));
    answer = ok({ state: 'unknown', reason: 'network', checkedAt: '2026-08-11T17:00:00.000Z' });
    await vi.advanceTimersByTimeAsync(MIN_POLL_MS + 10);
    await vi.waitFor(() => expect(svc.current().state).toBe('unknown'));
    expect(svc.current().checkedAt).toBe('2026-08-11T09:00:00.000Z');
    svc.stop();
  });

  it('nor for a poll that was skipped because polling is off', async () => {
    const { svc } = make({ poll: false });
    svc.start();
    expect(svc.current().checkedAt).toBeUndefined();
    svc.stop();
  });

  it('pushes a fresh check time even when the verdict has not changed', async () => {
    // the tooltip's whole job is saying how fresh the dot is; a record that only
    // pushed on a change of verdict would leave it reading 09:12 all afternoon
    let answer = ok({ checkedAt: '2026-08-11T09:00:00.000Z' });
    const { svc, pushed } = make({ probe: vi.fn(async () => answer) });
    svc.start();
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    answer = ok({ checkedAt: '2026-08-11T09:05:00.000Z' });
    await vi.advanceTimersByTimeAsync(MIN_POLL_MS + 10);
    await vi.waitFor(() => expect(pushed.length).toBe(2));
    expect(pushed[1].checkedAt).toBe('2026-08-11T09:05:00.000Z');
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
