// The one list of the popped-out windows dockview has opened (#227).
//
// A popped-out session lives in its own OS window and its own DOCUMENT, but its
// JS runs here — dockview adopts the group's DOM into the new window and leaves
// the code in this realm. So three separate features have to know which of those
// windows exist right now:
//
//   - App gives each one the keyboard dispatcher (#90/E9-02) — a popout with no
//     shortcuts is a session you cannot reach the palette from;
//   - tab-rows copies this window's theme and tab-row flags across (#84) — a
//     popout with neither renders in the stylesheet's default theme;
//   - the workspace read-only notice draws itself into every one of them (#208).
//
// Each of those grew its OWN list, filled by its OWN subscription to the same
// two window CustomEvents SessionGrid published. Three registries for one fact
// with no shared definition of "open" between them: drift waiting to happen —
// the next feature makes four, and the first one to disagree about membership
// does it silently, in the window the user is actually sitting in.
//
// So: this module is the registry, and the only thing that says a popout came or
// went. SessionGrid (which owns the dockview instance, the sole authority on
// which popouts exist) calls `addPopoutWindow` / `removePopoutWindow`; everyone
// else reads `getPopoutWindows()` and/or subscribes here. The
// `switchboard:popout-added` / `-removed` window events are gone with the three
// lists — they were an untyped bus between modules in the same realm, and every
// listener they ever had is in this repo.
//
// Nothing here DECIDES anything: dockview remains the authority, this is its
// bookkeeping. And nothing here may throw into the caller — a popout that fails
// to be registered would be a session the keyboard cannot reach.
//
// With one exception, which is why the registry is worth having (#279): dockview
// only reports what dockview DID. A popout the OS took — killed from the task
// bar's close, lost with a crashed child window — never produces a remove event,
// and the entry would be retained for the life of the app. Every one of the
// three old lists had that hole; there is one place to close it now, so the
// registry also asks the windows themselves whether they are still there.

/**
 * One open popout window, with a key React can hold onto.
 *
 * The `id` is the reason this is a list of records and not a `Set<Window>`: a
 * `Window` is a fine map key but a poor React key, and dockview REUSES a named
 * window when the same group is popped out again — so a fresh entry has to be
 * distinguishable from the one that just closed. Ids are never reused.
 */
export interface TrackedPopout {
  readonly id: number;
  readonly win: Window;
}

/** listener bundle; every member optional, so a consumer takes only what it needs */
export interface PopoutListener {
  /**
   * dockview announced a popout — usually a new one, but ALSO a re-announced
   * one. A window dockview reuses is a fresh DOCUMENT with none of our flags on
   * it, so a consumer that writes into that document (the theme sync) has to
   * redo its work, and one that merely keys off the window (the keyboard
   * dispatcher) no-ops on the repeat. Whether the registry actually grew is
   * `changed`'s question, not this one.
   */
  added?: (win: Window) => void;
  /**
   * a window we knew about closed or was docked back — or was found already
   * closed by the liveness sweep (#279). Deliberately indistinguishable: the
   * window is gone either way, and only the messenger differs.
   */
  removed?: (win: Window) => void;
  /**
   * membership actually changed — the `useSyncExternalStore` shape, for
   * consumers that render the list rather than reacting to the transition. A
   * re-announced window is not a change and does not fire this: it would put a
   * second notice in the same popout.
   */
  changed?: () => void;
}

let seq = 0;
/**
 * The snapshot. Replaced (never mutated) on every change, so its identity is a
 * valid `useSyncExternalStore` snapshot: React compares by reference and would
 * loop forever on a getter that built a new array each call.
 */
let tracked: readonly TrackedPopout[] = Object.freeze([]);
const listeners = new Set<PopoutListener>();

