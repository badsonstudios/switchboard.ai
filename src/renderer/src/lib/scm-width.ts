// How wide the Changes tab's file list is (#1142).
//
// It was a fixed 240px. The owner, with two cards side by side and every name
// cut to a few letters: "I should be able to pull that over so I can see full
// file names."
//
// ONE WIDTH FOR EVERY SESSION, like the Sessions list's own (`railWidth`): drag
// it once and every Changes tab — in every card, and in a popped-out window's
// own copy of this module after its next mount — uses it. A width per card was
// the alternative; it means setting it again for each one, which is the chore
// this exists to remove.
//
// Pure arithmetic plus a tiny subscribable value. No React, no DOM: the
// component turns pointer events into calls here, and the mirror for
// right-to-left is one subtraction that is invisible to anyone reading in
// English (the same reason `railWidthAtPointer` is a tested function).
import { uiGet, uiSet } from './ui-state';

/** The width it has always had. */
export const SCM_WIDTH_DEFAULT = 240;
/** Narrower than this and a row cannot show a letter, a name and its numbers. */
export const SCM_WIDTH_MIN = 180;
/** Wide enough for a deep path; past it the list is taking the diff's room. */
export const SCM_WIDTH_MAX = 640;
/** What the diff beside the list always keeps, however far the edge is dragged. */
export const SCM_BODY_MIN = 200;
/** One arrow-key press on the focused edge. */
export const SCM_WIDTH_STEP = 16;

const KEY = 'scmWidth';

/**
 * A width the list may actually take inside a pane `paneWidth` wide.
 *
 * `paneWidth` is the whole Changes tab (list + diff). Absent or unusable, only
 * the fixed bounds apply — which is the case before the pane has been measured,
 * and in a test that has no layout.
 *
 * The minimum WINS over the body's share: on a card too narrow for both, the
 * list keeps its 180px and the diff gets what is left, exactly as it did when
 * the list was a fixed 240.
 */
export function clampScmWidth(px: number, paneWidth?: number): number {
  if (!Number.isFinite(px)) return SCM_WIDTH_DEFAULT;
  let max = SCM_WIDTH_MAX;
  if (paneWidth !== undefined && Number.isFinite(paneWidth) && paneWidth > 0) {
    max = Math.min(max, paneWidth - SCM_BODY_MIN);
  }
  return Math.round(Math.max(SCM_WIDTH_MIN, Math.min(max, px)));
}

/**
 * The width while the edge is being dragged.
 *
 * Relative to where the drag STARTED, not to the window: the list sits inside a
 * card that can be anywhere on screen, so unlike the Sessions list there is no
 * edge of the viewport to measure from. Under `dir="rtl"` the list is on the
 * right of its pane and its free edge is its LEFT one, so dragging left makes
 * it wider.
 */
export function scmWidthFromDrag(
  startWidth: number,
  startX: number,
  clientX: number,
  direction: 'ltr' | 'rtl',
  paneWidth?: number
): number {
  const moved = direction === 'rtl' ? startX - clientX : clientX - startX;
  return clampScmWidth(startWidth + moved, paneWidth);
}

// ── the one shared value ───────────────────────────────────────────────────

let current: number | null = null;
const listeners = new Set<() => void>();

/** The stored width, clamped to the fixed bounds. Read lazily: `ui-state` is
 *  filled in at boot, after this module has been imported. */
export function getScmWidth(): number {
  if (current === null) current = clampScmWidth(uiGet<number>(KEY, SCM_WIDTH_DEFAULT));
  return current;
}

/**
 * Change the width for every list on screen.
 *
 * `persist: false` while a drag is in flight: the value moves on every pointer
 * event and only the last one is worth writing down.
 */
export function setScmWidth(px: number, opts: { persist?: boolean } = {}): void {
  const next = clampScmWidth(px);
  const changed = next !== getScmWidth();
  current = next;
  if (opts.persist !== false) uiSet(KEY, next);
  if (changed) for (const l of [...listeners]) l();
}

/** For `useSyncExternalStore`. */
export function subscribeScmWidth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forget the cached value so the next read goes back to `ui-state`. */
export function resetScmWidthForTests(): void {
  current = null;
  listeners.clear();
}
