// P2-E10-08 (#406): the composer's height is a MEASUREMENT, not a newline count.
//
// The numbers below are the composer's real ones: 12px text on a 1.45 ratio
// (17.4px per rendered line) with 7px of padding on each block edge.
import { describe, it, expect } from 'vitest';
import { composerSize, COMPOSER_MAX_LINES, resolveLineHeight } from './composer-size';

const LINE = 17.4;
const PAD = 14;
const BORDER = 2;

/** what the DOM reports for `n` RENDERED lines — hard or soft, it cannot tell */
const metrics = (lines: number, over: Partial<Parameters<typeof composerSize>[0]> = {}) => ({
  scrollHeight: lines * LINE + PAD,
  lineHeight: LINE,
  padding: PAD,
  border: BORDER,
  borderBox: false,
  ...over,
});

describe('composerSize', () => {
  it('is one line tall for one line', () => {
    expect(composerSize(metrics(1)).blockSize).toBeCloseTo(LINE, 5);
  });

  it('grows with RENDERED lines — the wrap the browser did, not the newlines typed', () => {
    // the #406 case: one pasted paragraph, no '\n' in it at all, wrapping to 8
    expect(composerSize(metrics(8)).blockSize).toBeCloseTo(8 * LINE, 5);
    expect(composerSize(metrics(8)).overflowY).toBe('hidden'); // all of it visible
  });

  it('caps at twelve lines and scrolls inside itself past that', () => {
    const capped = composerSize(metrics(COMPOSER_MAX_LINES));
    expect(capped.blockSize).toBeCloseTo(COMPOSER_MAX_LINES * LINE, 5);
    expect(capped.overflowY).toBe('hidden'); // exactly full is not overflowing

    const past = composerSize(metrics(30));
    expect(past.blockSize).toBeCloseTo(COMPOSER_MAX_LINES * LINE, 5);
    expect(past.overflowY).toBe('auto');
  });

  it('shrinks back to one line when the text is deleted', () => {
    expect(composerSize(metrics(9)).blockSize).toBeGreaterThan(composerSize(metrics(1)).blockSize);
    // an empty box still reports one line of content; a browser mid-relayout
    // can report less, and the floor is what keeps that from collapsing the box
    expect(composerSize(metrics(0)).blockSize).toBeCloseTo(LINE, 5);
  });

  it('adds padding and border back under border-box', () => {
    const size = composerSize(metrics(4, { borderBox: true }));
    expect(size.blockSize).toBeCloseTo(4 * LINE + PAD + BORDER, 5);
  });

  it('does not fire a scrollbar for a sub-pixel rounding error at the cap', () => {
    // 12 × 17.4 = 208.8: an engine that rounds each line up reports a few
    // tenths more than the cap for the line that exactly fills the box
    const size = composerSize(metrics(COMPOSER_MAX_LINES, { scrollHeight: 12 * LINE + PAD + 0.4 }));
    expect(size.overflowY).toBe('hidden');
  });

  it('fits the content when the line height is unknowable', () => {
    // no line height means no line COUNT: capping would be a guess, and a
    // scrollbar we cannot size is a prompt the user cannot read
    const size = composerSize(metrics(40, { lineHeight: 0 }));
    expect(size.blockSize).toBeCloseTo(40 * LINE, 5);
    expect(size.overflowY).toBe('hidden');
  });

  it('takes a caller-supplied cap', () => {
    expect(composerSize(metrics(30), 3).blockSize).toBeCloseTo(3 * LINE, 5);
  });
});

describe('resolveLineHeight', () => {
  it('reads the px a browser resolves', () => {
    expect(resolveLineHeight('17.4px', '12px')).toBeCloseTo(17.4, 5);
  });

  it('multiplies out a unitless ratio (what jsdom hands back)', () => {
    expect(resolveLineHeight('1.45', '12px')).toBeCloseTo(17.4, 5);
  });

  it('falls back to the composer ratio for `normal` and for nonsense', () => {
    expect(resolveLineHeight('normal', '12px')).toBeCloseTo(17.4, 5);
    expect(resolveLineHeight('', '')).toBeCloseTo(12 * 1.45, 5);
  });
});
