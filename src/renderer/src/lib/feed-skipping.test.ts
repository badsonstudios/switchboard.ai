// What the feed knows about its own block heights (#740).
//
// Every claim here is one the DOM cannot be asked about in a unit test and one
// that, if it broke, would break quietly: a stale height does not throw, it
// just makes `scrollHeight` wrong — and `scrollHeight` is what #442's tail pin
// and #555's reading position are computed from. The reverted first attempt at
// this feature failed on exactly that, on Linux CI, with no error anywhere.
import { describe, expect, it } from 'vitest';
import {
  FEED_GROUP_SIZE,
  FeedHeights,
  groupBySeq,
  HEIGHT_EPSILON_PX,
  isRenderedMeasurement,
  WIDTH_EPSILON_PX,
  skipStyleFor,
} from './feed-skipping';

describe('skipStyleFor', () => {
  it('leaves an UNMEASURED block alone, because rendering it is how it gets measured', () => {
    // The whole bootstrap depends on this: a block with no known height must
    // lay out for real, or the observer has nothing to report and it is never
    // measured, never skipped, and never recovers.
    expect(skipStyleFor(undefined)).toEqual({ contentVisibility: '', containIntrinsicSize: '' });
  });

  it('stands a measured block on its OWN height, not a guess', () => {
    expect(skipStyleFor(31.5)).toEqual({
      contentVisibility: 'auto',
      containIntrinsicSize: 'auto 31.50px',
    });
  });

  it('keeps sub-pixel precision — 400 blocks rounded down is a visible error', () => {
    // At 400 blocks, rounding each height to a whole pixel can move the bottom
    // of the conversation by hundreds of pixels, which is the class of error
    // that reverted the first attempt (+127%).
    const { containIntrinsicSize } = skipStyleFor(32.4567);
    expect(containIntrinsicSize).toBe('auto 32.46px');
  });

  it('refuses a height that is not a usable number rather than writing garbage CSS', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(skipStyleFor(bad).contentVisibility).toBe('');
    }
  });

  it('allows zero — a collapsed block is a real measurement, not a missing one', () => {
    expect(skipStyleFor(0).contentVisibility).toBe('auto');
  });
});

describe('isRenderedMeasurement', () => {
  it('REFUSES a 0x0 report, because that is a detached panel and not a short block', () => {
    // ⚠️ THE REGRESSION. Dockview hides a background panel by detaching the
    // subtree or collapsing an ancestor, and every block inside then reports a
    // 0x0 content box to the observer. Believing it records a height of ZERO
    // for all 400 blocks of that session; `scrollHeight` collapses; and the
    // `scrollTop` the restore writes is clamped to the top.
    //
    // This is not hypothetical and it is not new: with this guard absent,
    // `e2e/feed.spec.ts` → "switching away and back keeps your reading
    // position (Dan 2026-07-26)" restored 140 where 889 was saved — the same
    // test, and nearly the same number, that reverted the first attempt at
    // this feature.
    expect(isRenderedMeasurement(0, 0)).toBe(false);
  });

  it('refuses a zero WIDTH even when a height came with it', () => {
    // A block is never zero-wide while it is being rendered: it is a
    // block-level child of a scroller that has a width.
    expect(isRenderedMeasurement(0, 32)).toBe(false);
  });

  it('ACCEPTS a zero height at a real width — an empty block is a real block', () => {
    expect(isRenderedMeasurement(954, 0)).toBe(true);
  });

  it('accepts an ordinary block', () => {
    expect(isRenderedMeasurement(954, 24)).toBe(true);
  });

  it('refuses nonsense rather than letting it reach the map', () => {
    expect(isRenderedMeasurement(Number.NaN, 24)).toBe(false);
    expect(isRenderedMeasurement(954, Number.NaN)).toBe(false);
    expect(isRenderedMeasurement(954, -1)).toBe(false);
  });
});

describe('FeedHeights — recording', () => {
  it('reports a first measurement as new information', () => {
    const h = new FeedHeights();
    expect(h.record('7', 32)).toBe(true);
    expect(h.get('7')).toBe(32);
    expect(h.size).toBe(1);
  });

  it('IGNORES a report that agrees with what it already has, and that is what ends the loop', () => {
    // The observer re-reports a block every time it is skipped or un-skipped.
    // A skipped block reports back exactly the height we wrote, so if that
    // counted as news we would write the style again, which re-delivers, for
    // ever.
    const h = new FeedHeights();
    h.record('7', 32);
    expect(h.record('7', 32)).toBe(false);
    expect(h.record('7', 32 + HEIGHT_EPSILON_PX / 2)).toBe(false);
  });

  it('takes a change bigger than the epsilon — a tool row expanding is real', () => {
    const h = new FeedHeights();
    h.record('7', 32);
    expect(h.record('7', 180)).toBe(true);
    expect(h.get('7')).toBe(180);
  });

  it('refuses a nonsense height rather than poisoning the map with it', () => {
    const h = new FeedHeights();
    expect(h.record('7', Number.NaN)).toBe(false);
    expect(h.record('7', -4)).toBe(false);
    expect(h.has('7')).toBe(false);
  });
});

