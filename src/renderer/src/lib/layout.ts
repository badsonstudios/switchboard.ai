// Popout-layout persistence helpers (P2-E8-02). dockview serializes popout
// groups with their url + on-screen position, so the workspace layout already
// round-trips them — but three things must be fixed on restore:
//  1. the stored url carries the loopback server's port, which is RANDOM each
//     launch, so rewrite every popout url to the current origin;
//  2. if a popout's saved position is off every current display (monitor
//     unplugged), rescue it — null the position so dockview reopens it on/near
//     the main window instead of a monitor that no longer exists;
//  3. a popout window whose only content is a DERIVED pane must not be
//     reopened at all — see `dropDerivedPopoutGroups` (#494).

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

/* ---- derived panes never come back (#494) ----------------------------------
 *
 * `SessionGrid`'s restore drops every `diff-` and `doc-` panel right after
 * `fromJSON`: both are DERIVED (a diff is recomputed, and "restoring open
 * viewers across relaunch" is named in E16's *Not in scope*). That is fine for
 * a panel in the GRID, which `fromJSON` builds synchronously — but it is a race
 * for a panel in a POPOUT, and the race leaves a real user with an empty second
 * window on their screen.
 *
 * MEASURED, not reasoned about (2026-08-20, the instrumented repro on #494):
 * dockview 7 restores popouts on a TIMER (`scheduleRestoration`,
 * `DESERIALIZATION_POPOUT_DELAY_MS`), and `addPopoutGroup` opens the OS window
 * first and wires the group to it only once the child window has LOADED. So
 * right after `fromJSON` the restored `doc-1` sits in a group whose location is
 * still `grid` —
 *
 *     [diag] prune-start groups=1:grid:session-…|diff-… , 2:grid: , 3:grid:doc-1
 *     [popout] onDidAddPopoutGroup (opened OK)      ← 130 ms LATER
 *
 * — and the prune takes its last panel away before dockview has anything to
 * hang the "last panel left, so close the window" rule on: that rule lives in
 * `doRemoveGroup`, under `group.api.location.type === 'popout'`, which is not
 * true yet. The window then finishes opening, empty, and nothing ever closes
 * it. Which side of the ~130 ms wins depends on how long the renderer's
 * `sessions.knownCards()` IPC takes, i.e. on machine load — the flake in #494.
 *
 * The fix is not a longer wait, it is not opening the window: a popout group
 * that holds nothing but derived panes is dropped from the layout BEFORE
 * `fromJSON` sees it. Nothing races because nothing is created. A user relaunch
 * also stops flashing a viewer window open and shut.
 *
 * Runs BEFORE `sanitizePopoutLayout` on purpose, so a dropped window is never
 * offered to the E8-06 display-reconnect prompt either — restoring an empty
 * window later is no better than restoring one now.
 *
 * A popout that holds a session card KEEPS its window; only the derived tabs
 * inside it go, and they go the way they always did (the group does not empty,
 * so no window is orphaned).
 */

/** Panels the restore throws away: `diff-` and `doc-`.
 *  The one spelling of the rule — `SessionGrid`'s prune uses it too. */
export function isDerivedPanelId(id: string): boolean {
  return /^(diff|doc)-/.test(id);
}

/** One serialized dockview GROUP — the `data` of a leaf, or of a popout. */
interface SerializedGroup {
  views?: unknown;
  activeView?: unknown;
  id?: unknown;
  [k: string]: unknown;
}

/** Every leaf `data` in a serialized gridview tree, in order.
 *  A popout window can host a nested grid of several groups (dockview 7), so a
 *  popout entry carries either a single `data` group or a whole `grid`. */
function leafGroups(node: unknown, out: SerializedGroup[] = []): SerializedGroup[] {
  if (!node || typeof node !== 'object') return out;
  const n = node as { type?: unknown; data?: unknown };
  if (n.type === 'leaf') {
    if (n.data && typeof n.data === 'object') out.push(n.data as SerializedGroup);
    return out;
  }
  if (Array.isArray(n.data)) for (const child of n.data) leafGroups(child, out);
  return out;
}

/**
 * Drop popout windows that would restore nothing but derived panes (#494).
 *
 * Returns a COPY — the caller's layout object is left untouched, so a failure
 * downstream cannot leave a half-edited layout behind to be saved.
 *
 * Unreferenced entries in `panels` are left alone deliberately: dockview only
 * ever instantiates the ids named in a group's `views`, so an orphan definition
 * costs nothing and pruning it is one more chance to corrupt a restore.
 */
export function dropDerivedPopoutGroups(layout: unknown): unknown {
  if (!layout || typeof layout !== 'object') return layout;
  const l = structuredClone(layout) as Layout & { activeGroup?: unknown };
  if (!Array.isArray(l.popoutGroups)) return l;
  const droppedGroupIds = new Set<string>();
  l.popoutGroups = l.popoutGroups.filter((p) => {
    const nested = (p as { grid?: { root?: unknown } }).grid;
    const groups = nested
      ? leafGroups(nested.root)
      : p.data && typeof p.data === 'object'
        ? [p.data as SerializedGroup]
        : [];
    let survivors = 0;
    for (const g of groups) {
      const views = Array.isArray(g.views) ? g.views : [];
      const kept = views.filter((v) => typeof v !== 'string' || !isDerivedPanelId(v));
      g.views = kept;
      survivors += kept.length;
      // the active tab may be one of the ones just removed; dockview falls back
      // to the last panel when `activeView` names nobody
      if (typeof g.activeView === 'string' && isDerivedPanelId(g.activeView)) delete g.activeView;
    }
    if (survivors > 0) return true;
    for (const g of groups) if (typeof g.id === 'string') droppedGroupIds.add(g.id);
    return false;
  });
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
