// Composer auto-grow (P2-E10-08, §5.10).
//
// The composer used to size itself with `rows={min(6, draft.split('\n').length)}`
// — a count of HARD NEWLINES. Soft wrapping is invisible to that rule, so a
// pasted paragraph that renders as eight lines stayed a one-row slot with the
// rest hidden, and the nominal 6-row cap was only reachable by pressing
// Shift+Enter six times. The box has to be sized by what the browser ACTUALLY
// RENDERED, which is what `scrollHeight` reports.
//
// The arithmetic lives here, away from the DOM, for two reasons: it is the part
// that can be wrong (box-sizing, the cap, the floor, when a scrollbar is owed),
// and a rule pinned in a pure test cannot silently regress to newline counting.
// The component's job is only to MEASURE — reset the height, read scrollHeight,
// hand the numbers over.

/** Owner call, 2026-08-11 (#406): grow to twelve rendered lines, then scroll. */
export const COMPOSER_MAX_LINES = 12;

/** The composer's own type. Exported so the style prop and the fallback below
 *  cannot drift apart — the fallback claims to BE the composer's ratio. */
export const COMPOSER_FONT_SIZE = 12;
export const COMPOSER_LINE_RATIO = 1.45;

/** What the DOM reports about a textarea whose height has been released. */
export interface ComposerMetrics {
  /** `scrollHeight` measured with the height reset — rendered content + block padding */
  scrollHeight: number;
  /** one rendered line, in px */
  lineHeight: number;
  /** block-start + block-end padding, in px (`scrollHeight` includes it) */
  padding: number;
  /** block-start + block-end border, in px (`scrollHeight` does NOT include it) */
  border: number;
  /** `box-sizing: border-box` — i.e. the height we set must swallow padding + border */
  borderBox: boolean;
  /**
   * The tallest the box may be (border-box px) given what its panel can spare,
   * or undefined when nothing is measurable and the line cap is the only limit.
   *
   * The 12-line cap is a READING limit, not a fitting one: the composer is the
   * bottom of a flex column whose conversation yields height first, so in a
   * short panel — a small pop-out, a splitter dragged up — twelve lines would
   * eat the feed and then push the options row off the panel entirely. The
   * layout guard in #406's spec is exactly that: growth pushes the feed up, it
   * does not overlap a neighbour. Whichever limit is lower wins; one line
   * always survives both.
   */
  available?: number;
}

export interface ComposerSize {
  /** the height to write back, in px */
  blockSize: number;
  /** `auto` only past the cap: an always-auto textarea flickers a scrollbar mid-measure */
  overflowY: 'hidden' | 'auto';
}

/**
 * The height the box should take for the content it just rendered — at least
 * one line, at most `maxLines`, with an inner scrollbar past that.
 */
export function composerSize(m: ComposerMetrics, maxLines = COMPOSER_MAX_LINES): ComposerSize {
  // rendered content only: scrollHeight carries the padding with it
  const content = Math.max(0, m.scrollHeight - m.padding);
  // A line-height we could not resolve means we cannot count lines, so the line
  // cap simply does not apply — the room the panel has is a real limit either
  // way, and a floor of zero is the browser's own minimum.
  const floor = m.lineHeight > 0 ? m.lineHeight : 0;
  const byLines = m.lineHeight > 0 ? m.lineHeight * maxLines : Infinity;
  const byRoom =
    m.available === undefined ? Infinity : Math.max(0, m.available - m.padding - m.border);
  // one line always beats both limits: a box too small to show the line being
  // typed is not a composer
  const max = Math.max(Math.min(byLines, byRoom), floor);
  const fitted = Math.min(Math.max(content, floor), max);
  // half a pixel of slack: sub-pixel line-heights (12px × 1.45 = 17.4) make
  // `content` land a hair over the cap on the exact line that fills it, and a
  // scrollbar for nothing is worse than a rounding error
  return { blockSize: box(fitted, m), overflowY: content > max + 0.5 ? 'auto' : 'hidden' };
}

/** content height -> the number `height` wants, in this box model */
function box(content: number, m: ComposerMetrics): number {
  return m.borderBox ? content + m.padding + m.border : content;
}

/**
 * Resolve a computed `line-height` to px.
 *
 * A browser resolves the ratio for us ("17.4px"); jsdom hands back the
 * specified value ("1.45"), and `normal` is legal everywhere. Parsing all three
 * here keeps the component free of the distinction — and keeps the unit tests
 * measuring the same lines the app does.
 */
export function resolveLineHeight(lineHeight: string, fontSize: string): number {
  const parsedFont = Number.parseFloat(fontSize);
  const font = Number.isFinite(parsedFont) && parsedFont > 0 ? parsedFont : COMPOSER_FONT_SIZE;
  const raw = (lineHeight ?? '').trim();
  if (raw.endsWith('px')) {
    const px = Number.parseFloat(raw);
    if (Number.isFinite(px) && px > 0) return px;
  } else {
    const ratio = Number(raw); // unitless multiplier, e.g. "1.45"
    if (Number.isFinite(ratio) && ratio > 0) return ratio * font;
  }
  return font * COMPOSER_LINE_RATIO;
}
