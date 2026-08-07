// The update-check contract (P2-E19-03, plan §E19).
//
// Shared because three processes have to agree on it: main produces the
// result, preload types the bridge, and the renderer renders it. Only the
// SHAPE lives here — the version comparison and every decision that depends on
// it stay in `main/update/`, where the check itself runs (E19-03: "the
// COMPARISON happens in main").
//
// THE RULE THAT SHAPES ALL OF THIS: nothing in the update path throws, and
// nothing in the update path blocks a session. Every failure is a value in
// `state` + `reason`, and every automatic failure is silent. The feature exists
// to save Dan a manual download; it may never cost him a running agent.

/**
 * Why a check did not produce an offer.
 *
 * `auth` is the one that matters and the reason this enum exists at all: on a
 * PRIVATE repo the GitHub API answers **404** when the token is missing or too
 * weak, which reads exactly like "this repo has no releases". ClaudeMon's
 * checker took that at face value and reported "you're up to date" forever
 * (plan §E19 decision 5). We ask a question whose two answers differ — see
 * `main/update/checker.ts` — and 404 is reported as `auth`, never as up to date.
 */
export type UpdateFailureReason =
  /** no token could be resolved locally — checks are OFF, and that is fine */
  | 'no-token'
  /** the user turned automatic checks off, and this was an automatic one */
  | 'auto-check-off'
  /** the app is quitting — the answer arrived too late to be worth anything */
  | 'quitting'
  /** disabled for this run by the dev/test feed override */
  | 'overridden-off'
  /** 401/403/404 — missing or insufficient credentials (see above) */
  | 'auth'
  /** the API said we have asked too often */
  | 'rate-limit'
  /** DNS, offline, TLS, timeout — anything that never reached the API */
  | 'network'
  /** reached it, could not believe it: wrong status, wrong shape, bad JSON */
  | 'bad-response';

/**
 * The outcome of one check. A RECORD, never a throw.
 *
 * `state` is what the UI switches on; `reason` explains the two unhappy ones
 * and is aimed at the log. `ok` is deliberately redundant with `state` — call
 * sites that only want "did this answer the question" should not have to know
 * which states count.
 */
export interface UpdateCheckResult {
  /** the check completed and its answer can be trusted */
  ok: boolean;
  state: 'available' | 'up-to-date' | 'disabled' | 'failed';
  /** package.json semver of the running build */
  currentVersion: string;
  /** the release we found, normalized (no `v`), when there is one */
  latestVersion?: string;
  /** the release body — markdown, rendered in-app */
  notes?: string;
  /** the release page, for the browser fallback */
  url?: string;
  /** ISO timestamp from the release */
  publishedAt?: string;
  reason?: UpdateFailureReason;
  /** ISO timestamp of this check */
  checkedAt: string;
  /**
   * The installer this release can be installed FROM, when it has a complete,
   * verifiable pair (P2-E19-04). Absent is an ordinary outcome — a release
   * built before the sidecar existed, a platform we do not package for — and
   * the dialog falls back to opening the release page in the browser.
   */
  download?: UpdateDownloadTarget;
}

/**
 * The installer asset and its checksum sidecar, as named by the feed
 * (P2-E19-04).
 *
 * Both URLs are the GitHub **API** asset URLs
 * (`https://api.github.com/repos/…/releases/assets/<id>`), not the
 * `browser_download_url`: on a private repo the browser URL is a login page,
 * and the API URL with `Accept: application/octet-stream` is the documented
 * way to fetch the bytes with a token. `download.ts` is where the redirect
 * that URL answers with is handled — and where the token is dropped before
 * following it.
 */
export interface UpdateDownloadTarget {
  /** the installer's file name, e.g. `switchboard-Setup-0.1.1.exe` */
  name: string;
  /** the installer asset's API URL */
  url: string;
  /** the `<name>.sha256` sidecar's API URL. No sidecar, no target at all. */
  checksumUrl: string;
  /** the asset's byte count, for determinate progress. 0 when the feed omits it. */
  size: number;
}

/**
 * Where a download-and-install has got to.
 *
 * A record, like everything else in this path — the install never throws and
 * never puts an error dialog on screen by itself. `cancelled` and `failed` are
 * both terminal and both leave the release still on offer.
 */
export type UpdateInstallPhase =
  /** fetching the bytes; `received`/`total` are meaningful */
  | 'downloading'
  /** hashing what arrived against the sidecar */
  | 'verifying'
  /** verified, staged, and handed to the OS — the app is on its way out */
  | 'launching'
  /** the user pressed Cancel, or declined the quit. Nothing was executed. */
  | 'cancelled'
  /** see `reason`. Nothing was executed, and nothing was left on disk. */
  | 'failed';

/** Why an install stopped. Every one of these falls back to the browser path. */
export type UpdateInstallFailure =
  /** not Windows — v1 packages an NSIS installer and nothing else */
  | 'unsupported'
  /** the release has no installer + sidecar pair to work from */
  | 'no-asset'
  /** no token could be resolved locally, and the asset is private */
  | 'no-token'
  /** the asset host refused the credentials we have */
  | 'auth'
  /** never reached it, or the connection died mid-body */
  | 'network'
  /** **the important one.** The bytes are not the bytes the feed vouched for. */
  | 'checksum'
  /** could not write to the temp directory */
  | 'disk'
  /** verified, staged, and the OS would not start it */
  | 'launch';

/** Pushed to the renderer as the install proceeds. Never thrown. */
export interface UpdateInstallStatus {
  phase: UpdateInstallPhase;
  /** the release being installed, normalized (no `v`) */
  version: string;
  /** bytes on disk so far */
  received: number;
  /** bytes expected; 0 when the feed did not say, which the UI reads as indeterminate */
  total: number;
  reason?: UpdateInstallFailure;
  /** the release page, so the fallback button has somewhere to go */
  url?: string;
}

/**
 * The post-update handshake (P2-E19-04).
 *
 * Written before we quit, read once on the next startup. It is the only way
 * the app can tell "the install worked" from "the installer was closed at the
 * UAC prompt" — the process that would have reported either is the one being
 * replaced.
 */
export interface UpdateHandshake {
  /** the version we are NOW running, confirmed equal to what was pending */
  updatedTo: string;
}

/**
 * What main pushes / returns. `prompt` is main's decision, not the renderer's:
 * skip is persisted in the workspace store, so only main can say whether this
 * particular version has been skipped.
 */
export interface UpdateStatus {
  result: UpdateCheckResult;
  /** a human asked for this check — it always shows something */
  manual: boolean;
  /** show the "there's a new release" dialog without being asked */
  prompt: boolean;
}

/** Persisted, in the workspace store next to the other app-level preferences. */
export interface UpdatePrefs {
  /** check on startup and once a day. Default ON. */
  autoCheck: boolean;
  /** "Skip this version" — suppressed for automatic checks only */
  skippedVersion?: string;
  /** ISO timestamp of the last completed check, for the daily timer */
  lastCheck?: string;
  /**
   * The version an installer was launched for, written just before we quit
   * (P2-E19-04). The NEXT startup compares it to the version actually running
   * and then clears it — always clears it, whichever way the comparison went,
   * because a stale pending version would either congratulate the user forever
   * or warn them forever.
   */
  pendingUpdateVersion?: string;
}
