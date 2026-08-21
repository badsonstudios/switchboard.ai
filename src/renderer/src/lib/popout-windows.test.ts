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
  LIVENESS_SWEEP_MS,
  openPopoutWindows,
  removePopoutWindow,
  resetPopoutWindows,
  subscribePopoutChange,
  subscribePopoutWindows,
  type TrackedPopout,
} from './popout-windows';

/**
 * A stand-in popout: a distinct object, which is all identity here needs, plus
 * the one property the registry asks it about. `closed` starts false the way a
 * real freshly-opened window's does; a test kills one by setting it, which is
 * exactly what the OS taking a window looks like from in here (#279).
 */
function fakePopout(): Window & { closed: boolean } {
  return {
    closed: false,
    document: document.implementation.createHTMLDocument('popout'),
  } as unknown as Window & { closed: boolean };
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

describe('the popout registry: windows that die without saying so (issue 279)', () => {
  // dockview only reports what dockview DID. A window the OS takes never
  // produces a remove event, so the registry has to ask the windows themselves
  // — and the entries it drops have to look, to every consumer, exactly like an
  // ordinary close, because that is what happened.
  afterEach(() => {
    resetPopoutWindows();
    vi.useRealTimers();
  });

  it('drops a window found closed, and says so exactly as a normal close does', () => {
    const removed = vi.fn();
    const changed = vi.fn();
    const dead = fakePopout();
    const alive = fakePopout();
    addPopoutWindow(dead);
    addPopoutWindow(alive);
    subscribePopoutWindows({ removed, changed });

    dead.closed = true; // the OS took it; dockview never hears, so nor do we...
    addPopoutWindow(fakePopout()); // ...until something walks the list

    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith(dead);
    expect(changed).toHaveBeenCalledTimes(2); // the burial, then the new window
    expect(openPopoutWindows()).not.toContain(dead);
    expect(openPopoutWindows()).toContain(alive);
  });

  it('buries every window that died, not just the first', () => {
    const first = fakePopout();
    const second = fakePopout();
    const survivor = fakePopout();
    addPopoutWindow(first);
    addPopoutWindow(second);
    addPopoutWindow(survivor);
    // Typed to the listener's real signature, not a bare `vi.fn()`: the
    // assertion below reads `.mock.calls`, and an untyped mock records `any[]`
    // — `toEqual([first, second])` would then compile against whatever the
    // sweep actually announced (#255 T4).
    const removed = vi.fn<(win: Window) => void>();
    subscribePopoutWindows({ removed });

    first.closed = true;
    second.closed = true;
    removePopoutWindow(fakePopout()); // dockview reporting some other close

    expect(removed.mock.calls.map((call) => call[0])).toEqual([first, second]);
    expect(openPopoutWindows()).toEqual([survivor]);
  });

  it('has the window out of the registry before it tells anyone', () => {
    // the contract the ordinary removal keeps, and the reason it exists: the
    // theme sync re-reads the list from inside its own handler, and must not be
    // handed the corpse
    const dead = fakePopout();
    addPopoutWindow(dead);
    let seen: Window[] | undefined;
    subscribePopoutWindows({ removed: () => (seen = openPopoutWindows()) });

    dead.closed = true;
    removePopoutWindow(fakePopout()); // dockview reporting some other close

    expect(seen).toEqual([]); // told, and told AFTER the list was corrected —
    expect(seen).toBeDefined(); // ...which an empty array alone would not prove
  });

  it('replaces the group of a window that died before it was popped out again', () => {
    // the sequence this exists for: the OS takes the popout, dockview never
    // says so, and the user's answer is to pop the same group out again — which
    // opens a NEW window. Both registered would mean two read-only notices, one
    // of them keyed to a document nobody can see.
    const dead = fakePopout();
    addPopoutWindow(dead);

    dead.closed = true;
    const replacement = fakePopout();
    addPopoutWindow(replacement);

    expect(openPopoutWindows()).toEqual([replacement]);
  });

  it('keeps a window dockview RE-ANNOUNCES — a repeat is not a death certificate', () => {
    // dockview reuses a named window, and #227's contract for that repeat is
    // exact: same entry, same id, `added` again (the reused document needs the
    // theme re-copied), no `changed`. The sweep runs on that path now and must
    // leave every part of it alone.
    const win = fakePopout();
    addPopoutWindow(win);
    const id = getPopoutWindows()[0].id;
    const listener = { added: vi.fn(), removed: vi.fn(), changed: vi.fn() };
    subscribePopoutWindows(listener);

    addPopoutWindow(win);

    expect(getPopoutWindows()).toHaveLength(1);
    expect(getPopoutWindows()[0].id).toBe(id);
    expect(listener.added).toHaveBeenCalledWith(win);
    expect(listener.removed).not.toHaveBeenCalled();
    expect(listener.changed).not.toHaveBeenCalled();
  });

  it('keeps a window it cannot ask about', () => {
    // evicting a LIVE popout costs it its keyboard and its theme; keeping a
    // dead one costs an object. Only a window that says so in as many words goes.
    const unreachable = {
      get closed(): boolean {
        throw new Error('detached');
      },
    } as unknown as Window;
    addPopoutWindow(unreachable);
    const removed = vi.fn();
    subscribePopoutWindows({ removed });

    addPopoutWindow(fakePopout()); // walks the list, asks, is refused an answer

    expect(removed).not.toHaveBeenCalled();
    // through a boolean on purpose: a matcher handed this object would inspect
    // it, and being inspected is the very thing that throws
    expect(openPopoutWindows().includes(unreachable)).toBe(true);
  });

  it('notices on its own, without waiting for the next popout', () => {
    // the announcements are the cheap moments, but a user who kills their only
    // popout and opens no other would never reach one
    vi.useFakeTimers();
    const dead = fakePopout();
    addPopoutWindow(dead);
    const removed = vi.fn();
    subscribePopoutWindows({ removed });

    dead.closed = true;
    vi.advanceTimersByTime(LIVENESS_SWEEP_MS);

    expect(removed).toHaveBeenCalledWith(dead);
    expect(getPopoutWindows()).toEqual([]);
  });

  it('leaves the snapshot alone while every window is still open', () => {
    // a sweep that found nothing must not be a re-render: useSyncExternalStore
    // compares snapshots by reference, and this one ticks forever
    vi.useFakeTimers();
    addPopoutWindow(fakePopout());
    const snapshot = getPopoutWindows();
    const changed = vi.fn();
    subscribePopoutChange(changed);

    vi.advanceTimersByTime(LIVENESS_SWEEP_MS * 20);

    expect(getPopoutWindows()).toBe(snapshot);
    expect(changed).not.toHaveBeenCalled();
  });

  it('runs no timer with nothing to sweep', () => {
    // a wakeup asked of the OS on behalf of nobody — and most of a session has
    // no popout open at all
    vi.useFakeTimers();
    expect(vi.getTimerCount()).toBe(0);
    const first = fakePopout();
    const second = fakePopout();

    addPopoutWindow(first);
    expect(vi.getTimerCount()).toBe(1);
    addPopoutWindow(second);
    expect(vi.getTimerCount()).toBe(1); // a second popout is not a second timer

    removePopoutWindow(first);
    expect(vi.getTimerCount()).toBe(1); // one still open
    removePopoutWindow(second);
    expect(vi.getTimerCount()).toBe(0);

    addPopoutWindow(first); // and it comes back for the next one
    expect(vi.getTimerCount()).toBe(1);
    resetPopoutWindows();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('announces a dead window once, even when its remove event arrives too', () => {
    // the window closed AND dockview noticed: the sweep gets there first (it
    // runs before the removal), and the removal is then the no-op it already is
    // for a window the registry does not have
    const win = fakePopout();
    addPopoutWindow(win);
    const removed = vi.fn();
    subscribePopoutWindows({ removed });

    win.closed = true;
    removePopoutWindow(win);

    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith(win);
    expect(getPopoutWindows()).toEqual([]);
  });
});