/**
 * How often the registry checks that the windows it holds are still open (#279).
 *
 * dockview is the authority on which popouts exist, but it only knows what it
 * did — a window the OS took (killed, or closed during a crash) never produces
 * a remove event, and the entry would otherwise be retained forever. So the
 * registry also asks the windows themselves.
 *
 * Five seconds because the answer is one boolean read per open popout and there
 * are never more than a handful, while the cost of asking LATE is nothing a
 * user can see: every consumer of a dead window already fails open (the theme
 * copy catches, the keyboard handler goes to an inert EventTarget, the notice
 * portals into a document nobody is looking at). This is a janitor, not a
 * watchdog — so it must never be the reason a frame is late.
 *
 * The timer exists only while at least one popout is open, which for most of
 * any session is never (see `syncSweepTimer`).
 */
const LIVENESS_SWEEP_MS = 5_000;
let sweepTimer: ReturnType<typeof setInterval> | undefined;

/**
 * every popout currently open, in the order they opened
 *
 * Deliberately does NOT sweep: this is `useSyncExternalStore`'s `getSnapshot`,
 * which must be pure — a read that could drop an entry and notify would change
 * the store from inside React's own read of it. The sweep runs at the honest
 * moments instead (`addPopoutWindow`, `removePopoutWindow`, the interval).
 */
export function getPopoutWindows(): readonly TrackedPopout[] {
  return tracked;
}

/** the same list as bare windows, for the consumers that don't need the keys */
export function openPopoutWindows(): Window[] {
  return tracked.map((p) => p.win);
}

/**
 * Register a popout dockview has just opened.
 *
 * The REGISTRY is idempotent by window — dockview re-announces a reused window
 * when the same group is popped out again, and a second entry would mean a
 * second read-only notice keyed as a different popout. That de-duplication used
 * to live separately in all three consumers; now it is here, once, and they
 * cannot disagree about it.
 *
 * The ANNOUNCEMENT is not deduplicated: `added` fires either way (see the
 * listener docs — a reused window is a fresh document that has to be re-themed,
 * and that repeat is the one thing the old three-list code did NOT dedupe).
 */
export function addPopoutWindow(win: Window): void {
  if (!win) return; // dockview's event can carry no window; fail open, ignore it
  // Before anything else, bury the dead (#279). A popout the OS took never
  // fired a remove event, and an announcement is the cheapest honest moment to
  // notice: the list is about to be walked anyway. It matters here in
  // particular because "pop the same group out again" is exactly how a user
  // follows up a window that vanished — the stale entry and its replacement
  // would otherwise sit in the registry side by side.
  //
  // The window being announced is taken on dockview's word rather than tested:
  // it is the authority on what it just opened, and if it somehow hands us one
  // that is already gone, the interval collects it.
  sweepClosedWindows();
  const known = tracked.some((p) => p.win === win);
  if (!known) {
    tracked = freeze([...tracked, { id: ++seq, win }]);
    syncSweepTimer();
  }
  notify('added', win, !known);
}

/**
 * Forget a popout that closed or was docked back.
 *
 * A window we never had is silently ignored — the consumers' own removals were
 * all no-ops in that case anyway (a delete from a set that lacks it, a filter
 * that matches nothing), so announcing it would be noise nobody acted on.
 */
export function removePopoutWindow(win: Window): void {
  if (!win) return;
  // The other honest moment (#279): one popout going is when others are most
  // likely to have gone too (a quit, a crash, a user closing a stack of them),
  // and this walks the list regardless. If `win` itself is the one that died
  // silently, the sweep announces it here and the removal below is the no-op it
  // already is for an unknown window — so consumers hear about it exactly once.
  sweepClosedWindows();
  const next = tracked.filter((p) => p.win !== win);
  if (next.length === tracked.length) return;
  tracked = freeze(next);
  syncSweepTimer();
  notify('removed', win, true);
}

/**
 * Hear about popouts opening and closing. Returns the unsubscribe.
 *
 * Subscribing does NOT replay what is already open — the transition is what the
 * `added`/`removed` consumers act on. A consumer that mounts late and needs the
 * current state reads `getPopoutWindows()` itself (which is what the
 * `changed` + snapshot pair is for).
 */
