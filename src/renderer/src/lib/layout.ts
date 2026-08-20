// Popout-layout persistence helpers (P2-E8-02). dockview serializes popout
// groups with their url + on-screen position, so the workspace layout already
// round-trips them — but three things must be fixed on restore:
//  1. the stored url carries the loopback server's port, which is RANDOM each
//     launch, so rewrite every popout url to the current origin;
//  2. if a popout's saved position is off every current display (monitor
//     unplugged), rescue it — null the position so dockview reopens it on/near
//     the main window instead of a monitor that no longer exists;
//  3. a popout window must not be reopened holding a panel the restore is
//     about to prune, nor at all if that leaves it empty — see
//     `prunePopoutGroups` (#494).

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PopoutGroup {
  url?: string;
  position?: Box | null;
  [k: string]: unknown;
}
interface Layout {
  popoutGroups?: PopoutGroup[];
  [k: string]: unknown;
}

/** At least a usable corner of the popout is visible on some display. */
export function boxOnAnyDisplay(box: Box, workAreas: WorkArea[]): boolean {
  return workAreas.some(
    (a) =>
      box.left < a.x + a.width - 80 &&
      box.left + box.width > a.x + 80 &&
      box.top < a.y + a.height - 40 &&
      box.top + box.height > a.y + 20
  );
}

/** A popout that was rescued into the grid because its display vanished —
 *  kept so the E8-06 reconnect offer can put it back when the display returns. */
export interface RescuedPopout {
  panelIds: string[];
  box: Box;
}

/* ---- a popout window is not opened just to be emptied (#494) ---------------
 *
 * `SessionGrid`'s restore prunes panels right after `fromJSON`: every `diff-`
 * and `doc-` panel, because both are DERIVED (a diff is recomputed, and
 * "restoring open viewers across relaunch" is named in E16's *Not in scope*),
 * and every `session-` panel whose card record is gone. That is fine for a
 * panel in the GRID, which `fromJSON` builds synchronously - but it is a race
 * for a panel in a POPOUT, and the race leaves a real user with an empty second
 * window on their screen.
 *
 * MEASURED, not reasoned about (2026-08-20, the instrumented repro on #494):
 * dockview 7 restores popouts on a TIMER (`scheduleRestoration`,
 * `DESERIALIZATION_POPOUT_DELAY_MS`), and `addPopoutGroup` opens the OS window
 * first and wires the group to it only once the child window has LOADED. So
 * right after `fromJSON` the restored `doc-1` sits in a group whose location is
 * still `grid` -
 *
 *     [diag] prune-start groups=1:grid:session-...|diff-... , 2:grid: , 3:grid:doc-1
 *     [popout] onDidAddPopoutGroup (opened OK)      <- 130 ms LATER
 *
 * - and the prune takes its last panel away before dockview has anything to
 * hang the "last panel left, so close the window" rule on: that rule lives in
 * `doRemoveGroup`, under `group.api.location.type === 'popout'`, which is not
 * true yet. The window then finishes opening, empty, and nothing ever closes
 * it. Which side of the ~130 ms wins depends on how long the renderer's
 * `sessions.knownCards()` IPC takes, i.e. on machine load - the flake in #494.
 *
 * The fix is not a longer wait, it is not opening the window: the prune's own
 * verdict is applied to the layout's popout groups BEFORE `fromJSON` sees it,
 * so a window that would end up empty is never created and a window that
 * survives never holds a panel the prune is coming for. Nothing races because
 * nothing is created. A user relaunch also stops flashing a viewer window open
 * and shut.
 *
 * The SAME predicate the prune loop uses is passed in - not a copy of it. Two
 * spellings of "this panel is not coming back" that could drift apart is
 * exactly how this bug would grow back on the `session-` half, which strands a
 * window the same way and was live until this function took the argument.
 *
 * Runs BEFORE `sanitizePopoutLayout` on purpose, so a window we are not
 * reopening is never offered to the E8-06 display-reconnect prompt either -
 * restoring an empty window later is no better than restoring one now.
 */

/** Panels the restore throws away outright: `diff-` and `doc-`.
 *  The one spelling of the DERIVED rule; the caller's full predicate adds the
 *  `session-`-with-no-record half, which needs state this module has none of. */
