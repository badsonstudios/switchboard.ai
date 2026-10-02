// Wiring `FeedHeights` to a live conversation (#740, §5.10).
//
// The rules and the measurements are in `feed-skipping.ts`; this is the part
// that has to touch the DOM, and it is a separate file for the reason
// `feed-pin.ts` is: the decisions belong somewhere a unit test can reach them,
// and what is left here is the three things only a component can do — find the
// blocks, read what the engine already measured, and write a style.
//
// ⚠️ IT NEVER READS GEOMETRY, AND THAT IS THE WHOLE DESIGN. Chromium performs a
// forced layout upgrade when script queries geometry inside skipped content, so
// a `getBoundingClientRect()` here would quietly un-skip the block it was
// measuring — deleting the optimisation while appearing to serve it. Probe B
// in `spike/probes/740/` hit exactly that: two independent witnesses reported
// "0 of 342 skipped" in runs where `scrollHeight` was unarguably standing on
// intrinsic sizes, because both witnesses had walked every block's rect before
// asking the question.
//
// So every height here arrives from a `ResizeObserver`, which reports sizes the
// engine computed for its own reasons. Nothing in this file forces a layout.
import React from 'react';
import { FeedHeights, isRenderedMeasurement, skipStyleFor } from './feed-skipping';

/** the feed's own markup, as `FeedView` writes it */
const BLOCK_SELECTOR = '[data-feed-block]';
const SEQ_ATTR = 'data-feed-seq';

function keyOf(el: Element): string | null {
  return el.getAttribute(SEQ_ATTR);
}

/**
 * Let the conversation skip the blocks nobody is looking at.
 *
 * `scroller` is the element whose WIDTH decides every stored height (see
 * `FeedHeights.setWidth`); `content` is the element the blocks live in. The
 * hook owns the `content-visibility` and `contain-intrinsic-size` inline styles
 * on `[data-feed-block]` elements and nothing else, so React is free to
 * re-render those blocks as often as it likes: it diffs the `style` prop it
 * owns and leaves properties it never set alone.
 */