export function subscribePopoutWindows(listener: PopoutListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * `useSyncExternalStore`-shaped subscribe, paired with `getPopoutWindows`.
 *
 * A module-level function so its identity is stable across renders — an inline
 * arrow would make React unsubscribe and resubscribe on every commit.
 */
export function subscribePopoutChange(onChange: () => void): () => void {
  return subscribePopoutWindows({ changed: onChange });
}

/**
 * Drop every window that closed without dockview saying so (#279).
 *
 * Consumers hear exactly what a normal close gives them — `removed` with the
 * window, then `changed` — because as far as they are concerned it IS a normal
 * close; the only difference is who noticed. Membership is updated before any
 * of them is told, the same order `removePopoutWindow` keeps, since the theme
 * sync reads the registry from inside its own handler.
 */
function sweepClosedWindows(): void {
  // One pass, one `closed` read per entry: whatever the answer is, it is the
  // answer used for BOTH the list we keep and the news we send. Asking twice
  // could drop a window without telling anyone (or the reverse) if it died
  // between the two questions.
  const live: TrackedPopout[] = [];
  const dead: TrackedPopout[] = [];
  for (const p of tracked) (isGone(p.win) ? dead : live).push(p);
  if (!dead.length) return; // the normal case: no new snapshot, so no re-render
  tracked = freeze(live);
  syncSweepTimer();
  for (const p of dead) notify('removed', p.win, true);
}

/** has this window gone without telling us? */
function isGone(win: Window): boolean {
  try {
    return win.closed === true;
  } catch {
    // A window we cannot even ask about stays: evicting a LIVE popout costs it
    // its keyboard and its theme, while keeping a dead one costs an object. So
    // only a window that says so in as many words is dropped — anything else
    // leaves the registry exactly as it was before this sweep existed.
    return false;
  }
}

/**
 * The timer runs exactly while there is something to sweep.
 *
 * Not a module-load side effect and not an app-lifetime interval: most of any
 * session has no popout open at all, and a timer with nothing to look at is a
 * wakeup we would be asking the OS for on behalf of nobody.
 */
function syncSweepTimer(): void {
  const wanted = tracked.length > 0;
  if (wanted === (sweepTimer !== undefined)) return;
  if (wanted) {
    sweepTimer = setInterval(sweepClosedWindows, LIVENESS_SWEEP_MS);
    // bookkeeping must never be the reason a process stays alive (this module
    // is imported by node-environment unit tests too)
    (sweepTimer as { unref?: () => void }).unref?.();
  } else {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}

function notify(kind: 'added' | 'removed', win: Window, membershipChanged: boolean): void {
  // Iterate a COPY, and swallow per listener. Both of those are what
  // `window.dispatchEvent` used to do for free, and losing either would be a
  // real regression rather than a refactor: DOM dispatch takes a snapshot of the
  // listener list (so a consumer that subscribes while handling an event is not
  // called for that same event, which is how it stays terminating), and it
  // reports a throwing listener without skipping the rest (so one broken
  // consumer cannot deafen the others' popout).
  //
  // `changed` gets its OWN try, so a throwing `added` cannot starve the
  // consumers that only render the list.
  for (const listener of [...listeners]) {
    fire(() => listener[kind]?.(win));
    if (membershipChanged) fire(() => listener.changed?.());
  }
}

function fire(deliver: () => void): void {
  try {
    deliver();
  } catch (err) {
    // fail-open: our bookkeeping breaking must never take the renderer with it
    console.error('[popout] a popout-window listener threw', err);
  }
}

/**
 * Frozen because `getPopoutWindows` hands the live array out and `readonly` is
 * compile-time only: a consumer's stray `sort()` would silently reorder every
 * other consumer's snapshot, and `useSyncExternalStore` would never hear of it.
 */
function freeze(next: TrackedPopout[]): readonly TrackedPopout[] {
  return Object.freeze(next);
}

/**
 * TESTS ONLY: back to an empty registry with nobody listening.
 *
 * The registry is module state, so it outlives a test; without this every test
 * file grows its own teardown loop (three of them at the time of writing) and
 * the listener half gets forgotten — a subscriber left behind by a failed
 * assertion goes on firing for the rest of the file.
 */
export function resetPopoutWindows(): void {
  tracked = freeze([]);
  listeners.clear();
  syncSweepTimer(); // and nothing ticking: an interval outlives the test too
}
