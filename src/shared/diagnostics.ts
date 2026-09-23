// The diagnostic report contract (#815) — shared, because the dialog composes a
// report and main is what actually files it.
//
// WHY THE SPLIT IS WHERE IT IS: the renderer cannot reach the network at all
// (`connect-src 'self'`) and has no read path to a stored credential by design
// (§5.29 — the IPC surface writes secrets and answers with booleans). So the
// window's whole job is to collect a subject and a description; resolving a
// token and posting to GitHub happens in main. These types are the seam.

import type { PerfSummary } from './perf';

/** Where a finished report goes. */
export type ReportDestination =
  /** POST a new issue to the project's GitHub repo */
  | 'github'
  /** hand the zip to the user's mail client (`mailto:` — see the note below) */
  | 'email'
  /** just build the zip and reveal it; file it however you like */
  | 'zip';

export const REPORT_DESTINATIONS: ReportDestination[] = ['github', 'email', 'zip'];

/**
 * The repo issues are filed against.
 *
 * A constant rather than a literal at the call site for the reason #815 gives
 * about the email addresses: it is configuration, and configuration someone
 * will one day need to change should be findable by name rather than by grep.
 */
export const REPORT_REPO = 'badsonstudios/switchboard.ai';

/**
 * Where the GitHub token lives in the OS credential store.
 *
 * `update/token.ts` resolves env → credential store → `gh auth token`, and this
 * is the key the middle step reads. On a machine where `gh` is signed in
 * nothing ever has to be pasted here, which is what keeps litmus test 1
 * ("works sensibly with no setup") satisfied.
 */
export const GITHUB_TOKEN_SECRET_KEY = 'github.token';

/** Addresses the email destination pre-fills. Configuration, not literals. */
export const REPORT_EMAIL_TO = ['dheinz@badsonstudios.com', 'dheinz100@gmail.com'];

/** What the user typed, plus where they want it to go. */
export interface ReportDraft {
  /** the issue title / mail subject — trimmed, never empty by the time it ships */
  subject: string;
  /** free text; becomes the issue body above the auto-collected diagnostics */
  description: string;
  destination: ReportDestination;
  /**
   * E21's responsiveness numbers, as the renderer sees them (#927).
   *
   * Carried ON THE DRAFT rather than fetched by main, because the recorder's
   * buffers live in the renderer and the Report dialog is already there. Main
   * reaching back into a window to ask would need a new request channel and
   * would immediately raise "which window?" — a question this shape never has
   * to answer.
   *
   * OPTIONAL, and that is load-bearing: a broken preload bridge, or a renderer
   * whose observers the platform refused, must cost the report its performance
   * section and nothing else. Fail-open is a hard constraint, and a report about
   * slowness is exactly the wrong thing to lose to a failure in the code that
   * measures slowness.
   */
  perf?: PerfSummary;
}

/** Why a report could not be filed. Each one gets its own sentence on screen. */
export type ReportProblem =
  /** no credential anywhere: no env var, nothing in the store, no `gh` */
  | 'no-token'
  /** the token exists but GitHub refused it (401/403) */
  | 'auth'
  /** GitHub said no for some other reason, or the repo is wrong (404) */
  | 'refused'
  /** rate limited — worth saying, because it resolves itself */
  | 'rate-limited'
  /** could not reach the host at all, or the request timed out */
  | 'network'
  /** the zip could not be written (disk full, permissions) */
  | 'bundle-failed'
  /** the user gave us nothing to file */
  | 'empty-subject'
  /**
   * the mail app could not be opened. A failure, not a shrug: a successful send
   * closes the dialog, and a "success" here would close it on words that went
   * nowhere (#896)
   */
  | 'mail-failed'
  /**
   * main could not be asked at all — no `diagnostics` bridge namespace, or the
   * call was refused. Its own name rather than borrowing `network`: nothing was
   * attempted, so telling the user GitHub was unreachable would be a guess
   * dressed as a diagnosis.
   */
  | 'unavailable';

/** One file that did not make it into the zip, and why. */
export interface SkippedEntry {
  name: string;
  reason: string;
}

/** What building the bundle produced. */
export interface BundleResult {
  ok: boolean;
  /** absolute path to the zip, when one was written */
  path: string | null;
  bytes: number;
  /**
   * Files we meant to include and could not. Surfaced rather than swallowed:
   * a bundle quietly missing the log is worse than one that says it is missing
   * it, because the reader assumes the evidence was collected.
   */
  skipped: SkippedEntry[];
  problem?: ReportProblem;
}

/** What filing a report produced. */
export interface ReportResult {
  ok: boolean;
  destination: ReportDestination;
  /** the new issue's URL, when one was created */
  url: string | null;
  /** the new issue's number, when one was created */
  number: number | null;
  /**
   * The bundle is built for EVERY destination and always reported, including
   * when the post failed. That is the fail-open half (litmus 3): the evidence
   * is on disk and revealed no matter what the network did.
   */
  bundle: BundleResult;
  problem?: ReportProblem;
}

/**
 * What the dialog needs to know before it offers a destination.
 *
 * Booleans only, and that is the contract rather than a simplification: there
 * is no channel anywhere that reads a stored credential back (§5.29), so the
 * window can learn THAT one exists and never WHAT it is.
 *
 * Lives in shared rather than beside its handler because the preload declares
 * the return type and must not import from `src/main`.
 */
export interface ReportStatus {
  /** a GitHub credential is resolvable right now (from `gh`, or the store) */
  canFileIssue: boolean;
  /** the OS credential store works on this machine, so pasting one is possible */
  storeAvailable: boolean;
  /** a token is saved in the store (as opposed to coming from `gh`) */
  tokenStored: boolean;
}

/**
 * The answer to writing a credential — the status AFTER the write, and whether
 * the write happened.
 *
 * `SecretStore.set` returns false for a machine with no keyring, a value over
 * its length cap, an encryption failure and a failed disk write. A channel that
 * answered only a `ReportStatus` could not tell any of those from success, and
 * the user would be left believing a token was saved that was not. The sibling
 * credential surface answers a `PushWriteResult` for exactly this reason.
 */
export interface ReportWriteResult {
  status: ReportStatus;
  ok: boolean;
}

/**
 * The status of a machine we have not managed to ask.
 *
 * Every flag false. Note what that MEANS on screen, since it is not the same as
 * "we asked and the answer was no": `storeAvailable: false` would have the
 * dialog state that this machine cannot keep secrets, which is a claim about
 * someone's computer that we have not earned. So the dialog treats a `null`
 * status as "not asked yet" and says so, and this value exists for the narrower
 * case where a call was made and came back unusable.
 */
export function unknownReportStatus(): ReportStatus {
  return { canFileIssue: false, storeAvailable: false, tokenStored: false };
}

/**
 * What the dialog shows when the bridge could not be asked.
 *
 * A real result rather than a thrown error, for the reason the whole renderer
 * family is optional-chained: a diagnostic must never be able to white-screen
 * the shell (#444).
 */
export function unavailableReport(destination: ReportDestination): ReportResult {
  return {
    ok: false,
    destination,
    url: null,
    number: null,
    bundle: { ok: false, path: null, bytes: 0, skipped: [] },
    problem: 'unavailable',
  };
}

/** A subject with nothing in it is the one thing we refuse before trying. */
export function isFilable(draft: Pick<ReportDraft, 'subject'>): boolean {
  return draft.subject.trim().length > 0;
}
