// The one way renderer surfaces write a prompt/command into a session's PTY
// (§5.10: composer and session controls are INPUT ROUTES to the real CLI).
// Multiline goes as one bracketed paste so the TUI treats it as a single
// prompt; the Enter is a SEPARATE, delayed write — text+CR in one chunk
// registers as a paste and never submits (S-03 finding, refound live
// 2026-07-22). Escape bytes are built from char codes: no control bytes in
// source files.
import { sessionStore } from '../store/session-store';
import type { PromptImage } from '../../../shared/prompt-images';

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

export const SUBMIT_DELAY_MS = 75;

export function writePromptToPty(sessionId: string, text: string): void {
  const payload = text.includes(LF) ? ESC + '[200~' + text + ESC + '[201~' : text;
  window.switchboard.pty.input(sessionId, payload);
  setTimeout(() => window.switchboard.pty.input(sessionId, CR), SUBMIT_DELAY_MS);
}

/**
 * Send text to a session, whichever transport it is on (P2-E18-08a) — WITHOUT
 * the "the user just submitted a prompt" side effects.
 *
 * TRY-THEN-FALL-BACK, deliberately: main answers false when the session has no
 * typed-message transport, and only then do we do the PTY dance. That keeps the
 * renderer completely ignorant of transports — it has no session record to
 * consult and no need of one.
 *
 * This is what the ⋯ session-controls menu uses for `/clear` and `/compact`.
 * Those two called `writePromptToPty` directly until #381, which was survivable
 * only while Direct mode was opt-in: a stream session has no PTY, so
 * `ptys.get(id)?.write()` dropped the command and the menu item did nothing at
 * all. Exactly the #154 stop-button defect, on the last surface that still had
 * it — and #381 made Direct the default, which would have shipped it to
 * everyone.
 */
export async function sendSessionCommand(sessionId: string, text: string): Promise<void> {
  if (await mainTook('submitPrompt', () => window.switchboard.sessions.submitPrompt(sessionId, text)))
    return;
  writePromptToPty(sessionId, text);
}

/**
 * Submit a prompt the USER typed, whichever transport this session is on.
 *
 * `sendSessionCommand` plus the one thing that separates a person pressing
 * Enter from a menu item writing a command: §5.8's auto-minimize.
 *
 * Resolves TRUE when the prompt went, FALSE when it did not — which only the
 * image path can produce (see below), and which the composer uses to keep the
 * draft on screen rather than clearing a box whose contents went nowhere.
 */
export async function submitPrompt(
  sessionId: string,
  text: string,
  images: readonly PromptImage[] = []
): Promise<boolean> {
  // §5.8's auto-minimize hangs off THIS call and not off the composer component,
  // because this function is already documented as "the one way renderer
  // surfaces write a prompt into a session" — so a future second surface gets
  // the behaviour for free instead of forgetting it.
  //
  // BEFORE the await, deliberately: the collapse is a response to the user's
  // gesture and must not wait on an IPC round trip, nor depend on which
  // transport ended up taking the prompt.
  //
  // `sendSessionCommand` is NOT a submit point of its own. Its other caller is
  // the ⋯ session-controls menu, which sends slash commands like `/compact` —
  // the workspace folding itself away because you clicked a menu item would be
  // baffling, and §5.8 says "submitting a prompt", not "sending text".
  sessionStore.notifyPromptSubmitted(sessionId);

  // NO PTY FALLBACK WHEN THERE ARE IMAGES (P2-E10-09). The whole point of
  // try-then-fall-back is that both routes deliver the same thing; that stops
  // being true the moment a bitmap is attached, because the PTY route is
  // keystrokes and there is no keystroke for a picture. Falling back here would
  // send "what's wrong with this screenshot?" with no screenshot — the prompt
  // arrives, looks fine, and the answer is nonsense. So an image submission is
  // stream-only, and a refusal is REPORTED rather than papered over.
  if (images.length > 0) {
    return mainTook('submitPrompt', () =>
      window.switchboard.sessions.submitPrompt(sessionId, text, images)
    );
  }

  await sendSessionCommand(sessionId, text);
  return true;
}

/**
 * Stop the running turn, whichever transport this session is on (#154).
 *
 * The stop button used to write Esc to the PTY unconditionally. A stream
 * session HAS no PTY, so `ptys.get(id)?.write()` was a silent no-op and the
 * button did nothing at all — Dan reproduced it every time. Same try-then-
 * fall-back shape as `submitPrompt`, for the same reason: the renderer has no
 * business knowing which transport it is on.
 */
export async function interruptSession(sessionId: string): Promise<void> {
  if (await mainTook('interrupt', () => window.switchboard.sessions.interrupt(sessionId))) return;
  window.switchboard.pty.input(sessionId, ESC);
}

/**
 * Did main take this call? A REJECTION is read as "no" — and said out loud.
 *
 * Every caller of the two functions above is a `void`-ed click handler, so
 * until P2-E18-17 a rejecting IPC did two bad things at once: it became an
 * unhandled renderer rejection nobody had a reason to expect (the #326 shape,
 * on a different family), and the try-then-fall-back never ran — so the control
 * did nothing at all and said nothing about it. That is the #154 defect class
 * arriving through a different door.
 *
 * Falling back on a throw is safe WHEREVER the throw came from, which is a
 * stronger claim than "the typed message did not land" and the one that
 * actually holds: a session is spawned on exactly ONE transport, so the
 * fallback either reaches a real PTY (correct) or is dropped by main's
 * `ptys.get(id)?.write()` because a stream session has no PTY to write to
 * (harmless). Even a throw raised AFTER `handle.send()` already succeeded
 * cannot double-send, and that is why — not because the ordering is lucky.
 *
 * `=== true`, not truthiness, and that is the second door: `broker.handle`
 * RESOLVES an `IpcRefusal` object for a refused channel rather than throwing
 * (#346), and an object is truthy — so a refusal would have been read as "main
 * took it" and suppressed the fallback, silently reinstating the #154 defect
 * this function exists to remove. Unreachable today (first-party windows hold
 * every capability), which is exactly how it would have been found the hard
 * way; the preload's return types stay as they are, and `shared/ipc/refusal.ts`
 * says why widening ~60 of them was declined.
 *
 * Console, not UI, for the same reason `groups.ts` chose it: main has already
 * written the real cause to the app log, and inventing a dialog for a failure
 * whose retry is one click away would be worse than a line next to it.
 */
async function mainTook(what: string, call: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await call()) === true;
  } catch (err) {
    console.warn(`[composer] sessions.${what} failed — trying the terminal route`, err);
    return false;
  }
}
