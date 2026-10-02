// "Show me everything, in one scroll" (E24 Git v2 item 9) — the ⧉ in the filter row.
//
// The fourth member of a family with one shape: `lib/document-open`,
// `lib/diff-open`, `lib/file-history` and this. A module the grid installs an
// opener into, so a panel body can reach a dockview verb without a prop drilled
// through every host between them.
//
// FAIL-OPEN, and it is the owner's rule rather than a nicety: with no opener
// installed `openAllChanges` reports false and the Changes tab draws no ⧉ at all —
// *"a row with a `＋` that does nothing is worse than a row with no `＋`"*, applied
// to a toolbar button.
//
// ⚠️ **IT TAKES A CARD ID, NOT A TARGET, and that is the difference from
// `diff-open`.** There is exactly one "everything that changed" per card, so the
// panel id is derivable and asking twice focuses the panel you already have. A
// `gitdiff-` panel is per comparison and a card can want several at once.

/** What actually opens the panel — installed by `App` from the grid. */
export type AllChangesOpener = (cardId: string, folder: string, title: string) => void;

let opener: AllChangesOpener | null = null;

/** Install (or, with null, remove) the opener. Called from App's mount. */
export function setAllChangesOpener(next: AllChangesOpener | null): void {
  opener = next;
}

/** Is there anywhere to open an all-changes panel right now? */
export function canOpenAllChanges(): boolean {
  return opener !== null;
}

/**
 * Open (or focus) the all-changes panel for this card.
 *
 * Returns false when nothing is listening or the request cannot mean anything, so
 * the caller can leave its own affordance out rather than offering a dead click.
 */
export function openAllChanges(cardId: string | undefined, folder: string, title: string): boolean {
  if (!opener || !cardId || !folder) return false;
  try {
    opener(cardId, folder, title);
    return true;
  } catch {
    // The grid throwing must not take the surface that asked with it — the same
    // bargain every module in this family makes.
    return false;
  }
}

/** Test seam — a fresh renderer has no opener, and neither should a test. */
export function resetAllChangesOpener(): void {
  opener = null;
}
