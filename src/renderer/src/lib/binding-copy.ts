// What an empty Session view should SAY (P2-E15-10, §5.26, AR-P1-8).
//
// Pure, so the rule can be tested without React: given the binding state and
// what the watcher observed, produce the i18n keys to render. The Session view
// is the primary working surface and it renders nothing until a transcript is
// bound — so until this item, all four situations below looked identical: a
// blank pane. Telling them apart is P9 (trust through transparency) applied to
// our own plumbing.
import { BindingDiagnostics, BindingState } from '../../../shared/transcripts';
import type { TransportKind } from '../../../shared/transport';

export interface EmptyStateCopy {
  /** headline i18n key */
  title: string;
  /** supporting line — the headline never carries the whole message, because
   *  "couldn't find it" without "here is where we looked" is the shrug this
   *  item exists to remove */
  detail: string;
  /** true for the one state that means something is actually wrong — the view
   *  tints it, so "nothing has happened yet" never wears an error's clothes */
  problem: boolean;
  /**
   * The fail-open line, said out loud: our binding failing never stops the CLI,
   * and a user staring at an error needs to know where the session still is.
   * `null` for every state that is not a problem — there is nothing to reassure
   * anyone about when nothing has gone wrong.
   *
   * STILL TRANSPORT-DEPENDENT, and the history is why. #447: the PTY line read
   * "The Terminal tab is unaffected — your session is still running there",
   * which was true only where a terminal existed. On Direct it composed with
   * the Terminal tab's own equally-true "No terminal for this session"
   * (P2-E18-08b) into a lie — two honest surfaces sending the user to a place
   * that was not there. Same defect class as #261's handoff bar, one surface
   * over, and the reason this field takes the transport at all.
   *
   * #873 removed the tab, and with it the destination. The PTY line no longer
   * names a place to go — it says the session is still running and only this
   * view of its conversation is missing — so the contradiction #447 was about
   * can no longer be constructed. The split is KEPT rather than collapsed
   * because the two transports still differ in the thing that matters here:
   * a Direct session's conversation never came from that file in the first
   * place, which is a stronger reassurance than the PTY line can give.
   */
  fallback: string | null;
}

/**
 * Only ever consulted when the view has nothing to render. `bound` therefore
 * means "we are tailing a file that has no conversation in it yet", which is
 * the same thing the user needs to hear as `awaiting-prompt` — hence the
 * shared arm.
 */
export function emptyStateCopy(
  binding: BindingState,
  diag: BindingDiagnostics | null,
  /**
   * Accepted and UNREAD since #952, deliberately.
   *
   * It chose between two fail-open lines; there is one line now. The parameter
   * stays because every caller already threads it, and §5.3's adapter contract
   * makes "which transport is this session on" a question that can come back —
   * at which point this is where the answer goes. Dropping it would mean
   * re-threading it through every call site to ask it again.
   */
  transport?: TransportKind
): EmptyStateCopy {
  void transport;
  switch (binding) {
    case 'searching':
      return {
        title: 'binding.searching',
        detail: 'binding.searchingDetail',
        problem: false,
        fallback: null,
      };
    case 'unbound':
      // Name the contracts rather than shrugging. These are distinguishable
      // failures with DIFFERENT fixes, and one "something went wrong" would
      // send the reader looking in the wrong place — so all four combinations
      // get their own sentence, including the two-signal case, where the fact
      // that a turn ran is the most triage-relevant thing on the screen.
      return {
        title: 'binding.unbound',
        detail: diag?.candidateSeen
          ? diag.conversationStarted
            ? 'binding.unboundFound' // a turn ran AND files exist: none are ours
            : 'binding.unboundFoundQuiet' // files exist but no turn reached us
          : diag?.conversationStarted
            ? 'binding.unboundSilent' // a turn ran and wrote nothing we can see
            : 'binding.unboundNothing', // no evidence at all (defensive)
        problem: true,
        // ONE LINE SINCE #952, and it is the one that was always true here.
        //
        // There were two. The PTY line said the session was still running and
        // only this view of its conversation was missing; the Direct line says
        // what is actually true — the conversation arrives in THIS window over
        // the stream, and the transcript it cannot find is not what feeds this
        // pane (`deriveFeed: false`, `sessions/ipc.ts`).
        //
        // The split existed because #447 found the PTY line composing with the
        // Terminal tab's own equally-true "No terminal for this session" into a
        // lie — two honest surfaces sending the user to a place that was not
        // there. #873 removed the destination and #952 removed the transport, so
        // the weaker line has nothing left to describe.
        //
        // `problem` stays TRUE, which is the part not to lose: the watch is still
        // wanted for usage totals, the native id `--resume` needs, and the drift
        // detector, so an unbound session is genuinely degraded.
        fallback: 'binding.unboundFallbackDirect',
      };
    case 'bound':
    case 'awaiting-prompt':
    default:
      // The default case is the good one: a session nobody has prompted yet is
      // the normal state of a session you just opened, and the old copy ("No
      // activity yet") described the PANE rather than telling you what it is
      // waiting for.
      return {
        title: 'binding.awaitingPrompt',
        detail: 'binding.awaitingPromptDetail',
        problem: false,
        fallback: null,
      };
  }
}
