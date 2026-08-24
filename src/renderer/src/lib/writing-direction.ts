// Which way the app reads, and the one safe way to ask (#642).
//
// Two coordinate systems meet in every pointer-driven placement and they do not
// agree. A DOM event's `clientX` is PHYSICAL — a distance from the window's LEFT
// edge, in every writing mode, because that is what the spec says. DESIGN §5.21
// commits us to LOGICAL styles ("logical CSS properties (`margin-inline-start`,
// not `margin-left`) throughout"), and a logical property counts from the
// inline-START edge, which is the RIGHT one under `dir="rtl"`.
//
// Feeding one to the other is silent, invisible in English, and off by the
// whole width of the window in Arabic or Hebrew — which is exactly how the
// rail's context menu ended up opening off-screen. Anything converting a
// pointer coordinate into a logical one needs this type; nothing should read
// the direction any other way.

/** The inline direction a subtree is laid out in. */
export type WritingDirection = 'ltr' | 'rtl';

/**
 * The writing direction an element is ACTUALLY laid out in.
 *
 * The element and not the document, deliberately: `dir` is inheritable, a
 * right-to-left locale sets it at the root, but any subtree can carry its own —
 * and a placement computed from the document's answer would be wrong in exactly
 * the case that is hardest to notice.
 *
 * The computed style is the only honest source: a `dir` attribute is not the
 * only thing that sets it (the CSS `direction` property does too), and an
 * element without one inherits from an ancestor that may be far away.
 */
export function directionOf(el: Element): WritingDirection {
  return el.ownerDocument.defaultView?.getComputedStyle(el).direction === 'rtl' ? 'rtl' : 'ltr';
}
