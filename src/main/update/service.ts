// Update-check policy (P2-E19-03): when to check, whether to prompt, and what
// to remember. `checker.ts` answers the question; this decides when it is
// asked and who hears the answer.
//
// FAIL-OPEN, everywhere and without exception. A dead feed, a missing `gh`, a
// hostile response, a quit mid-flight — every one of them is a log line and a
// record. Nothing here can block a session, and nothing here throws.
import { UpdateCheckResult, UpdatePrefs, UpdateStatus } from '../../shared/update';
import { checkForUpdate, CheckDeps } from './checker';

/** The daily cadence the item asks for. */
export const DAILY_MS = 24 * 60 * 60 * 1000;

/**
 * How often the timer looks at the clock.
 *
 * Not `setInterval(24h)`: a laptop that sleeps for eighteen hours has not run
 * eighteen hours of timer, and a machine left open for a week should still get
 * one check a day. An hourly glance at a persisted timestamp gives both, and
 * costs nothing.
 */
export const TICK_MS = 60 * 60 * 1000;

/**
 * Two automatic checks closer together than this collapse into one.
 *
 * The startup check is driven by the RENDERER's mount (see `check()` below), and
 * macOS re-activate mounts a second window. Without this, opening the app,
 * closing the window and clicking the dock icon would be two API calls a second
 * apart for no new information.
 */
export const AUTO_COALESCE_MS = 5 * 60 * 1000;

/**
 * The dev/test feed seam.
 *
 * Read ONLY in a non-packaged build, exactly like `SWITCHBOARD_BIND_GIVEUP_MS`
 * (P2-E15-10): a shipped binary must have no environment variable that can
 * point its update check at somebody else's server.
 *
 *   • a URL  — check that instead of the GitHub API, with no token resolution
 *   • `off`  — no checks at all this run. The e2e fixture sets this on every
 *     launch, so no test in the suite ever touches the real GitHub or reaches
 *     for the machine's real `gh` credentials.
 */
export const FEED_ENV = 'SWITCHBOARD_UPDATE_FEED';

export interface UpdateServiceDeps {
  /** package.json semver of the running build */
  currentVersion: string;
  getPrefs: () => UpdatePrefs;
  setPrefs: (patch: Partial<UpdatePrefs>) => void;
  /** deliver a status the renderer did not ask for (timer, menu) */
  push: (status: UpdateStatus) => void;
  log: {
    debug: (msg: string, meta?: Record<string, unknown>) => void;
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** `process.env[FEED_ENV]` in a non-packaged build; undefined otherwise */
  feedOverride?: string;
  /** test seam */
  checkImpl?: (deps: CheckDeps) => Promise<UpdateCheckResult>;
  now?: () => number;
}

export class UpdateService {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight: Promise<UpdateCheckResult> | null = null;
  private lastAutoAt = 0;
  private last: UpdateStatus | null = null;

  constructor(private readonly deps: UpdateServiceDeps) {}

  /**
   * Start the daily timer.
   *
   * There is deliberately no startup check HERE. The renderer runs it when it
   * mounts, which is the one moment we know a window exists to receive the
   * answer — a check fired from the bootstrap would race the window it wants to
   * talk to, and lose that race on a slow machine, silently.
   */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // Never hold the process open for an update check (the convention every
    // other timer in main follows).
    this.timer.unref?.();
  }

  /** Called from `app.on('quit')`. A check in flight becomes a no-op. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Run a check.
   *
   * `manual` means a human asked — from the palette, the menu, or About. A
   * manual check ignores the auto-check switch, ignores the coalescing window,
   * and ALWAYS prompts, even for a version that was skipped: "check for
   * updates" that silently does nothing is worse than no button at all.
   *
   * `push` is false when the caller is the renderer's own invoke — it already
   * gets the answer as the return value, and pushing as well would open the
   * dialog twice.
   */
  async check(manual: boolean, opts: { push?: boolean } = {}): Promise<UpdateStatus> {
    const prefs = this.deps.getPrefs();
    const now = this.deps.now ?? Date.now;

    // Distinct from 'auto-check-off': a check that arrived after quit is not
    // a user preference, and labelling it as one is a log line that lies.
    if (this.stopped) return this.statusOf(this.disabled('quitting'), manual, prefs);
    if (!manual) {
      if (!prefs.autoCheck) {
        this.deps.log.debug('automatic update check skipped: turned off');
        return this.statusOf(this.disabled('auto-check-off'), manual, prefs);
      }
      if (this.last && now() - this.lastAutoAt < AUTO_COALESCE_MS) {
        // A second window, or a second mount. Re-decide `prompt` against the
        // CURRENT prefs (a version skipped in between must stop prompting)
        // rather than replaying the old decision.
        return this.statusOf(this.last.result, false, prefs);
      }
    }

    const result = await this.run();
    if (this.stopped) {
      // Quit landed while the request was open. Answer the caller — it may be
      // a promise something is still awaiting — but write nothing and push
      // nothing: the store is on its way out and the window is gone.
      return this.statusOf(result, manual, prefs);
    }
    if (!manual) this.lastAutoAt = now();
    // Persisted even when the check failed: the daily timer is a POLITENESS
    // budget, and retrying a dead feed every hour is exactly what it is for.
    this.deps.setPrefs({ lastCheck: new Date(now()).toISOString() });

    const status = this.statusOf(result, manual, this.deps.getPrefs());
    this.last = status;
    if (result.state === 'available') {
      this.deps.log.info('a newer release is available', {
        current: result.currentVersion,
        latest: result.latestVersion,
        prompt: status.prompt,
      });
    }
    if (opts.push) this.deps.push(status);
    return status;
  }

