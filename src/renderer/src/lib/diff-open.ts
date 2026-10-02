// "Open this comparison in a diff panel", from anywhere in the renderer
// (E24 Git v2 item 5, §5.7).
//
// The same seam as `lib/document-open.ts`, for the same reason it gives: the
// surfaces that want to open a diff have nothing in common — the Changes tab's
// row (a React component deep inside a dockview panel), the History tab's commit
// file list, a command callback — and the thing that actually opens a panel is a
// `DockviewApi` held in a ref inside `SessionGrid`.
//
// So the seam is a module, not a prop and not a context. Threading a callback
// through `PanelContext` would make every future caller another prop through
// another surface's props, and each of those is a shared file.
//
// FAIL-OPEN: with no opener registered, `openDiff` reports false and does
// nothing. A click on a diff before the grid is ready must not throw — and the
// Changes tab uses the `false` to keep its in-place preview as the route that
// always works.
import type { DiffTarget } from './diff-panels';

/**
 * What actually opens a panel — installed by `App` from the grid controller.
 *
 * Takes the whole `DiffTarget` rather than a path, because what identifies a diff
 * is the COMPARISON and not the file: see `diffKey`.
 */
export type DiffOpener = (target: DiffTarget) => void;

let opener: DiffOpener | null = null;

/** Install (or, with null, remove) the opener. Called from App's mount effect. */
export function setDiffOpener(next: DiffOpener | null): void {
  opener = next;
}

/**
 * Is there somewhere to open a diff panel right now?
 *
 * Read by the Changes tab to decide whether to offer its ⧉ at all — design §3 is
 * explicit that ⧉ is *"the escalation, not the only route"*, so a surface with
 * nowhere to escalate to shows no button rather than a dead one. The owner's rule
 * about a `＋` that does nothing, applied to the control this item adds.
 */
export function canOpenDiffs(): boolean {
  return opener !== null;
}

/**
 * Open a diff panel for `target`.
 *
 * Returns false when nothing is listening, so a caller can leave its own
 * affordance disabled rather than offering a click that does nothing.
 */
export function openDiff(target: DiffTarget): boolean {
  if (!opener) return false;
  // A folder is the one field with no sensible default: without it there is
  // nothing to read either side from, and `diffKey` would fold an empty string
  // into a key that collides with every other empty-folder request.
  if (typeof target.folder !== 'string' || target.folder.length === 0) return false;
  try {
    opener(target);
    return true;
  } catch {
    // The grid throwing must not take the surface that asked with it.
    return false;
  }
}
