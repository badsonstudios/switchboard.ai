// "You landed here" — the brief outline on a session you just asked for
// (#1456).
//
// Picking a session from any list (the rail, the tab pills, the Events drawer,
// the palette, a toast) moves you to it. In a busy grid, or in a window that has
// just come forward, the eye still has to find WHICH pane that was, so the pane
// outlines itself in the app's accent and the outline fades.
//
// THE RULES, each one a line of the issue:
// - only for what the person asked for: the caller decides that, and the
//   attention auto-focus, the auto-placement and the launch restore never call
//   this (`SessionGrid`'s `land` option);
// - a repeat RESTARTS it and never stacks: one attribute and one timer per
//   element, the timer replaced and the animation re-armed;
// - less motion: the same outline standing still, then gone — chosen here from
//   the element's OWN window, because a popped-out pane is in another document
//   (`instanceof` and the main window's globals both lie about it);
// - it clears itself; nothing has to remember to take it off.
//
// The look is CSS (`[data-landed]` in theme/dockview-tokens.css), in the per-theme
// accent ink the focus ring uses, so a theme switch needs nothing here.

/** How long the fading outline lasts — the CSS animation's duration too. */
export const LANDING_FLASH_MS = 700;
/** How long the still outline stays when the system asks for less motion. */
export const LANDING_STATIC_MS = 900;

/** The attribute the stylesheet and the e2e read. `motion` or `static`. */
export const LANDED_ATTR = 'data-landed';

/** The slice of an element this needs. Structural: a popout's nodes are not
 *  `instanceof` the main window's `Element`. */
export interface LandingTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  readonly ownerDocument: { defaultView: Pick<Window, 'matchMedia'> | null } | null;
  readonly offsetWidth?: number;
}

const timers = new WeakMap<LandingTarget, ReturnType<typeof setTimeout>>();

/** Whether the window this element is drawn in asks for less motion. */
export function prefersLessMotion(el: LandingTarget): boolean {
  try {
    const view = el.ownerDocument?.defaultView;
    return view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch {
    return false;
  }
}

/**
 * Outline `el` as the place the person just landed. Safe to call again while it
 * runs: the outline starts over rather than doubling up.
 */
export function flashLanding(el: LandingTarget | null | undefined): void {
  if (!el) return;
  const still = prefersLessMotion(el);
  const prior = timers.get(el);
  if (prior !== undefined) clearTimeout(prior);
  if (el.getAttribute(LANDED_ATTR) !== null) {
    // RE-ARM the animation: a CSS animation does not restart when the same
    // attribute value is set again, so take it off and read layout once
    // (the read is what makes the browser notice the gap) before putting it back
    el.removeAttribute(LANDED_ATTR);
    void el.offsetWidth;
  }
  el.setAttribute(LANDED_ATTR, still ? 'static' : 'motion');
  timers.set(
    el,
    setTimeout(
      () => {
        timers.delete(el);
        el.removeAttribute(LANDED_ATTR);
      },
      still ? LANDING_STATIC_MS : LANDING_FLASH_MS
    )
  );
}
