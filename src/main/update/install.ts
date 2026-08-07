// Download → verify → install, and the handshake that proves it worked
// (P2-E19-04, plan §E19).
//
// `checker.ts` finds a release, `service.ts` decides whether to offer it, and
// this runs the offer once the user has accepted it. It owns four things the
// pieces underneath deliberately do not:
//
//   • **the order**, and the fact that nothing is executed before the checksum
//     matches — the single invariant this whole item exists to hold;
//   • **re-entrancy**: one install at a time, and a daily timer tick landing
//     mid-download must not turn into a second dialog (the item's own words);
//   • **the handshake**: `pendingUpdateVersion` written before we quit, read
//     and cleared by the next startup. It is the only way to tell "installed"
//     from "closed at the first prompt", because the process that could have
//     reported either is the one being replaced;
//   • **the sweep**: temp installers are ~120 MB, and one left behind by a
//     crash is a bill the user never agreed to pay.
//
// FAIL-OPEN, like everything else in this path. Every exit is a record; the
// user's fallback is always "open the release page in a browser", which is
// exactly where they were before this item existed.
import fs from 'fs';
import path from 'path';
import {
  UpdateCheckResult,
  UpdateHandshake,
  UpdateInstallFailure,
  UpdateInstallStatus,
  UpdatePrefs,
} from '../../shared/update';
import { DownloadError, downloadAsset, fetchAssetText, unlinkQuietly } from './download';
import { verifyChecksum } from './verify';
import { resolveUpdateToken, TokenSource } from './token';

/**
 * The directory name under the OS temp dir. Ours alone, because `sweep()`
 * empties it — pointing this at a shared location would make the sweep a
 * delete of somebody else's files.
 */
export const UPDATE_DIR_NAME = 'switchboard-updates';

/**
 * What an installer asset may be called.
 *
 * The name comes off the network and becomes a PATH, so it is matched, not
 * escaped: `path.basename` alone still admits `..` on some inputs and admits
 * every unicode homoglyph on all of them. `electron-builder.js` names the
 * artifact `switchboard-Setup-<version>.exe`, which is comfortably inside this.
 */
const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.exe$/;

/** Which asset in a release is the installer, and which is its sidecar. */
const SIDECAR_SUFFIX = '.sha256';

export interface UpdateInstallerDeps {
  currentVersion: string;
  /** absolute; created on demand and emptied by `sweep()` */
  updateDir: string;
  getPrefs: () => UpdatePrefs;
  setPrefs: (patch: Partial<UpdatePrefs>) => void;
  push: (status: UpdateInstallStatus) => void;
  log: {
    debug: (msg: string, meta?: Record<string, unknown>) => void;
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /**
   * Ask the app to shut down and run `file`.
   *
   * Owned by `index.ts` because the busy-session question and `app.quit()` both
   * live there.
   *
   * THREE answers, not two, and the third is why: `'declined'` (the user said
   * no to the mid-task quit question — nothing is wrong) and `'failed'` (the OS
   * refused to start a verified installer — something IS wrong and the user
   * needs the browser fallback) are different events, and a boolean collapsed
   * them into a silent re-offer with no explanation. Both roll the pending
   * version back; only one of them is reported as a failure.
   */
  quitAndRun: (file: string) => 'quit' | 'declined' | 'failed';
  /** the dev/test feed override is active — see `download.ts`'s `allowLoopback` */
  allowLoopback?: boolean;
  /** the override's feed wants no credentials, so do not reach for `gh` */
  skipToken?: boolean;
  platform?: NodeJS.Platform;
  tokenSources?: TokenSource[];
  /** test seams */
  downloadImpl?: typeof downloadAsset;
  fetchTextImpl?: typeof fetchAssetText;
  verifyImpl?: typeof verifyChecksum;
}

export class UpdateInstaller {
  private running: Promise<UpdateInstallStatus> | null = null;
  private abort: AbortController | null = null;
  private cancelled = false;
  private last: UpdateInstallStatus | null = null;

  constructor(private readonly deps: UpdateInstallerDeps) {}

  /** True while a download/verify/launch is in flight. Read by `service.ts`,
   *  which stops offering a release we are already installing. */
  busy(): boolean {
    return this.running !== null;
  }

  /** The most recent status, for a window that mounted mid-install. */
  status(): UpdateInstallStatus | null {
    return this.last;
  }

