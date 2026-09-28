// @vitest-environment jsdom
// #967 — the feed's bookkeeping around the tail pin, in the component.
//
// ⚠️ WHY THIS EXISTS SEPARATELY FROM `lib/feed-pin.test.ts`, and it is a gap review
// found rather than one I planned for. That file tests the RULE, which is pure and
// has eighteen cases. It cannot test the two refs the rule depends on, and every
// bug review found in this change lived in exactly those refs:
//
//   * `knownTop` — where the scroller physically is. Read to compute `delta`, so a
//     path that moves the scroller without recording it makes the NEXT event look
//     like the user, which unpins.
//   * `lastTop` — the user's READING POSITION, which #555 and #562 restore them to.
//     Written only from something the user did. The two were briefly one ref, and
//     sharing them let a layout scroll or a clamp overwrite the reading position
//     with somewhere nobody chose.
//
// jsdom does no layout, so `scrollTop`, `scrollHeight` and `clientHeight` are all
// supplied — the `FeedView.find.test.tsx` pattern, one file over. That is a real
// limit and worth stating: this file proves the BOOKKEEPING, the e2e proves the
// behaviour on a real scroller, and neither substitutes for the other.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { registerBuiltinContributions } from '../bootstrap';
import { rendererRegistry } from '../extensibility/registry-instance';
import type { PanelContext } from '../extensibility/contributions';
import type { FeedBlockDto } from '../lib/feed';
import { TAIL_SLACK } from '../lib/feed-pin';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** enough blocks that the conversation is longer than the pane */
const BLOCKS: FeedBlockDto[] = Array.from({ length: 12 }, (_, i) => ({
  seq: i + 1,
  kind: 'assistant',
  text: `block ${i + 1}`,
  sidechain: false,
}));

function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve(BLOCKS),
      onBlock: () => () => {},
      onReset: () => () => {},
    },
    sessions: { slashCommands: () => Promise.resolve([]) },
    workspace: { getUi: () => Promise.resolve({}), setUi: () => {} },
  };
}

function ctx(): PanelContext {
  return {
    sessionId: 'live-1',
    cardId: 'card-1',
    title: 'demo',
    visible: true,
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    controlsLock: null,
    setView: () => {},
  };
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;
const roots: Root[] = [];

/** The scroller, with a geometry jsdom will not give us. */
interface Scroller {
  el: HTMLElement;
  /** what our own writes landed on, in order — the pin's own footprints */
  writes: number[];
  setTop: (v: number) => void;
  scrollTo: (v: number) => Promise<void>;
  top: () => number;
}

async function mountFeed(): Promise<{ host: HTMLElement; s: Scroller }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(feedPanel.render(ctx()));
  });
  await act(async () => {
    await Promise.resolve();
  });
  const el = host.querySelector<HTMLElement>('[data-feed-region]')!;
  let top = 0;
  const writes: number[] = [];
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      // The browser clamps, and the clamp is load-bearing here: `pin()` writes
      // `scrollHeight` and reads back the clamped value to record it.
      top = Math.min(Math.max(0, v), 2_000 - 300);
      writes.push(top);
    },
  });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 2_000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 300 });
  return {
    host,
    s: {
      el,
      writes,
      setTop: (v: number) => {
        top = v;
      },
      scrollTo: async (v: number) => {
        top = v;
        await act(async () => {
          el.dispatchEvent(new Event('scroll'));
        });
      },
      top: () => top,
    },
  };
}

/**
 * Let animation frames land.
 *
 * ⚠️ NOT OPTIONAL, and the reason is `autoPin`: `pin()` sets it and clears it in a
 * `requestAnimationFrame`, so until a frame has actually run, every scroll event is
 * read as OUR OWN and the reconcile branch never gets a chance. Without this the
 * whole file passed vacuously — zero writes, because nothing ever left the `auto`
 * branch.
 */
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
};

/** a wheel on the scroller, which is what opens the gesture window */
const wheel = async (s: Scroller): Promise<void> => {
  await act(async () => {
    s.el.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
  });
};

