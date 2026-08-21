// The collapsed tab's badge (P2-E14-01). Shape B's whole bet is that a slim
// tab can stand in for a 220px column, and the badge is what makes that true or
// a lie — so every rule it derives is pinned here rather than guessed at from
// an e2e screenshot.
import { describe, it, expect } from 'vitest';
import { badgeState, liveNotices } from './events-drawer';
import type { AttentionEvent } from './queue';

const at = (min: number): string => `2026-08-13T10:${String(min).padStart(2, '0')}:00.000Z`;
const ev = (id: number, kind: AttentionEvent['kind'], min = id): AttentionEvent => ({
  id,
  sessionId: `s-${id}`,
  kind,
  at: at(min),
});

describe('the badge counts what the hotkey would walk', () => {
  it('is empty and untinted when nothing is waiting', () => {
    expect(badgeState([], {})).toEqual({ count: 0, hottest: null, notices: 0 });
  });

  it('counts one per waiting session', () => {
    const badge = badgeState([ev(1, 'needs-input'), ev(2, 'crashed'), ev(3, 'done')], {});
    expect(badge.count).toBe(3);
  });

  // The reason the badge takes the QUEUE's list and not the feed's: `ready` is
  // reviewed work, which the panel still lists (the feed is the log) and the
  // queue does not (§5.12). A tab that counted it would send you to the drawer
  // to find nothing to do.
  it('does not count reviewed work', () => {
    expect(badgeState([ev(1, 'ready'), ev(2, 'ready')], {}).count).toBe(0);
    expect(badgeState([ev(1, 'ready'), ev(2, 'done')], {}).count).toBe(1);
  });
});

describe('the tint is the hottest thing waiting', () => {
  // The one rule that makes the tint worth having: with three sessions parked,
  // the tab is the colour of the WORST of them, not of whichever arrived last.
  it('takes the queue head, not the newest arrival', () => {
    const events = [
      ev(1, 'done', 1), // oldest, lowest priority
      ev(2, 'needs-permission', 2), // the hottest
      ev(3, 'needs-input', 3), // newest
    ];
    expect(badgeState(events, {}).hottest).toBe('needs-permission');
  });

  // Arrival order must not be able to change the answer — this is the whole
  // reason `badgeState` re-derives the order instead of trusting its input.
  it('is the same whatever order the events arrive in', () => {
    const events = [ev(1, 'done'), ev(2, 'needs-permission'), ev(3, 'crashed')];
    const reversed = [...events].reverse();
    expect(badgeState(reversed, {}).hottest).toBe(badgeState(events, {}).hottest);
    expect(badgeState(reversed, {}).hottest).toBe('needs-permission');
  });

  it('follows the priority ladder all the way down', () => {
    expect(badgeState([ev(1, 'needs-input'), ev(2, 'crashed')], {}).hottest).toBe('needs-input');
    expect(badgeState([ev(1, 'crashed'), ev(2, 'done')], {}).hottest).toBe('crashed');
    expect(badgeState([ev(1, 'done')], {}).hottest).toBe('done');
  });

  it('has no tint when the only events are reviewed', () => {
    expect(badgeState([ev(1, 'ready')], {}).hottest).toBeNull();
  });
});

describe('the notice marker speaks for all three tenants', () => {
  // The #425 coordination note: the update notice, the reconnect offer and the
  // incidents card share one slot and rehomed into this drawer together. Behind
  // a collapsed tab all three are invisible, so all three have to raise the
  // marker — a marker that only one of them could raise would make the other
  // two silently disappear, which is what "rehome them, don't orphan them" was
  // guarding against.
  it('is raised by the update notice', () => {
    expect(liveNotices({ updateNotice: { kind: 'available', version: '0.6.0' } })).toBe(1);
  });

  it('is raised by the reconnect offer', () => {
    expect(liveNotices({ reconnectOffer: true })).toBe(1);
  });

  it('is raised by an open incident', () => {
    expect(liveNotices({ incidents: [{ id: 'i1' }] })).toBe(1);
  });

  it('is raised by a history repair (#539)', () => {
    expect(liveNotices({ historyRepairs: [{ id: 'r1' }] })).toBe(1);
  });

  it('counts them, so the accessible name can say how many', () => {
    expect(
      liveNotices({
        updateNotice: { kind: 'installed', version: '0.6.0' },
        reconnectOffer: true,
        incidents: [{ id: 'i1' }, { id: 'i2' }],
        historyRepairs: [{ id: 'r1' }, { id: 'r2' }],
      })
    ).toBe(4); // four TENANTS, not six notices — a slot's rows are one card
  });

  it('stays down for the empty shapes each tenant actually sends', () => {
    // every one of these is a real value from App: a null notice, a false
    // offer, and the empty array `serviceHealth.incidents` is when all is well
    expect(liveNotices({})).toBe(0);
    expect(
      liveNotices({ updateNotice: null, reconnectOffer: false, incidents: [], historyRepairs: [] })
    ).toBe(0);
  });

  it('is independent of the queue — a notice with an empty queue still marks', () => {
    const badge = badgeState([], { reconnectOffer: true });
    expect(badge.count).toBe(0);
    expect(badge.notices).toBe(1);
  });
});
