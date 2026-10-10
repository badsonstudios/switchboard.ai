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
// ONE ANNOUNCER, A REGION IN EVERY WINDOW, ONE VOICE (#1022). This app's
// popouts are dockview groups adopted into the OPENER's realm
// (`renderer/popout.html` ships no script of its own), so a popped-out card runs
// this module's singleton. Until #1022 it also wrote into the MAIN window's
// regions and nowhere else, and a screen reader parked in a popout heard
// nothing: that was stated in the manual rather than fixed. Now every window
// has a region (`components/PopoutSurfaces`), each tells this module it is
// there, and each announcement is given to exactly ONE of them, chosen HERE:
//
//   - the window a caller NAMES, when it knows better than focus does. The
//     popout key bridge is the case: a chord that RUNS brings the main window
//     forward with it, so its sentence belongs there, while a chord that is
//     REFUSED leaves the user in the popout, and so does its reason;
//   - otherwise the window that has the keyboard;
//   - otherwise the main window.
//
// And never a window with no region mounted in it: a sentence given to nobody
// is a sentence dropped, so those fall to the main window too.

type Listener = (text: string, to: Window) => void;

const listeners = new Set<Listener>();
/** the windows that have a region mounted in them right now, counted */
const voices = new Map<Window, number>();
/** announcements held back until a caller says where they go (`holdAnnouncements`) */
let held: string[] | null = null;
let holds = 0;

/** A region is mounted in `win`. Returns the "it is gone" call. */
export function registerVoice(win: Window): () => void {
  voices.set(win, (voices.get(win) ?? 0) + 1);
  return () => {
    const n = (voices.get(win) ?? 1) - 1;
    if (n <= 0) voices.delete(win);
    else voices.set(win, n);
  };
}

/**
 * The ONE window whose region says the next announcement, when nobody named
 * one: the popout that has the keyboard, else the main window.
 *
 * `windows` is the candidates (in the app: every window with a region in it).
 * Nobody focused (the app is in the background, or a test has no focus at all)
 * falls to the main window, which is what happened before popouts had a region
 * and is the least surprising thing for it to keep doing.
 */
export function voiceWindow(windows: Iterable<Window>, main: Window = window): Window {
  const hasFocus = (w: Window): boolean => {
    try {
      return w.document.hasFocus();
    } catch {
      return false; // closed under us
    }
  };
  // popouts first: a focused popout is the unusual case and the one this is for
  for (const w of windows) if (w !== main && hasFocus(w)) return w;
  return main;
}

function deliver(text: string, to?: Window): void {
  // a named window with no region in it cannot say anything: fall back.
  // (No `window` at all is a test of this module running outside a browser:
  // there is no region anywhere, and the listeners are still owed the text.)
  const target =
    to && voices.has(to)
      ? to
      : typeof window === 'undefined'
        ? (undefined as unknown as Window)
        : voiceWindow(voices.keys());
  for (const fn of Array.from(listeners)) {
    try {
      fn(text, target);
    } catch (err) {
      console.warn('[live-region] a subscriber threw', err);
    }
  }
}

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
  if (held) {
    held.push(text);
    return;
  }
  deliver(text);
}

/**
 * Hold every announcement made from now until the returned function is called,
 * then say them all in the window it is given (or, given none, wherever the
 * keyboard is by then).
 *
 * For a caller that is about to MOVE the keyboard and does not yet know where
 * to. The popout key bridge dispatches a chord, and only once the command has
 * run does it know whether the main window is coming forward; the command's
 * own sentence is made in the middle of that, while the popout still has
 * focus. Said at once, it would land in the window the user is leaving.
 *
 * Nests, and the OUTERMOST release decides: an inner one cannot know more than
 * the caller that wrapped it.
 */
export function holdAnnouncements(): (to?: Window) => void {
  holds += 1;
  held ??= [];
  let done = false;
  return (to) => {
    if (done) return;
    done = true;
    holds -= 1;
    if (holds > 0) return;
    const say = held ?? [];
    held = null;
    for (const text of say) deliver(text, to);
  };
}

/** Listen for announcements, each with the window that is to say it. Returns the unsubscribe. */
export function subscribeAnnouncements(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test seam: forget every subscriber, voice and held sentence. */
export function resetAnnouncementsForTest(): void {
  listeners.clear();
  voices.clear();
  held = null;
  holds = 0;
}
