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
 * Submit a prompt, whichever transport this session is on (P2-E18-08a).
 *
 * TRY-THEN-FALL-BACK, deliberately: main answers false when the session has no
 * typed-message transport, and only then do we do the PTY dance. That keeps the
 * renderer completely ignorant of transports — it has no session record to
 * consult and, until P2-E18-08b, no setting either. When the choice becomes a
 * user-facing one, this function does not change.
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
  // `writePromptToPty` is NOT a submit point of its own. Its other caller is the
  // ⋯ session-controls menu, which types slash commands like `/compact` — the
  // workspace folding itself away because you clicked a menu item would be
  // baffling, and §5.8 says "submitting a prompt", not "writing to the PTY".
  sessionStore.notifyPromptSubmitted(sessionId);
  if (await window.switchboard.sessions.submitPrompt(sessionId, text)) return;
  writePromptToPty(sessionId, text);
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
