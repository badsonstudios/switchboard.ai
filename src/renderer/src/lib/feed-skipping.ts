// Letting the conversation skip its own off-screen blocks (#740, §5.10).
//
// ── WHY THIS EXISTS, AND WHY IT IS NOT A CSS LINE ───────────────────────────
//
// Typing into a long session is expensive because ANY layout invalidation in
// the panel re-lays-out the WHOLE feed: the conversation is not virtualised, so
// `visibleBlocks.map(...)` renders every block and changing the textarea's
// value costs a full reflow of all of them. #739 removed the composer's own
// forced synchronous layout; this is the other half, and `tokens.css` carries
// the measurements that rule out the cheap answers — containment in every form
// is worthless here (160-176ms/key against a 160ms baseline), because
// containment isolates a subtree from changes made INSIDE it and this
// invalidation arrives from OUTSIDE. Only SKIPPING helps.
//
// And skipping was tried, shipped to CI and REVERTED. `content-visibility:
// auto` with `contain-intrinsic-size: auto 80px` makes an unrendered block
// contribute a GUESS, and this feed is mostly one-line blocks about 32px tall,
// so `scrollHeight` read +85% at 60 blocks and +127% at 400. This app has a
// pixel-exact scroll-restore contract — #442's tail pin, #555's "a conversation
// you come back to is where you left it", and Dan's own 2026-07-26 reading-
// position bug — and an estimate cannot satisfy it. The revert's failure was
// `feed.spec.ts` restoring a scrollTop of 2189 where 1640 was saved, on Linux
// CI, deterministically.
//
// ── WHAT IS DIFFERENT THIS TIME: THE HEIGHT IS MEASURED, NOT GUESSED ────────
//
// Every block stands in for its OWN last-measured content-box height instead of
// one global number. Measured in the real app under a 4x CPU throttle
// (`spike/probes/740/feed-relayout.spec.ts`, findings in
// `spike/findings/e21-740-feed-skipping.md`), 400 blocks, long draft in the box:
//
//     mode                             layout ms/key  frame ms/key  scrollHeight
//     feature stripped (the before)            28.5          43.3        +0.0%
//     feed removed entirely (the floor)         1.7          16.6            —
//     the reverted global 80px guess            7.3          17.9      +140.8%
//     each block's own measurement (ships)      7.3          16.6        +0.0%
//
// ⚠️ ONE RUN, and every other copy of these numbers in the tree quotes the same
// one — `tokens.css`, `FeedView.tsx` and the findings doc. An earlier draft had
// three slightly different runs cited in four places, which makes every number
// look approximate and none of them checkable.
//
// So the keystroke's layout bill drops by about three quarters, the frame comes
// back under its 16.7ms budget — which is what "keystrokes appear in bursts"
// means when it stops happening — and `scrollHeight` is EXACT at both 60 and
// 400 blocks, which is the objection that reverted the first attempt.
//
// ── THE THREE THINGS THAT MAKE THIS SUBTLE ──────────────────────────────────
//
//  1. **A measured height is only true at the width it was measured at.**
//     Narrowing the pane 954px -> 525px left the stored heights reading -27.5%
//     against the truth, and `scrollHeight` is the number the restore contract
//     rides on. Dropping every height and letting ONE real layout put them back
//     measured 0.0%. That is why `setWidth` below throws the whole map away
//     rather than trying to be clever: a resize already pays a full relayout,
//     so re-measuring inside it costs the user nothing new.
//
//  2. **Reading a block's geometry UN-SKIPS it.** Chromium performs a forced
//     layout upgrade when script queries geometry inside skipped content, which
//     means a "measure everything, every time" pass would quietly delete the
//     optimisation it was serving — and, worse, would look like it was working.
//     This is not a guess: two different witnesses in probe B reported "0 of
//     342 skipped" in runs where `scrollHeight` was unarguably standing on
//     intrinsic sizes, because the witnesses had walked every block's rect
//     before asking. So nothing here measures a block that already has a
//     height; the ResizeObserver reports sizes the engine computed anyway.
//
//  3. **A block whose content changes WHILE SKIPPED does not re-measure, and
//     that is a real limitation rather than an oversight.** A skipped subtree
//     is not laid out, so a DOM change inside one produces no resize report.
//     The in-tree path that does this is the transcript watcher re-emitting a
//     block when its tool OUT lands (`FeedView`'s `upsertBlock` call): a tool
//     row that completes below the fold keeps its one-line height until it is
//     scrolled into view.
//
//     Traced against the restore contract, and it is safe in the direction
//     that matters: the error is always SHORT, and it accumulates at the tail,
//     i.e. below any saved reading position — so `restore()`'s clamp cannot
//     bite, and a pinned feed self-heals through the reconcile observer within
//     a frame or two of the block being rendered. "Exact" above therefore
//     means exact for content that has not changed unseen, which is every
//     block the user has ever looked at.
//
//     GROUPS (#716) HAVE THE SAME LIMITATION ONE LEVEL UP, and one more case.
//     A group whose child LIST changes while it is skipped is caught and
//     re-measured (`regroup` in the hook). A block that changes size inside a
//     skipped group without the list changing is not — the tool OUT above, and
//     also a block the find bar had expanded collapsing again when the bar
//     closes, which leaves the group TALL rather than short until it is
//     scrolled to. That one was already true of the block itself.
//
//  4. **The feedback loop has to be closed by construction.** We write a
//     CONTENT-box height and observe the CONTENT box, so a skipped block
//     reports back exactly the number we wrote and nothing happens. Observing
//     the border box instead would report `height + padding`, we would store
//     that, write it back, and every block would grow by its own padding on
//     every cycle — 8px a turn, for ever.

