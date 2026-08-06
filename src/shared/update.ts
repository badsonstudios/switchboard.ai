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
}
