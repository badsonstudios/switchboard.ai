// Where the reader was in a card's Changes tab, across an unmount (#562).
//
// THE MECHANISM, measured rather than assumed. `panels.tsx` renders only the
// ACTIVE panel — the Terminal alone is `keepMounted` — so switching a card's tab
// destroys `DiffPane` and every piece of state in it. Come back and the pane has
// **no file selected at all**, let alone the same place in it.
//
// NOTE WHAT THIS IS NOT. #562 was filed expecting #555's defect: a dockview MOVE
// that detaches and reappends the DOM. The Changes tab is IMMUNE to that, and
// the measurement is in `e2e/panel-restore-position.spec.ts` — first visible
// line 66 before the move, 66 after, with the detach itself confirmed by a
// MutationObserver. Monaco scrolls a VIRTUAL viewport (content translated inside
// an `overflow: hidden` box), so there is no native `scrollTop` for the browser
// to drop. A signal like `dockEpoch` would therefore have fixed nothing here,
// and memory that outlives the component fixes nothing in the document viewer,
// which has the opposite problem. Two mechanisms, two fixes, one issue.
//
// Here rather than inside the component for `lib/diff-layout`'s reason: this is
// a rule with edge cases (what counts as a place, what to do with a file that is
// no longer changed, what to evict), and a rule inside a component that needs
// Monaco to mount is a rule with no unit test.
//
// PER RENDERER, AND NOT PERSISTED. `popout.html` is its own entry point, so a
// popped-out card builds its own copy of this map: pop out, read a file, dock
// back, and the docked window restores what IT last saw. That is a smaller
// promise than it might look — a card is in one window at a time, and the case
// only shows up if you read the Changes tab in both — but it is worth stating
// rather than discovering. Making it durable means the session store and a
// restart-surviving path (as `#532` did for the layout preference); this issue
// is about coming back to a tab, not coming back to the app.

/**
 * A place in a diff — the file, and the LINE at the top of the viewport.
 *
 * A LINE, not a pixel offset, and that is load-bearing:
 *
 *   * side-by-side inserts alignment view zones for deleted lines AFTER the
 *     async diff computation, so the same pixel offset means a different line
 *     before and after it lands;
 *   * the layout mode is workspace-wide (#532), so a pane recorded in
 *     side-by-side can be restored in inline, where a pixel offset is somewhere
 *     else entirely.
 *
 * A line number survives both.
 */
export interface DiffPlace {
  /** the repo-relative path, as git spells it */
  selected: string;
  /** 1-based first visible line in the MODIFIED editor */
  line: number;
}

/**
 * How many cards may hold a place at once.
 *
 * Nothing tells this module that a card has closed, so without a cap the map
 * grows for the life of the process. Twenty is far more than can be on screen
 * and each entry is a short string and a number. Oldest evicted first, and a
 * re-touched entry moves to the back, so the card being read is the last to go.
 */
export const MAX_DIFF_PLACES = 20;

const places = new Map<string, DiffPlace>();

/**
 * Record where the reader is.
 *
 * REJECTS A NONSENSE LINE rather than storing it. Monaco answers `-1` for a
 * viewport it has no model for, and there is a real window in which that
 * happens: the load effect asks git for the two file versions over IPC, and
 * until that resolves the editor is empty. Storing it would overwrite a good
 * place with a bad one — and the reader would lose the position precisely when
 * they left the tab quickly, which is the common case.
 */
export function rememberDiffPlace(
  cardId: string | undefined,
  place: DiffPlace
): void {
  if (!cardId || !place.selected) return;
  if (!Number.isFinite(place.line) || place.line < 1) return;
  places.delete(cardId);
  places.set(cardId, { ...place });
  while (places.size > MAX_DIFF_PLACES) {
    const oldest = places.keys().next();
    if (oldest.done) break;
    places.delete(oldest.value);
  }
}

/** Where this card was left, or null. */
export function readDiffPlace(cardId: string | undefined): DiffPlace | null {
  if (!cardId) return null;
  const place = places.get(cardId);
  return place ? { ...place } : null;
}

/**
 * Drop a card's place — used when the remembered file is no longer a changed
 * file, so the next mount does not try to reopen it.
 */
export function forgetDiffPlace(cardId: string | undefined): void {
  if (cardId) places.delete(cardId);
}

/** Drop everything. Tests, and nothing else. */
export function forgetAllDiffPlaces(): void {
  places.clear();
}

/**
 * Is a remembered file still worth reopening?
 *
 * A place is only as good as the file under it. Between leaving the tab and
 * coming back, the change can have been committed, discarded or the file
 * deleted — and `git.fileVersions` does not fail for any of those, it returns
 * EMPTY STRINGS. So a stale path restores as a blank two-pane diff with no row
 * highlighted and nothing on screen saying why, which reads as breakage.
 */
export function placeIsStillThere(
  place: DiffPlace | null,
  changedPaths: readonly string[]
): boolean {
  return !!place && changedPaths.includes(place.selected);
}
