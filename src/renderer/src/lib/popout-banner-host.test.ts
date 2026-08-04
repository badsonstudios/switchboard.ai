// @vitest-environment jsdom
// #208 — the plumbing that puts #168's read-only notice inside a popped-out
// window. Its look in a real popout is covered by e2e; what unit tests can hold
// is the contract this module makes with another document: exactly one host, in the right place,
// removed again afterwards, and never throwing at a window that has closed.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountBannerHost, onPopoutWindows, unmountBannerHost } from './popout-banner-host';

/** a stand-in popout: its own document, as a real popout has */
function fakePopout(): Window {
  const doc = document.implementation.createHTMLDocument('popout');
  // dockview's own container, positioned by inline style — the thing our CSS
  // has to make room for
  const dv = doc.createElement('div');
  dv.id = 'dv-popout-window';
  doc.body.appendChild(dv);
  return { document: doc } as unknown as Window;
}

describe('the read-only notice host in a popout (issue 208)', () => {
  it('goes in first, so the notice is the first thing in the window', () => {
    const win = fakePopout();
    const host = mountBannerHost(win);
    expect(host).not.toBeNull();
    expect(win.document.body.firstElementChild).toBe(host);
    // and dockview's container is still there, after it
    expect(win.document.body.lastElementChild?.id).toBe('dv-popout-window');
  });

  it('marks the body so the popout stylesheet makes room for it', () => {
    const win = fakePopout();
    mountBannerHost(win);
    expect(win.document.body.hasAttribute('data-sb-banner')).toBe(true);
  });

  it('is idempotent — the same window twice is still one notice', () => {
    const win = fakePopout();
    const first = mountBannerHost(win);
    const second = mountBannerHost(win);
    expect(second).toBe(first);
    expect(win.document.body.querySelectorAll('[data-sb-banner-host]')).toHaveLength(1);
  });

  it('leaves nothing behind when the notice goes away', () => {
    const win = fakePopout();
    mountBannerHost(win);
    unmountBannerHost(win);
    expect(win.document.body.querySelectorAll('[data-sb-banner-host]')).toHaveLength(0);
    expect(win.document.body.hasAttribute('data-sb-banner')).toBe(false);
    expect(win.document.body.firstElementChild?.id).toBe('dv-popout-window');
  });

  it('fails open at a window that has already closed', () => {
    // touching a closed window's document throws; a missing notice is bad, a
    // dead renderer is worse
    const dead = {
      get document(): Document {
        throw new Error('window closed');
      },
    } as unknown as Window;
    expect(mountBannerHost(dead)).toBeNull();
    expect(() => unmountBannerHost(dead)).not.toThrow();
  });

  it('fails open at a window that has no body yet', () => {
    const blank = { document: document.implementation.createDocument(null, null) } as unknown as Window;
    expect(mountBannerHost(blank)).toBeNull();
  });
});

describe('learning that a popout came or went (issue 208)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reports the window SessionGrid publishes, both ways', () => {
    const added = vi.fn();
    const removed = vi.fn();
    const off = onPopoutWindows({ added, removed });
    const win = fakePopout();

    window.dispatchEvent(new CustomEvent('switchboard:popout-added', { detail: win }));
    expect(added).toHaveBeenCalledWith(win);

    window.dispatchEvent(new CustomEvent('switchboard:popout-removed', { detail: win }));
    expect(removed).toHaveBeenCalledWith(win);
    off();
  });

  it('ignores an event with no window on it', () => {
    const added = vi.fn();
    const off = onPopoutWindows({ added, removed: vi.fn() });
    window.dispatchEvent(new CustomEvent('switchboard:popout-added', { detail: null }));
    expect(added).not.toHaveBeenCalled();
    off();
  });

  it('stops listening when told to', () => {
    const added = vi.fn();
    const removed = vi.fn();
    onPopoutWindows({ added, removed })();
    window.dispatchEvent(new CustomEvent('switchboard:popout-added', { detail: fakePopout() }));
    window.dispatchEvent(new CustomEvent('switchboard:popout-removed', { detail: fakePopout() }));
    expect(added).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
  });
});
