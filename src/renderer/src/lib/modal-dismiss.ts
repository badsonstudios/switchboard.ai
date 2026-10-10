// The half of a modal's behaviour that has nothing to do with what is in it
// (#1008): where focus was, where it goes, and where it comes back to.
//
// Pulled out of `ReportProblemDialog` when `FeatureRequestDialog` arrived,
// because the alternative was a second copy — and a second copy of focus
// restoration is how one of them quietly stops doing it. `SettingsDialog` set
// the shape this keeps; two modals that behave differently is a bug report
// waiting to happen, which is the note #815 left on itself.
//
// IT HANDS BACK `close` RATHER THAN OWNING THE DIALOG, and that is the point of
// the split: a successful send has to close the window from inside the
// component's own promise chain, and it must restore focus when it does. A
// component that could only be closed by Escape or by Cancel would drop the
// user's focus on the floor every time the button actually worked.
import React from 'react';

export interface ModalDismiss {
  /** put this on the dialog element — it is what receives focus on open */
  dialogRef: React.RefObject<HTMLDivElement | null>;
  /** close it AND put focus back where it was */
  close: () => void;
}

export function useModalDismiss(open: boolean, onClose: () => void): ModalDismiss {
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);

  // A LAYOUT EFFECT, NOT A PASSIVE ONE (#1171). When the open did not come from
  // a click or a key press in this window (a native menu item, a chord main
  // claimed, anything after an `await`), a passive effect runs in a later task
  // than the commit that puts the dialog on screen, so for that long the
  // dialog was visible and the keyboard was still wherever it had been. A key
  // pressed in the gap went there: Escape reached the prompt box and the dialog
  // stayed open. Measured, not reasoned about: at the moment the dialog entered
  // the document, `document.activeElement` was the prompt box, three runs of
  // three; and the Windows CI trace has Escape 1ms after the dialog was first
  // seen. A layout effect runs inside the commit, so "on screen" and "has the
  // keyboard" are the same moment. Every modal that takes focus on open does
  // it this way; `e2e/file-menu.spec.ts` holds Settings to it.
  React.useLayoutEffect(() => {
    if (!open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
  }, [open]);

  const close = React.useCallback((): void => {
    onClose();
    const el = returnFocusTo.current;
    // NEXT FRAME, not now: the element we are handing focus back to may be
    // inside a tree React is about to re-render, and focusing it before that
    // settles puts the caret somewhere that is gone a millisecond later.
    requestAnimationFrame(() => el?.focus?.());
  }, [onClose]);

  return { dialogRef, close };
}
