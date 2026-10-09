// One-click arrangements of the sessions that are open, and "make them even"
// (#1147).
//
// The owner: "If I want two docks side by side, I click a button. If I want
// three, I click a button. … I resized the left one bigger and now I want them
// even again — I have no way to know where the middle is, so I guess."
//
// This file is the ARITHMETIC: which shape a preset is, which session goes in
// which place, and what "even" means for an arrangement of any shape. It knows
// nothing about dockview, which is how it gets unit tests; the half that moves
// real panels is components/grid-presets.ts.
//
// THE RULES, which the ticket asked to have said out loud:
//
//  1. ORDER IS THE SESSIONS LIST'S. The first session in the list takes the
//     first place (top left), the next the second, reading left to right and
//     then down.
//  2. EXTRAS STACK AS TABS IN THE LAST PLACE. "2-up" with five sessions open is
//     one session on the left and four tabbed on the right. Nothing is closed
//     and nothing is folded away.
//  3. A SHAPE NEVER HAS AN EMPTY PLACE. "3-up" with two sessions is two columns.
//  4. WHAT IS NOT A SESSION FOLLOWS ITS SESSION. A changes or document panel
//     goes where the first session it shared a place with went; one that shared
//     with no session goes to the last place.
//  5. ONLY THE MAIN WORKSPACE. Popped-out windows and sessions that are folded
//     away are not touched.

export type LayoutPreset = 'single' | 'columns2' | 'columns3' | 'rows' | 'grid';

/** In the order the buttons are drawn. */
export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
  'single',
  'columns2',
  'columns3',
  'rows',
  'grid',
];

/** the most places each shape has */
const MOST: Record<LayoutPreset, number> = {
  single: 1,
  columns2: 2,
  columns3: 3,
  rows: 2,
  grid: 4,
};

/** How many places the shape has for this many sessions: never more places
 *  than sessions (rule 3), never fewer than one. */
export function slotCount(preset: LayoutPreset, sessions: number): number {
  return Math.max(1, Math.min(MOST[preset], sessions));
}

/**
 * How to make place N, for N from 1 up (place 0 is made first, on its own).
 *
 * `beside` is the place it is split off from; `'edge'` means the whole
 * workspace's edge, which is how a row that spans the full width is made.
 */
export interface SlotStep {
  beside: number | 'edge';
  direction: 'right' | 'below';
}

export function slotPlan(preset: LayoutPreset, sessions: number): SlotStep[] {
  const n = slotCount(preset, sessions);
  if (n === 1) return [];
  if (preset === 'rows') return [{ beside: 0, direction: 'below' }];
  if (preset === 'grid') {
    // two on top; then a second row across the whole width, split in two when
    // there is a fourth. With three, the third has the bottom row to itself.
    const steps: SlotStep[] = [{ beside: 0, direction: 'right' }];
    if (n >= 3) steps.push({ beside: 'edge', direction: 'below' });
    if (n >= 4) steps.push({ beside: 2, direction: 'right' });
    return steps;
  }
  // columns: each one to the right of the one before
  return Array.from({ length: n - 1 }, (_, i) => ({ beside: i, direction: 'right' as const }));
}

/** One panel in the workspace, as the arithmetic sees it. */
export interface PresetPanel {
  id: string;
  /** a session's own card, as against a changes or document panel */
  session: boolean;
}

/**
 * Which panels go in which place.
 *
 * `places` is what is in the workspace now: one entry per place, its panels in
 * tab order. `sessionOrder` is the Sessions list's order (panel ids); a session
 * it does not name goes after the ones it does, in the order it was found.
 */
