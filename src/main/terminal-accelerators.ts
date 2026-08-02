// Claiming the two terminal accelerators in the BROWSER process (#90).
//
// `before-input-event` fires before a keystroke is dispatched into the page, so
// preventDefault() here means the page never sees it — and neither, therefore,
// does xterm, and neither does the PTY. That is the whole reason this lives in
// main: an accelerator that competed with the terminal inside the renderer
// would either lose (today's bug) or steal keys from the CLI (the thing we may
// never do). Above the renderer it does neither.
//
// NOT `globalShortcut`: that claims the chord OS-wide, so Ctrl+Space would be
// dead in the user's editor and browser while switchboard merely runs. The
// claim has to end at our own windows.
//
// WHICH keys may be claimed — and the rule for ever adding a third — is in
// shared/terminal-accelerators.ts, next to the list itself.
//
// TWO consequences of `before-input-event` being per-webContents, not
// per-element, that are easy to miss:
//
//   • The claim is WINDOW-WIDE. These two chords now take this path from
//     anywhere in the app, not just from a terminal — so in the running app the
//     renderer's own dispatcher never sees them at all. (The e2e suite still
//     drives that path, because Playwright injects over CDP, which does not
//     reach before-input-event; see terminal-accelerators.spec.ts.)
//   • preventDefault happens even when the command then DECLINES — the palette
//     is already open, the queue is empty, the composer has focus. `dispatch`
//     only ever prevented the default when a command actually ran; here the
//     decision to take the key is made before the registry is consulted,
//     because the alternative is asking the renderer a question and waiting for
//     the answer inside Chromium's input path. Neither chord produces text or
//     has a default action in our own inputs, so nothing is lost by it.
import type { WebContents } from 'electron';
import type { Platform } from '../shared/accelerators';
import { AcceleratorInput, matchTerminalAccelerator } from '../shared/terminal-accelerators';

export interface AcceleratorDeps {
  platform: Platform;
  /**
   * Hand the matched command id to the renderer that owns the registry — the
   * MAIN window's, always: a popout runs no JS of its own (dockview adopts the
   * DOM but leaves the script in the opener).
   *
   * Returns whether it was actually delivered. False means we did NOT take the
   * key, and the caller leaves it to the page: fail-open, a hard constraint. A
   * closed or crashed renderer must degrade to "the hotkey does nothing here",
   * never to "the hotkey eats your keystroke".
   */
  deliver: (commandId: string) => boolean;
  /** never let a listener throw into Chromium's input path */
  onError?: (err: unknown) => void;
}

/** What the browser process can see of the window that owns the registry. */
export interface RendererState {
  /** webContents id, or null when there is no window at all */
  id: number | null;
  /** not destroyed, not crashed — i.e. able to act on what we send it */
  alive: boolean;
}

export interface AcceleratorWiring {
  platform: Platform;
  renderer: () => RendererState;
  /**
   * The webContents id that has SUBSCRIBED to the accelerator channel, or null.
   *
   * Without this, "delivered" would only mean "we called send()". A window
   * exists for a moment before its renderer has mounted — and a renderer whose
   * preload bridge is missing never mounts a listener at all — and in both
   * cases we would have taken the keystroke away from the page and dropped it
   * on the floor. That is the fail-open constraint failing in the one direction
   * that matters, so the claim waits for someone to be listening.
   */
  ready: () => number | null;
  /** push it; false if the channel could not be used at all */
  send: (commandId: string, fromPopout: boolean) => boolean;
  onError?: (err: unknown) => void;
}

/**
 * Build the per-window deps, with the fail-open decision in ONE testable place.
 * `fromPopout` only travels with the message — every window's chord is answered
 * by the same renderer.
 */
export function makeAcceleratorDeps(
  wiring: AcceleratorWiring
): (fromPopout: boolean) => AcceleratorDeps {
  return (fromPopout) => ({
    platform: wiring.platform,
    onError: wiring.onError,
    deliver: (commandId) => {
      const r = wiring.renderer();
      if (r.id === null || !r.alive) return false; // nobody to run it
      if (wiring.ready() !== r.id) return false; // nobody listening yet
      return wiring.send(commandId, fromPopout);
    },
  });
}

/** The slice of Electron's event object we use — keeps the unit test DOM-free. */
export interface PreventableEvent {
  preventDefault: () => void;
}

/**
 * Decide one keystroke. Returns the command id claimed, or null when the key
 * was left alone — which is the answer for everything except the allowlist,
 * including every key the CLI itself binds (Ctrl+R, Ctrl+C, Escape, arrows).
 *
 * Exported for the test that proves the negative without an Electron window.
 */
export function handleAcceleratorInput(
  event: PreventableEvent,
  input: AcceleratorInput,
  deps: AcceleratorDeps
): string | null {
  try {
    const commandId = matchTerminalAccelerator(input, deps.platform);
    if (!commandId) return null;
    // deliver BEFORE preventDefault: taking the key away from the page is only
    // justified if something is going to act on it
    if (!deps.deliver(commandId)) return null;
    event.preventDefault();
    return commandId;
  } catch (err) {
    deps.onError?.(err);
    return null; // a throw must cost the user nothing but this one chord
  }
}

/**
 * Wire the claim onto one window's contents. Called for the main window AND for
 * every dockview popout — popouts host terminals too, and a capability that
 * evaporates when you tear a session off is exactly the §5.8 failure this item
 * is fixing.
 */
export function installTerminalAccelerators(contents: WebContents, deps: AcceleratorDeps): void {
  // Electron's Input is structurally an AcceleratorInput — a plain assignment
  // rather than a cast, so a shape change upstream fails the build instead of
  // being asserted away.
  contents.on('before-input-event', (event, input: AcceleratorInput) => {
    handleAcceleratorInput(event, input, deps);
  });
}
