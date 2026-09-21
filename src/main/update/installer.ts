// Starting the installer (P2-E19-04, plan §E19).
//
// The smallest file in the feature and the one with the sharpest edge: this is
// where switchboard.ai executes something it downloaded. Two guards, both
// non-negotiable:
//
//   1. **The path must be one WE staged.** Not "an absolute path", not "an
//      .exe" — a file inside the update directory this process owns, with the
//      extension we packaged. The argument reaching here has come through a
//      verified checksum, but a guard that depends on a caller having done its
//      job is not a guard.
//   2. **No shell, ever.** `spawn` with an argv array. There is no user string
//      in the command line, and there will not be one, but an installer launch
//      is the last place to leave a shell sitting.
//
// NOT SILENT, SINCE 0.8.95. This used to pass NSIS's `/S`, and the owner's
// report is what that cost: *"the app closes out, and then nothing happens for
// about 30 seconds … I have no visual feedback."* Silent meant exactly that —
// the installer ran with no window at all while the app was gone.
//
// Without `/S`, electron-builder's oneClick target (see `electron-builder.js`)
// still shows NO wizard — read in `app-builder-lib/templates/nsis/
// installSection.nsh`, not assumed: under `${IfNot} ${Silent}` a ONE_CLICK
// build shows `SpiderBanner` — a small window with the app icon, "Installing,
// please wait…" and an animated bar — and nothing else (`oneClick.nsh` has only
// the instfiles page; there is no licence page to show). Per-user, so still no
// UAC.
//
// `--updated` is what makes non-silent safe to run UNATTENDED, and it is the
// argument electron-updater itself passes. The installer checks whether the
// app is still running (`_CHECK_APP_RUNNING`, `include/
// allowOnlyOneInstallerInstance.nsh`); we launch it and THEN quit, so it often
// is. Silent, that check answered its own "switchboard is running, click OK"
// box (`/SD IDOK`). Non-silent it would put that box in front of the user —
// unless `${isUpdated}`, in which case it waits ~1.3s and then TERMINATES
// whatever is left (`Stop-Process`), no prompt. That is why `workspace.save()`
// runs before the spawn (`index.ts`): nothing that matters may be moved into
// shutdown. The relaunched app receives `--updated` on its command line, which
// main ignores (it reads no argv).
//
// ONE PROMPT REMAINS POSSIBLE, and it is NSIS's, not ours: if copying the new
// files fails five times, `extractAppPackage.nsh` asks "cannot be closed —
// Retry / Cancel". Silent answered Retry for itself; visible, the user must.
// Rare (the running-app check has already killed everything under the install
// folder), and the manual says to press Retry.
//
// `--force-run` is the half that is easy to get wrong, and we did (#525). The
// oneClick installer relaunches the app after installing — but read the
// generated script rather than the feature name: in
// `app-builder-lib/templates/nsis/installSection.nsh` the relaunch is guarded
// by `${ifNot} ${Silent} ${orIf} ${isForceRun}`. `runAfterFinish` (default
// true) only defines RUN_AFTER_FINISH, which selects that guard; it does not
// satisfy it. So under `/S` the FIRST arm is false by construction — a silent
// install relaunches nothing unless `--force-run` is also passed. Without it
// the update installs correctly and the app simply never comes back, which is
// exactly what the user sees: the app quits and stays quit. Non-silent, the
// first arm is true and `--force-run` is belt to it — kept, because it is the
// argument whose absence already cost one release, and it costs nothing.
//
// That relaunch is what makes the post-update handshake possible at all —
// nobody has to double-click anything for the new version to come back — and
// it is what the UI has already promised by this point (`update.launching`:
// "the app reopens on the new version by itself").
import { spawn } from 'child_process';
import path from 'path';

/**
 * What the installer is started with — see the header for each one. No `/S`:
 * the visible "Installing…" banner is the point.
 */
export const INSTALLER_ARGS: readonly string[] = Object.freeze(['--updated', '--force-run']);

export interface LaunchDeps {
  /** the directory `install.ts` staged into — the only place we will run from */
  updateDir: string;
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
}

/**
 * Is `file` something we are willing to execute?
 *
 * Exported for its own tests, and readable on its own: containment is checked
 * with `path.relative`, not `startsWith`, so `…\updates-evil\x.exe` cannot pass
 * as being inside `…\updates`.
 */
export function isStagedInstaller(file: unknown, updateDir: string): boolean {
  if (typeof file !== 'string' || !file) return false;
  if (!path.isAbsolute(file)) return false;
  if (path.extname(file).toLowerCase() !== '.exe') return false;
  const rel = path.relative(path.resolve(updateDir), path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Start the installer, detached, and return.
 *
 * DETACHED and `unref`'d on purpose: the very next thing the caller does is
 * quit this app, and a child in our process group would be killed with us — by
 * the installer we just asked to replace us. `stdio: 'ignore'` for the same
 * reason; there is no pipe left to read from once we are gone.
 *
 * Returns false rather than throwing, so a caller in the fail-open update path
 * cannot be handed an exception.
 */
export function launchInstaller(file: string, deps: LaunchDeps): boolean {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return false;
  if (!isStagedInstaller(file, deps.updateDir)) return false;
  const spawnFn = deps.spawnImpl ?? spawn;
  try {
    const child = spawnFn(file, INSTALLER_ARGS, {
      detached: true,
      stdio: 'ignore',
      // FALSE, and load-bearing: for a GUI program libuv turns `windowsHide`
      // into STARTUPINFO `wShowWindow = SW_HIDE`, which Windows applies to the
      // process's first shown window — the "Installing…" banner this whole
      // change exists to show. True would put us straight back to thirty
      // silent seconds.
      windowsHide: false,
      // No `shell`. Stated rather than omitted: the default is already false,
      // and this is the line a future "just add shell:true to fix quoting"
      // should have to delete on purpose.
      shell: false,
    });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
