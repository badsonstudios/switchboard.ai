// How the Changes tab draws a diff: two columns or one (#532).
//
// ── WHY THIS EXISTS AT ALL, WHICH IS NOT WHAT THE BUG REPORT SAYS ───────────
//
// The report was "the Changes tab defaults to an inline diff and offers no way
// to switch". Half of that is true: there was no control. But the pane has
// asked Monaco for `renderSideBySide: true` since P1-E5-02 — the inline view
// was never a default anyone chose. Monaco's diff editor carries TWO more
// options, both on by default:
//
//   useInlineViewWhenSpaceIsLimited: true      (vs/editor/common/config/diffEditor.js)
//   renderSideBySideInlineBreakpoint: 900
//
// i.e. "side by side, unless you are under 900px wide, in which case quietly
// don't". A Changes tab in a 1280px window spends ~260px on the rail and 200px
// on this pane's own file list, so the diff editor lands near 800 — under the
// breakpoint, every time, on the machine the app was designed on. The user was
// getting an override he never asked for and could not see.
//
// So this module does two things: it gives the choice a name and a home in the
// workspace, and it takes the width decision away from Monaco. `DiffPane`
// passes `useInlineViewWhenSpaceIsLimited: false` and computes the answer here
// instead — not because Monaco's rule is wrong, but because a rule the user
// cannot see is the actual defect. Ours is applied at a threshold two columns
// genuinely cannot survive, and the toggle SAYS so when it fires.
//
// ── WHY MODULE STATE AND NOT REACT STATE ────────────────────────────────────
//
// There are N mounted DiffPanes at once — one per card with the Changes tab
// open, plus any in popped-out windows — and the palette command has no card
// in hand at all. Following `lib/find-surfaces` and `lib/popout-windows`: a
// module-level value with a subscribe, read through `useSyncExternalStore`.
// A popout is a second document in the SAME renderer realm, so it sees this
// module and updates with everything else.
import { uiGet, uiSet } from './ui-state';

export type DiffLayout = 'side-by-side' | 'inline';

/** ui-blob key. NOT localStorage — the packaged renderer's origin changes port
 *  every launch, so a pref stored there survives nothing (P2-E15-06). */
export const DIFF_LAYOUT_KEY = 'diffLayout';

/** What a workspace that has never been told gets. */
export const DEFAULT_DIFF_LAYOUT: DiffLayout = 'side-by-side';

/**
 * Below this many CSS px of DIFF EDITOR (not card, not window), a side-by-side
 * diff stops being a diff at all.
 *
 * MEASURED, not guessed. A Changes tab opened from the rail in a default
 * 1280px window lands beside its session card and the diff editor comes out at
 * **506px** (probed in the real app, 2026-08-15) — so any threshold at or above
 * that reproduces the bug this item exists to fix, however well it is
 * explained. Monaco's own 900 is nearly twice the width this app's panes
 * actually get; it is tuned for a VS Code editor group that owns the window.
 *
 * 400 is where the fallback stops being a judgement call. Two 200px columns
 * each spend ~50px on line numbers, the change gutter and the scrollbar,
 * leaving ~150px — about 18 monospace characters a side. There is no reading of
 * code at 18 characters, so below 400 the second column is costing space and
 * returning nothing. Above it the user's choice stands, cramped or not: this is
 * a floor under the absurd case, NOT a second opinion about the preference.
 */
export const SIDE_BY_SIDE_MIN_WIDTH = 400;

/**
 * One stored value -> a layout. Anything unrecognised becomes the default
 * rather than throwing: a ui blob outlives the code that wrote it, and a stale
 * value must never cost the user their Changes tab.
 */
export function parseDiffLayout(raw: unknown): DiffLayout {
  return raw === 'inline' ? 'inline' : DEFAULT_DIFF_LAYOUT;
}

/**
 * Is this many CSS px of DIFF EDITOR too little for two columns?
 *
 * `widthPx <= 0` means NOT MEASURED — the first render before the
 * ResizeObserver has said anything, and also every frame a dockview tab spends
 * HIDDEN (`display: none` observes 0×0). Both answer "no": guessing narrow
 * before a measurement would flash one column on mount, and letting a hidden
 * tab reset the verdict would flash TWO on the way back in.
 *
 * Separate from `effectiveDiffLayout` so the pane can keep a boolean in React
 * state instead of a pixel count — a splitter drag then re-renders the file
 * list only when the verdict actually flips, not on every frame.
 */
export function isTooNarrowForColumns(widthPx: number): boolean {
  return widthPx > 0 && widthPx < SIDE_BY_SIDE_MIN_WIDTH;
}

/** What the editor is actually told to render. */
export function effectiveDiffLayout(pref: DiffLayout, tooNarrow: boolean): DiffLayout {
  return pref === 'inline' || tooNarrow ? 'inline' : 'side-by-side';
}

const listeners = new Set<() => void>();

/**
 * The preference, read through `lib/ui-state`'s cache every time.
 *
 * No SECOND copy here on purpose: `useSyncExternalStore` compares snapshots by
 * reference and this returns a string, so there is nothing to allocate and
 * nothing to keep in sync. The invariant that makes that safe is that
 * `setDiffLayout` is the only writer of this key — anything else that mutated
 * the ui cache under it (a second `loadUiState`, a future reset-prefs) would
 * change the snapshot without announcing it, and mounted panes would sit stale
 * until something else re-rendered them. If such a thing ever lands, it calls
 * the announce below rather than writing the key behind this module's back.
 */
export function getDiffLayout(): DiffLayout {
  return parseDiffLayout(uiGet<unknown>(DIFF_LAYOUT_KEY, DEFAULT_DIFF_LAYOUT));
}

/** Set and persist. Returns what was applied. A no-op write still announces
 *  nothing — subscribers would re-render for a value that did not change. */
export function setDiffLayout(next: DiffLayout): DiffLayout {
  if (getDiffLayout() === next) return next;
  uiSet(DIFF_LAYOUT_KEY, next);
  // copy first: a listener that unsubscribes itself during the walk would
  // otherwise mutate the set we are iterating
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* fail-open: a bad subscriber costs its own update, not everyone's */
    }
  }
  return next;
}

/** Flip it — what the palette command runs. */
export function toggleDiffLayout(): DiffLayout {
  return setDiffLayout(getDiffLayout() === 'side-by-side' ? 'inline' : 'side-by-side');
}

/** Fires whenever the preference changes (for `useSyncExternalStore`). */
export function subscribeDiffLayout(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
