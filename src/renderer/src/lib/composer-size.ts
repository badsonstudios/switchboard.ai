// Composer auto-grow (P2-E10-08, §5.10).
//
// The composer used to size itself with `rows={min(6, draft.split('\n').length)}`
// — a count of HARD NEWLINES. Soft wrapping is invisible to that rule, so a
// pasted paragraph that renders as eight lines stayed a one-row slot with the
// rest hidden, and the nominal 6-row cap was only reachable by pressing
// Shift+Enter six times. The box has to be sized by what the browser ACTUALLY
// RENDERED — soft wrapping included.
//
// WHO DOES THE GROWING, AND WHY IT MOVED (#716). It used to be this module plus
// a JS measurement on every keystroke: release the box's height, read back
// `scrollHeight`, write the fitted height, restore `scrollTop`. That works, and
// it is what `scrollHeight` is for — but a write→read pair forces a SYNCHRONOUS
// layout, and a forced layout is DOCUMENT-wide. Its cost is therefore the size
// of the conversation scrolled above the box: measured on the dev desktop at
// 0.27ms per keystroke on an empty feed and **36.5ms at 400 turns** (7,879
// nodes), which is the "keystrokes buffer and appear in bursts" Dan reported,
// and why a laptop feels it and a desktop barely does.
//
// The growing is now CSS's job — `field-sizing: content` on the textarea
// (`.composer-box`, tokens.css) — which was measured to cost exactly what
// having no auto-grow at all costs. What is left for JS is the part CSS cannot
// express: WHERE THE BOX MUST STOP. That is this module.
//
// The arithmetic lives here, away from the DOM, for two reasons: it is the part
// that can be wrong (box-sizing, the cap, the floor, which limit wins), and a
// rule pinned in a pure test cannot silently regress to newline counting.
//
// The bounds cannot change from TYPING — only from the panel resizing or the
// attachment strip changing height — which is the whole reason the keystroke
// path is now free of layout entirely.

/** Owner call, 2026-08-11 (#406): grow to twelve rendered lines, then scroll. */
export const COMPOSER_MAX_LINES = 12;

/** The composer's own type. Exported so the style prop and the fallback below
 *  cannot drift apart — the fallback claims to BE the composer's ratio. */
export const COMPOSER_FONT_SIZE = 12;
export const COMPOSER_LINE_RATIO = 1.45;

/**
 * What the DOM reports about the textarea and the room around it.
 *
 * Note what is NOT here any more: `scrollHeight`. Reading it is what forced the
 * per-keystroke layout (#716) — and now that CSS grows the box, nothing needs
 * to know how tall the content currently is, only how tall it may become.
 */
export interface ComposerMetrics {
  /** one rendered line, in px — the floor, and the unit the cap counts in */
  lineHeight: number;
  /** block-start + block-end padding, in px */
  padding: number;
  /** block-start + block-end border, in px */
  border: number;
  /** `box-sizing: border-box` — i.e. the bounds we write must swallow padding + border */
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

/** The two numbers CSS grows the box BETWEEN. Both are border-box px. */
export interface ComposerBounds {
  /** `min-block-size` — one rendered line */
  minBlockSize: number;
  /**
   * `max-block-size`, or `Infinity` when neither limit is knowable (no
   * resolvable line-height AND no measurable panel). The caller writes no
   * `max-block-size` at all for that, rather than inventing a number: an
   * unbounded box is recoverable, a wrongly-short one hides what you typed.
   */
  maxBlockSize: number;
}

/**
 * Where the box must stop growing — at least one line, at most `maxLines`, and
 * never taller than the room its panel can spare.
 *
 * ROUNDING GOES A DIFFERENT WAY FOR EACH LIMIT, deliberately. The line cap is
 * rounded UP because sub-pixel line-heights (12px × 1.45 = 17.4, ×12 =
 * 208.79999999999998) leave a cap a hair short of the text it was measured to
 * show, which clips the last line. The room limit is rounded DOWN for the
 * mirror-image reason: a cap a hair over the room available is the box
 * overhanging its own options row (#406). The old code ceil'd one number for
 * both jobs, which was only ever safe because the room limit had slack.
 */
export function composerBounds(m: ComposerMetrics, maxLines = COMPOSER_MAX_LINES): ComposerBounds {
  // A line-height we could not resolve means we cannot count lines, so the line
  // cap simply does not apply — the room the panel has is a real limit either
  // way, and a floor of zero is the browser's own minimum.
  const floor = m.lineHeight > 0 ? Math.ceil(m.lineHeight) : 0;
  const byLines = m.lineHeight > 0 ? Math.ceil(m.lineHeight * maxLines) : Infinity;
  const byRoom =
    m.available === undefined
      ? Infinity
      : Math.floor(Math.max(0, m.available - m.padding - m.border));
  // one line always beats both limits: a box too small to show the line being
  // typed is not a composer
  const cap = Math.max(Math.min(byLines, byRoom), floor);
  return {
    minBlockSize: box(floor, m),
    maxBlockSize: Number.isFinite(cap) ? box(cap, m) : Infinity,
  };
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