export function assignSlots(
  preset: LayoutPreset,
  places: readonly (readonly PresetPanel[])[],
  sessionOrder: readonly string[]
): string[][] {
  const all = places.flat();
  // a workspace with no session cards at all (only documents, say) still has
  // something to arrange: every panel is treated as its own leader
  const leaders = all.some((p) => p.session) ? all.filter((p) => p.session) : all;
  const rank = new Map(sessionOrder.map((id, i) => [id, i]));
  const ordered = leaders
    .map((p, found) => ({ id: p.id, at: rank.get(p.id) ?? sessionOrder.length + found }))
    .sort((a, b) => a.at - b.at)
    .map((p) => p.id);

  const n = slotCount(preset, ordered.length);
  const slotOf = new Map<string, number>();
  ordered.forEach((id, i) => slotOf.set(id, Math.min(i, n - 1)));

  const out: string[][] = Array.from({ length: n }, () => []);
  for (const id of ordered) out[slotOf.get(id)!].push(id);
  // rule 4: the rest follow the first leader they shared a place with
  for (const place of places) {
    const leader = place.find((p) => slotOf.has(p.id));
    const to = leader ? slotOf.get(leader.id)! : n - 1;
    for (const p of place) if (!slotOf.has(p.id)) out[to].push(p.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// "Make them even"
// ---------------------------------------------------------------------------

/** dockview's serialized grid, as much of it as this needs */
export interface GridNode {
  type: 'branch' | 'leaf';
  /** a branch's children, or a leaf's group */
  data: GridNode[] | { id: string };
  /**
   * `false` for a place that is in the grid but not on screen. A popped-out
   * window leaves one behind: the spot it comes back to. It takes no room,
   * so it gets no share — counting it would make two cards "even" at a
   * third each, with the last third going to nothing.
   */
  visible?: boolean;
}

/** the tree with every hidden place taken out, and any split that leaves empty */
function shown(node: GridNode): GridNode | null {
  if (node.visible === false) return null;
  if (node.type === 'leaf') return node;
  const kids = (node.data as GridNode[]).map(shown).filter((k): k is GridNode => k !== null);
  return kids.length ? { type: 'branch', data: kids } : null;
}
export interface SerializedGrid {
  root: GridNode;
  width: number;
  height: number;
  /** which way the ROOT's children run; each level below alternates */
  orientation: 'HORIZONTAL' | 'VERTICAL';
}

export interface EvenSize {
  id: string;
  width: number;
  height: number;
}

/**
 * The size every place should be for the arrangement to be even: at each split,
 * the pieces share the space equally. Nothing moves; only sizes change.
 *
 * "Even" is per split, not per session: with one session on the left and two
 * stacked on the right, left and right get half each and the two on the right
 * get a quarter each. That is the reading where the owner's case (two side by
 * side, one dragged wider) comes back to the middle, and where a 2-by-2 comes
 * back to four equal quarters.
 *
 * Returned outermost first, which is the order they have to be applied in: a
 * piece cannot be given half of something that has not been sized yet.
 */
export function evenSizes(grid: SerializedGrid): EvenSize[] {
  const out: EvenSize[] = [];
  const walk = (node: GridNode, width: number, height: number, across: boolean): void => {
    if (node.type === 'leaf') {
      out.push({ id: (node.data as { id: string }).id, width, height });
      return;
    }
    const kids = node.data as GridNode[];
    if (kids.length === 0) return;
    const w = across ? width / kids.length : width;
    const h = across ? height : height / kids.length;
    // breadth first within a split, so siblings are sized before any of their
    // own children are
    const sized = kids.map((k) => ({ k, w, h }));
    for (const s of sized) {
      if (s.k.type === 'leaf') out.push({ id: (s.k.data as { id: string }).id, width: s.w, height: s.h });
    }
    for (const s of sized) {
      if (s.k.type === 'branch') walk(s.k, s.w, s.h, !across);
    }
  };
  const root = shown(grid.root);
  if (root) walk(root, grid.width, grid.height, grid.orientation === 'HORIZONTAL');
  return out;
}

/** Is the arrangement already even, to within `slack` pixels? What the
 *  "make them even" button asks before it says it did something. */
export function isEven(
  grid: SerializedGrid,
  actual: (id: string) => { width: number; height: number } | undefined,
  slack = 2
): boolean {
  return evenSizes(grid).every((want) => {
    const got = actual(want.id);
    return (
      !!got &&
      Math.abs(got.width - want.width) <= slack &&
      Math.abs(got.height - want.height) <= slack
    );
  });
}
