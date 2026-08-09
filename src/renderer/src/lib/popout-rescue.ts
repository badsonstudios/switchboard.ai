// Bringing home a card whose popout window died without saying so (#292).
//
// #279 taught the popout REGISTRY to notice a window that closed without an
// event — killed from the task bar, lost with a crash, force-closed by the OS.
// That stopped the registry lying, but it left the SESSION where it was: as far
// as dockview is concerned the card is still in a popout group, so it is
// neither in the grid nor in a window anyone can see. The registry sweep fixes
// the bookkeeping; this fixes the user's problem.
//
// WHAT WE DO ABOUT IT is the design call, and it is "exactly what a clean close
// does": the card comes back to the grid and its session suspends. Two reasons.
// A user who closes a popout from the task bar has done the same thing as a
// user who closes it with the ⤡ button; whether dockview happened to hear the
// event is our implementation detail, and a rule that reads "closing a popout
// suspends the session — unless the close was one we missed, in which case
// something else happens" is not a rule anybody could hold in their head. And
// the alternative shape — leave it stranded, offer a "re-open it" affordance —
// keeps the session invisible until the user finds the offer, which IS the
// defect. E8's display-change rescue set the precedent: when the OS invalidates
// a window, the app puts the card somewhere visible on its own and tells the
// user afterwards.
//
// Everything that DECIDES is here and pure — which panels are stranded, and
// where a rescued one lands — for the reason lib/dock-slot gives: these rules
// are easy to get subtly wrong and impossible to exercise through a real
// DockviewApi. SessionGrid keeps only the dockview verbs.

/** dockview's group location, structurally — `getWindow` only exists on a popout. */
export interface RescueLocation {
  readonly type: string;
  readonly getWindow?: () => Window | null;
}

/** The shape of a dockview group this module needs. */
export interface RescueGroup {
  readonly id: string;
  readonly panels: readonly unknown[];
  readonly api: { readonly location: RescueLocation };
}

/** The shape of a dockview panel this module needs. */
export interface RescuePanel {
  readonly id: string;
  readonly group: RescueGroup;
}

/**
 * Has this popout window gone?
 *
 * `closed === true` or no window object at all. A window that REFUSES to answer
 * is treated as alive, deliberately and for the same reason `popout-windows`
 * keeps it in the registry: guessing "dead" about a living popout would tear a
 * session out of a window the user is looking at, while guessing "alive" about
 * a dead one costs one more sweep. Only a window that says so in as many words
 * loses its card.
 */
export function popoutWindowGone(loc: RescueLocation): boolean {
  if (loc.type !== 'popout') return false;
  try {
    const win = loc.getWindow?.();
    return !win || win.closed === true;
  } catch {
    return false;
  }
}

/** Is this panel sitting in a popout window that is gone? */
export function isStranded(panel: RescuePanel): boolean {
  return popoutWindowGone(panel.group.api.location);
}

/**
 * The stranded panels, grouped by the dead group they are in.
 *
 * Grouped because a popout window can host more than one card (they are
 * dragged in), and cards that shared a window should still share one when they
 * come home — a clean close keeps them together, so this must too.
 *
 * Insertion-ordered, so the rescue is deterministic and the first card in a
 * window is the one that picks where the group lands.
 */
export function strandedByGroup<T extends RescuePanel>(panels: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const panel of panels) {
    if (!isStranded(panel)) continue;
    const list = out.get(panel.group.id);
    if (list) list.push(panel);
    else out.set(panel.group.id, [panel]);
  }
  return out;
}

/**
 * Where a rescued card comes home to: an EMPTY group in the grid, if there is
 * one, otherwise nothing (the caller makes a group).
 *
 * An empty grid group is not a coincidence — dockview deletes a group the
 * moment its last panel leaves, with two exceptions, and both of them are
 * exactly where this card belongs. Popping a card out leaves its old group
 * behind as an empty hidden shell, and closing the window normally is what
 * puts the card back INTO that shell; landing there is therefore the same spot
 * a clean close would have chosen. The other exception is the watermark group
 * of an empty workspace, which is the only thing in the grid and so is also
 * where the card should go.
 *
 * Best-effort, and worth being honest about in the same way `placeAt` is: with
 * two windows dead at once the second card may take the first one's shell.
 * Both shells are empty and both are in the grid, so the cost is a card
 * arriving one slot from where it left — against a card nobody can see at all.
 */
export function rescueHome<T extends RescueGroup>(groups: readonly T[]): T | undefined {
  return groups.find((g) => g.api.location.type === 'grid' && g.panels.length === 0);
}
