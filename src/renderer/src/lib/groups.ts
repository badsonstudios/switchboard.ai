// Membership adoption rule for grid drags (P2-E12-04): when a session panel
// lands in a dockview group, it adopts the persistent group of the panels
// already there — first sibling with a membership wins; an all-ungrouped
// destination means ungrouped. Kept pure for unit testing.
export interface CardMembership {
  cardId: string;
  groupId?: string;
}

// Emergent repo/folder auto-groups (E12-05, §7): sessions sharing an autoKey
// (repo toplevel, else folder) cluster visually — computed, never persisted.
// User-made groups always win (S4): an explicitly-grouped session never
// auto-groups. Singletons don't group; empty means gone by construction.
export interface AutoGroupable {
  id: string;
  groupId?: string;
  autoKey?: string;
  folder?: string;
}

export interface AutoGroup {
  key: string;
  memberIds: string[];
}

export function computeAutoGroups(sessions: AutoGroupable[]): AutoGroup[] {
  const buckets = new Map<string, string[]>();
  for (const s of sessions) {
    if (s.groupId) continue; // explicit membership overrides (S4)
    const key = s.autoKey ?? s.folder;
    if (!key) continue;
    const list = buckets.get(key) ?? [];
    list.push(s.id);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([key, memberIds]) => ({ key, memberIds }));
}

// The rail's VISUAL order (P2-E9-01): persistent groups in their stored order,
// each followed by its members, then the emergent auto-groups and their
// members, then everything loose. "Jump to session N" (Ctrl+1..9) counts
// against exactly this list, so the rail renders FROM it — one function, no
// chance of the keyboard and the eye disagreeing.
export interface RailOrderResult<T> {
  /** persistent groups paired with their members, in render order */
  groups: Array<{ id: string; members: T[] }>;
  /** emergent auto-groups paired with their members, in render order */
  autoGroups: Array<{ key: string; members: T[] }>;
  /** ungrouped sessions that didn't land in an auto-group */
  loose: T[];
  /** every session, flattened in the order the rail paints it */
  flat: T[];
}

export function railOrder<T extends AutoGroupable>(
  sessions: T[],
  groups: Array<{ id: string }>
): RailOrderResult<T> {
  const grouped = new Map<string, T[]>();
  for (const g of groups) grouped.set(g.id, []);
  const ungrouped: T[] = [];
  for (const s of sessions) {
    if (s.groupId && grouped.has(s.groupId)) grouped.get(s.groupId)!.push(s);
    else ungrouped.push(s);
  }
  const auto = computeAutoGroups(ungrouped);
  const autoMemberIds = new Set(auto.flatMap((g) => g.memberIds));
  const byId = new Map(ungrouped.map((s) => [s.id, s]));
  const orderedGroups = groups.map((g) => ({ id: g.id, members: grouped.get(g.id) ?? [] }));
  const orderedAuto = auto.map((ag) => ({
    key: ag.key,
    members: ag.memberIds.map((id) => byId.get(id)).filter((s): s is T => !!s),
  }));
  const loose = ungrouped.filter((s) => !autoMemberIds.has(s.id));
  return {
    groups: orderedGroups,
    autoGroups: orderedAuto,
    loose,
    flat: [
      ...orderedGroups.flatMap((g) => g.members),
      ...orderedAuto.flatMap((g) => g.members),
      ...loose,
    ],
  };
}

export function pickAdoptedGroupId(
  myCardId: string,
  siblingCardIds: string[],
  cards: CardMembership[]
): string | null {
  const byId = new Map(cards.map((c) => [c.cardId, c.groupId]));
  for (const sib of siblingCardIds) {
    if (sib === myCardId) continue;
    const g = byId.get(sib);
    if (g) return g;
  }
  return null;
}