/**
 * Get to the state the app is actually ever in: ON THE TAIL, pinned.
 *
 * ⚠️ WITHOUT THIS THE TESTS BELOW START SOMEWHERE THE APP CANNOT BE. jsdom does no
 * layout, so the mount pin lands on a `scrollTop` of 0 — i.e. "pinned, and 1,300px
 * from the tail", which in the real app is unreachable: getting away from the tail
 * requires a gesture, and that gesture unpins. Starting there made a later scroll to
 * 400 read as movement DOWN (0 → 400) when the test meant it as scrolling up and
 * away, and the rule correctly refused to unpin.
 *
 * So: put it on the tail and let the frame land, then gestures from there mean what
 * they look like.
 */
const onTheTail = async (s: Scroller): Promise<void> => {
  await s.scrollTo(1_700);
  await settle();
  s.writes.length = 0;
};

/** a CLICK in the conversation — `onPointerDown`, the #967 trigger */
const clickInFeed = async (s: Scroller): Promise<void> => {
  await act(async () => {
    s.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
};

beforeAll(async () => {
  registerBuiltinContributions(rendererRegistry);
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  stubBridge();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
});

afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
  vi.unstubAllGlobals();
});

describe('#967 — the pin survives a click in the conversation', () => {
  it('follows the tail after a click, not away from it', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);

    // A click, then a scroll event that the CONTENT caused — `scrollTop` unchanged.
    // This is the owner's case, and the old rule unpinned here.
    await clickInFeed(s);
    await act(async () => {
      s.el.dispatchEvent(new Event('scroll'));
    });

    // it put itself back on the tail rather than treating the click as a scroll
    expect(s.writes.length).toBeGreaterThan(0);
    expect(s.writes[s.writes.length - 1]).toBe(1_700);
  });
});

describe('#555 / #562 — the reading position is only ever the user`s own', () => {
  it('saves a position the user scrolled to', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    // a real gesture, then the scroll it caused — UP and away from the tail
    await wheel(s);
    await s.scrollTo(400);
    // unpinned (400 is nowhere near the tail) and the position is theirs; the only
    // observable proof from here is that nothing pinned them back
    expect(s.writes).toEqual([]);
    expect(s.top()).toBe(400);
  });

  it('does NOT let a layout scroll overwrite it', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    // the user parks, deliberately, by scrolling up
    await wheel(s);
    await s.scrollTo(400);
    await settle();
    s.writes.length = 0;

    // …and then something that is not the user moves the scroller: a reflow, a
    // clamp, dockview detaching and reattaching the panel. No gesture behind it.
    // Before the split this wrote the reading position, and a clamp to 0 also
    // disabled the #555 recovery permanently (it keys off `lastTop > 0`).
    await s.scrollTo(0);

    // an unpinned feed is left where it is — nothing pinned it, nothing restored it
    expect(s.writes).toEqual([]);
  });

  it('does not re-pin an unpinned feed just because content arrived', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await wheel(s);
    await s.scrollTo(400);
    await settle();
    s.writes.length = 0;
    // content grows under a stationary viewport: `scrollTop` unchanged
    await act(async () => {
      s.el.dispatchEvent(new Event('scroll'));
    });
    expect(s.writes).toEqual([]);
    expect(s.top()).toBe(400);
  });
});

describe('#442 — the slack is one number', () => {
  it('re-pins a feed the user scrolled back to the bottom', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await wheel(s);
    await s.scrollTo(400); // up and away: unpin
    await settle();
    s.writes.length = 0;
    await wheel(s);
    // 1700 is the clamped tail; land inside the slack of it
    await s.scrollTo(1_700 - (TAIL_SLACK - 1));
    await settle();
    // pinned again, so the next content arrival follows — proved by the pin the
    // reconcile issues on the next scroll with `scrollTop` unchanged
    await act(async () => {
      s.el.dispatchEvent(new Event('scroll'));
    });
    expect(s.writes[s.writes.length - 1]).toBe(1_700);
  });
});
