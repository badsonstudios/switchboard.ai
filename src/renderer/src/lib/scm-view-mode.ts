// Flat list or folder tree, in the source-control sidebar (E24 Git v2 item 8).
//
// The same shape as `lib/diff-layout.ts` beside it, and for the same reasons
// spelled out at length there: there are N mounted sidebars at once — one per card
// with the Changes tab open, plus any in popped-out windows — so a preference that
// lived in React state would be N preferences that disagree. Module state with a
// subscribe, read through `useSyncExternalStore`; a popout is a second document in
// the SAME renderer realm, so it sees this module and updates with everything
// else.
//
// ⚠️ **THE UI BLOB, NOT `localStorage`** (P2-E15-06): the packaged renderer's
// origin changes port every launch, so a pref stored there survives nothing.
import { uiGet, uiSet } from './ui-state';

export type ScmViewMode = 'flat' | 'tree';

/** ui-blob key. */
export const SCM_VIEW_MODE_KEY = 'scmViewMode';

/**
 * What a workspace that has never been told gets.
 *
 * ⚠️ **FLAT, AND THAT IS A DELIBERATE DISAGREEMENT WITH THE MOCKUP**, which draws
 * screen 2 with the tree button lit. The reason is the surface's job: the Changes
 * tab answers *"what did the agent just change?"*, and a flat list answers it in
 * one glance where a tree makes you expand to find out. The tree earns its keep on
 * a big change set, which is the case the user can ask for — and the ask is
 * remembered, so somebody who prefers it says so once.
 */
export const DEFAULT_SCM_VIEW_MODE: ScmViewMode = 'flat';

/**
 * One stored value → a mode. Anything unrecognised becomes the default rather
 * than throwing: a ui blob outlives the code that wrote it, and a stale value must
 * never cost the user their Changes tab.
 */
export function parseScmViewMode(raw: unknown): ScmViewMode {
  return raw === 'tree' ? 'tree' : DEFAULT_SCM_VIEW_MODE;
}

const listeners = new Set<() => void>();

/**
 * The preference, read through `lib/ui-state`'s cache every time.
 *
 * No second copy, for the reason `getDiffLayout` gives: `useSyncExternalStore`
 * compares snapshots by reference and this returns a string, so there is nothing
 * to allocate and nothing to keep in sync. The invariant that makes it safe is
 * that `setScmViewMode` is the only writer of this key.
 */
export function getScmViewMode(): ScmViewMode {
  return parseScmViewMode(uiGet<unknown>(SCM_VIEW_MODE_KEY, DEFAULT_SCM_VIEW_MODE));
}

/** Set and persist. A no-op write announces nothing. */
export function setScmViewMode(next: ScmViewMode): ScmViewMode {
  if (getScmViewMode() === next) return next;
  uiSet(SCM_VIEW_MODE_KEY, next);
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

/** Fires whenever the preference changes (for `useSyncExternalStore`). */
export function subscribeScmViewMode(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
