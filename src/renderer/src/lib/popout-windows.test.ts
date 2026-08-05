// @vitest-environment jsdom
// The one registry of open popout windows (#227).
//
// Three features used to keep their own list of the same windows, each filled
// by its own subscription to the same events: the keyboard dispatcher, the
// theme flags, the read-only notice. What this file holds is the contract they
// all now depend on — that "open" means one thing, that a re-announced window
// is still one window, and that a consumer which breaks costs only itself.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  addPopoutWindow,
  getPopoutWindows,
  openPopoutWindows,
  removePopoutWindow,
  resetPopoutWindows,
  subscribePopoutChange,
  subscribePopoutWindows,
  type TrackedPopout,
} from './popout-windows';

/** a stand-in popout: a distinct object, which is all identity here needs */
function fakePopout(): Window {
  return { document: document.implementation.createHTMLDocument('popout') } as unknown as Window;
}

// Windows AND listeners: a subscriber left behind by a failed assertion would
// go on firing — and one of these deliberately throws.
beforeEach(resetPopoutWindows);
afterEach(resetPopoutWindows);

describe('the popout registry (issue 227)', () => {
  it('holds what was opened, in the order it opened', () => {
    const first = fakePopout();
    const second = fakePopout();
    addPopoutWindow(first);
    addPopoutWindow(second);

    expect(openPopoutWindows()).toEqual([first, second]);
  });

  it('drops only the window that closed', () => {
    const first = fakePopout();
    const second = fakePopout();
    addPopoutWindow(first);
    addPopoutWindow(second);

    removePopoutWindow(first);

    expect(openPopoutWindows()).toEqual([second]);
  });

  it('counts a re-announced window ONCE', () => {
    // dockview reuses a named window when the same group is popped out again.
    // Two entries would be two read-only notices and two keydown handlers in
    // the same window — the de-duplication each consumer used to do for itself.
    const win = fakePopout();
    addPopoutWindow(win);
    const id = getPopoutWindows()[0].id;
    addPopoutWindow(win);

    expect(getPopoutWindows()).toHaveLength(1);
    expect(getPopoutWindows()[0].id).toBe(id); // and it is the SAME entry
  });

  it('never reuses a key, so a reopened window is not mistaken for the old one', () => {
    // React keys the notice by this. A window docked back and popped out again
    // is a NEW mount, and reusing the id would have React keep the dead
    // window's portal state for it.
    const win = fakePopout();
    addPopoutWindow(win);
    const first = getPopoutWindows()[0].id;
    removePopoutWindow(win);
    addPopoutWindow(win);

    expect(getPopoutWindows()[0].id).not.toBe(first);
  });

  it('ignores a missing window rather than tracking a hole', () => {
    addPopoutWindow(undefined as unknown as Window);
    removePopoutWindow(undefined as unknown as Window);
    expect(getPopoutWindows()).toEqual([]);
  });

  it('hands out a snapshot no consumer can rearrange under the others', () => {
    // `readonly` is compile-time only, and this array is shared by every
    // consumer AND used as useSyncExternalStore's identity
    addPopoutWindow(fakePopout());
    expect(() => (getPopoutWindows() as TrackedPopout[]).push({ id: 99, win: fakePopout() })).toThrow();
    expect(getPopoutWindows()).toHaveLength(1);
  });

  it('replaces the snapshot on a change and keeps it otherwise', () => {
    // `useSyncExternalStore` compares snapshots BY REFERENCE: a getter that
    // built a fresh array each call would re-render forever, and one that
    // mutated in place would never re-render at all.
    const empty = getPopoutWindows();
    const win = fakePopout();

    addPopoutWindow(win);
    const filled = getPopoutWindows();
    expect(filled).not.toBe(empty);
    expect(getPopoutWindows()).toBe(filled); // stable while nothing changes

    addPopoutWindow(win); // already known — not a change
    expect(getPopoutWindows()).toBe(filled);
    removePopoutWindow(fakePopout()); // never tracked — not a change either
    expect(getPopoutWindows()).toBe(filled);

    removePopoutWindow(win);
    expect(getPopoutWindows()).not.toBe(filled);
  });
});

