// Which modal is on top (#1020).
//
// A dialog marked `aria-modal="true"` tells assistive technology that it owns
// the window and everything else is to be ignored. Two of them at once is a
// contradiction, and screen readers resolve it differently. #1008 stopped the
// two Help dialogs stacking by having each close the other, and said so: it
// covered the twins it created. Nothing stopped any other pair. The app's
// keyboard guard knew about nine dialogs and not the five whose state lives
// inside a card; an update prompt arrives from the main process whatever is
// open; `/mcp` typed in a popped-out window opens a dialog in the main one.
//
// THE RULE, decided once and here: dialogs may stack, and ONLY THE TOP ONE IS
// MODAL. The ones beneath it lose `aria-modal` and are `inert` (no focus, no
// clicks, skipped by assistive technology) until they are on top again.
//
// Stacking, and not "the newcomer closes the one beneath", for a reason that
// is about the user's work: Report a problem and Feature request hold text
// somebody typed. An update prompt that arrives over one must not throw that
// away. And two stacks are deliberate (About opens Settings and the update
// dialog over itself).
//
// PER DOCUMENT. A popped-out card is a second document in its own OS window
// (the session history window travels with its card). A dialog there and a
// dialog in the main window are one modal each, in two windows, and neither
// is beneath the other.
//
// PAINT ORDER FOLLOWS THE STACK. Each dialog used to carry a fixed layer number
// (50, 51 or 60), so which one was DRAWN on top was decided by those numbers
// and by where it sat in the tree, and which one was MODAL by which opened
// last. Where the two disagreed, the dialog you could see was the inert one:
// dead to the keyboard, and one click on it fell through to its own
// backdrop and dismissed it. So a dialog is lifted above every modal that
// was open before it (`lift`), and what is on top is what is modal.
//
// EVERY DIALOG CALLS `useModalLayer`. `modal-layer.test.tsx` reads the source
// and fails for any component with a dialog role that does not.
import React from 'react';

interface Layer {
  readonly id: symbol;
  readonly doc: Document;
}

/** open modals, oldest first */
const layers: Layer[] = [];
const listeners = new Set<() => void>();

function announce(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* fail-open: a bad subscriber costs its own update, not everyone's */
    }
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** A modal opened in `doc`. Returns the function that says it has closed. */
export function pushModalLayer(id: symbol, doc: Document): () => void {
  layers.push({ id, doc });
  announce();
  return () => {
    const at = layers.findIndex((l) => l.id === id);
    if (at < 0) return;
    layers.splice(at, 1);
    announce();
  };
}

/**
 * Is this modal the top one in its own document?
 *
 * A modal that has not registered yet answers TRUE: it renders once before
 * its layout effect runs, and for that render it is the newest thing on
 * screen, which is the top.
 */
export function isTopModalLayer(id: symbol): boolean {
  const mine = layers.find((l) => l.id === id);
  if (!mine) return true;
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    if (layers[i].doc === mine.doc) return layers[i].id === id;
  }
  return true;
}

/** How far apart two stacked modals are drawn. More than the spread of the
 *  dialogs' own layer numbers (50 to 60), so a later one is always above. */
export const MODAL_LIFT_STEP = 20;

/**
 * How far to lift this modal above its own layer number: one step for every
 * modal already open in its document. Not registered yet (its first render),
 * it is about to be the newest, so it is lifted above all of them.
 */
export function modalLift(id: symbol, doc: Document = document): number {
  const mine = layers.find((l) => l.id === id);
  const where = mine?.doc ?? doc;
  let beneath = 0;
  for (const l of layers) {
    if (l.id === id) break;
    if (l.doc === where) beneath += 1;
  }
  return beneath * MODAL_LIFT_STEP;
}

/** Is any modal open in this document? What the keyboard guard asks. */
export function isModalOpen(doc: Document = document): boolean {
  return layers.some((l) => l.doc === doc);
}

/** How many modals are open in this document (the tests' question). */
export function modalDepth(doc: Document = document): number {
  return layers.filter((l) => l.doc === doc).length;
}

/** The tests' reset, and nothing else's. */
export function resetModalLayersForTest(): void {
  layers.length = 0;
  announce();
}

/**
 * Take a place in the stack while `open`, and answer whether this modal is on
 * top and how far to lift it. Write the answers onto the dialog:
 *
 *     aria-modal={top ? 'true' : undefined}
 *     inert={!top}
 *     zIndex: <its own layer number> + lift      (on its backdrop)
 *
 * `where` is anything inside the dialog, for a dialog that can be in a
 * popped-out window: its `ownerDocument` is the stack it joins. Without it,
 * the main window's.
 *
 * A LAYOUT effect, for `modal-dismiss.ts`'s reason: the dialog beneath stops
 * being modal in the same commit the new one appears, not a task later.
 */
export function useModalLayer(
  open: boolean,
  where?: React.RefObject<Element | null>
): { top: boolean; lift: number } {
  const [id] = React.useState(() => Symbol('modal'));
  React.useLayoutEffect(() => {
    if (!open) return;
    return pushModalLayer(id, where?.current?.ownerDocument ?? document);
    // `where` is a ref: its identity is stable and its value is read here
  }, [open, id, where]);
  // two primitives, not one object: a snapshot has to be the same VALUE when
  // nothing changed, or every stack change re-renders every dialog forever
  const top = React.useSyncExternalStore(
    subscribe,
    () => isTopModalLayer(id),
    () => true
  );
  const lift = React.useSyncExternalStore(
    subscribe,
    () => modalLift(id, where?.current?.ownerDocument ?? document),
    () => 0
  );
  return React.useMemo(() => ({ top, lift }), [top, lift]);
}
