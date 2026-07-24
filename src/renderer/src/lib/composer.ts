// The one way renderer surfaces write a prompt/command into a session's PTY
// (§5.10: composer and session controls are INPUT ROUTES to the real CLI).
// Multiline goes as one bracketed paste so the TUI treats it as a single
// prompt; the Enter is a SEPARATE, delayed write — text+CR in one chunk
// registers as a paste and never submits (S-03 finding, refound live
// 2026-07-22). Escape bytes are built from char codes: no control bytes in
// source files.
const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

export const SUBMIT_DELAY_MS = 75;

export function writePromptToPty(sessionId: string, text: string): void {
  const payload = text.includes(LF) ? ESC + '[200~' + text + ESC + '[201~' : text;
  window.switchboard.pty.input(sessionId, payload);
  setTimeout(() => window.switchboard.pty.input(sessionId, CR), SUBMIT_DELAY_MS);
}
