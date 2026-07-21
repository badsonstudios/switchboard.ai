import { describe, it, expect } from 'vitest';
import { sanitizePopoutLayout, boxOnAnyDisplay } from './layout';

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 1920, height: 1040 };

describe('boxOnAnyDisplay', () => {
  it('true when a corner is visible, false when fully off-screen', () => {
    expect(boxOnAnyDisplay({ left: 100, top: 100, width: 800, height: 600 }, [primary])).toBe(true);
    expect(boxOnAnyDisplay({ left: 2200, top: 100, width: 800, height: 600 }, [primary])).toBe(false);
    expect(boxOnAnyDisplay({ left: 2200, top: 100, width: 800, height: 600 }, [primary, second])).toBe(true);
  });
});

describe('sanitizePopoutLayout', () => {
  const origin = 'http://127.0.0.1:55555';

  it('rewrites popout urls to the current origin (port changes each launch)', () => {
    const layout = {
      popoutGroups: [{ url: 'http://127.0.0.1:40000/popout.html', position: { left: 100, top: 100, width: 800, height: 600 } }],
    };
    const out = sanitizePopoutLayout(layout, origin, [primary]) as typeof layout;
    expect(out.popoutGroups[0].url).toBe('http://127.0.0.1:55555/popout.html');
  });

  it('rescues an off-display popout position to null', () => {
    const layout = {
      popoutGroups: [{ url: 'x', position: { left: 3000, top: 100, width: 800, height: 600 } }],
    };
    // second monitor gone -> position rescued
    const out = sanitizePopoutLayout(layout, origin, [primary]) as typeof layout;
    expect(out.popoutGroups[0].position).toBeNull();
  });

  it('keeps an on-display popout position', () => {
    const layout = {
      popoutGroups: [{ url: 'x', position: { left: 2100, top: 100, width: 800, height: 600 } }],
    };
    const out = sanitizePopoutLayout(layout, origin, [primary, second]) as typeof layout;
    expect(out.popoutGroups[0].position).toEqual({ left: 2100, top: 100, width: 800, height: 600 });
  });

  it('no-ops on layouts without popouts / on garbage', () => {
    expect(sanitizePopoutLayout({ panels: {} }, origin, [primary])).toEqual({ panels: {} });
    expect(sanitizePopoutLayout(null, origin, [primary])).toBeNull();
  });
});