  /** "Skip this version" — persisted, and only ever suppresses AUTO prompts. */
  skip(version: string): UpdatePrefs {
    if (typeof version === 'string' && version.trim()) {
      this.deps.setPrefs({ skippedVersion: version.trim() });
      this.deps.log.info('release skipped by the user', { version: version.trim() });
    }
    return this.deps.getPrefs();
  }

  /** The single in-flight check, shared by every concurrent caller. */
  private run(): Promise<UpdateCheckResult> {
    if (this.inFlight) return this.inFlight;
    const feed = this.deps.feedOverride?.trim();
    if (feed === 'off') {
      this.deps.log.debug('update checks disabled for this run by the feed override');
      return Promise.resolve(this.disabled('overridden-off'));
    }
    const deps: CheckDeps = {
      currentVersion: this.deps.currentVersion,
      log: (msg, meta) => this.deps.log.debug(msg, meta),
      ...(feed ? { endpoint: feed, skipToken: true } : {}),
    };
    const impl = this.deps.checkImpl ?? checkForUpdate;
    // `.catch` as well as the checker's own promise: this is the last barrier
    // between an unexpected throw and an unhandled rejection in the main
    // process, and "nothing in the update path throws" has to be true even if
    // someone changes the checker.
    const p = impl(deps)
      .catch((err: unknown) => {
        this.deps.log.warn('update check threw — treating as a failed check', {
          error: String(err),
        });
        return {
          ok: false,
          state: 'failed',
          currentVersion: this.deps.currentVersion,
          reason: 'network',
          checkedAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
        } as UpdateCheckResult;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = p;
    return p;
  }

  /**
   * The timer body, wrapped so that NOTHING escapes into `setInterval`.
   *
   * An uncaught throw from an interval callback in the main process is an "A
   * JavaScript error occurred" modal on top of the user's work — which is the
   * opposite of what a background update check is allowed to cost.
   */
  private tick(): void {
    try {
      if (this.stopped) return;
      const prefs = this.deps.getPrefs();
      if (!prefs.autoCheck) return;
      const now = (this.deps.now ?? Date.now)();
      const last = prefs.lastCheck ? Date.parse(prefs.lastCheck) : NaN;
      // An unparseable or future timestamp counts as "due": a hand-edited file
      // must not switch update checks off for good.
      if (Number.isFinite(last) && last <= now && now - last < DAILY_MS) return;
      void this.check(false, { push: true }).catch((err: unknown) =>
        this.deps.log.warn('scheduled update check failed', { error: String(err) })
      );
    } catch (err) {
      this.deps.log.warn('update timer tick failed', { error: String(err) });
    }
  }

  private disabled(reason: 'auto-check-off' | 'overridden-off' | 'quitting'): UpdateCheckResult {
    return {
      ok: false,
      state: 'disabled',
      currentVersion: this.deps.currentVersion,
      reason,
      checkedAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
    };
  }

  private statusOf(result: UpdateCheckResult, manual: boolean, prefs: UpdatePrefs): UpdateStatus {
    return { result, manual, prompt: shouldPrompt(result, prefs, manual) };
  }
}

/**
 * Does this result put a dialog on screen without being asked?
 *
 * Manual checks always show something — that is the difference between a
 * button and a decoration. Automatic ones show the dialog only for a genuinely
 * new release that has not been skipped; every failure, every "disabled" and
 * every up-to-date is silent, which is the item's done-when.
 */
export function shouldPrompt(
  result: UpdateCheckResult,
  prefs: UpdatePrefs,
  manual: boolean
): boolean {
  if (manual) return true;
  if (result.state !== 'available' || !result.latestVersion) return false;
  return prefs.skippedVersion !== result.latestVersion;
}

/**
 * May we hand this URL to the user's browser?
 *
 * Its own guard rather than main's general `isSafeExternalUrl` (which allows
 * any http/https): the strings that reach here come from a release body we
 * rendered, so the honest boundary is "GitHub, over TLS" and not "anywhere the
 * notes felt like sending you". `http:` is refused outright — a plaintext link
 * out of an update dialog is the shape of a downgrade attack, even when all it
 * opens is a browser tab.
 */
export function isAllowedReleaseUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return host === 'github.com' || host.endsWith('.github.com');
}
