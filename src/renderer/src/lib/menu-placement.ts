// Where a pointer-anchored menu actually goes (#641, #642).
//
// A context menu is `position: fixed` and opened at the pointer, so the
// coordinates the event hands you are a REQUEST, not an answer: nothing about
// `contextmenu` knows how tall the menu is, and a fixed box that runs past the
// window edge cannot be scrolled back — there is no scroll container between it
// and the viewport. The overflowing items are simply unreachable, by mouse and
// by Playwright alike ("element is outside of the viewport"), which is how this
// surfaced: #559 grew the rail's menu by one section, the bottom item landed
// 7px below the windows-latest runner's 655px viewport, and the click retried
// for 30s against an element that was visible, enabled, stable and off-screen.
//
// Every native menu answers this the same way and so does this: keep the asked
// position when it fits, FLIP to the other side of the pointer when it does
// not, and fall back to sitting against the edge when neither side has room.
// The last case is the one a margin alone cannot save — a menu taller than the
// window — so the caller also gets a `maxBlockSize` to scroll inside.
//
// ## Physical in, logical out (#642)
//
// The two coordinate systems in play do not agree, and the first version of
// this quietly mixed them. A pointer event's `clientX` is PHYSICAL — a distance
// from the window's left edge, in every writing mode, because that is what the
// DOM defines. DESIGN §5.21 says our styles are LOGICAL ("logical CSS
// properties (`margin-inline-start`, not `margin-left`) throughout"), and the
// rail duly wrote `insetInlineStart`. Under `dir="rtl"` that property counts
// from the RIGHT edge, so a right-click 100px from the left of the window
// opened the menu 100px from the RIGHT of it — the full width of the window
// away from the pointer, in the one place a menu must never be.
//
// So the axis is mirrored HERE, once, where it can be unit-tested: the anchor
// arrives physical (`clientX`), the answer leaves logical (`insetInlineStart`),
// and the caller keeps its logical properties. The mirror also buys the correct
// RTL BEHAVIOUR for free — in mirrored space "grow forward from the pointer"
// means growing leftward on screen, which is what a native RTL menu does.

/** Gap kept between the menu and the window edge, in CSS px. */
export const MENU_EDGE_MARGIN = 4;

/** The inline direction the menu will be laid out in. */
export type WritingDirection = 'ltr' | 'rtl';

export interface MenuPlacement {
  /**
   * Offset from the inline START edge, in CSS px — the left edge under `ltr`,
   * the right edge under `rtl`. Feed it straight to `insetInlineStart`.
   */
  insetInlineStart: number;
  /** Offset from the block START edge (the top), in CSS px. */
  insetBlockStart: number;
  /** how tall the menu may be before it has to scroll inside itself */
  maxBlockSize: number;
}

export interface PlaceMenuOptions {
  /** the writing direction of the menu's own subtree; defaults to `ltr` */
  direction?: WritingDirection;
  /** gap kept between the menu and the window edge; defaults to {@link MENU_EDGE_MARGIN} */
  margin?: number;
}

/**
 * Place a menu of `size` at `anchor` inside `viewport`.
 *
 * @param anchor  where the pointer (or the keyboard's stand-in) asked for it,
 *   in PHYSICAL client coordinates — i.e. exactly `event.clientX/clientY`
 * @param size    the menu's natural, unclamped size
 * @param viewport the window's client area
 * @param options  writing direction and edge margin
 */
export function placeMenu(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  options: PlaceMenuOptions = {}
): MenuPlacement {
  const { direction = 'ltr', margin = MENU_EDGE_MARGIN } = options;

  const fit = (at: number, extent: number, limit: number): number => {
    const room = Math.max(0, limit - margin * 2);
    // a menu bigger than the window gets the whole window and scrolls inside
    const size_ = Math.min(extent, room);
    // the far edge of the window, expressed as a start offset. Every branch
    // below is clamped into `[margin, last]` rather than trusted: an anchor
    // OUTSIDE the viewport (a mirrored RTL coordinate, a stale event, a
    // synthetic point) otherwise flips to a position just as far outside it,
    // and `fit` is the one place that promises the box lands on screen.
    const last = Math.max(margin, limit - margin - size_);
    const clamp = (v: number): number => Math.min(Math.max(v, margin), last);
    if (at + size_ <= limit - margin) return clamp(at);
    // flip: the menu's far edge lands ON the pointer, which is what a native
    // menu does and what keeps the pointer's own row visible
    const flipped = at - size_;
    if (flipped >= margin) return clamp(flipped);
    // neither side fits — sit against the far edge
    return last;
  };

  // Mirror the inline axis under RTL so the rest of the arithmetic — and every
  // "flip", "far edge" and "margin" in it — is stated once, in inline-start
  // terms, which is the space the CSS property is in.
  const anchorInline = direction === 'rtl' ? viewport.width - anchor.x : anchor.x;

  return {
    insetInlineStart: fit(anchorInline, size.width, viewport.width),
    // The block axis needs no mirror: `direction` does not touch it, and the
    // app's writing-mode is horizontal-tb everywhere (a vertical writing mode
    // would swap the two axes wholesale, which is a different piece of work).
    insetBlockStart: fit(anchor.y, size.height, viewport.height),
    maxBlockSize: Math.max(0, viewport.height - margin * 2),
  };
}
