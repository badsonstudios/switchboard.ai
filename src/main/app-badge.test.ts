// #1605: the count on the app icon. What is accepted from the window, and what
// each platform is asked to do with it.
import { describe, expect, it } from 'vitest';
import { applyBadge, parseBadgeRequest, type BadgeHost } from './app-badge';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function host(platform: NodeJS.Platform, opts: { window?: boolean; empty?: boolean } = {}) {
  const calls: Array<[string, unknown, unknown?]> = [];
  const h: BadgeHost = {
    platform,
    window: () =>
      opts.window === false
        ? null
        : {
            setOverlayIcon: (img, d) => calls.push(['overlay', img, d]),
            isDestroyed: () => false,
          },
    image: (url) => ({ isEmpty: () => !!opts.empty, url }) as { isEmpty(): boolean },
    setBadgeCount: (n) => {
      calls.push(['badge', n]);
      return true;
    },
  };
  return { h, calls };
}

describe('parseBadgeRequest: renderer input is untrusted (#1605)', () => {
  it('takes a count, a PNG and words', () => {
    expect(parseBadgeRequest({ count: 3, png: PNG, label: '3 need you' })).toEqual({
      ok: true,
      req: { count: 3, png: PNG, label: '3 need you' },
    });
    expect(parseBadgeRequest({ count: 0 })).toEqual({ ok: true, req: { count: 0 } });
  });
  it.each([
    ['nothing', undefined],
    ['a negative count', { count: -1 }],
    ['a fraction', { count: 1.5 }],
    ['a string count', { count: '3' }],
    ['a huge count', { count: 1e6 }],
    ['a picture that is not a PNG data URL', { count: 1, png: 'file:///C:/x.png' }],
    ['an oversized picture', { count: 1, png: PNG + 'A'.repeat(70000) }],
    ['a label that is not a string', { count: 1, label: 5 }],
  ])('refuses %s', (_why, raw) => {
    expect(parseBadgeRequest(raw).ok).toBe(false);
  });
});

describe('applyBadge', () => {
  it('Windows: the overlay with its words; 0 clears it', () => {
    const { h, calls } = host('win32');
    expect(applyBadge(h, { count: 2, png: PNG, label: '2 need you' })).toBe('overlay');
    expect(calls[0][0]).toBe('overlay');
    expect(calls[0][2]).toBe('2 need you');
    expect(applyBadge(h, { count: 0 })).toBe('cleared');
    expect(calls[1]).toEqual(['overlay', null, '']);
  });
  it('Windows: no window, or a picture that does not decode, changes nothing', () => {
    expect(applyBadge(host('win32', { window: false }).h, { count: 1, png: PNG })).toBe('no-window');
    const bad = host('win32', { empty: true });
    expect(applyBadge(bad.h, { count: 1, png: PNG })).toBe('no-picture');
    expect(bad.calls).toEqual([]);
  });
  it('macOS and Linux: the app badge count', () => {
    const mac = host('darwin');
    expect(applyBadge(mac.h, { count: 4 })).toBe('badge');
    expect(applyBadge(mac.h, { count: 0 })).toBe('cleared');
    expect(mac.calls).toEqual([
      ['badge', 4],
      ['badge', 0],
    ]);
  });
});
