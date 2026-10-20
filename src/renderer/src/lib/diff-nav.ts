// The "3 of 7" beside the diff panel's ↑ / ↓ (#1384).
//
// ⚠️ **THE MOVING IS MONACO'S; ONLY THE COUNTING IS OURS.** The issue asks for
// Monaco's own navigation rather than a hand-rolled hunk walker, and the buttons
// call `IDiffEditor.goToDiff` — which wraps at both ends, scrolls the change to
// the centre and puts the cursor on its first line. What Monaco does not offer is
// "which change is that", so this module answers it from the same two facts
// `goToDiff` itself reads: the change list and the modified editor's cursor line.
//
// ⚠️ **AND IT HAS TO AGREE WITH `goToDiff` ABOUT WHERE A DELETION IS.** The
// public `getLineChanges()` reports a pure deletion as "after line N" —
// `modifiedStartLineNumber = N`, `modifiedEndLineNumber = 0` — but `goToDiff`
// lands the cursor on N + 1, the first line AFTER the hole (it reads the
// internal `LineRange`, whose start is exclusive-style; see `toLineChanges` in
// monaco's `diffEditorWidget.js`). Counting from N would make the counter say
// "not on a change" right after the button put you on one. So a deletion's
// anchor is N + 1, clamped to the file's last line the way `setPosition` clamps.

/** The public shape, so this module never imports monaco. */
export interface LineChangeLike {
  readonly modifiedStartLineNumber: number;
  readonly modifiedEndLineNumber: number;
}

export type DiffNavState =
  /** the worker has not answered yet (or no file is loaded) */
  | { kind: 'pending' }
  /** the two sides are identical, as far as the current options see them */
  | { kind: 'none' }
  /** `index` is 1-based; `null` when the cursor is not on any change */
  | { kind: 'changes'; total: number; index: number | null };

/** Where `goToDiff` puts the cursor for this change, and where the change ends. */
export function changeSpan(c: LineChangeLike, lineCount: number): { from: number; to: number } {
  const last = Math.max(1, lineCount);
  if (c.modifiedEndLineNumber === 0) {
    // a deletion: nothing on the modified side, the cursor goes to the line after
    const at = Math.min(last, Math.max(1, c.modifiedStartLineNumber + 1));
    return { from: at, to: at };
  }
  const from = Math.min(last, Math.max(1, c.modifiedStartLineNumber));
  return { from, to: Math.max(from, Math.min(last, c.modifiedEndLineNumber)) };
}

/**
 * The counter's state.
 *
 * `changes === null` is Monaco's "no diff computed yet" and is NOT the same as
 * an empty list, which is "computed, and identical" — the first must not say
 * "no changes" for the half second the worker takes, or a reader would be told
 * a modified file is unchanged.
 */
export function diffNavState(
  changes: readonly LineChangeLike[] | null,
  cursorLine: number,
  lineCount: number
): DiffNavState {
  if (changes === null) return { kind: 'pending' };
  if (changes.length === 0) return { kind: 'none' };
  const i = changes.findIndex((c) => {
    const s = changeSpan(c, lineCount);
    return cursorLine >= s.from && cursorLine <= s.to;
  });
  return { kind: 'changes', total: changes.length, index: i < 0 ? null : i + 1 };
}

/** Same state, same answer — so a cursor move inside one change re-renders nothing. */
export function sameDiffNavState(a: DiffNavState, b: DiffNavState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'changes' && b.kind === 'changes') return a.total === b.total && a.index === b.index;
  return true;
}

/**
 * Is this keydown one of the two navigation shortcuts? VS Code's, so a hand that
 * knows them does not have to learn ours: **Alt+F5** next, **Shift+Alt+F5**
 * previous. Ctrl / Meta held as well is a different chord and is left alone.
 */
export function diffNavKey(e: {
  key: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): 'next' | 'previous' | null {
  if (e.key !== 'F5' || !e.altKey || e.ctrlKey || e.metaKey) return null;
  return e.shiftKey ? 'previous' : 'next';
}
