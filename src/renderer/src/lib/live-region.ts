// THE APP'S ONE ANNOUNCER OUTSIDE ANY SURFACE (#581).
//
// Every live region the renderer had before this one belonged to a surface: the
// rail owns the one that speaks a menu-driven move (#253), the events panel
// wraps its own notices (#314), the batch bar and the composer's attachment list
// each carry theirs. That is the right shape for news a surface produces, and it
// is the reason §5.32's rule (b) was already discharged on the MENU path of all
// three chord families this closes.
//
// A CHORD HAS NO SURFACE. `Mod+Alt+P`, `Mod+Shift+Arrow` and `Mod+Alt+Arrow` are
// window-scoped commands that act on the active card from wherever the keyboard
// happens to be — which may be a composer, a feed, a diff, or nothing at all.
// `lib/command-set.ts` said so in as many words and declined to speak: "giving
// them a voice would mean a second announcer outside the surface that knows what
// the list looks like. If that ever changes, it should change for all three at
// once." This is that announcer, and this is that change.
//
// NOT `lib/announcer.ts`, which is the SOUND module — chimes and speech synthesis
// for attention events. Named apart on purpose; they are two different promises
// to two different users.
//
// A MODULE SINGLETON, like `sessionStore` — one announcer per JS realm, with no
// registry and nothing to keep in sync.
//
// THAT IS NOT THE SAME AS ONE PER WINDOW, and the difference matters here: this
// app's popouts are dockview groups adopted into the OPENER's realm
// (`renderer/popout.html` ships no script of its own), so a popped-out card runs
// this module's singleton and writes into the MAIN window's regions. It is also
// where the chord would have landed anyway — the popout key bridge forwards a
// card-scoped command back to the main window to run — so the announcement is in
// the window that acted. A screen reader parked in the popout will not hear it,
// which is stated in the manual rather than papered over. Making it hear would
// mean §5.8 deciding which window a command acts in, and that is not a live-region
// question.

type Listener = (text: string) => void;

const listeners = new Set<Listener>();

/**
 * Say something to a screen reader, from anywhere in the renderer.
 *
 * Fire-and-forget by design: a caller that has just changed some state should
 * not also have to know whether anybody is listening, or care that in a test
 * nobody is. An empty string is dropped — "announce nothing" is the absence of a
 * call, and letting it through would clear the region a previous announcement is
 * still being read out of.
 */
export function announce(text: string): void {
  if (!text) return;
  // A copy, so a listener that unsubscribes itself while being called cannot
  // make the iteration skip the next one.
  for (const fn of Array.from(listeners)) {
    try {
      fn(text);
    } catch (err) {
      // Fail-open (PHILOSOPHY §3), and the same shape the store's notify loop
      // uses: a broken subscriber costs itself, not the keystroke. This is called
      // from a keydown handler — a throw here would surface as a chord that
      // "does nothing" long after anyone would think to look at the announcer.
      console.warn('[live-region] a subscriber threw', err);
    }
  }
}

/** Listen for announcements. Returns the unsubscribe. */
export function subscribeAnnouncements(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test-only reset, so one file's listeners cannot leak into the next. */
export function resetAnnouncementsForTest(): void {
  listeners.clear();
}