  /**
   * Run the offer. Never throws.
   *
   * A second call while one is running returns the SAME promise rather than
   * starting a second download — a double-click on Update, or a menu check
   * racing the dialog, must not put two writers on one temp file.
   */
  install(result: UpdateCheckResult): Promise<UpdateInstallStatus> {
    if (this.running) return this.running;
    this.cancelled = false;
    this.abort = new AbortController();
    const p = this.run(result)
      .catch((err: unknown) => {
        // The barrier. `run` is written not to throw; this is here so that a
        // future edit which forgets that becomes a log line instead of an
        // unhandled rejection in the main process.
        this.deps.log.warn('the update install threw — treating as a failed install', {
          error: String(err),
        });
        return this.emit(result, 'failed', { reason: 'network' });
      })
      .finally(() => {
        this.running = null;
        this.abort = null;
      });
    this.running = p;
    return p;
  }

  /**
   * Stop the download in flight.
   *
   * Idempotent and safe to call when nothing is running. The `cancelled` latch
   * is what lets `run` report a cancel as a cancel rather than as a network
   * failure — the abort reaches the socket as an ordinary error.
   */
  cancel(): void {
    if (!this.running) return;
    this.cancelled = true;
    this.abort?.abort();
    this.deps.log.info('update download cancelled by the user');
  }

  /**
   * Empty the staging directory. Called once at startup, before anything can
   * be downloading.
   *
   * Whole-directory rather than age-based: a download only ever lives inside a
   * single run, and the single-instance lock (#289) means no other run owns
   * these files. The one file that can legitimately resist deletion is the
   * installer still running from the update we just did — Windows holds a lock
   * on a running image — so a failure here is a debug line and nothing more.
   * The next startup gets it.
   */
  async sweep(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.deps.updateDir);
    } catch {
      return; // no directory is the normal case
    }
    let removed = 0;
    for (const name of entries) {
      const file = path.join(this.deps.updateDir, name);
      try {
        await fs.promises.rm(file, { recursive: true, force: true });
        removed++;
      } catch (err) {
        this.deps.log.debug('a staged installer could not be swept', {
          file: name,
          error: String(err),
        });
      }
    }
    if (removed) this.deps.log.info('swept staged installers', { removed });
  }

  private async run(result: UpdateCheckResult): Promise<UpdateInstallStatus> {
    const platform = this.deps.platform ?? process.platform;
    if (platform !== 'win32') {
      // Not a failure of ours: v1 packages an NSIS installer and nothing else
      // (E19 decision 3). The browser fallback is the whole answer here.
      return this.emit(result, 'failed', { reason: 'unsupported' });
    }

    const target = result.download;
    if (!target || !SAFE_ASSET_NAME.test(target.name)) {
      this.deps.log.info('this release has no installer this app can verify and run', {
        version: result.latestVersion,
        asset: target?.name,
      });
      return this.emit(result, 'failed', { reason: 'no-asset' });
    }

    let token: string | null = null;
    if (!this.deps.skipToken) {
      token = (await resolveUpdateToken(this.deps.tokenSources)).token;
      if (!token) return this.emit(result, 'failed', { reason: 'no-token' });
    }

    const dest = path.join(this.deps.updateDir, target.name);
    try {
      await fs.promises.mkdir(this.deps.updateDir, { recursive: true });
    } catch (err) {
      this.deps.log.warn('could not create the update staging directory', { error: String(err) });
      return this.emit(result, 'failed', { reason: 'disk' });
    }

    const common = {
      token,
      currentVersion: this.deps.currentVersion,
      signal: this.abort?.signal,
      allowLoopback: this.deps.allowLoopback,
    };

    this.emit(result, 'downloading', { received: 0, total: target.size });
    try {
      const download = this.deps.downloadImpl ?? downloadAsset;
      await download({
        ...common,
        url: target.url,
        dest,
        onProgress: (received, total) =>
          this.emit(result, 'downloading', { received, total: total || target.size }),
      });
    } catch (err) {
      await unlinkQuietly(dest);
      return this.emit(result, this.cancelled ? 'cancelled' : 'failed', {
        reason: this.cancelled ? undefined : failureOf(err),
      });
    }
    if (this.cancelled) {
      await unlinkQuietly(dest);
      return this.emit(result, 'cancelled', {});
    }

    this.emit(result, 'verifying', { received: target.size, total: target.size });
    let sidecar: string;
    try {
      const fetchText = this.deps.fetchTextImpl ?? fetchAssetText;
      sidecar = await fetchText({ ...common, url: target.checksumUrl });
    } catch (err) {
      await unlinkQuietly(dest);
      return this.emit(result, this.cancelled ? 'cancelled' : 'failed', {
        reason: this.cancelled ? undefined : failureOf(err),
      });
    }

    const verify = this.deps.verifyImpl ?? verifyChecksum;
    const ok = await verify(dest, sidecar);
    if (!ok) {
      // THE line the item is built around. Deleted, never executed, and loud in
      // the log — a mismatch is either a corrupted download or something worse,
      // and both deserve a record. The user goes to the browser instead.
      await unlinkQuietly(dest);
      this.deps.log.warn('the downloaded installer did not match its checksum — deleted', {
        version: result.latestVersion,
        asset: target.name,
      });
      return this.emit(result, 'failed', { reason: 'checksum' });
    }
    if (this.cancelled) {
      await unlinkQuietly(dest);
      return this.emit(result, 'cancelled', {});
    }

    // Written BEFORE the launch, because after it there may be no `we` left to
    // write anything: the installer shuts this app down itself.
    const version = result.latestVersion ?? '';
    this.deps.setPrefs({ pendingUpdateVersion: version });
    this.emit(result, 'launching', { received: target.size, total: target.size });
    this.deps.log.info('verified installer staged; handing over', { version, file: dest });

    // Wrapped, and the rollback is in the `catch` as well as the unhappy
    // branch: `quitAndRun` reaches a native message box and a `spawn`, and a
    // throw from either would leave `pendingUpdateVersion` set. That is the one
    // piece of update state that outlives the process, so the cost of missing
    // it is the NEXT run warning about an install that never started.
    let launched: 'quit' | 'declined' | 'failed';
    try {
      launched = this.deps.quitAndRun(dest);
    } catch (err) {
      this.deps.setPrefs({ pendingUpdateVersion: '' });
      await unlinkQuietly(dest);
      this.deps.log.warn('handing over to the installer threw', { error: String(err) });
      return this.emit(result, 'failed', { reason: 'launch' });
    }
    if (launched === 'quit') return this.last as UpdateInstallStatus;

    // Nothing is going to run it, so nothing should be holding ~120 MB of temp
    // until the next startup sweep. A retry re-downloads to the same path
    // anyway — there is no resume to preserve.
    this.deps.setPrefs({ pendingUpdateVersion: '' });
    await unlinkQuietly(dest);
    if (launched === 'declined') {
      // The user answered "cancel" to the mid-task quit question. Nothing is
      // wrong, nothing was executed, and the release is still on offer.
      this.deps.log.info('the install was not started; the release is still on offer');
      return this.emit(result, 'cancelled', {});
    }
    // The OS would not start an installer we downloaded and verified. That IS
    // a failure, and the user needs the browser fallback rather than a silent
    // re-offer of the button that just did nothing.
    this.deps.log.warn('the verified installer could not be started', { file: dest });
    return this.emit(result, 'failed', { reason: 'launch' });
  }

  /** Build, remember and push one status. Returns it, so callers can `return` it. */
  private emit(
    result: UpdateCheckResult,
    phase: UpdateInstallStatus['phase'],
    extra: { received?: number; total?: number; reason?: UpdateInstallFailure }
  ): UpdateInstallStatus {
    const status: UpdateInstallStatus = {
      phase,
      version: result.latestVersion ?? '',
      received: extra.received ?? this.last?.received ?? 0,
      total: extra.total ?? this.last?.total ?? 0,
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(result.url ? { url: result.url } : {}),
    };
    this.last = status;
    try {
      this.deps.push(status);
    } catch (err) {
      // The window died mid-download. Nothing here is worth taking the install
      // path down for.
      this.deps.log.debug('could not push an install status', { error: String(err) });
    }
    return status;
  }
}

