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
// `/S` is NSIS's silent switch and the whole user-facing point: electron-
// builder's oneClick target (see `electron-builder.js`) installs per-user with
// no UAC and no wizard, then relaunches the app itself. That relaunch is what
// makes the post-update handshake possible at all — nobody has to double-click
// anything for the new version to come back.
import { spawn } from 'child_process';
import path from 'path';

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
    const child = spawnFn(file, ['/S'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
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
