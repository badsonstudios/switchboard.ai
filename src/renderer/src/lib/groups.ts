// Membership adoption rule for grid drags (P2-E12-04): when a session panel
// lands in a dockview group, it adopts the persistent group of the panels
// already there — first sibling with a membership wins; an all-ungrouped
// destination means ungrouped. Kept pure for unit testing.
export interface CardMembership {
  cardId: string;
  groupId?: string;
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
