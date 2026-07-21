// Popout-layout persistence helpers (P2-E8-02). dockview serializes popout
// groups with their url + on-screen position, so the workspace layout already
// round-trips them — but two things must be fixed on restore:
//  1. the stored url carries the loopback server's port, which is RANDOM each
//     launch, so rewrite every popout url to the current origin;
//  2. if a popout's saved position is off every current display (monitor
//     unplugged), rescue it — null the position so dockview reopens it on/near
//     the main window instead of a monitor that no longer exists.

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
