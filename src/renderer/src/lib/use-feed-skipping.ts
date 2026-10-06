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
import { FEED_SEQ_ATTR } from './feed-reveal';
import { FeedHeights, isRenderedMeasurement, skipStyleFor } from './feed-skipping';

/**
 * The feed's own markup, as `FeedView` writes it.
 *
 * `FEED_SEQ_ATTR` is imported rather than respelled: it is the same attribute
 * the find bar jumps to and the keyboard walk reads, and three copies of a
 * string is three places for a rename to miss one.
 */
const BLOCK_SELECTOR = '[data-feed-block]';

/**
 * The wrapper around a run of blocks (#716) — see `FEED_GROUP_SIZE` for why
 * there is one. Its value is the group's key.
 *
 * Inside the feed's own `data-feed` namespace, which `decorateFeedMarkdown`
 * takes back from every reply before it reaches the page — so prose cannot
 * write one of these onto itself and have a height pinned to it.
 */
export const FEED_GROUP_ATTR = 'data-feed-group';
/**
 * The group still being WRITTEN to — the last one. It is measured like the
 * others and never skipped: blocks land in it continuously, a skipped subtree
 * reports no growth, and the conversation's height would stop following the
 * conversation for a reader who had scrolled away.
 */
export const FEED_GROUP_OPEN_ATTR = 'data-feed-group-open';
const GROUP_SELECTOR = `[${FEED_GROUP_ATTR}]`;
/** everything this hook writes a style onto */
const SKIPPABLE_SELECTOR = `${GROUP_SELECTOR}, ${BLOCK_SELECTOR}`;

/**
 * The key a height is stored under: a block's `seq`, or `g:` and a group's key.
 * One map for both, so a width change, a `/clear` and the eviction sweep each
 * stay one operation.
 */
function keyOf(el: Element): string | null {
  const group = el.getAttribute(FEED_GROUP_ATTR);
  return group === null ? el.getAttribute(FEED_SEQ_ATTR) : `g:${group}`;
}

/**
 * Let the conversation skip the blocks nobody is looking at.
 *
 * `scroller` is the element whose WIDTH decides every stored height (see
 * `FeedHeights.setWidth`); `content` is the element the blocks live in. The
 * hook owns the `content-visibility` and `contain-intrinsic-size` inline styles
 * on `[data-feed-block]` and `[data-feed-group]` elements and nothing else, so
 * React is free to re-render them as often as it likes: it diffs the `style`
 * prop it owns and leaves properties it never set alone.
 *
 * `conversation` changes when the list is REPLACED rather than added to — a
 * different session in the same card, a transcript loading over what was
 * there. Every height is then about a conversation that has gone, and nothing
 * else would say so: both conversations count from the same first `seq`, so
 * React keeps the same elements under the same keys, the eviction sweep keeps
 * every height, and a skipped block or group whose children look the same
 * never reports a change. (Found in review of #716; true of blocks since
 * #740, and forty times the error once a group could carry it.)
 */