export function useFeedSkipping(
  scroller: React.RefObject<HTMLElement | null>,
  content: React.RefObject<HTMLElement | null>
): void {
  /**
   * Every height we have, and the width they were measured at.
   *
   * ⚠️ THE WIDTH COMES FROM AN OBSERVER, NEVER FROM `clientWidth`. Reading it
   * in the effect below would force a synchronous layout once per render — and
   * this component re-renders on every streamed block, so that would be a
   * forced layout per token. #739 removed exactly that from the composer;
   * putting one back here would be trading one report for another.
   */
  const heights = React.useRef(new FeedHeights());
  /** blocks already handed to the observer, so a re-sync only costs the new ones */
  const observed = React.useRef(new WeakSet<Element>());

  React.useEffect(() => {
    const host = content.current;
    const box = scroller.current;
    if (!host || !box) return;

    const map = heights.current;
    const seen = observed;

    /** apply what we know about one block, and nothing when we know nothing */
    const paint = (el: HTMLElement): void => {
      const key = keyOf(el);
      const style = skipStyleFor(key === null ? undefined : map.get(key));
      // Written only when it differs. An unconditional assignment of the same
      // string is not free — it dirties style resolution for the subtree — and
      // this runs for every block on every observer delivery.
      if (el.style.contentVisibility !== style.contentVisibility) {
        el.style.contentVisibility = style.contentVisibility;
      }
      if (el.style.containIntrinsicSize !== style.containIntrinsicSize) {
        el.style.containIntrinsicSize = style.containIntrinsicSize;
      }
    };

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const key = keyOf(el);
        if (key === null) continue;
        // THE CONTENT BOX, and it closes the loop by construction: we write a
        // content-box height, so a skipped block reports back exactly the
        // number we wrote and `record` returns false. Observing the border box
        // would report `height + padding`, we would store that and write it
        // back, and every block would grow by its own padding for ever.
        const size = entry.contentBoxSize?.[0];
        const h = size?.blockSize ?? entry.contentRect.height;
        const w = size?.inlineSize ?? entry.contentRect.width;
        // A detached or collapsed panel reports 0x0 for every block it
        // contains; believing that would record a height of zero for the whole
        // conversation. See `isRenderedMeasurement`.
        if (!isRenderedMeasurement(w, h)) continue;
        if (map.record(key, h)) paint(el);
      }
    });

    /**
     * Bring the observer's idea of the feed up to date with the DOM's.
     *
     * Cheap on purpose — a `querySelectorAll` and a `WeakSet` probe per block,
     * no geometry — because it runs after every render, and a streaming session
     * renders on every block that arrives.
     */
    const sync = (): void => {
      const blocks = [...host.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)];
      const keys = new Set<string>();
      for (const el of blocks) {
        const key = keyOf(el);
        if (key !== null) keys.add(key);
      }
      // `/clear`, a rebind, and `upsertBlock`'s 1,000-block cap all retire
      // blocks; a map that only ever grew would hold a height for everything
      // the session had ever shown.
      map.retain(keys);
      for (const el of blocks) {
        if (seen.current.has(el)) {
          // Re-asserted rather than assumed. Nothing in the app clears these
          // properties behind our back, so this is belt-and-braces — but it is
          // two string comparisons against the style we already want, and it
          // makes the invariant "every block's style agrees with the map" hold
          // after EVERY DOM change rather than only after an observer
          // delivery. The failure it guards against does not throw; it leaves
          // one block the wrong height, which is invisible until someone
          // scrolls past it.
          paint(el);
          continue;
        }
        seen.current.add(el);
        // The first delivery for a newly observed element is what MEASURES it:
        // it has no skip styling yet, so it is laid out for real, and the
        // observer reports that height without anyone having read it.
        ro.observe(el, { box: 'content-box' });
      }
    };

    /**
     * A width change makes every stored height a lie — measured at -27.5%
     * across a 954px -> 525px narrowing.
     *
     * The remedy is deliberately blunt: strip the skip styling off every block
     * so one real layout re-measures them, and re-subscribe so the observer
     * delivers a first observation for each. Re-subscribing is the part that is
     * easy to leave out and impossible to notice — a block whose height happens
     * to be unchanged at the new width never fires a resize, so without a fresh
     * first delivery it would sit unmeasured and unskipped for ever.
     *
     * The user pays nothing new for this: a resize already re-lays-out the
     * whole feed, which is the cost being re-spent.
     */
    const widthRo = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (!map.setWidth(w)) return;
      for (const el of host.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) {
        el.style.contentVisibility = '';
        el.style.containIntrinsicSize = '';
      }
      ro.disconnect();
      seen.current = new WeakSet<Element>();
      sync();
    });
    widthRo.observe(box, { box: 'content-box' });

    sync();
    // Blocks arrive from the stream without this component being told which
    // ones, and the verbosity filter and the find-reveal set both change WHICH
    // blocks are in the DOM without changing how many. A MutationObserver on
    // the child list catches all three for less than re-deriving any of them.
    //
    // ⚠️ NOT `subtree`. Every block is a DIRECT child of this element — the
    // fragments `FeedView` maps over flatten away — so the child list is the
    // whole question, and a subtree observer would instead fire on every
    // streamed token rewriting text inside a block, running a full re-sync per
    // character of a reply.
    const mo = new MutationObserver(() => sync());
    mo.observe(host, { childList: true });

    return () => {
      mo.disconnect();
      widthRo.disconnect();
      ro.disconnect();
      observed.current = new WeakSet<Element>();
      map.clear();
      for (const el of host.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) {
        el.style.contentVisibility = '';
        el.style.containIntrinsicSize = '';
      }
    };
  }, [content, scroller]);
}
