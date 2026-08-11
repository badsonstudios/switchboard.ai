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

/**
 * `line-height: normal` is ~1.2 in every engine, but the composer sets its own
 * 1.45 ratio — so when a computed value can't be read, the composer's own
 * number is a closer guess than the generic one.
 */
const FALLBACK_LINE_RATIO = 1.45;

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
  // A line-height we could not resolve means we cannot count lines — cap and
  // floor both stop meaning anything, so fit the content and never trap it
  // behind a scrollbar we can't size.
  if (!(m.lineHeight > 0)) {
    return { blockSize: box(content, m), overflowY: 'hidden' };
  }
  const max = m.lineHeight * maxLines;
  const fitted = Math.min(Math.max(content, m.lineHeight), max);
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
  const font = Number.isFinite(parsedFont) && parsedFont > 0 ? parsedFont : 12;
  const raw = (lineHeight ?? '').trim();
  if (raw.endsWith('px')) {
    const px = Number.parseFloat(raw);
    if (Number.isFinite(px) && px > 0) return px;
  } else {
    const ratio = Number(raw); // unitless multiplier, e.g. "1.45"
    if (Number.isFinite(ratio) && ratio > 0) return ratio * font;
  }
  return font * FALLBACK_LINE_RATIO;
}
