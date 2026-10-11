// "I looked at it" (#1219): when a finished session stops being counted.
//
// A session that finishes files a `done` event, "finished, nobody has looked",
// which stays in the count until it is acknowledged. Until this module, exactly
// two things acknowledged: the jump hotkey and a click on the session's row in
// the Events list. Clicking the session in the list of sessions, picking it
// from the strip, clicking its tab, typing in its card, or simply having it in
// front of you when it finished: none of those counted. The owner: "It still
// says 'Need you' at the top, even though I viewed the sessions."
//
// THREE WAYS OF LOOKING, and one thing they all do:
//
//   1. You go to it. The card in front changes while you are using the window:
//      a row, a pill, a tab, a pick from a group's list, the hotkey.
//   2. You touch it. A click, a key or a scroll INSIDE the card that is
//      already in front, in the main window or in a popped-out one.
//   3. It finishes in front of you, while you are using its window.
//
// "USING THE WINDOW" is one test for 1 and 3: the window has the keyboard and
// saw a click, a key or a scroll in the last minute (or saw one a moment ago,
// whatever focus says). VISIBLE IS NOT SEEN: a card on screen while you are at
// lunch has not been looked at, and is still counted when you come back.
//
// What that test cannot tell apart, and does not try to: a card that came to
// the front BY ITSELF while you were busy in the same window (a session set to
// "always jump to it", or the neighbour of a card you just closed). It was put
// in front of someone who is there, which is way 3 by another road.
//
// WAY 2 IS NARROWER THAN "ANY INPUT". A click on the list, a key in the
// command palette or a dialog, a right-click that opens a menu: none of those
// is looking at the card in front, and treating them as such cleared a session
// while its own "Mark as seen" menu was still opening.
//
// ONLY FINISHED WORK CLEARS THIS WAY. Acknowledging is `EventFeed.acknowledge`
// in main, which rewrites a `done` to `ready` and does nothing at all to any
// other kind. A held permission, an open question and a crash cannot be
// silenced by looking at them, by construction and not by a check here.
import { sessionStore } from '../store/session-store';
import { getPopoutWindows, subscribePopoutWindows } from './popout-windows';

/** How recently the window must have been used for "it finished in front of
 *  me" to count as seen. */
export const SEEN_INPUT_WINDOW_MS = 60_000;

/** Input this recent needs no second opinion from the window's focus state. */
export const SEEN_JUST_NOW_MS = 2_000;

/**
 * Is somebody using this window right now? (Ways 1 and 3.)
 */
export function seenWhileWatching(opts: {
  /** the window holding the card has the keyboard */
  windowFocused: boolean;
  /** when that window last saw a click, a key or a scroll, or null for never */
  lastInputAt: number | null;
  now: number;
}): boolean {
  if (opts.lastInputAt === null) return false;
  const ago = opts.now - opts.lastInputAt;
  // A click or a key in this window a moment ago IS the person being here,
  // whatever the window manager says about focus in that instant (a click
  // that is itself bringing the window forward lands before focus does).
  if (ago <= SEEN_JUST_NOW_MS) return true;
  return opts.windowFocused && ago <= SEEN_INPUT_WINDOW_MS;
}

/** Acknowledge this card's finished work. A no-op for a card that has none,
 *  so every caller can ask without checking first. */
export function markSeen(cardId: string | null | undefined): void {
  if (!cardId) return;
  for (const liveId of sessionStore.unseenDoneFor(cardId)) {
    // fail-open: a bridge that is not there costs a count that stays up
    void window.switchboard?.events?.ack?.(liveId);
  }
}

/** Acknowledge every finished session at once: the "N finished" button. */
export function markAllSeen(): void {
  for (const cardId of sessionStore.getFinishedCards()) markSeen(cardId);
}

/** `closest`, for a node that may belong to ANOTHER window's document, where
 *  `instanceof Element` is false. Duck-typed on purpose. */
function closestOf(target: unknown, selector: string): Element | null {
  const el = target as { closest?: (s: string) => Element | null } | null;
  return typeof el?.closest === 'function' ? el.closest(selector) : null;
}

/**
 * The BODY of the card in front that this event landed in, or null when it
 * landed anywhere else: the tabs, the list of sessions, a menu, a dialog.
 */
export function activeCardBody(target: unknown): Element | null {
  const body = closestOf(target, '.dv-content-container');
  if (!body) return null;
  return closestOf(body, '.dv-groupview.dv-active-group') ? body : null;
}

