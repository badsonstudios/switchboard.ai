// Which element had focus when a chord claimed above the renderer arrived (#90).
//
// The keystroke came in through the browser process, not through the DOM, so
// there is no event to read a target off — and the answer may not even be in
// this document: a popped-out session is its OWN window, with its own
// activeElement, and ours is stale the moment focus leaves it.
//
// The answer feeds classifyTarget, which decides whether a command that must
// stand down while you type gets to run. Guessing wrong costs at most one
// stood-down hotkey; it can never make a command fire in a text input that
// really has focus, because a document that does NOT hold focus is skipped.

/** The parts of a Window this needs — a real popout, or a fake in a test. */
export interface FocusableWindow {
  document: { hasFocus(): boolean; activeElement: Element | null };
}

export function focusedElementIn(
  popouts: Iterable<FocusableWindow>,
  fallback: { activeElement: Element | null }
): Element | null {
  for (const win of popouts) {
    try {
      if (win.document.hasFocus()) return win.document.activeElement;
    } catch {
      // a popout mid-close throws on document access: it is not the one with
      // focus, and a torn-down window must never take the hotkey down with it
    }
  }
  return fallback.activeElement;
}
