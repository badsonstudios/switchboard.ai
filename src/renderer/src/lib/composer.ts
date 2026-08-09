// The one way renderer surfaces write a prompt/command into a session's PTY
// (§5.10: composer and session controls are INPUT ROUTES to the real CLI).
// Multiline goes as one bracketed paste so the TUI treats it as a single
// prompt; the Enter is a SEPARATE, delayed write — text+CR in one chunk
// registers as a paste and never submits (S-03 finding, refound live
// 2026-07-22). Escape bytes are built from char codes: no control bytes in
// source files.
import { sessionStore } from '../store/session-store';

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
  if (await window.switchboard.sessions.submitPrompt(sessionId, text)) return;
  writePromptToPty(sessionId, text);
}

/**
 * Submit a prompt the USER typed, whichever transport this session is on.
 *
 * `sendSessionCommand` plus the one thing that separates a person pressing
 * Enter from a menu item writing a command: §5.8's auto-minimize.
 */
export async function submitPrompt(sessionId: string, text: string): Promise<void> {
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
  await sendSessionCommand(sessionId, text);
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
  if (await window.switchboard.sessions.interrupt(sessionId)) return;
  window.switchboard.pty.input(sessionId, ESC);
}
