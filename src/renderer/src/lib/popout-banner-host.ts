// A place to put the read-only notice inside a popped-out window (#208).
//
// A popout is its own DOCUMENT. dockview adopts the group's DOM into it and
// copies the opener's stylesheets across, but nothing of the app's chrome goes
// with it — so #168's notice ("nothing you do this run will be saved") stopped
// at the main window, and a user who works the whole run in a maximized popout
// was told nothing at all. That is the exact failure #168 exists to prevent.
//
// This module owns only the DOM plumbing: WHERE the notice goes in that other
// document, and WHEN we learn a popout came or went. The notice itself, and the
// one call that decides whether there is anything to say, stay in
// WorkspaceReadOnlyBanner.tsx — there is still a single source of truth.
//
// Everything here is fail-open by construction: a popout window can be closed
// (or navigating) between the event and our reaching into it, and touching a
// dead window throws. A missing notice is bad; a renderer that dies trying to
// draw one is worse.

/** marks the host element we insert; also the CSS hook in popout.html */
const HOST_ATTR = 'data-sb-banner-host';
/** marks the body so popout.html's rules make room for the host */
const BODY_ATTR = 'data-sb-banner';

/**
 * The element to portal the notice into, at the very top of the popout's body.
 *
 * Idempotent: dockview can hand us the same window twice (it reuses a named
 * window when the same group is popped out again), and a second host would be a
 * second notice. Returns null if the window is gone — the caller renders
 * nothing rather than throwing.
 *
 * There is no retry behind that null, and none is needed: dockview appends its
 * container and only THEN announces the popout, from the child window's own
 * `load` handler, so by the time anyone calls this the body exists. A null here
 * means the window has already gone away, and a window that has gone away is
 * not coming back.
 */
export function mountBannerHost(win: Window): HTMLElement | null {
  try {
    const doc = win.document;
    const body = doc?.body;
    if (!body) return null;
    const existing = body.querySelector<HTMLElement>(`:scope > [${HOST_ATTR}]`);
    const host = existing ?? doc.createElement('div');
    if (!existing) {
      host.setAttribute(HOST_ATTR, '');
      // first child, so the notice is the first thing in the window and the
      // first thing a screen reader walking the document meets
      body.insertBefore(host, body.firstChild);
    }
    body.setAttribute(BODY_ATTR, '');
    return host;
  } catch {
    return null; // window closed mid-flight — nothing to draw into
  }
}

/**
 * Undo `mountBannerHost`. Called when React unmounts the portal, which in
 * practice means the popout closed (nothing to do) or the notice's window was
 * re-docked into the main one (where the leftover flex column would otherwise
 * outlive it in a re-used window).
 */
export function unmountBannerHost(win: Window): void {
  try {
    const body = win.document?.body;
    if (!body) return;
    body.querySelector<HTMLElement>(`:scope > [${HOST_ATTR}]`)?.remove();
    body.removeAttribute(BODY_ATTR);
  } catch {
    /* the window is already gone — which is the state we wanted */
  }
}

/**
 * Subscribe to popouts opening and closing.
 *
 * SessionGrid already republishes dockview's `onDidAddPopoutGroup` /
 * `onDidRemovePopoutGroup` as window events carrying the popout's `Window` —
 * that is how App gives each popout the keyboard dispatcher and the theme
 * flags. Listening to the same events keeps this feature out of everyone else's
 * files, and dockview stays the authority on which windows exist — nobody here
 * decides anything, they only listen.
 *
 * That does make three separate lists of the same windows (App's keyboard map,
 * tab-rows' theme set, and now the banner's), each with its own subscription.
 * Not worth a refactor for one notice; worth one for whoever adds the fourth —
 * a shared `lib/popout-windows.ts` is the obvious shape.
 *
 * Returns the unsubscribe.
 */
export function onPopoutWindows(handlers: {
  added: (win: Window) => void;
  removed: (win: Window) => void;
}): () => void {
  const onAdded = (e: Event): void => {
    const win = (e as CustomEvent<Window>).detail;
    if (win) handlers.added(win);
  };
  const onRemoved = (e: Event): void => {
    const win = (e as CustomEvent<Window>).detail;
    if (win) handlers.removed(win);
  };
  window.addEventListener('switchboard:popout-added', onAdded);
  window.addEventListener('switchboard:popout-removed', onRemoved);
  return () => {
    window.removeEventListener('switchboard:popout-added', onAdded);
    window.removeEventListener('switchboard:popout-removed', onRemoved);
  };
}
