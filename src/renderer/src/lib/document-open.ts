// "Open this file in the viewer", from anywhere in the renderer (P2-E16-02).
//
// §5.30 says a viewer opens "from wherever a path already appears" — a path in
// a Session-view block, the Changes tab's file list, the Files tree, a drop on
// the window, `Open file…` in the palette. Those surfaces have nothing in
// common: some are React components deep inside a dockview panel, some are
// command callbacks, and the thing that actually opens a panel is a
// `DockviewApi` held in a ref inside `SessionGrid`.
//
// So the seam is a module, not a prop and not a context. It is the same shape
// as `extensibility/registry-instance.ts` — one instance, set once during
// mount, read by whoever needs it — and it is chosen over threading a callback
// through `PanelContext` for a reason that outlives this item: every future
// caller (a feed block, a drop target, the §5.7 tree) would otherwise be
// another prop through another surface's props, and each of those is a shared
// file that a parallel worker is also editing.
//
// FAIL-OPEN: with no opener registered, `openDocument` reports false and does
// nothing. A click on a path before the grid is ready must not throw.

/** What actually opens a panel — installed by `App` from the grid controller. */
export type DocumentOpener = (absolutePath: string) => void;

let opener: DocumentOpener | null = null;

/** Install (or, with null, remove) the opener. Called from App's mount effect. */
export function setDocumentOpener(next: DocumentOpener | null): void {
  opener = next;
}

/** Is there somewhere to open a document right now? */
export function canOpenDocuments(): boolean {
  return opener !== null;
}

/**
 * Open `absolutePath` in a document viewer.
 *
 * Returns false when nothing is listening, so a caller can leave its own
 * affordance disabled rather than offering a click that does nothing.
 */
export function openDocument(absolutePath: string): boolean {
  if (!opener || typeof absolutePath !== 'string' || absolutePath.length === 0) return false;
  try {
    opener(absolutePath);
    return true;
  } catch {
    // The grid throwing must not take the surface that asked with it.
    return false;
  }
}
