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
  /** a window we knew about closed or was docked back */
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

/** every popout currently open, in the order they opened */
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
  const known = tracked.some((p) => p.win === win);
  if (!known) tracked = freeze([...tracked, { id: ++seq, win }]);
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
  const next = tracked.filter((p) => p.win !== win);
  if (next.length === tracked.length) return;
  tracked = freeze(next);
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
}