describe('FeedHeights — width', () => {
  it('does not call the FIRST width an invalidation', () => {
    // Nothing is stored yet, so there is nothing to throw away — and reporting
    // one would make the first paint of every session do a resize's work.
    const h = new FeedHeights();
    expect(h.setWidth(954)).toBe(false);
    expect(h.width).toBe(954);
  });

  it('throws every height away when the width really changes', () => {
    // MEASURED (`spike/probes/740/feed-skipping-contract.spec.ts`): narrowing
    // 954px -> 525px left the stored heights reading -27.5% against the truth,
    // because prose rewraps. Keeping them would put that error straight into
    // `scrollHeight`.
    const h = new FeedHeights();
    h.setWidth(954);
    h.record('1', 32);
    h.record('2', 32);
    expect(h.setWidth(525)).toBe(true);
    expect(h.size).toBe(0);
    expect(h.width).toBe(525);
  });

  it('ignores sub-pixel drift, or a dockview drag would be a sequence of full relayouts', () => {
    const h = new FeedHeights();
    h.setWidth(954);
    h.record('1', 32);
    expect(h.setWidth(954 + WIDTH_EPSILON_PX / 2)).toBe(false);
    expect(h.size).toBe(1);
  });

  it('says nothing changed when the width moves but there was nothing stored', () => {
    // A hidden panel resizing while empty must not be reported as work to do.
    const h = new FeedHeights();
    h.setWidth(954);
    expect(h.setWidth(525)).toBe(false);
  });

  it('ignores a zero or negative width — that is a HIDDEN panel, not a resize', () => {
    // Dockview hides a background panel by collapsing an ancestor, so the
    // scroller reports 0. Treating that as a real width would throw away every
    // height of every session the moment it went to the background, and the
    // heights would be re-measured at a width of zero.
    const h = new FeedHeights();
    h.setWidth(954);
    h.record('1', 32);
    expect(h.setWidth(0)).toBe(false);
    expect(h.setWidth(-5)).toBe(false);
    expect(h.width).toBe(954);
    expect(h.size).toBe(1);
  });
});

describe('FeedHeights — retain', () => {
  it('forgets blocks the feed no longer has, and says how many', () => {
    // `upsertBlock` evicts at a 1,000-block cap and a `/clear` replaces the
    // transcript outright. A map that only ever grew would hold a number for
    // every block the session had ever shown — the shape of the leak #1013
    // reported from the other side.
    const h = new FeedHeights();
    h.setWidth(954);
    for (const k of ['1', '2', '3']) h.record(k, 32);
    expect(h.retain(['2', '3'])).toBe(1);
    expect(h.has('1')).toBe(false);
    expect(h.size).toBe(2);
  });

  it('keeps everything when every key is still live, and reports no work', () => {
    const h = new FeedHeights();
    for (const k of ['1', '2']) h.record(k, 32);
    expect(h.retain(new Set(['1', '2']))).toBe(0);
    expect(h.size).toBe(2);
  });

  it('empties the map when the conversation does', () => {
    const h = new FeedHeights();
    h.record('1', 32);
    expect(h.retain([])).toBe(1);
    expect(h.size).toBe(0);
  });
});

describe('FeedHeights — forget', () => {
  it('drops one height and leaves the rest, so only the group that changed is re-measured', () => {
    const h = new FeedHeights();
    h.record('g:0', 900);
    h.record('g:1', 1200);
    expect(h.forget('g:0')).toBe(true);
    expect(h.has('g:0')).toBe(false);
    expect(h.get('g:1')).toBe(1200);
  });

  it('says so when there was nothing to forget', () => {
    expect(new FeedHeights().forget('g:7')).toBe(false);
  });

  it('makes the SAME height news again, which is what gets the group skipped a second time', () => {
    // A group that loses a block and gains one of the same height measures
    // exactly what it measured before. Without the forget, `record` would call
    // that old news and the group would stay rendered for the rest of the session.
    const h = new FeedHeights();
    h.record('g:0', 900);
    h.forget('g:0');
    expect(h.record('g:0', 900)).toBe(true);
  });
});

describe('groupBySeq', () => {
  const seqs = (...ns: number[]): Array<{ seq: number }> => ns.map((seq) => ({ seq }));
  const shape = (gs: Array<{ key: number; blocks: Array<{ seq: number }> }>): Array<[number, number[]]> =>
    gs.map((g) => [g.key, g.blocks.map((b) => b.seq)]);

  it('cuts by sequence number, not by position', () => {
    expect(shape(groupBySeq(seqs(0, 1, 2, 3, 4, 5), 3))).toEqual([
      [0, [0, 1, 2]],
      [1, [3, 4, 5]],
    ]);
  });

  it('keeps every surviving block in the group it was in when the oldest is evicted', () => {
    // THE reason it is by seq. At the 1,000-block cap every new block evicts
    // one from the front; grouped by position, all 999 others would change
    // group — and React moves a child between parents by unmounting it.
    const before = shape(groupBySeq(seqs(0, 1, 2, 3, 4, 5, 6), 3));
    const after = shape(groupBySeq(seqs(1, 2, 3, 4, 5, 6, 7), 3));
    expect(before).toEqual([
      [0, [0, 1, 2]],
      [1, [3, 4, 5]],
      [2, [6]],
    ]);
    expect(after).toEqual([
      [0, [1, 2]],
      [1, [3, 4, 5]],
      [2, [6, 7]],
    ]);
  });

  it('does not open a group for sequence numbers nothing is showing', () => {
    // the verbosity filter leaves gaps, and an empty wrapper is still an element
    expect(shape(groupBySeq(seqs(1, 2, 40, 41), 10))).toEqual([
      [0, [1, 2]],
      [4, [40, 41]],
    ]);
  });

  it('never hands out the same key twice, even for a list that is out of order', () => {
    const groups = groupBySeq(seqs(0, 1, 5, 2, 6), 3);
    const keys = groups.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(groups.flatMap((g) => g.blocks.map((b) => b.seq))).toEqual([0, 1, 5, 2, 6]);
  });

  it('uses the shipped size by default, and returns nothing for an empty conversation', () => {
    expect(groupBySeq([])).toEqual([]);
    const groups = groupBySeq(seqs(0, FEED_GROUP_SIZE - 1, FEED_GROUP_SIZE));
    expect(groups.map((g) => g.blocks.length)).toEqual([2, 1]);
  });
});