/**
 * How much a width may drift before every stored height is considered a lie.
 *
 * Sub-pixel: a dockview drag, a scrollbar appearing and a device-pixel-ratio
 * rounding all produce fractional width changes that cannot rewrap anything,
 * and throwing 400 heights away for them would turn a smooth drag into a
 * sequence of full relayouts — the exact cost this module exists to remove.
 */
export const WIDTH_EPSILON_PX = 1;

/**
 * How much a block's height may drift before it is worth a style write.
 *
 * Also the thing that makes the ResizeObserver loop terminate: a report that
 * agrees with what we already stored writes nothing, so there is no second
 * observation to deliver.
 */
export const HEIGHT_EPSILON_PX = 0.5;

/**
 * How many sequence numbers share one GROUP (#716, #1013).
 *
 * ── WHY BLOCKS ARE GROUPED AT ALL ───────────────────────────────────────────
 *
 * Skipping each block on its own made an off-screen block cheap, not free: the
 * engine still keeps a visibility watch on every `content-visibility: auto`
 * element and still walks each one in layout, pre-paint and commit. MEASURED
 * in the real app (`spike/probes/716/`: 980 real blocks, one reply streaming, a
 * key typed every 100ms, 12s; the engine's own timeline):
 *
 *                                        long tasks / stalled   frames   layout   key->paint p95
 *     4x, every block skipped (before)   16-27 / 950-1,700 ms   420-530  4,400 ms    88-104 ms
 *     4x, the old ones `display: none`       0 /       0 ms      ~785    1,430 ms    56-64 ms
 *     4x, in PLAIN wrappers of 40         5-11 /   310-660 ms    ~600    3,600 ms       88 ms
 *     4x, in SKIPPED groups of 40 (this)   0-1 /     0-79 ms     ~748    1,360 ms    56-64 ms
 *     6x, every block skipped (before)   66-70 / 5,470-5,940 ms 183-212  5,300 ms   144-200 ms
 *     6x, in SKIPPED groups of 40 (this)   0-2 /    0-124 ms    556-630  2,150 ms    80-96 ms
 *
 * And at the 1,000-block cap with a new block every half second, so that each
 * one evicts the oldest and the first group is re-measured every time — the
 * steady state of a long session: 38-40 / 3,100-3,300 ms and ~350 frames
 * before, 0-1 / 0-66 ms and ~710 frames after, at 4x.
 *
 * Row two is the floor — what it would cost if the old blocks were not there —
 * and a skipped group reaches it. A wrapper that is NOT itself skipped buys a
 * fraction, so it is not the number of siblings that costs; it is the number of
 * skipped elements the engine can see, and a skipped group hides its forty.
 * `spike/findings/716-streaming-render-cost.md` has the engine's own timeline.
 *
 * ── WHY BY SEQUENCE NUMBER ──────────────────────────────────────────────────
 *
 * Because a block's `seq` never changes, so neither does its group: an eviction
 * at the 1,000-block cap takes a block off the FRONT, a new block lands on the
 * end, and nothing in between changes parent. Grouping by position in the list
 * would move every block one place on every eviction, and React re-parents by
 * unmounting.
 *
 * Forty is what was measured. Smaller means more groups for the engine to walk,
 * larger means more blocks rendered for the group on screen; the square root of
 * the cap is 32, and nothing here is sensitive to the difference.
 */
