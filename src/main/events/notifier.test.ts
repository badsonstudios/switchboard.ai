import { describe, it, expect } from 'vitest';
import { inQuietHours, shouldNotify, DEFAULT_PREFS } from './notifier';
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
