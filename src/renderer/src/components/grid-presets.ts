// The half of #1147 that moves real panels: apply a one-click arrangement to
// the workspace, and make an arrangement even. The rules and the arithmetic are
// in lib/layout-presets; this file only does what that file decided.
//
// ONLY dockview's public API is used. It has no "distribute evenly" of its own
// at the grid level (the splitter underneath does, privately), so even sizes
// are computed from the serialized grid and applied with each group's own
// `setSize`, outermost first.
import type { DockviewApi } from 'dockview-react';
import { sessionStore } from '../store/session-store';
import {
  assignSlots,
  evenSizes,
  isEven,
  LayoutPreset,
  PresetPanel,
  SerializedGrid,
  slotPlan,
} from '../lib/layout-presets';

type Group = DockviewApi['groups'][number];

/**
 * A place in the MAIN workspace that is on screen.
 *
 * `isVisible` is a guard, raised in review: dockview can keep an empty, hidden
 * group in the grid as the spot a popped-out window comes back to. It is
 * `location: grid` like any other, and tidying it away would leave that
 * window nowhere to return. NOT OBSERVED in this app (the real-app test passes
 * with or without this), so it costs nothing today and is right if the way
 * popouts are made ever changes.
 */
const inGrid = (g: Group): boolean => g.api.location.type === 'grid' && g.api.isVisible;

/** How many panels are in the main workspace, on screen or behind a tab on
 *  screen: what the buttons ask before offering to arrange anything. */
export function arrangeablePanels(api: DockviewApi | null): number {
  if (!api) return 0;
  return api.groups.filter(inGrid).reduce((n, g) => n + g.panels.length, 0);
}
const cardIdOf = (panelId: string): string | undefined => /^session-(.+)$/.exec(panelId)?.[1];

function serialized(api: DockviewApi): SerializedGrid {
  const grid: unknown = api.toJSON().grid;
  return grid as SerializedGrid;
}

/**
 * Make the arrangement even: every split shares its space equally. Nothing
 * moves. Returns false when it was already even (or there is nothing to size),
 * so the caller can say so instead of claiming it did something.
 */
export function equalizeGrid(api: DockviewApi | null): boolean {
  if (!api) return false;
  const grid = serialized(api);
  const actual = (id: string): { width: number; height: number } | undefined => {
    const g = api.getGroup(id);
    return g ? { width: g.api.width, height: g.api.height } : undefined;
  };
  const targets = evenSizes(grid);
  if (targets.length < 2 || isEven(grid, actual)) return false;
  // Twice: giving one piece its size takes from its neighbours, so the first
  // pass can leave the last-sized sibling a few pixels out. The second pass
  // starts from nearly-even and lands.
  for (let pass = 0; pass < 2; pass++) {
    for (const t of targets) {
      api.getGroup(t.id)?.api.setSize({ width: t.width, height: t.height });
    }
  }
  return true;
}

/**
 * Rearrange what is open in the main workspace into a named shape.
 *
 * Returns how many places the result has, or 0 when there was nothing to
 * arrange (fewer than two panels). Nothing is closed and nothing is folded
 * away; popped-out windows are not touched.
 *
 * The caller has already put the workspace in the plain grid
 * (`arrangeWorkspace` in SessionGrid): a Focus or Queue mode, or a standing
 * maximize, would put things back its own way at the next event.
 */
export function applyPreset(api: DockviewApi | null, preset: LayoutPreset): number {
  if (!api) return 0;
  const old = api.groups.filter(inGrid);
  const places: PresetPanel[][] = old.map((g) =>
    g.panels.map((p) => ({ id: p.id, session: !!cardIdOf(p.id) }))
  );
  if (places.flat().length < 2) return 0;

  const order = sessionStore.getRailOrder().flat.map((s) => `session-${s.id}`);
  const slots = assignSlots(preset, places, order);
  const steps = slotPlan(preset, slots.length);
  const front = api.activePanel?.id;

  // New, empty places, built at the workspace's own edge so the shape is the
  // whole workspace's and not a corner of whatever was there before. The old
  // places empty out as their panels leave, and dockview drops them.
  // `skipSetActive`: an empty group taking focus would tell the app "no
  // session is active" for a moment, once per place.
  const made: Group[] = [api.addGroup({ direction: 'left', skipSetActive: true })];
  for (const step of steps) {
    made.push(
      step.beside === 'edge'
        ? api.addGroup({ direction: step.direction, skipSetActive: true })
        : api.addGroup({
            referenceGroup: made[step.beside],
            direction: step.direction,
            skipSetActive: true,
          })
    );
  }

  slots.forEach((ids, i) => {
    for (const id of ids) {
      const panel = api.getPanel(id);
      if (!panel) continue;
      const cardId = cardIdOf(id);
      // OUR move, not a user drag (see the store's `setMoving`): without the
      // flag, a session landing in a place with another session in it would
      // be taken for the user dragging it into that session's GROUP.
      if (cardId) sessionStore.setMoving(cardId, true);
      try {
        panel.api.moveTo({ group: made[i], skipSetActive: true });
      } catch (err) {
        // one panel that will not move must not strand the rest half-arranged
        console.error('[layout] preset could not move', id, err);
      } finally {
        if (cardId) sessionStore.setMoving(cardId, false);
      }
      // it is in the workspace, at home: whatever rung it was on (the tab
      // stack, say) is no longer where it is
      if (cardId) sessionStore.setPresentation(cardId, { ladder: 'expanded', poppedOut: false });
    }
  });

  // anything left behind empty (dockview keeps a last empty group alive)
  for (const g of old) {
    if (g.panels.length === 0 && api.groups.includes(g)) {
      try {
        api.removeGroup(g);
      } catch {
        // already gone
      }
    }
  }
  // ...and a place nothing could be moved into
  for (const g of made) {
    if (g.panels.length === 0 && api.groups.filter(inGrid).length > 1) {
      try {
        api.removeGroup(g);
      } catch {
        // already gone
      }
    }
  }

  equalizeGrid(api);
  // you are still in the session you were in
  if (front) api.getPanel(front)?.api.setActive();
  return api.groups.filter(inGrid).length;
}
