// "Which session is the user in?" — told to main (#1267).
//
// The needs-you cue rings when a session you are NOT in asks for an approval
// or asks a question. Main runs that rule and owns window focus, but which
// CARD is in front is only known here: the active card in the main window, or
// the open tab of a focused pop-out (whose DOM lives in this realm — dockview
// adopts it). So this module works the answer out and sends it on every
// change. It never decides anything about sound.
//
// WHAT A FAILURE COSTS. No bridge, or no report yet: main treats every card
// as not in front, and the cue rings for the session you are already looking
// at — an extra sound. A report that is LOST after an earlier one landed
// leaves main with the card before: if that card then asks, it gets the plain
// beep instead of the needs-you cue — the wrong sound, never silence. A failed
// send is retried on the next change (P6).
import { sessionStore } from '../store/session-store';
import { getPopoutWindows, subscribePopoutWindows } from './popout-windows';

/** The open tab's card in a pop-out document — the active group first. */
export function popoutFrontCard(doc: Document): string | null {
  const pick = (sel: string): string | null =>
    doc.querySelector(sel)?.getAttribute('data-last-prompt-for') ?? null;
  return (
    pick('.dv-groupview.dv-active-group .dv-active-tab [data-last-prompt-for]') ??
    pick('.dv-active-tab [data-last-prompt-for]')
  );
}

/**
 * The card in front of the user right now.
 *
 * A pop-out that has the keyboard wins: that is the window being typed in.
 * Otherwise the main window's active card — unless it is popped out, in which
 * case the main window is not where it is being read. Whether the APP has
 * focus at all is main's question (`visibilityAcross`), not this one's: the
 * rule that reads this answer only runs while it does.
 */
export function frontCardNow(): string | null {
  for (const p of getPopoutWindows()) {
    try {
      if (!p.win.document.hasFocus()) continue;
      const card = popoutFrontCard(p.win.document);
      if (card) return card;
    } catch {
      // a pop-out the OS already took is not where anyone is typing
    }
  }
  const card = sessionStore.getState().activeCard;
  return card && !sessionStore.getPresentation(card).poppedOut ? card : null;
}

interface FrontBridge {
  setFrontCard?: (cardId: string | null) => Promise<unknown>;
}

/**
 * Start reporting. Called once, by App; returns the teardown.
 *
 * Recomputed on a store change (a row, a pill, a tab or the hotkey moved the
 * active card), on focus moving between our windows, and on a click or a key
 * in any of them (a tab picked inside a pop-out moves nothing in the store).
 * Coalesced to one computation per task, and SENT only when the answer
 * changed — this runs on every keystroke, and a report per keystroke would be
 * an IPC round trip per keystroke.
 */
export function installFrontCardReport(
  bridge: FrontBridge | undefined,
  mainWindow: Window = window
): () => void {
  if (!bridge?.setFrontCard) return () => {};
  let last: string | null | undefined = undefined;
  let queued = false;
  const report = (): void => {
    queued = false;
    let now: string | null;
    try {
      now = frontCardNow();
    } catch {
      now = null;
    }
    if (now === last) return;
    last = now;
    try {
      void bridge.setFrontCard?.(now)?.catch(() => {
        last = undefined; // not delivered: the next change tries again
      });
    } catch {
      last = undefined;
    }
  };
  const soon = (): void => {
    if (queued) return;
    queued = true;
    setTimeout(report, 0);
  };

  const watched = new Map<Window, () => void>();
  const kinds = ['focus', 'blur', 'pointerdown', 'keydown'] as const;
  const watch = (win: Window): void => {
    if (watched.has(win)) return;
    for (const k of kinds) win.addEventListener(k, soon, { capture: true, passive: true });
    watched.set(win, () => {
      try {
        for (const k of kinds) win.removeEventListener(k, soon, { capture: true });
      } catch {
        // a pop-out the OS already took: nothing left to detach from
      }
    });
  };
  const unwatch = (win: Window): void => {
    watched.get(win)?.();
    watched.delete(win);
    soon();
  };

  watch(mainWindow);
  for (const p of getPopoutWindows()) watch(p.win);
  const offPopouts = subscribePopoutWindows({
    added: (win) => {
      watch(win);
      soon();
    },
    removed: unwatch,
  });
  // The store changes on every streamed frame; only the active card, and
  // whether it is popped out, can move the answer.
  const key = (): string => {
    const card = sessionStore.getState().activeCard;
    return card ? `${card}|${sessionStore.getPresentation(card).poppedOut ? 1 : 0}` : '';
  };
  let front = key();
  const offStore = sessionStore.subscribe(() => {
    const now = key();
    if (now === front) return;
    front = now;
    soon();
  });
  soon();

  return () => {
    offStore();
    offPopouts();
    for (const win of [...watched.keys()]) watched.get(win)?.();
    watched.clear();
  };
}