describe('the popout registry: telling its consumers (issue 227)', () => {
  it('names the window both ways, and says a change happened', () => {
    const added = vi.fn();
    const removed = vi.fn();
    const changed = vi.fn();
    subscribePopoutWindows({ added, removed, changed });
    const win = fakePopout();

    addPopoutWindow(win);
    expect(added).toHaveBeenCalledWith(win);
    expect(changed).toHaveBeenCalledTimes(1);

    removePopoutWindow(win);
    expect(removed).toHaveBeenCalledWith(win);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('repeats the ANNOUNCEMENT for a re-announced window, but not the change', () => {
    // The one thing the three old lists did NOT dedupe: tab-rows re-copied the
    // theme on every announcement. A window dockview reuses is a fresh document
    // with no flags on it, so swallowing the repeat would leave it unthemed —
    // while a repeated `changed` would put a second notice in the same popout.
    const listener = { added: vi.fn(), changed: vi.fn() };
    const win = fakePopout();
    addPopoutWindow(win);
    subscribePopoutWindows(listener);

    addPopoutWindow(win); // dockview re-announcing the same window

    expect(listener.added).toHaveBeenCalledWith(win);
    expect(listener.changed).not.toHaveBeenCalled();
    expect(getPopoutWindows()).toHaveLength(1);
  });

  it('is silent about a window it never had', () => {
    const listener = { removed: vi.fn(), changed: vi.fn() };
    subscribePopoutWindows(listener);

    removePopoutWindow(fakePopout());

    expect(listener.removed).not.toHaveBeenCalled();
    expect(listener.changed).not.toHaveBeenCalled();
  });

  it('has the registry already updated when a consumer is told', () => {
    // the theme sync reads the registry from inside its own `added` handler; a
    // notify that ran first would hand it a list without the new window in it
    let seenOnAdd: Window[] = [];
    let seenOnRemove: Window[] = [];
    const win = fakePopout();
    subscribePopoutWindows({
      added: () => (seenOnAdd = openPopoutWindows()),
      removed: () => (seenOnRemove = openPopoutWindows()),
    });

    addPopoutWindow(win);
    removePopoutWindow(win);

    expect(seenOnAdd).toEqual([win]);
    expect(seenOnRemove).toEqual([]);
  });

  it('stops telling a consumer that unsubscribed', () => {
    const added = vi.fn();
    subscribePopoutWindows({ added })();
    addPopoutWindow(fakePopout());
    expect(added).not.toHaveBeenCalled();
  });

  it('reaches every consumer, and one that throws costs only itself', () => {
    // window.dispatchEvent gave us this for free; direct calls have to keep it,
    // or a broken feature deafens the popout's keyboard and hides its notice
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: Window[] = [];
    subscribePopoutWindows({
      added: () => {
        throw new Error('boom');
      },
    });
    subscribePopoutWindows({ added: (win) => seen.push(win) });
    const win = fakePopout();

    expect(() => addPopoutWindow(win)).not.toThrow();
    expect(seen).toEqual([win]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('does not tell a consumer that subscribed while the event was being delivered', () => {
    // the same guarantee DOM dispatch makes (it snapshots the listener list),
    // and what keeps a handler that opens something from re-entering forever
    const late = vi.fn();
    subscribePopoutWindows({
      added: () => subscribePopoutWindows({ added: late }),
    });

    addPopoutWindow(fakePopout());

    expect(late).not.toHaveBeenCalled();
  });

  it('survives a consumer that changes the registry while being told about it', () => {
    // fail-open in the shape it would actually arrive: a consumer reaches into
    // a popout, finds it dead, and drops it there and then. The nested notify
    // must finish and the outer loop must carry on with the rest.
    const doomed = fakePopout();
    const seen: string[] = [];
    subscribePopoutWindows({
      added: (win) => {
        seen.push('first-added');
        if (win === doomed) removePopoutWindow(win);
      },
      removed: () => seen.push('first-removed'),
    });
    subscribePopoutWindows({ added: () => seen.push('second-added') });

    addPopoutWindow(doomed);

    expect(seen).toEqual(['first-added', 'first-removed', 'second-added']);
    expect(getPopoutWindows()).toEqual([]);
  });

  it('gives useSyncExternalStore the plain subscribe it wants', () => {
    // one stable module-level function, or React resubscribes every commit
    expect(subscribePopoutChange).toBe(subscribePopoutChange);
    const onChange = vi.fn();
    const off = subscribePopoutChange(onChange);
    const win = fakePopout();

    addPopoutWindow(win);
    expect(onChange).toHaveBeenCalledTimes(1);
    off();
    removePopoutWindow(win);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
