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

// --- Session find (P2-E17-01, §5.31) -----------------------------------------
//
// Shared because these cross the wire on `transcripts:search`: the find bar
// (E17-02) builds the query and renders the hits, and main runs the scan.

/** What to look for. Case-insensitive literal unless told otherwise. */
export interface TranscriptQuery {
  term: string;
  caseSensitive?: boolean;
  /** the term must not sit inside a longer word */
  wholeWord?: boolean;
  /** `term` is a regular expression. An uncompilable one is REPORTED, not thrown */
  regex?: boolean;
}

/**
 * Scope, as a PARAMETER (§5.31's fourth decision).
 *
 * A list, not a session id, so §10's cross-session search is this engine with a
 * longer list rather than a rewrite. The find bar passes one entry today.
 */
export interface TranscriptSearchRequest {
  sessionIds: string[];
  query: TranscriptQuery;
  /** stop after this many hits across the whole scope (default 500) */
  limit?: number;
}

/** One match, anchored to the block the Feed renders. */
export interface TranscriptHit {
  sessionId: string;
  /**
   * 1-based ordinal of this block among the blocks derived from the transcript
   * FILE — the same number `FeedBuffer` assigns as `seq` when it derives the
   * same file from the top.
   */
  blockIndex: number;
  /**
   * The live Feed `seq` to jump to, when the block is still in the renderer's
   * view buffer AND the engine could line the two up (see `aligned`).
   *
   * ABSENT IS THE ONE SIGNAL "you cannot jump to this" — read it with
   * `groups[].aligned`, not with `earlierThanLoaded`. There are three ways to
   * get here and only one of them is the v1 boundary: the block was evicted
   * (`earlierThanLoaded` true), the block is NEWER than the renderer's window
   * because the watcher has not drained those lines yet (`earlierThanLoaded`
   * false, and a moment later it will be jumpable), or the file could not be
   * lined up with the Feed at all (`aligned` false for the whole session).
   */
  seq?: number;
  /**
   * This block is KNOWN to be older than the renderer's view buffer — the §5.31
   * v1 boundary, a hit that is readable in the results list and not jump-to-able
   * in place.
   *
   * False also covers "we could not tell", deliberately: asserting "earlier in
   * the session" about a block that is on screen would be a small lie told
   * confidently, and this is a feature whose whole value is not doing that.
   */
  earlierThanLoaded: boolean;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'todos';
  /** which part of the block matched — `text`, `tool.out`, `tool.input`, … */
  field: string;
  /** context around the match, for the results list */
  snippet: string;
  /** where the match starts inside `snippet`, and how long it is */
  matchStart: number;
  matchLength: number;
  /** the block's timestamp, when the transcript line carried one */
  ts?: string;
}

/**
 * Why a search produced nothing, or less than everything — never a throw
 * (§5.31 litmus 3, fail-open).
 *
 * `bad-pattern`: the regex would not compile, or has the shape that backtracks
 * for minutes (`(a+)+`). Nothing was searched.
 * `timed-out`: the scan hit its wall-clock ceiling. The hits and counts are real
 * but PARTIAL, and the bar must say so rather than showing them as a total.
 */
export interface TranscriptSearchError {
  code: 'bad-pattern' | 'timed-out';
  message: string;
}

/** Per-session totals, which is what the bar's grouped count is built from. */
export interface TranscriptSearchGroup {
  sessionId: string;
  hits: number;
  /** blocks derived from this session's transcript during the scan */
  blocks: number;
  /** false when the session has no transcript to search (not an error) */
  searched: boolean;
  /**
   * Could the file's blocks be lined up with the ones the renderer holds?
   *
   * False means every hit in this session is snippet-only: honest, and the
   * alternative — guessing a `seq` — would scroll the Feed to the wrong block,
   * which is the same class of lie as searching the DOM.
   */
  aligned: boolean;
}

export interface TranscriptSearchResult {
  hits: TranscriptHit[];
  /** matches found in total; `hits` is capped by `limit` */
  total: number;
  truncated: boolean;
  groups: TranscriptSearchGroup[];
  /** wall-clock time the whole scan took, including the yields between chunks */
  elapsedMs: number;
  /** the longest UNINTERRUPTED stretch of main-thread work in the scan */
  longestBlockMs: number;
  error?: TranscriptSearchError;
}