/**
 * The session card whose body this is, in a POPPED-OUT window. Dockview does
 * not report an active panel for another OS window, but the open tab of the
 * group carries its card id (the last-prompt hover's handle).
 */
function popoutCardOf(body: Element): string | null {
  const group = closestOf(body, '.dv-groupview');
  const tab = group?.querySelector('.dv-active-tab [data-last-prompt-for]');
  return tab?.getAttribute('data-last-prompt-for') ?? null;
}

/** Every session card that is the open tab of a group in this document. */
function popoutCardsIn(doc: Document): string[] {
  return Array.from(doc.querySelectorAll('.dv-active-tab [data-last-prompt-for]'))
    .map((t) => t.getAttribute('data-last-prompt-for'))
    .filter((id): id is string => !!id);
}

/**
 * Start watching. Called once, by App; returns the teardown.
 *
 * One store subscription and three listeners per window. Nothing here renders,
 * and none of it does any work unless a card has finished work to clear.
 */
export function installSeenWatch(mainWindow: Window = window): () => void {
  const lastInput = new Map<Window, number>();
  /** per window, so a re-announced popout is not watched twice and a closed
   *  one is let go */
  const watched = new Map<Window, () => void>();

  /** the main window's card in front. Not a popped-out one: that card is in
   *  another window, and input HERE says nothing about whether it was read. */
  const mainFront = (): string | null => {
    const card = sessionStore.getState().activeCard;
    return card && !sessionStore.getPresentation(card).poppedOut ? card : null;
  };

  const onInput = (win: Window, e: Event): void => {
    lastInput.set(win, Date.now());
    if (sessionStore.getFinishedCards().size === 0) return;
    // way 2: only input inside the card's own body is "touching it"
    const body = activeCardBody(e.target);
    if (!body) return;
    const card = win === mainWindow ? mainFront() : popoutCardOf(body);
    if (card && sessionStore.getFinishedCards().has(card)) markSeen(card);
  };

  const watch = (win: Window): void => {
    if (watched.has(win)) return;
    const handler = (e: Event): void => onInput(win, e);
    // CAPTURE, so a handler inside the card that stops the event cannot hide
    // the fact that the user is plainly there
    const kinds = ['pointerdown', 'keydown', 'wheel'] as const;
    for (const k of kinds) win.addEventListener(k, handler, { capture: true, passive: true });
    watched.set(win, () => {
      try {
        for (const k of kinds) win.removeEventListener(k, handler, { capture: true });
      } catch {
        // a popout the OS already took: nothing left to detach from
      }
      lastInput.delete(win);
    });
  };
  const unwatch = (win: Window): void => {
    watched.get(win)?.();
    watched.delete(win);
  };

  watch(mainWindow);
  for (const p of getPopoutWindows()) watch(p.win);
  const offPopouts = subscribePopoutWindows({ added: watch, removed: unwatch });

  const using = (win: Window, now: number): boolean => {
    try {
      return seenWhileWatching({
        windowFocused: win.document.hasFocus(),
        lastInputAt: lastInput.get(win) ?? null,
        now,
      });
    } catch {
      return false; // a window that is going away is not being used
    }
  };

  let front = sessionStore.getState().activeCard;
  let finished = sessionStore.getFinishedCards();
  const offStore = sessionStore.subscribe(() => {
    const nowFront = sessionStore.getState().activeCard;
    const nowFinished = sessionStore.getFinishedCards();
    if (nowFront === front && nowFinished === finished) return;
    const went = nowFront !== front;
    const before = finished;
    front = nowFront;
    finished = nowFinished;
    if (nowFinished.size === 0) return;
    const now = Date.now();
    // ONLY AT THE MOMENT SOMETHING HAPPENED TO THAT CARD: you just went to it
    // (way 1) or it just finished (way 3). The finished set is rebuilt on
    // every change to the feed, so without this a card that finished while
    // you were away would be cleared by ANOTHER session's event arriving a
    // moment after you clicked somewhere else in the window.
    const justFinished = (id: string): boolean => nowFinished.has(id) && !before.has(id);
    const card = mainFront();
    if (
      card &&
      nowFinished.has(card) &&
      (went || justFinished(card)) &&
      using(mainWindow, now)
    ) {
      markSeen(card);
    }
    // way 3, popped-out windows
    for (const p of getPopoutWindows()) {
      if (!using(p.win, now)) continue;
      for (const id of popoutCardsIn(p.win.document)) {
        if (justFinished(id)) markSeen(id);
      }
    }
  });

  return () => {
    offStore();
    offPopouts();
    for (const win of [...watched.keys()]) unwatch(win);
  };
}