export function useFeedSkipping(
  scroller: React.RefObject<HTMLElement | null>,
  content: React.RefObject<HTMLElement | null>,
  conversation: unknown = 0
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
  // Lazily, both of them: `useRef(new X())` evaluates its argument on EVERY
  // render and throws the result away, and this component re-renders on every
  // streamed block.
  const heights = React.useRef<FeedHeights | null>(null);
  heights.current ??= new FeedHeights();
  /** blocks already handed to the observer, so a re-sync only costs the new ones */
  const observed = React.useRef<WeakSet<Element> | null>(null);
  observed.current ??= new WeakSet<Element>();

  React.useEffect(() => {
    const host = content.current;
    const box = scroller.current;
    if (!host || !box) return;

    const map = heights.current!;
    const seen = observed as React.RefObject<WeakSet<Element>>;
    // Blocks arrive from the stream without this component being told which
    // ones, and the verbosity filter and the find-reveal set both change WHICH
    // blocks are in the DOM without changing how many. A MutationObserver on
    // the child lists catches all three for less than re-deriving any of them.
    //
    // ⚠️ NOT `subtree`. Every block is a direct child of a GROUP and every
    // group a direct child of this element — the fragments `FeedView` maps over
    // flatten away — so those child lists are the whole question (`sync`
    // subscribes each group as it meets it), and a subtree observer would
    // instead fire on every streamed token rewriting text inside a block,
    // running a full re-sync per character of a reply.
    //
    // Up here because `sync` subscribes to it; it is not started until the
    // bottom of this effect, by which time everything it calls exists.
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.target !== host) regroup(r.target as HTMLElement);
      }
      sync();
    });
    /** groups last seen as the open one — see `sync` */
    const wasOpen = new WeakSet<Element>();

    /** apply what we know about one block, and nothing when we know nothing */
    const paint = (el: HTMLElement): void => {
      const key = keyOf(el);
      // the open group's height is KEPT (it is what the group stands on the
      // moment a newer one opens) and deliberately not applied — see the attribute
      const known = key === null || el.hasAttribute(FEED_GROUP_OPEN_ATTR) ? undefined : map.get(key);
      const style = skipStyleFor(known);
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
      // Groups FIRST, so that when everything is new — a conversation loading —
      // the observer's first report for a group arrives with its blocks'.
      const blocks = [
        ...host.querySelectorAll<HTMLElement>(GROUP_SELECTOR),
        ...host.querySelectorAll<HTMLElement>(BLOCK_SELECTOR),
      ];
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
        // A group that has just stopped being the open one. Whatever height it
        // was last reported at may be a block short — two blocks can land
        // inside one frame, the second opening the next group before the
        // engine has laid out the first — and once skipped it would never be
        // corrected. So it is measured once more, as a closed group.
        if (el.hasAttribute(FEED_GROUP_OPEN_ATTR)) wasOpen.add(el);
        else if (wasOpen.delete(el)) regroup(el);
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
        // ⚠️ A NEW ELEMENT IS NOT ALWAYS A NEW BLOCK, and the difference is a
        // block that stays unskipped for the rest of the session.
        //
        // The first delivery for a newly observed element is what MEASURES it:
        // it has no skip styling yet, so it is laid out for real, and the
        // observer reports that height without anyone having read it. That is
        // only the whole story when the KEY is new too. React can mount a
        // fresh element for a key the map already knows — an unmount and
        // remount inside one commit, which `retain` never sees — and then the
        // first observation agrees with the stored height, `record` returns
        // false, and `paint` is never reached.
        //
        // Painting it here is safe precisely BECAUSE the key survived: a
        // `/clear` or a rebind empties the DOM first, so `retain` above has
        // already dropped those keys and this branch cannot fire with a height
        // belonging to a different conversation.
        if (keyOf(el) !== null && map.has(keyOf(el)!)) paint(el);
        ro.observe(el, { box: 'content-box' });
        // a group's own child list is where its blocks arrive and leave
        if (el.hasAttribute(FEED_GROUP_ATTR)) mo.observe(el, { childList: true });
      }
    };

    /**
     * A group's blocks changed — one arrived, was evicted, or the verbosity
     * filter or a find-reveal added or removed some — so the height stored for
     * it describes a group that no longer exists.
     *
     * ⚠️ WITHOUT THIS A SKIPPED GROUP KEEPS ITS OLD HEIGHT FOR EVER, in either
     * direction. A skipped subtree is not laid out, so nothing reports that it
     * changed: switching to `quiet` would leave every group as tall as it was
     * on `firehose`, and the conversation would end in a screen of nothing.
     *
     * Forget the height, let the group render, and RE-SUBSCRIBE — the part that
     * is easy to leave out. A group whose new height happens to equal its old
     * one never fires a resize, so without a fresh first report it would sit
     * unmeasured and unskipped. (`invalidate` below does the same for a width
     * change, for the same reason.)
     *
     * The open group is left alone: it is not skipped, so the observer has been
     * following it all along.
     */
    const regroup = (el: HTMLElement): void => {
      if (el.hasAttribute(FEED_GROUP_OPEN_ATTR)) return;
      const key = keyOf(el);
      if (key === null || !map.forget(key)) return;
      paint(el);
      ro.unobserve(el);
      ro.observe(el, { box: 'content-box' });
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
     * ⚠️ AND IT WAITS FOR THE DRAG TO STOP, which an earlier version did not.
     * The RELAYOUT is free — a resize was paying for one anyway — but the
     * ~1,600 style writes, two `querySelectorAll`s and 400 re-subscriptions
     * that come with it are not, and a dockview splitter moves 5-20px per
     * frame, every frame, for as long as the user holds the mouse down. One
     * frame of settling collapses a whole drag into a single invalidation at
     * the width the user actually chose.
     */
    let settle = 0;
    const invalidate = (): void => {
      cancelAnimationFrame(settle);
      settle = requestAnimationFrame(() => {
        for (const el of host.querySelectorAll<HTMLElement>(SKIPPABLE_SELECTOR)) {
          el.style.contentVisibility = '';
          el.style.containIntrinsicSize = '';
        }
        ro.disconnect();
        // ...and the child-list watch with it, so the two observers always
        // describe the same set of elements: `sync` re-subscribes every group
        // it does not remember, and `seen` is about to forget all of them.
        mo.disconnect();
        mo.observe(host, { childList: true });
        seen.current = new WeakSet<Element>();
        sync();
      });
    };
    const widthRo = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      // `setWidth` is called on EVERY report, not inside the frame below: it is
      // the thing that decides whether this width is news at all, and deferring
      // it would compare each frame of a drag against the previous frame rather
      // than against the width the heights were measured at — which, at 5px a
      // frame against a 1px epsilon, is the same answer, but for a reason that
      // would stop being true the moment the epsilon moved.
      if (map.setWidth(w)) invalidate();
    });
    widthRo.observe(box, { box: 'content-box' });

    mo.observe(host, { childList: true });
    sync();

    return () => {
      cancelAnimationFrame(settle);
      mo.disconnect();
      widthRo.disconnect();
      ro.disconnect();
      observed.current = new WeakSet<Element>();
      map.clear();
      for (const el of host.querySelectorAll<HTMLElement>(SKIPPABLE_SELECTOR)) {
        el.style.contentVisibility = '';
        el.style.containIntrinsicSize = '';
      }
    };
    // `conversation` is read by nobody in here: it is a dependency so that the
    // cleanup above — forget everything, unstyle everything — runs when the
    // list is replaced, and the next pass measures what is there now.
  }, [content, scroller, conversation]);
}