export const FEED_GROUP_SIZE = 40;

/** One group of the conversation: its blocks, and a key that outlives them changing. */
export interface FeedGroup<B> {
  /** `Math.floor(seq / FEED_GROUP_SIZE)` of the block that opened it */
  key: number;
  blocks: B[];
}

/**
 * Cut a conversation into groups by sequence number.
 *
 * The list is in `seq` order — `upsertBlock` inserts by it — so each group is a
 * consecutive run. A block that is somehow OUT of order stays with the run it
 * was found in rather than opening a second group under a key that already
 * exists: keys only ever go up, so React is never handed the same one twice.
 */
export function groupBySeq<B extends { seq: number }>(
  blocks: readonly B[],
  size: number = FEED_GROUP_SIZE
): Array<FeedGroup<B>> {
  const out: Array<FeedGroup<B>> = [];
  let open: FeedGroup<B> | undefined;
  for (const b of blocks) {
    const key = Math.floor(b.seq / size);
    if (!open || key > open.key) {
      open = { key, blocks: [] };
      out.push(open);
    }
    open.blocks.push(b);
  }
  return out;
}

/** What a block's inline style should say, given what we know about its height. */
export interface SkipStyle {
  /** `'auto'` once we can stand in for it honestly, `''` (i.e. unset) before */
  contentVisibility: '' | 'auto';
  /** `''`, or the `contain-intrinsic-size` value */
  containIntrinsicSize: string;
}

/** A block that has never been measured must render normally — that is how it gets measured. */
const UNMEASURED: SkipStyle = { contentVisibility: '', containIntrinsicSize: '' };

/**
 * The style for a block whose content-box height we know.
 *
 * `auto <length>`, not a bare length. The `auto` keyword lets the engine prefer
 * its OWN last remembered size when it has one, and ours is the fallback for
 * the case that reverted the first attempt: a block that has never been
 * rendered, which has no remembered size at all and would otherwise contribute
 * a guess. Belt and braces, and the belt is the one we can test.
 */
export function skipStyleFor(height: number | undefined): SkipStyle {
  if (height === undefined || !Number.isFinite(height) || height < 0) return UNMEASURED;
  return { contentVisibility: 'auto', containIntrinsicSize: `auto ${height.toFixed(2)}px` };
}

/**
 * Is this resize report a real measurement, or an element with no layout?
 *
 * ⚠️ THE GUARD THAT THE FEED'S OLDEST BUG WALKS INTO. Dockview does not hide a
 * background panel by re-rendering it — it DETACHES the subtree, or collapses
 * an ancestor to zero — and a detached element reports a 0x0 content box to
 * every ResizeObserver watching it. Without this, switching away from a session
 * records a height of ZERO for all 400 of its blocks, `scrollHeight` collapses
 * to nothing, and the `scrollTop` the restore writes is clamped to the top:
 * `feed.spec.ts` → "switching away and back keeps your reading position" (Dan,
 * 2026-07-26) failed with 140 where 889 was saved. That is the same test, and
 * very nearly the same failure, that reverted the first attempt at this
 * feature.
 *
 * The INLINE size is what answers it. A block is never zero-width while it is
 * being rendered — it is a block-level child of a scroller with a width — so a
 * zero there means "no layout", while a zero block size can legitimately mean
 * "an empty block". Taken from the observer entry, never read back off the
 * element, because reading geometry would un-skip it.
 */
