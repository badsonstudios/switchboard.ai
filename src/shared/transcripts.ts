// Binding state, shared by both processes (P2-E15-10, §5.26, AR-P1-8).
//
// The Session view is the primary working surface and it renders only if
// transcript binding succeeded — which depends on two undocumented contracts
// in series: the CLI's storage layout, and hooks liveness. Until this item, a
// session that failed either one showed an EMPTY PANE with no explanation,
// which is P9 (trust through transparency) failing on our own plumbing.
//
// These four states are what the watcher can honestly distinguish from
// evidence it already has. Note that only ONE of them means something is
// wrong: an empty Session view is the normal state of a session nobody has
// prompted yet, and saying so is most of the value here.
export type BindingState =
  /** a transcript is bound and tailing — the Feed renders */
  | 'bound'
  /** no evidence a conversation has started. NOTHING IS WRONG: transcripts
   *  appear on the FIRST PROMPT, not at spawn (the S-04/S-05 finding) */
  | 'awaiting-prompt'
  /** evidence exists that a conversation is underway, but we have not bound a
   *  file to it yet. Normally lasts a poll or two */
  | 'searching'
  /** searching for longer than the deadline — one of the two contracts is not
   *  holding, and we say which */
  | 'unbound';

/**
 * Why the watcher believes what it believes. The renderer shows this on the
 * `unbound` state so the message can name the contract that went quiet rather
 * than shrugging — and so a bug report carries it.
 */
export interface BindingDiagnostics {
  /** a TURN has run in this session — the CLI is reaching us AND has been
   *  asked to do something. Deliberately not "hooks have spoken": the CLI
   *  sends `SessionStart` at launch, long before it writes a transcript. */
  conversationStarted: boolean;
  /** a transcript file appeared under this session's folder during our watch
   *  and we could not claim it: the storage layout is producing files we do
   *  not recognise as ours. */
  candidateSeen: boolean;
  /** how long we have been searching with evidence in hand, or null while
   *  there is no evidence to search on. */
  searchingMs: number | null;
  /** the directory being watched, so "we looked and found nothing" is a
   *  checkable claim rather than an assertion. */
  projectsRoot: string;
}

/** What crosses the wire on `transcripts:binding` — the binding half of a
 *  snapshot, for a panel that mounted between transitions. */
export interface BindingSnapshot {
  binding: BindingState;
  bindingDiag: BindingDiagnostics;
}
