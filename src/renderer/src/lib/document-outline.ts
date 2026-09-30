// Whether the document viewer draws its Markdown outline (#1010, §5.30).
//
// The outline already hides itself twice — under three headings there is
// nothing worth navigating, and under a 420px pane a third of the width is a
// navigation aid that has stopped serving the thing it navigates. Both of those
// are the APP deciding. This is the user's own off switch for the case neither
// covers: a long document in a wide pane, where the reader wants the prose and
// not the index.
//
// ── WHY THIS IS GLOBAL AND NOT PER PANEL, which is not what #1010 asked for ──
//
// The dispatch asked for per-viewer-panel workspace state. A document panel
// cannot carry workspace state across a relaunch, and the reason is structural:
//
//   * `lib/layout.ts`'s `isDerivedPanelId` drops EVERY `doc-` panel out of a
//     restored layout, deliberately — a viewer does not come back next launch.
//   * `lib/document-panels.ts` mints ids from `seq = 0` in every renderer, so
//     this launch's `doc-1` and the next one's are different files.
//
// So a key of `documentOutline.doc-1` is either never read again — which fails
// the acceptance criterion that the choice survives a restart — or read by a
// document that has nothing to do with the one the user set it on, which is
// worse than not remembering. The honest per-thing key would be the PATH, and
// that grows the workspace blob by one entry for every file anyone ever hid an
// outline on, with nothing to prune it (the per-card keys have
// `sessionStore.pruneLayout`; there is no such list of paths).
//
// One preference, then, in the same shape as `lib/diff-layout.ts` — the
// nearest thing in the app, and the same question asked of a different surface:
// "how do you want to read this kind of file?" That answer is a property of the
// reader, not of a panel that will not exist tomorrow.
//
// ── WHY MODULE STATE AND NOT REACT STATE ────────────────────────────────────
//
// There are N mounted viewers at once — every open document tab, plus any in
// popped-out windows, which are a second document in the SAME renderer realm
// and therefore see this module. Following `lib/diff-layout`, `lib/find-
// surfaces` and `lib/popout-windows`: a module-level value with a subscribe,
// read through `useSyncExternalStore`.
import { uiGet, uiSet } from './ui-state';

/** ui-blob key. NOT localStorage — the packaged renderer's origin changes port
 *  every launch, so a pref stored there survives nothing (P2-E15-06). */
export const DOCUMENT_OUTLINE_KEY = 'documentOutline';

/** Shown, because litmus #1 is that the default needs no setup and #6 is that
 *  a new feature adds nothing to the default experience. The outline is what
 *  the viewer has always done; this item only adds the way out of it. */
export const DEFAULT_DOCUMENT_OUTLINE = true;

/**
 * One stored value -> shown or hidden.
 *
 * Anything unrecognised becomes the DEFAULT rather than throwing or coercing:
 * a ui blob outlives the code that wrote it, and `Boolean('hidden')` — the
 * obvious cast — is `true`, so a future rename to strings would silently mean
 * the opposite of itself. Only a literal `false` hides.
 */
export function parseDocumentOutline(raw: unknown): boolean {
  return raw === false ? false : DEFAULT_DOCUMENT_OUTLINE;
}

const listeners = new Set<() => void>();

/**
 * The preference, read through `lib/ui-state`'s cache every time.
 *
 * No second copy here, for `diff-layout`'s reason: `useSyncExternalStore`
 * compares snapshots by reference, this returns a boolean, and the invariant
 * that makes it safe is that `setDocumentOutline` is the only writer of this
 * key. Anything that ever mutates the ui cache underneath it calls the announce
 * below rather than writing the key behind this module's back.
 */
export function getDocumentOutline(): boolean {
  return parseDocumentOutline(uiGet<unknown>(DOCUMENT_OUTLINE_KEY, DEFAULT_DOCUMENT_OUTLINE));
}

/** Set and persist. A no-op write announces nothing — subscribers would
 *  re-render every mounted viewer for a value that did not change. */
export function setDocumentOutline(next: boolean): boolean {
  if (getDocumentOutline() === next) return next;
  uiSet(DOCUMENT_OUTLINE_KEY, next);
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

/** Flip it — what the toolbar chip runs. */
export function toggleDocumentOutline(): boolean {
  return setDocumentOutline(!getDocumentOutline());
}

/** Fires whenever the preference changes (for `useSyncExternalStore`). */
export function subscribeDocumentOutline(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