export function isDerivedPanelId(id: string): boolean {
  return /^(diff|doc)-/.test(id);
}

/** One serialized dockview GROUP - the `data` of a grid leaf, or of a popout. */
interface SerializedGroup {
  views?: unknown;
  activeView?: unknown;
  id?: unknown;
  [k: string]: unknown;
}
/** One node of a serialized gridview tree: a `branch` of nodes, or a `leaf`. */
interface SerializedNode {
  type?: unknown;
  data?: unknown;
  [k: string]: unknown;
}

/** Every leaf `data` in a serialized gridview tree, in order.
 *  A popout window can host a nested grid of several groups (dockview 7), so a
 *  popout entry carries either a single `data` group or a whole `grid`. */
function leafGroups(node: unknown, out: SerializedGroup[] = []): SerializedGroup[] {
  if (!node || typeof node !== 'object') return out;
  const n = node as SerializedNode;
  if (n.type === 'leaf') {
    if (n.data && typeof n.data === 'object') out.push(n.data as SerializedGroup);
    return out;
  }
  if (Array.isArray(n.data)) for (const child of n.data) leafGroups(child, out);
  return out;
}

/**
 * Delete the leaves `doomed` names, and any branch they leave childless.
 *
 * NEVER empties a branch: one that would lose every child keeps all of them,
 * because `Gridview.deserialize` builds a `BranchNode` straight from this array
 * and a grid with no views at all is a worse outcome than a stale husk. In
 * practice that guard fires only when the husk is the ONLY thing in the grid -
 * a viewer popped out of an app with no sessions open (`session.spec.ts`'s
 * #462 case). Sizes are not touched: `Gridview.deserialize` calls `layout()`
 * immediately afterwards, which re-proportions whatever is left.
 */
function pruneLeaves(node: unknown, doomed: (g: SerializedGroup) => boolean): void {
  if (!node || typeof node !== 'object') return;
  const n = node as SerializedNode;
  if (n.type !== 'branch' || !Array.isArray(n.data)) return;
  const children = n.data as unknown[];
  for (const child of children) pruneLeaves(child, doomed);
  const survivors = children.filter((child) => {
    const c = child as SerializedNode;
    if (c.type === 'leaf')
      return !(c.data && typeof c.data === 'object' && doomed(c.data as SerializedGroup));
    // a branch that just lost its last child goes with it
    return !(c.type === 'branch' && Array.isArray(c.data) && c.data.length === 0);
  });
  if (survivors.length > 0 && survivors.length < children.length) n.data = survivors;
}

/** How many views a serialized group has left. */
function viewCount(g: SerializedGroup): number {
  return Array.isArray(g.views) ? g.views.length : 0;
}

/** Take the panels that are not coming back out of one serialized group, and
 *  report how many are left - so the caller can tell an emptied group from a
 *  merely thinned one. */
function keepViews(g: SerializedGroup, willBePruned: (id: string) => boolean): number {
  const views = Array.isArray(g.views) ? g.views : [];
  g.views = views.filter((v) => typeof v !== 'string' || !willBePruned(v));
  // the active tab may be one of the ones just removed; dockview falls back to
  // the last panel when `activeView` names nobody
  if (typeof g.activeView === 'string' && willBePruned(g.activeView)) delete g.activeView;
  return viewCount(g);
}

/**
 * Apply the restore's prune to the layout's POPOUT groups, before `fromJSON`
 * opens their windows (#494).
 *
 * `willBePruned` is the restore's own verdict on a panel id. Every popout group
 * loses the panels it names; a popout WINDOW left with nothing is dropped
 * entirely, and so is the hidden dock-back husk it would have left in the grid
 * - dockview removes that husk itself when a popout window closes
 * (`doRemoveGroup`), and a window we never open never closes, so without this
 * the layout would collect one more husk per pop-out-then-quit.
 *
 * The GRID is otherwise untouched: `fromJSON` builds it synchronously, so the
 * prune loop does its own half there with nothing to race.
 *
 * Returns a COPY - the caller's layout object is left untouched, so a failure
 * downstream cannot leave a half-edited layout behind to be saved. (The copy is
 * a `structuredClone`, which is safe on the layout as it arrives here - main
 * sends it over IPC, so it is structured-cloneable by construction.)
 *
 * Unreferenced entries in `panels` are left alone deliberately: at this call
 * site `fromJSON` runs once on an empty grid, so a panel is only ever built
 * from the ids in a group's `views`, and an orphan definition costs nothing
 * where pruning it is one more chance to corrupt a restore. `tabGroups` is left
 * alone for the same reason - it can still name a pruned id, and dockview drops
 * a tab group whose panels do not exist.
 */
