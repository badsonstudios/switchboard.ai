// The needs-you cue's one repeat (#1267): once, a minute before an approval's
// deadline; never for a question; never once the request has left.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NEEDS_YOU_REPEAT_LEAD_MS, NeedsYouReminder } from './needs-you-reminder';

const T0 = 1_000_000;
const FIVE_MIN = 300_000;

describe('NeedsYouReminder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(leadMs?: number) {
    const reminded: Array<[string, string]> = [];
    const r = new NeedsYouReminder({
      remind: (sessionId, requestId) => void reminded.push([sessionId, requestId]),
      ...(leadMs !== undefined ? { leadMs } : {}),
      now: () => Date.now(),
    });
    return { r, reminded };
  }

  it('the lead is the owner minute', () => {
    expect(NEEDS_YOU_REPEAT_LEAD_MS).toBe(60_000);
  });

  it('reminds ONCE, a minute before the deadline', () => {
    const { r, reminded } = make();
    r.requested({ requestId: 'q1', sessionId: 's1', deadline: T0 + FIVE_MIN });
    vi.advanceTimersByTime(FIVE_MIN - 60_000 - 1);
    expect(reminded).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reminded).toEqual([['s1', 'q1']]);
    vi.advanceTimersByTime(FIVE_MIN);
    expect(reminded).toHaveLength(1);
    expect(r.armed).toBe(0);
  });

  it('a question (no deadline) arms nothing', () => {
    const { r, reminded } = make();
    r.requested({ requestId: 'q1', sessionId: 's1' });
    expect(r.armed).toBe(0);
    vi.advanceTimersByTime(60 * 60_000);
    expect(reminded).toEqual([]);
  });

  it('answered or withdrawn first: no repeat', () => {
    const { r, reminded } = make();
    r.requested({ requestId: 'q1', sessionId: 's1', deadline: T0 + FIVE_MIN });
    r.requested({ requestId: 'q2', sessionId: 's2', deadline: T0 + FIVE_MIN });
    vi.advanceTimersByTime(60_000);
    r.resolved('q1');
    vi.advanceTimersByTime(FIVE_MIN);
    expect(reminded).toEqual([['s2', 'q2']]);
  });

  it('a hold shorter than the lead gets no repeat, not an immediate one', () => {
    const { r, reminded } = make();
    r.requested({ requestId: 'q1', sessionId: 's1', deadline: T0 + 30_000 });
    expect(r.armed).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(reminded).toEqual([]);
  });

  it('a replayed request is armed once', () => {
    const { r, reminded } = make();
    const req = { requestId: 'q1', sessionId: 's1', deadline: T0 + FIVE_MIN };
    r.requested(req);
    r.requested({ ...req });
    vi.advanceTimersByTime(FIVE_MIN);
    expect(reminded).toHaveLength(1);
  });

  it('the lead can be moved (the e2e seam)', () => {
    const { r, reminded } = make(FIVE_MIN - 2_000);
    r.requested({ requestId: 'q1', sessionId: 's1', deadline: T0 + FIVE_MIN });
    vi.advanceTimersByTime(2_000);
    expect(reminded).toEqual([['s1', 'q1']]);
  });

  it('a remind that throws costs nothing else (P6)', () => {
    const r = new NeedsYouReminder({
      remind: () => {
        throw new Error('boom');
      },
      now: () => Date.now(),
    });
    r.requested({ requestId: 'q1', sessionId: 's1', deadline: T0 + FIVE_MIN });
    expect(() => vi.advanceTimersByTime(FIVE_MIN)).not.toThrow();
  });

  it('dispose disarms everything', () => {
    const { r, reminded } = make();
    r.requested({ requestId: 'q1', sessionId: 's1', deadline: T0 + FIVE_MIN });
    r.dispose();
    vi.advanceTimersByTime(FIVE_MIN);
    expect(reminded).toEqual([]);
  });
});
