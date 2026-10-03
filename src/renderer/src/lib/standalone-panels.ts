// Which panel has the user's attention, when it is neither a session card nor
// one of a card's tabs (#533, #1054).
//
// A §5.30 document viewer and a `gitdiff-` diff panel are both dockview panels
// with no card behind them, and both are reachable in EITHER window — the main
// one, or an OS window dockview popped them out into. `find.open` is the
// command that needs to know, and it needs the same rule for both kinds. This
// is that rule, written once and outside `SessionGrid` so it can be tested
// without mounting a grid.

/** The slice of dockview's API this reads. Structural, so a test can build one. */
export interface PanelShape {
  readonly id: string;
}
export interface GroupShape {
  readonly activePanel?: PanelShape | undefined;
  readonly api: {
    // every dockview location but `popout` is "somewhere in the main window",
    // and only the popout one is read
    readonly location:
      | { readonly type: 'grid' | 'floating' | 'edge' }
      | { readonly type: 'popout'; getWindow(): Window };
  };
}
export interface DockShape {
  readonly activePanel?: PanelShape | undefined;
  readonly groups: readonly GroupShape[];
}

/**
 * The id of the panel of a given kind that has the user's attention, or null.
 *
 * WHICH WINDOW THE KEYSTROKE CAME FROM IS AN ARGUMENT, not a guess. Dockview's
 * `activePanel` does NOT follow the user into another OS window: pop a viewer
 * out and the grid's own panel stays active, so a keystroke typed in the
 * popout would resolve to whatever is sitting behind it. The popout key bridge
 * knows which window it attached its listener to, and passes it.
 *
 * - With a `sourceWindow`: the panel SHOWN in the popout group that window
 *   belongs to, if it is of this kind. A window we cannot place among the
 *   popout groups answers null — NOT the grid's active panel — so a keystroke
 *   from a window holding a session card behaves exactly as it always did.
 * - Without one: the grid's active panel, if it is of this kind.
 */
export function activeStandalonePanelId(
  api: DockShape | null | undefined,
  sourceWindow: Window | undefined,
  isKind: (panelId: string) => boolean
): string | null {
  if (!api) return null;
  if (sourceWindow) {
    for (const group of api.groups) {
      const loc = group.api.location;
      if (loc.type !== 'popout') continue;
      let win: Window | null = null;
      try {
        win = loc.getWindow() ?? null;
      } catch {
        win = null; // torn down between the lookup and the read
      }
      if (win !== sourceWindow) continue;
      const shown = group.activePanel;
      return shown && isKind(shown.id) ? shown.id : null;
    }
    return null;
  }
  const panel = api.activePanel;
  return panel && isKind(panel.id) ? panel.id : null;
}