function failureOf(err: unknown): UpdateInstallFailure {
  return err instanceof DownloadError ? err.reason : 'network';
}

/**
 * The stale-offer guard (#315): may main act on the offer it is holding?
 *
 * One condition, one place, and a shape the caller can narrow — the refusal
 * and the release it refuses must never be able to drift apart.
 *
 * ── why this exists ────────────────────────────────────────────────────────
 *
 * The dialog on screen is a PICTURE of an answer main gave earlier, and main is
 * the side that decides what gets downloaded and executed (`update:install`
 * takes no arguments at all). Those two can disagree: a window open across a
 * release being withdrawn, superseded, or across a later check that never
 * reached the feed. E19-04 refused the press correctly but reported it as
 * `no-asset` — "this release has no installer this app can verify" — which is
 * an accurate outcome attached to the wrong cause, and sends the user to a
 * release page that may no longer exist.
 *
 * ── why a REASON rather than a re-check ────────────────────────────────────
 *
 * Re-checking on the press would install whatever the feed answers NOW, which
 * is not necessarily the release whose notes the user just read and agreed to —
 * consent is to a version, not to "the newest thing". (And re-checking when the
 * dialog is REOPENED closes only part of the window: a withdrawal can land
 * between the reopen and the press, so this reason would still be needed.) The
 * honest move is to say the offer is gone and let the user ask again.
 *
 * ONE reason for every shape of "not on offer" — withdrawn, superseded, or a
 * later check that failed — because the user's next move is the same in all of
 * them and the UI cannot usefully carry the difference. The sentence it maps to
 * therefore names all three rather than guessing between them; the distinction
 * is kept where it is actually useful, in the log line's `state`.
 *
 * Pure, and exported, so the branch is unit-testable without an Electron app —
 * `index.ts` is the one file the suite cannot import.
 */
