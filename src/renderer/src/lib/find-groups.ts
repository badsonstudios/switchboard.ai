// Results grouped by view (P2-E17-03, §5.31's first decision).
//
// "One Ctrl+F covers the whole session, results grouped by view" was decided
// up front and could not be built until there were two `bar` registrants to
// group. There are now: the transcript engine and the terminal's scrollback.
//
// WHY GROUPS AND NOT A TOTAL — the reason is honesty, not layout. The two
// surfaces see DIFFERENT DEPTHS of the same session: the transcript file is
// the whole thing, xterm holds 5,000 ring-buffered lines. "17 matches" over
// those two is a number that is true of nothing, and a 0 with no label reads
// as "not in this session" when it means "not in the last 5,000 lines". So
// every group keeps its own count next to its own name, and a group's LABEL is
// where it declares what it can see (`find.group.terminal` says "scrollback
// only" out loud).
//
// Pure functions, no React: the bar owns the state and this owns the
// arithmetic, which is the half worth testing on its own.
import type { FindHit, FindNotice, FindResults } from '../extensibility/contributions';

/** One provider's answer, before it is folded into the view. */
export interface FindGroupInput {
  /** the provider's manifest id — namespaces its hit ids and keys the group */
  id: string;
  /** the panel it serves, so the bar can start stepping in the focused one */
  panelId: string;
  labelKey: string;
  results: FindResults;
}

export interface FindGroup {
  id: string;
  panelId: string;
  labelKey: string;
  /** matches found; `hits` may be fewer when the provider capped itself */
  total: number;
  hits: FindHit[];
  notice?: FindNotice;
}

/** One position in the flat walk Enter and Shift+Enter follow. */
export interface FindStep {
  groupIndex: number;
  hit: FindHit;
}

export interface FindGroupsView {
  groups: FindGroup[];
  steps: FindStep[];
  /** matches across every group — for "is there anything at all", never shown as one number */
  any: boolean;
}

export const EMPTY_GROUPS: FindGroupsView = { groups: [], steps: [], any: false };

/**
 * Fold each provider's results into groups plus the flat list Enter walks.
 *
 * Hit ids are NAMESPACED by provider here rather than by each provider: a
 * `FindHit.id` only promises uniqueness within one provider's result set, and
 * the results list now renders several sets at once — the transcript's
 * `12:tool.out:0` and a future provider's identical string would collide as
 * React keys and make one row disappear.
 */
export function buildFindGroups(inputs: FindGroupInput[]): FindGroupsView {
  const groups: FindGroup[] = inputs.map((input) => ({
    id: input.id,
    panelId: input.panelId,
    labelKey: input.labelKey,
    total: input.results.total,
    notice: input.results.notice,
    hits: input.results.hits.map((h) => ({ ...h, id: `${input.id}::${h.id}` })),
  }));
  const steps: FindStep[] = [];
  groups.forEach((g, groupIndex) => {
    for (const hit of g.hits) steps.push({ groupIndex, hit });
  });
  return { groups, steps, any: groups.some((g) => g.total > 0) };
}

/**
 * Where stepping starts after a query lands.
 *
 * The FOCUSED panel's first hit, when it has one. Landing in the Session group
 * because it sorts first, while the user is looking at the Terminal, would
 * "find" something they cannot see — the browser rhythm is that find starts in
 * the thing you are looking at. Falls back to the first hit anywhere, and -1
 * when there is nothing at all.
 */
export function initialStep(view: FindGroupsView, focusedPanelId: string): number {
  const focused = view.steps.findIndex((s) => view.groups[s.groupIndex]?.panelId === focusedPanelId);
  if (focused >= 0) return focused;
  return view.steps.length > 0 ? 0 : -1;
}

/** Where the current step sits INSIDE its own group — never across groups. */
export interface FindPosition {
  groupIndex: number;
  /** 1-based position within the group */
  position: number;
  /** the group's honest total (may exceed `shown`) */
  total: number;
  /** how many of that total are actually in the list */
  shown: number;
}

export function positionIn(view: FindGroupsView, index: number): FindPosition | null {
  const step = view.steps[index];
  if (!step) return null;
  const group = view.groups[step.groupIndex];
  if (!group) return null;
  const position = group.hits.findIndex((h) => h.id === step.hit.id) + 1;
  return { groupIndex: step.groupIndex, position, total: group.total, shown: group.hits.length };
}

/** Every notice any group raised, tagged with the group that raised it. */
export function noticesOf(view: FindGroupsView): { groupIndex: number; notice: FindNotice }[] {
  const out: { groupIndex: number; notice: FindNotice }[] = [];
  view.groups.forEach((g, groupIndex) => {
    if (g.notice) out.push({ groupIndex, notice: g.notice });
  });
  return out;
}

/** The empty answer, for a provider that could not run. */
export function failedResults(key: string): FindResults {
  return { hits: [], total: 0, truncated: false, notice: { key, tone: 'error' } };
}
