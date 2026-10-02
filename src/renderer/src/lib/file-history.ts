// "Show me this file's history" (E24 Git v2 item 10, §5.7) — the ⏱ row action.
//
// ⚠️ **THE SURFACE IS THE HISTORY TAB, FILTERED — NOT A NEW PANEL.** Design §4
// item 10 says `log --follow -- <path>`, which `logArgs` has supported since item
// 1, and "opens as a `diff-` panel per commit", which the History tab's expanded
// commit rows already do (item 4). So what was actually missing was a way to point
// the existing tab at ONE path. A second surface showing commit rows would have
// been a second place for the lanes, the ref chips, the paging and the five empty
// states to drift.
//
// ⚠️ **AND IT NEEDS TWO THINGS A PANEL CANNOT REACH, which is why this is a
// module.** The Changes tab is where you want a file's history from, and it is a
// DIFFERENT TAB from the History tab — card tabs are mutually exclusive, so the
// gesture has to switch the view. `PanelContext` carries no `setView`, and adding
// one would widen a contract every panel shares for the benefit of one button.
// `GridController.toggleCardView` exists and `App` holds it; so: a module seam,
// the same shape as `lib/document-open` and `lib/diff-open`.
//
// FAIL-OPEN: with no opener installed, `requestFileHistory` reports false and the
// Changes tab draws no ⏱ at all — the owner's rule about a control that does
// nothing.

/** What actually switches a card's view — installed by `App` from the grid. */
export type FileHistoryOpener = (cardId: string) => void;

interface Request {
  folder: string;
  /** git's forward-slash relative path */
  path: string;
}

let opener: FileHistoryOpener | null = null;
/** One request per card, because one card has one History tab. */
const requests = new Map<string, Request>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** Install (or, with null, remove) the view switcher. Called from App's mount. */
export function setFileHistoryOpener(next: FileHistoryOpener | null): void {
  opener = next;
}

/** Is there anywhere to send a file-history request right now? */
export function canShowFileHistory(): boolean {
  return opener !== null;
}

/** Subscribe to every card's request. Returns the unsubscribe. */
export function subscribeFileHistory(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * What path this card's History tab is currently pinned to, if any.
 *
 * ⚠️ **THE FOLDER IS CHECKED, NOT JUST THE CARD.** A card's folder can change —
 * a session resumed somewhere else — and a request left over from the old one
 * would filter the new repository's history by a path that means nothing in it,
 * producing an empty list with a chip blaming a file that is not there.
 */
export function fileHistoryRequest(cardId: string | undefined, folder: string): Request | null {
  if (!cardId) return null;
  const held = requests.get(cardId);
  if (!held) return null;
  if (held.folder === folder) return held;
  // ⚠️ **DROPPED, NOT MERELY HIDDEN (found in review).** Returning `null` and
  // leaving the entry in place made a stale pin RESURRECTABLE: the chip correctly
  // vanishes when the folder changes, so the user cannot clear a pin they cannot
  // see — and if the session is later resumed back in the original folder the
  // History tab silently re-pins itself to a file nobody clicked. Deleting here
  // needs no `notify()`: the snapshot this call returns is already `null`, which
  // is the change every subscriber would have been told about.
  requests.delete(cardId);
  return null;
}

/**
 * Pin this card's History tab to one path, and switch to it.
 *
 * Returns false when nothing is listening, so the caller can leave its own
 * affordance out rather than offering a click that does nothing.
 */
export function requestFileHistory(cardId: string | undefined, folder: string, path: string): boolean {
  if (!opener || !cardId || !folder || !path) return false;
  requests.set(cardId, { folder, path });
  notify();
  try {
    opener(cardId);
    return true;
  } catch {
    // The grid throwing must not take the surface that asked with it — and the
    // request STANDS, because the tab will apply it whenever it is next opened.
    // A user who clicked ⏱ and then switched tabs by hand still gets the answer.
    return false;
  }
}

/** Unpin — the chip's ✕. */
export function clearFileHistory(cardId: string | undefined): void {
  if (!cardId) return;
  if (requests.delete(cardId)) notify();
}

/**
 * Forget a card entirely — what `SessionGrid.forgetClosedCard` calls.
 *
 * ⚠️ **WITHOUT THIS, A CLOSED CARD'S PIN LIVED FOR THE RENDERER'S LIFETIME
 * (found in review).** A small leak rather than a wrong answer, but the grid
 * already has the hook for exactly this shape of per-card module state, and a map
 * nothing prunes is the kind of thing that is only ever noticed by a profiler.
 */
export function forgetCardFileHistory(cardId: string | undefined): void {
  if (!cardId) return;
  requests.delete(cardId);
}

/** Test seam — a fresh renderer has no requests, and neither should a test. */
export function resetFileHistory(): void {
  opener = null;
  requests.clear();
  listeners.clear();
}