export function isRenderedMeasurement(inlineSize: number, blockSize: number): boolean {
  if (!Number.isFinite(inlineSize) || !Number.isFinite(blockSize)) return false;
  if (blockSize < 0) return false;
  return inlineSize > 0;
}

/**
 * What the feed knows about how tall each of its blocks is.
 *
 * Deliberately free of the DOM: every decision this makes — is the width change
 * real, is this height new information, which keys have gone away — is a
 * decision about numbers, and the first six bugs in the feed's scroll handling
 * were all unreachable from a unit test while they lived inside a component
 * (see `feed-pin.ts`, which exists for the same reason).
 */
export class FeedHeights {
  private readonly heights = new Map<string, number>();
  /** the width every stored height was measured at; -1 before the first measure */
  private measuredAt = -1;

  /** how many blocks we can currently stand in for */
  get size(): number {
    return this.heights.size;
  }

  /** the width the stored heights belong to, or -1 if nothing is stored yet */
  get width(): number {
    return this.measuredAt;
  }

  /**
   * Tell the map how wide the feed is now.
   *
   * Returns `true` when that invalidated everything — i.e. the caller must
   * clear the skip styling off every block and let one real layout re-measure.
   * A FIRST width (nothing stored yet) is not an invalidation: there is nothing
   * to throw away, and reporting one would make the first paint of every
   * session look like a resize.
   */
  setWidth(width: number): boolean {
    if (!Number.isFinite(width) || width <= 0) return false;
    if (this.measuredAt < 0) {
      this.measuredAt = width;
      return false;
    }
    if (Math.abs(width - this.measuredAt) < WIDTH_EPSILON_PX) return false;
    this.measuredAt = width;
    const had = this.heights.size > 0;
    this.heights.clear();
    return had;
  }

  has(key: string): boolean {
    return this.heights.has(key);
  }

  get(key: string): number | undefined {
    return this.heights.get(key);
  }

  /**
   * Record a measurement. Returns `true` when it is new information — which is
   * also the answer to "is a style write worth doing".
   */
  record(key: string, height: number): boolean {
    if (!Number.isFinite(height) || height < 0) return false;
    const was = this.heights.get(key);
    if (was !== undefined && Math.abs(was - height) < HEIGHT_EPSILON_PX) return false;
    this.heights.set(key, height);
    return true;
  }

  /**
   * Forget ONE height, because what it measured has changed unseen (#716).
   *
   * A skipped group is not laid out, so a block arriving in it, leaving it or
   * being filtered out of it produces no resize report: the stored height is
   * then a lie the engine will never correct. The caller drops it, the group
   * renders once, and the observer measures it again. Returns whether there was
   * anything to forget.
   */
  forget(key: string): boolean {
    return this.heights.delete(key);
  }

  /**
   * Forget every block that is no longer in the feed, and say how many went.
   *
   * ⚠️ NOT OPTIONAL HOUSEKEEPING. `upsertBlock` evicts at a 1,000-block cap and
   * a `/clear` or a rebind replaces the transcript outright, so a map that only
   * ever grew would hold a number for every block the session had ever shown —
   * which is the shape of the leak #1013 reported from the other side.
   */
  retain(keys: Iterable<string>): number {
    const live = keys instanceof Set ? keys : new Set(keys);
    let dropped = 0;
    // Deleting from a Map during its own iteration is well defined, so this
    // does NOT need a copy of the key list — and it runs on every childList
    // mutation with up to 1,000 keys.
    for (const key of this.heights.keys()) {
      if (!live.has(key)) {
        this.heights.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  clear(): void {
    this.heights.clear();
    this.measuredAt = -1;
  }
}