export function resolveOffer(
  offered: UpdateCheckResult | null
): { ok: true; offer: UpdateCheckResult } | { ok: false; status: UpdateInstallStatus } {
  if (offered && offered.state === 'available') return { ok: true, offer: offered };
  return {
    ok: false,
    status: {
      phase: 'failed',
      // Deliberately EMPTY rather than `offered?.latestVersion`: on an
      // `up-to-date` result that field is whatever is newest now, which is not
      // the release the user pressed Update on. There is no version being
      // installed, and claiming one would be a second small lie.
      version: '',
      received: 0,
      total: 0,
      reason: 'no-offer',
    },
  };
}

/**
 * The post-update handshake, run once at startup. A pure decision plus one
 * write, so it can be unit-tested without an app.
 *
 * Three outcomes:
 *   • nothing pending  — the ordinary launch, no news;
 *   • pending === running — **it worked.** Returns the version so the shell can
 *     say "You're now on vX", and clears the flag;
 *   • pending !== running — the installer was closed, failed, or installed
 *     something else. A warning in the log and the flag cleared, because a
 *     pending version that is never cleared warns on every launch forever.
 */
export function resolveHandshake(deps: {
  currentVersion: string;
  getPrefs: () => UpdatePrefs;
  setPrefs: (patch: Partial<UpdatePrefs>) => void;
  log: { info: (m: string, x?: Record<string, unknown>) => void; warn: (m: string, x?: Record<string, unknown>) => void };
}): UpdateHandshake | null {
  const pending = deps.getPrefs().pendingUpdateVersion;
  if (!pending) return null;
  // Cleared FIRST, and unconditionally. Whatever we decide below, this run is
  // the one that answers the question — a crash between here and the return
  // must not leave the next run asking it again.
  deps.setPrefs({ pendingUpdateVersion: '' });
  if (pending === deps.currentVersion) {
    deps.log.info('update installed', { version: pending });
    return { updatedTo: pending };
  }
  deps.log.warn('an update was started but this build is not the one it was for', {
    expected: pending,
    running: deps.currentVersion,
  });
  return null;
}

/**
 * Pick the installer + sidecar pair out of a release's assets.
 *
 * BOTH or neither: a release with an installer and no `.sha256` is a release
 * this app will not auto-install, because the checksum is the only integrity
 * check an unsigned build has. That is also why the release workflow treats a
 * missing sidecar as a build failure (`.github/workflows/release.yml`).
 *
 * Exported and tested on its own — it is the one piece of GitHub's response
 * shape that E19-04 adds to the checker.
 */
export function pickInstallerAsset(
  assets: unknown,
  platform: NodeJS.Platform = process.platform
): { name: string; url: string; checksumUrl: string; size: number } | null {
  if (platform !== 'win32' || !Array.isArray(assets)) return null;
  const list = assets.filter(
    (a): a is { name: string; url: string; size?: unknown } =>
      !!a &&
      typeof a === 'object' &&
      typeof (a as { name?: unknown }).name === 'string' &&
      typeof (a as { url?: unknown }).url === 'string'
  );
  const exes = list.filter((a) => SAFE_ASSET_NAME.test(a.name));
  // The name `electron-builder.js` is configured to produce, first. Falling
  // back to "the only .exe" keeps a hand-uploaded release working; falling
  // back to "the FIRST of several .exe files" would be a coin toss over which
  // binary to run, so two unrecognised installers is no installer at all.
  const installer = exes.find((a) => /^switchboard-Setup-/i.test(a.name)) ?? (exes.length === 1 ? exes[0] : undefined);
  if (!installer) return null;
  const sidecar = list.find((a) => a.name === installer.name + SIDECAR_SUFFIX);
  if (!sidecar) return null;
  const size = Number((installer as { size?: unknown }).size);
  return {
    name: installer.name,
    url: installer.url,
    checksumUrl: sidecar.url,
    size: Number.isFinite(size) && size > 0 ? size : 0,
  };
}
