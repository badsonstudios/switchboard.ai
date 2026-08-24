// When the CLI keeps a decision for itself, say so where the user is looking
// (#125, PHILOSOPHY P7 as amended 2026-07-31 §6).
//
// P7's third line: "A decision the CLI delegates, we may present. A decision the
// CLI keeps, we may not fake … we say so plainly and route the user to where the
// decision actually lives." Screen-scraping the CLI's prompt was rejected as
// precedent (§5), so saying so plainly is the WHOLE of what we are permitted to
// do here — which makes doing it well the entire job, not a consolation prize.
//
// It used to be a 10px chip in the top-left header strip. Every permission the
// user had ever answered arrived as a full-width bar docked above the composer,
// so they looked at the bottom, found nothing, and concluded the app had lost
// the session. Observed live 2026-07-31: the chip was rendering correctly the
// whole time.
//
// Pure, so the rule is testable without React.

import type { TransportKind } from '../../../shared/transport';

export type HandoffTone = 'permission' | 'input';

/**
 * The theme tokens a tone paints with. Here rather than in the component so the
 * names are assertable against `theme/tokens.ts` — an unresolvable custom
 * property fails SILENTLY (the `--group-lift: none` incident, #102), so "these
 * names exist" has to be a test, not a hope.
 *
 * Note there is no text colour: the bar's prose is `--text` deliberately. The
 * `--status-*` hues are documented in tokens.css as tuned for dots and rings,
 * and on nordic the `-ink` variant IS the hue — so ink on a hue-tinted
 * background measures 3.89:1, which is worse than the chip this replaces. Hue
 * for the border and the tint; `--text` for anything anyone has to read.
 */
export function toneToken(tone: HandoffTone): string {
  return `--status-${tone === 'permission' ? 'needs-permission' : 'needs-input'}`;
}

export interface TerminalHandoff {
  /** headline i18n key */
  title: string;
  /** one line of plain English saying what is actually happening */
  body: string;
  /** which status colour the bar wears */
  tone: HandoffTone;
}

export interface HandoffInputs {
  /** the session's current status */
  status?: string;
  /** true when the inline approval bar is handling a HELD request — the CLI
   *  delegated that one to us, so there is nothing to hand off */
  hasApproval: boolean;
  /** a session stuck in `starting` past the boot grace period, which in
   *  practice means a startup TUI dialog only the Terminal can render */
  startingLong: boolean;
  /** The user answered an approval moments ago and the status has not caught
   *  up yet. The decision pops the local queue synchronously, but
   *  `permission-resolved` only arrives after a full IPC round trip — so for a
   *  frame or two `approval` is null while status is still `needs-permission`,
   *  and without this the user sees "switchboard can't answer it for you" in
   *  the exact spot they just clicked Allow. */
  recentlyDecided: boolean;
  /**
   * Which transport hosts the session (P2 #153 follow-up).
   *
   * EVERY branch of this rule routes the user to the Terminal, and a stream
   * session HAS no terminal — so in stream mode the bar is not merely
   * unhelpful, it is false, and its button is dead. The `startingLong` branch
   * is provably wrong there: S-10 measured that stream mode draws NO startup
   * dialog at all, which is the entire premise of that message.
   *
   * Dan hit this within minutes of the transport becoming switchable: a freshly
   * restarted Direct session showed "Claude is showing a start-up dialog …
   * appear only in the terminal" over an [Open Terminal] button, next to a
   * Terminal tab that correctly said there was no terminal. Two surfaces in one
   * window contradicting each other.
   *
   * What stream mode's equivalent should say when the CLI keeps a decision is
   * E18-11's question — it cannot be answered until the choosers are measured.
   * Until then, silence beats sending someone to a place that does not exist.
   */
  transport?: TransportKind;
}

/**
 * The bar to show, or null when the CLI is not waiting on anything we cannot
 * answer.
 *
 * Order matters: a HELD approval always wins, because that decision was
 * delegated to us and the approval bar is already rendering it. Showing a
 * "go to the Terminal" bar beside it would send the user away from the very
 * control that answers the question.
 */
export function terminalHandoff({
  status,
  hasApproval,
  startingLong,
  recentlyDecided,
  transport,
}: HandoffInputs): TerminalHandoff | null {
  if (hasApproval || recentlyDecided) return null;
  // No terminal to hand off TO. See the note on `transport`.
  if (transport === 'stream') return null;

  if (status === 'needs-permission') {
    // The CLI is asking for permission in its own prompt. Either it kept the
    // decision (a `.claude/**` write and friends — see S-09), or our hook path
    // never got the chance. Both look identical from here and both have the
    // same answer: it lives in the Terminal.
    return { title: 'handoff.permissionTitle', body: 'handoff.permissionBody', tone: 'permission' };
  }

  if (status === 'needs-input') {
    return { title: 'handoff.inputTitle', body: 'handoff.inputBody', tone: 'input' };
  }

  if (startingLong) {
    // Checked LAST: a session can be both slow to start and already asking
    // something, and "it is asking you a question" is more actionable than
    // "it is still starting".
    return { title: 'handoff.startingTitle', body: 'handoff.startingBody', tone: 'input' };
  }

  return null;
}
