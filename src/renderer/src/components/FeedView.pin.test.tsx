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
  // …and a width, so a press at x=0 is inside the content box rather than on a
  // scrollbar: the scrollbar test is `x >= clientWidth`, and jsdom's 0 fails it (#1111)
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => 800 });
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

/**
 * A wheel on the scroller, which is what opens the gesture window.
 *
 * TOWARD THE TOP unless told otherwise (#1111): the direction is now part of what
 * the gesture means, and a wheel with no `deltaY` at all cannot scroll up.
 */
const wheel = async (s: Scroller, deltaY = -120): Promise<void> => {
  await act(async () => {
    s.el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY }));
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
    await wheel(s, 120); // toward the tail
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

describe('#1111 — `scrollTop` going down is only a scroll if the gesture could scroll', () => {
  // At the 1,000-block cap every arriving block evicts one from the top, and
  // scroll anchoring lowers `scrollTop` by its height. 1,700 -> 1,622 with the
  // tail still at 1,700 is that event, exactly as the probe recorded it.
  it('keeps following when the number drops after a CLICK', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await clickInFeed(s);
    await s.scrollTo(1_622);
    // put back on the tail, not left 78px short of it with the pin gone
    expect(s.writes[s.writes.length - 1]).toBe(1_700);
  });

  it('keeps following when it drops after a wheel TOWARD the tail', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await wheel(s, 120);
    await s.scrollTo(1_622);
    expect(s.writes[s.writes.length - 1]).toBe(1_700);
  });

  it('keeps following when it drops after a key that scrolls nothing', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await act(async () => {
      s.el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Shift' }));
    });
    await s.scrollTo(1_622);
    expect(s.writes[s.writes.length - 1]).toBe(1_700);
  });

  it('lets go for a wheel toward the top — the same numbers, and a person leaving', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await wheel(s);
    await s.scrollTo(1_622);
    expect(s.writes).toEqual([]);
    expect(s.top()).toBe(1_622);
  });

  it('lets go for a press that TRAVELLED with the button held — a drag can scroll', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await act(async () => {
      s.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 50 }));
      s.el.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 50, clientY: 20, buttons: 1 })
      );
    });
    await s.scrollTo(1_622);
    expect(s.writes).toEqual([]);
  });

  it('does not promote a click whose pointer twitched', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await act(async () => {
      s.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 50 }));
      s.el.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 52, clientY: 51, buttons: 1 })
      );
    });
    await s.scrollTo(1_622);
    expect(s.writes[s.writes.length - 1]).toBe(1_700);
  });

  it('lets go for a press on the scrollbar itself', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await act(async () => {
      // past the content box's 800px: the thumb or the track
      s.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 806, clientY: 50 }));
    });
    await s.scrollTo(1_622);
    expect(s.writes).toEqual([]);
  });

  it('does not let a hover after the release turn a click into a drag', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await act(async () => {
      s.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 50 }));
      // no button held: the mouse is merely passing over the conversation
      s.el.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 300, clientY: 300, buttons: 0 })
      );
    });
    await s.scrollTo(1_622);
    expect(s.writes[s.writes.length - 1]).toBe(1_700);
  });

  // ── found in review: gestures that end, and gestures that are not ours ──────
  it('lets go for PageUp with focus on the conversation itself', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await act(async () => {
      s.el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageUp' }));
    });
    await s.scrollTo(1_400);
    expect(s.writes).toEqual([]);
  });

  it('does not let a sideways wheel erase a wheel-up that is still in flight', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await wheel(s);
    await wheel(s, 0); // a trackpad swipe's horizontal drift
    await s.scrollTo(1_622);
    expect(s.writes).toEqual([]);
  });

  it('ends a drag at its release — the next drop in `scrollTop` is not the user', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await act(async () => {
      s.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 50 }));
      s.el.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 50, clientY: 20, buttons: 1 })
      );
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await s.scrollTo(1_622);
    expect(s.writes[s.writes.length - 1]).toBe(1_700);
  });

  it('ends a scrollbar press at its release too', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await act(async () => {
      s.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 806, clientY: 50 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await s.scrollTo(1_622);
    expect(s.writes[s.writes.length - 1]).toBe(1_700);
  });

  it('does not adopt a drag that began somewhere else and crosses the conversation', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    // an old click here, long released…
    await clickInFeed(s);
    await act(async () => {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      // …then a button held from OUTSIDE (a composer selection, a panel divider)
      s.el.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 400, clientY: 200, buttons: 1 })
      );
    });
    await s.scrollTo(1_622);
    expect(s.writes[s.writes.length - 1]).toBe(1_700);
  });

  it('counts a held press that LEFT the conversation as a drag', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await act(async () => {
      s.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 50 }));
      // a fast flick: no move was ever delivered inside
      s.el.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, buttons: 1 }));
    });
    await s.scrollTo(1_622);
    expect(s.writes).toEqual([]);
  });

  it('disarms a wheel-up once the user has wheeled back home', async () => {
    const { s } = await mountFeed();
    await onTheTail(s);
    await wheel(s);
    await s.scrollTo(1_400); // away
    await s.scrollTo(1_690); // …and back inside the slack, still the same wheel
    await settle();
    s.writes.length = 0;
    // the next evicted block: down by its height, with a new one below the fold
    await s.scrollTo(1_622);
    expect(s.writes[s.writes.length - 1]).toBe(1_700);
  });
});
