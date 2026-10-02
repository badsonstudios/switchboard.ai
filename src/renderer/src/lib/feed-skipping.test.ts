// What the feed knows about its own block heights (#740).
//
// Every claim here is one the DOM cannot be asked about in a unit test and one
// that, if it broke, would break quietly: a stale height does not throw, it
// just makes `scrollHeight` wrong — and `scrollHeight` is what #442's tail pin
// and #555's reading position are computed from. The reverted first attempt at
// this feature failed on exactly that, on Linux CI, with no error anywhere.
import { describe, expect, it } from 'vitest';
import {
  FeedHeights,
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
