// @vitest-environment jsdom
// The DOM half of #581, and the one property that is the whole reason there are
// TWO regions rather than one.
//
// A live region announces on MUTATION. Writing the same string into the same
// region twice mutates nothing the second time, so it is read out once — and the
// same sentence twice in a row is not a corner case for these chords, it is the
// end of every list. `Mod+Alt+ArrowUp` held on the top row says "is still 1 of 5"
// every press; `Mod+Shift+ArrowDown` on a hidden card says "is already hidden"
// every press. A user who hears it once cannot tell that from a dead keybinding.
//
// These cases fail if the double-buffer is ever "simplified" back to one div.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { LiveRegion } from './LiveRegion';
import { announce, resetAnnouncementsForTest } from '../lib/live-region';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  resetAnnouncementsForTest();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    // UNDER STRICTMODE, because the app is (`main.tsx`) and the sibling region
    // tests are. It double-invokes effects and mount/unmount, which is where a
    // component holding a QUEUE can misbehave in ways a single pass never shows:
    // a subscription taken twice, or a drain that runs on a stale snapshot.
    root!.render(
      <React.StrictMode>
        <LiveRegion />
      </React.StrictMode>
    );
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
});

/** both regions, in document order */
const regions = (): HTMLElement[] =>
  Array.from(host.querySelectorAll<HTMLElement>('[role="status"]'));

/** what each region currently holds */
const texts = (): string[] => regions().map((r) => r.textContent ?? '');

const say = async (text: string): Promise<void> => {
  await act(async () => announce(text));
};

describe('the global live region', () => {
  it('is present from the first frame and empty', () => {
    // one INSERTED already holding its text is announced by almost nothing
    // (#222, #253, and the events drawer learned it the expensive way) — so the
    // region has to pre-date the words it will carry
    expect(regions()).toHaveLength(2);
    expect(texts()).toEqual(['', '']);
  });

  it('is polite on both regions — the user asked for this', () => {
    // assertive would interrupt whatever a screen reader is reading; every one of
    // these announcements answers a key the user just pressed on purpose
    for (const r of regions()) expect(r.getAttribute('aria-live')).toBe('polite');
  });

  it('is invisible rather than absent', () => {
    // display:none and visibility:hidden both take an element OUT of the
    // accessibility tree, which would make this an elaborate way to say nothing
    for (const r of regions()) {
      expect(r.style.display).not.toBe('none');
      expect(r.style.visibility).not.toBe('hidden');
      expect(r.style.clipPath).toBe('inset(50%)');
      // without nowrap a 1px box wraps to one character per line, and some
      // readers then spell it out letter by letter
      expect(r.style.whiteSpace).toBe('nowrap');
    }
  });

  it('holds one announcement in one region, leaving the other empty', async () => {
    await say('switchboard pinned');
    expect(texts()).toEqual(['switchboard pinned', '']);
  });

  it('ALTERNATES, so the same sentence twice is two mutations', async () => {
    await say('switchboard is still 1 of 5 in Projects');
    expect(texts()).toEqual(['switchboard is still 1 of 5 in Projects', '']);

    await say('switchboard is still 1 of 5 in Projects');
    // the FIRST region is now empty and the second holds it: an empty -> text
    // change in a region that was empty, which is what gets announced
    expect(texts()).toEqual(['', 'switchboard is still 1 of 5 in Projects']);

    await say('switchboard is still 1 of 5 in Projects');
    expect(texts()).toEqual(['switchboard is still 1 of 5 in Projects', '']);
  });

  it('never leaves two sentences readable at once', async () => {
    // both regions holding text would be read as one run-on utterance, and the
    // stale half would be the louder lie
    for (const s of ['a', 'b', 'c', 'd', 'e']) {
      await say(s);
      expect(texts().filter((x) => x !== '')).toEqual([s]);
    }
  });

  it('settles on the NEWEST sentence, with the other region cleared', async () => {
    // Deliberately named for what it checks. It is NOT the proof that nothing was
    // dropped — a queue-less implementation using a functional updater reaches this
    // same end state while never putting 'first' in the DOM at all. The next test
    // is the one that can tell those apart; this one pins the resting state.
    await act(async () => {
      announce('first');
      announce('second');
    });
    await act(async () => {}); // the queue drains across commits
    expect(texts()).toEqual(['', 'second']);
  });

  it('shows each queued sentence on its own, in order', async () => {
    // the observable proof of the above: watch the region across the flush rather
    // than only reading the end state, which any dropping implementation also
    // reaches
    // The RECORDS, not the live DOM: a MutationObserver callback is a microtask
    // and arrives after React has already drained every commit, so reading the
    // current text would only ever see the last one. The records are the history,
    // and the history is what a screen reader was handed.
    const seen: string[] = [];
    const watch = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of Array.from(r.addedNodes)) {
          const text = (n.textContent ?? '').trim();
          if (text) seen.push(text);
        }
        if (r.type === 'characterData') {
          const text = (r.target.textContent ?? '').trim();
          if (text) seen.push(text);
        }
      }
    });
    for (const r of regions()) {
      watch.observe(r, { childList: true, characterData: true, subtree: true });
    }

    await act(async () => {
      announce('alpha pinned');
      announce('bravo pinned');
      announce('charlie pinned');
    });
    await act(async () => {});
    await act(async () => {});
    watch.disconnect();

    // every one of them was in the DOM at some point, in the order announced —
    // which is the whole claim: a dropping implementation reaches the same END
    // state and fails right here
    expect(seen).toEqual(['alpha pinned', 'bravo pinned', 'charlie pinned']);
  });

  it('stops listening when it unmounts', async () => {
    // an announcer whose listeners outlive their regions leaks one per popout
    // open/close cycle. The observable claim is that the detached nodes never
    // receive the text — `not.toThrow()` alone would pass even with the
    // unsubscribe removed, since `announce` catches per subscriber and React no
    // longer warns about setState after unmount.
    const detached = regions();
    expect(detached).toHaveLength(2);

    await act(async () => root?.unmount());
    root = null;

    await act(async () => announce('after the window closed'));
    await act(async () => {});
    expect(detached.map((r) => r.textContent ?? '')).toEqual(['', '']);
  });
});
