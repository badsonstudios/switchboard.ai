// Where a pointer-anchored menu actually goes (#641).
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
// Pure, and therefore unit-tested rather than reasoned about: the geometry is
// four comparisons and the failure mode is invisible until it is on someone
// else's screen.

/** Gap kept between the menu and the window edge, in CSS px. */
export const MENU_EDGE_MARGIN = 4;

export interface MenuPlacement {
  /** physical left, in CSS px */
  left: number;
  /** physical top, in CSS px */
  top: number;
  /** how tall the menu may be before it has to scroll inside itself */
  maxBlockSize: number;
}

/**
 * Place a menu of `size` at `anchor` inside `viewport`.
 *
 * @param anchor  where the pointer (or the keyboard's stand-in) asked for it
 * @param size    the menu's natural, unclamped size
 * @param viewport the window's client area
 */
export function placeMenu(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin: number = MENU_EDGE_MARGIN
): MenuPlacement {
  const fit = (
    at: number,
    extent: number,
    limit: number
  ): number => {
    const room = Math.max(0, limit - margin * 2);
    // a menu bigger than the window gets the whole window and scrolls inside
    const size_ = Math.min(extent, room);
    if (at + size_ <= limit - margin) return Math.max(margin, at);
    // flip: the menu's far edge lands ON the pointer, which is what a native
    // menu does and what keeps the pointer's own row visible
    const flipped = at - size_;
    if (flipped >= margin) return flipped;
    // neither side fits — sit against the far edge
    return Math.max(margin, limit - margin - size_);
  };

  return {
    left: fit(anchor.x, size.width, viewport.width),
    top: fit(anchor.y, size.height, viewport.height),
    maxBlockSize: Math.max(0, viewport.height - margin * 2),
  };
}
