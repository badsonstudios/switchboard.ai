import { describe, it, expect, vi } from 'vitest';

const beeps = { count: 0 };
vi.mock('electron', () => ({
  shell: {
    beep: () => {
      beeps.count++;
    },
  },
}));

import { inQuietHours, shouldNotify, DEFAULT_PREFS, Notifier, NotificationPrefs } from './notifier';
import { FeedEvent } from './feed';

const at = (h: number, m = 0) => new Date(2026, 6, 19, h, m);
const ev = (kind: FeedEvent['kind']): FeedEvent => ({ id: 1, sessionId: 's', kind, at: '' });

describe('inQuietHours', () => {
  const prefs = { enabled: true, quietStart: '22:00', quietEnd: '08:00' };
  it('handles overnight windows', () => {
    expect(inQuietHours(prefs, at(23))).toBe(true);
    expect(inQuietHours(prefs, at(3))).toBe(true);
    expect(inQuietHours(prefs, at(12))).toBe(false);
    expect(inQuietHours(prefs, at(8, 0))).toBe(false); // end is exclusive
  });
  it('handles same-day windows', () => {
    const day = { enabled: true, quietStart: '12:00', quietEnd: '14:00' };
    expect(inQuietHours(day, at(13))).toBe(true);
    expect(inQuietHours(day, at(11))).toBe(false);
  });
  it('is off without both bounds or with garbage', () => {
    expect(inQuietHours(DEFAULT_PREFS, at(3))).toBe(false);
    expect(inQuietHours({ enabled: true, quietStart: 'xx', quietEnd: '08:00' }, at(3))).toBe(false);
  });
});

describe('shouldNotify', () => {
  it('gates on the toggle and quiet hours', () => {
    expect(shouldNotify({ enabled: false }, ev('done'), at(12))).toBe(false);
    expect(
      shouldNotify({ enabled: true, quietStart: '00:00', quietEnd: '23:59' }, ev('done'), at(12))
    ).toBe(false);
    expect(shouldNotify({ enabled: true }, ev('needs-permission'), at(12))).toBe(true);
    expect(shouldNotify({ enabled: true }, ev('crashed'), at(12))).toBe(true);
  });
});

// The MASTER SWITCH sits above the rules engine (P2-E14-03): a user who turned
// notifications off must not be reachable by a rule — otherwise the switch
// would be a lie the moment a rule existed.
//
// **Quiet hours no longer do (P2-E14-05b), and that is the item.** They used to
// return early right here, so between 22:00 and 07:00 the engine was never
// consulted at all — which silenced the WEBHOOK too, a channel that reaches a
// program rather than a sleeping human. The engine now sees every event and
// decides per action (`rules.ts` → `quietHolds`); what stays here is quiet
// hours' effect on the beep and the taskbar flash. The pair of tests below is
// the pin on that split: flip either and one of them fails.
describe('Notifier -> rules engine', () => {
  function notifier(prefs: NotificationPrefs, now = at(12)) {
    const handled: FeedEvent[] = [];
    const n = new Notifier({
      getWindow: () => null,
      getPrefs: () => prefs,
      rules: { handle: (e) => void handled.push(e) },
      now: () => now,
    });
    return { n, handled };
  }

  it('passes an attention event to the rules', () => {
    const { n, handled } = notifier({ enabled: true });
    n.handle(ev('done'));
    expect(handled.map((e) => e.kind)).toEqual(['done']);
  });

  it('consults no rule when notifications are off', () => {
    const { n, handled } = notifier({ enabled: false });
    n.handle(ev('crashed'));
    expect(handled).toEqual([]);
  });

  it('STILL consults the rules inside quiet hours — the engine decides per action', () => {
    const { n, handled } = notifier({ enabled: true, quietStart: '00:00', quietEnd: '23:59' });
    n.handle(ev('done'));
    expect(handled.map((e) => e.kind)).toEqual(['done']);
  });

  it('does not beep inside quiet hours — the local signal is aimed at a person', () => {
    beeps.count = 0;
    const { n, handled } = notifier({ enabled: true, quietStart: '00:00', quietEnd: '23:59' });
    n.handle(ev('done'));
    expect(beeps.count).toBe(0);
    // …and the engine still ran, which is the half that carries the webhook
    expect(handled).toHaveLength(1);
  });

  it('still beeps and still runs the rules — the two are independent channels', () => {
    beeps.count = 0;
    const { n, handled } = notifier({ enabled: true });
    n.handle(ev('needs-permission'));
    expect(beeps.count).toBe(1);
    expect(handled).toHaveLength(1);
  });
});

// One event, one noise (P2-E14-05a). With per-session cues on, the `sound` rule
// action fires on the same four events at every visibility — so if the beep
// below did not step aside, every attention event would make TWO sounds. This
// is the whole contract of a one-line guard, and it is invisible in every other
// test in the suite.
describe('the beep steps aside for per-session cues', () => {
  function notifier(prefs: NotificationPrefs) {
    const handled: FeedEvent[] = [];
    const n = new Notifier({
      getWindow: () => null,
      getPrefs: () => prefs,
      rules: { handle: (e) => void handled.push(e) },
    });
    return { n, handled };
  }

  it('beeps while cues are OFF — the shipped behaviour, unchanged', () => {
    beeps.count = 0;
    const { n } = notifier({ enabled: true });
    n.handle(ev('done'));
    expect(beeps.count).toBe(1);
  });

  it('does NOT beep while cues are on', () => {
    beeps.count = 0;
    const { n, handled } = notifier({ enabled: true, sounds: true });
    n.handle(ev('done'));
    expect(beeps.count).toBe(0);
    // …and the rules still run: the cue itself is one of them, so standing the
    // beep down without them would be silence rather than a better sound
    expect(handled).toHaveLength(1);
  });

  it('an explicit false is the same as off', () => {
    beeps.count = 0;
    const { n } = notifier({ enabled: true, sounds: false });
    n.handle(ev('crashed'));
    expect(beeps.count).toBe(1);
  });
});
