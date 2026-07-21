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
