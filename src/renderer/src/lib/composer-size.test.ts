// P2-E10-08 (#406): the composer's height is a MEASUREMENT, not a newline count.
// #716: and the part JS still measures is where it STOPS, not how tall it is.
//
// WHAT MOVED, and why these tests read differently to the ones they replace.
// `composerSize` took a `scrollHeight` and returned the height to write back —
// which meant reading the DOM on every keystroke, and a read-after-write forces
// a document-wide layout (36.5ms per character at 400 turns). CSS
// (`field-sizing: content`) now does the growing, so the only question left for
// arithmetic is the pair of BOUNDS it grows between. There is no `scrollHeight`
// input any more and no `overflowY` output — `.composer-box` is unconditionally
// `overflow-y: auto`, which it could not be while a scrollbar appearing
// mid-measure would have re-wrapped the text being measured.
//
// The numbers below are the composer's real ones: 12px text on a 1.45 ratio
// (17.4px per rendered line) with 7px of padding on each block edge.
import { describe, it, expect } from 'vitest';
import { composerBounds, COMPOSER_MAX_LINES, resolveLineHeight } from './composer-size';

const LINE = 17.4;
const PAD = 14;
const BORDER = 2;
/** the twelve-line cap as the module rounds it — up, so the last line cannot clip */
const CAP = Math.ceil(COMPOSER_MAX_LINES * LINE); // 209

const metrics = (over: Partial<Parameters<typeof composerBounds>[0]> = {}) => ({
  lineHeight: LINE,
  padding: PAD,
  border: BORDER,
  borderBox: false,
  ...over,
});

describe('composerBounds', () => {
  it('floors at one rendered line', () => {
    expect(composerBounds(metrics()).minBlockSize).toBe(Math.ceil(LINE));
  });

  it('caps at twelve rendered lines', () => {
    expect(composerBounds(metrics()).maxBlockSize).toBe(CAP);
  });

  it('rounds the line cap UP, so the line that exactly fills the box cannot clip', () => {
    // 12 × 17.4 = 208.79999999999998. A cap of 208 is a box a fraction shorter
    // than the twelve lines it is supposed to show, and the twelfth line loses
    // its descenders. This is the `Math.ceil` the old code applied to the height
    // it wrote back, kept in the place that now decides the same thing.
    expect(composerBounds(metrics()).maxBlockSize).toBe(209);
    expect(COMPOSER_MAX_LINES * LINE).toBeLessThan(209);
  });

  it('adds padding and border back under border-box', () => {
    const b = composerBounds(metrics({ borderBox: true }));
    expect(b.maxBlockSize).toBe(CAP + PAD + BORDER);
    expect(b.minBlockSize).toBe(Math.ceil(LINE) + PAD + BORDER);
  });

  it('is unbounded above when nothing at all is knowable', () => {
    // no line height means no line COUNT, and no panel means no room — there is
    // no honest number to cap at, so the caller writes no `max-block-size`
    expect(composerBounds(metrics({ lineHeight: 0 })).maxBlockSize).toBe(Infinity);
    expect(composerBounds(metrics({ lineHeight: 0 })).minBlockSize).toBe(0);
  });

  it('still applies the room limit when the line height is unknowable', () => {
    const b = composerBounds(metrics({ lineHeight: 0, available: 100 + PAD + BORDER }));
    expect(b.maxBlockSize).toBe(100);
  });

  describe('the room the panel can spare', () => {
    // The layout guard: the composer is the bottom of a flex column whose
    // conversation yields height first, so in a short panel twelve lines would
    // push the options row off the bottom rather than push the feed up.
    it('stops short of the cap when the panel cannot spare twelve lines', () => {
      const room = 5 * LINE + PAD + BORDER;
      expect(composerBounds(metrics({ available: room })).maxBlockSize).toBe(
        Math.floor(5 * LINE)
      );
    });

    it('rounds the room limit DOWN — the mirror of the line cap', () => {
      // A cap a hair OVER the room available is the box overhanging its own
      // options row (#406). The two limits therefore round opposite ways, and
      // that is why one shared `Math.ceil` could not serve both.
      const room = 100.9 + PAD + BORDER;
      expect(composerBounds(metrics({ available: room })).maxBlockSize).toBe(100);
    });

    it('is ignored when the panel has more room than the cap', () => {
      expect(composerBounds(metrics({ available: 1000 })).maxBlockSize).toBe(CAP);
    });

    it('never squeezes the box below the line being typed', () => {
      // a panel with nothing to give still owes the user the line they are on;
      // overlapping the options row for one line beats a box you cannot read
      const b = composerBounds(metrics({ available: 0 }));
      expect(b.maxBlockSize).toBe(Math.ceil(LINE));
      expect(b.minBlockSize).toBe(Math.ceil(LINE));
    });
  });

  it('takes a caller-supplied cap', () => {
    expect(composerBounds(metrics(), 3).maxBlockSize).toBe(Math.ceil(3 * LINE));
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