export function prunePopoutGroups(
  layout: unknown,
  willBePruned: (panelId: string) => boolean
): unknown {
  if (!layout || typeof layout !== 'object') return layout;
  const l = structuredClone(layout) as Layout & { grid?: SerializedNode; activeGroup?: unknown };
  if (!Array.isArray(l.popoutGroups)) return l;
  const droppedGroupIds = new Set<string>();
  const droppedHusks = new Set<string>();
  const liveHusks = new Set<string>();
  l.popoutGroups = l.popoutGroups.filter((p) => {
    const nested = (p as { grid?: SerializedNode }).grid;
    const anchor = p.data && typeof p.data === 'object' ? (p.data as SerializedGroup) : undefined;
    const groups = nested ? leafGroups(nested.root) : anchor ? [anchor] : [];
    let survivors = 0;
    for (const g of groups) survivors += keepViews(g, willBePruned);
    // The anchor copy is not what dockview restores when `grid` is present (see
    // `deserializePopoutWindows`), but `sanitizePopoutLayout` still reads it to
    // build the E8-06 rescue stash - so a panel that is not coming back must
    // not be named there either.
    if (nested && anchor && !groups.includes(anchor)) keepViews(anchor, willBePruned);
    const husk = (p as { gridReferenceGroup?: unknown }).gridReferenceGroup;
    if (survivors === 0) {
      for (const g of groups) if (typeof g.id === 'string') droppedGroupIds.add(g.id);
      if (typeof husk === 'string') droppedHusks.add(husk);
      return false;
    }
    // A group inside a SURVIVING window that lost everything is not a husk to
    // dock back into - it is a blank pane beside its neighbours, in a window
    // whose layout the user cannot easily repair. dockview used to take it away
    // with the panel; now nothing would.
    if (nested) pruneLeaves(nested.root, (g) => viewCount(g) === 0);
    if (typeof husk === 'string') liveHusks.add(husk);
    return true;
  });
  // A husk shared with a window that IS coming back stays: it is that window's
  // way home.
  for (const id of liveHusks) droppedHusks.delete(id);
  if (droppedHusks.size > 0) {
    pruneLeaves(
      l.grid?.root,
      (g) => typeof g.id === 'string' && droppedHusks.has(g.id) && viewCount(g) === 0
    );
  }
  // `activeGroup` naming a window that is no longer being opened. dockview
  // guards this itself; clearing it says what we meant rather than relying on
  // someone else's null check.
  if (typeof l.activeGroup === 'string' && droppedGroupIds.has(l.activeGroup)) delete l.activeGroup;
  return l;
}

/** Rewrite popout urls to the current origin and rescue off-display positions.
 *  Rescued popouts (panel ids + their original box) are appended to
 *  `rescuedOut` when provided, for the display-reconnect offer (E8-06). */
export function sanitizePopoutLayout(
  layout: unknown,
  origin: string,
  workAreas: WorkArea[],
  rescuedOut?: RescuedPopout[]
): unknown {
  if (!layout || typeof layout !== 'object') return layout;
  const l = { ...(layout as Layout) };
  if (Array.isArray(l.popoutGroups)) {
    l.popoutGroups = l.popoutGroups.map((p) => {
      const np: PopoutGroup = { ...p };
      if (typeof np.url === 'string') np.url = `${origin}/popout.html`;
      if (np.position && workAreas.length > 0 && !boxOnAnyDisplay(np.position, workAreas)) {
        const data = np.data as { views?: unknown } | undefined;
        const views = Array.isArray(data?.views)
          ? (data.views as unknown[]).filter((v): v is string => typeof v === 'string')
          : [];
        rescuedOut?.push({ panelIds: views, box: { ...np.position } });
        np.position = null; // rescue onto the main window
      }
      return np;
    });
  }
  return l;
}
