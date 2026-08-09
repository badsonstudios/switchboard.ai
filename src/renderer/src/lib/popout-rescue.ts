// Bringing home a card whose popout window died without saying so (#292).
//
// #279 taught the popout REGISTRY to notice a window that closed without an
// event — killed from the task bar, lost with a crash, force-closed by the OS.
// That stopped the registry lying, but it left the SESSION where it was: as far
// as dockview is concerned the card is still in a popout group, so it is
// neither in the grid nor in a window anyone can see. The registry sweep fixes
// the bookkeeping; this fixes the user's problem.
//
// WHAT WE DO ABOUT IT is the design call, and it is "the outcome of a clean
// close": the card is back in the grid and its session is suspended. A user who
// closes a popout from the task bar has done the same thing as a user who
// closes it with the ⤡ button; whether dockview happened to hear the event is
// our implementation detail, and a rule that reads "closing a popout suspends
// the session — unless the close was one we missed, in which case something
// else happens" is not a rule anybody could hold in their head. The alternative
// shape — leave it stranded and offer a "re-open it" affordance — keeps the
// session invisible until the user finds the offer, which IS the defect. E8's
// display-change rescue set the precedent: when the OS invalidates a window,
// the app puts the card somewhere visible on its own and says so afterwards.
//
// The card is REBUILT rather than carried back, because a destroyed document
// takes its nodes' event listeners with it — `rescueStrandedPopouts` in
// SessionGrid has that story, next to the code it dictates.
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
  // A popout location with no way to ask is the "cannot ask" case, not the
  // "gone" case — `getWindow` is optional here only because this type is
  // structural, and inventing a death from its absence is the one mistake this
  // function must not make. Its ANSWER being null is different: that is
  // dockview having dropped the window itself.
  if (typeof loc.getWindow !== 'function') return false;
  try {
    const win = loc.getWindow();
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

// WHERE a rescued card lands is deliberately NOT decided here, because there is
// no decision left to make: the card is rebuilt through the ordinary reveal, so
// it lands wherever a revealed card lands (lib/dock-slot's `placeAt`) — and its
// remembered slot names a popout group that no longer exists, so that is "a
// group of its own in the grid". The one thing worth knowing is that it must
// NOT come back as a new popout window: `popoutBoxOf` refuses to record a rect
// for a closed window, so the slot carries no box and `placeAt` asks for no
// window. Re-opening the window a user just killed is the one outcome nobody
// would forgive.
