// Ending a spawned child AND everything it started.
//
// Extracted from `git/git-service.ts` for #758, which is the second caller with
// the same problem and would otherwise have hand-copied it. This file's
// neighbour `env.ts` says why there is exactly one of these rather than one per
// transport: a hand-copied second list is how two callers quietly stop behaving
// the same. (`bus/mcp-attach-check.ts` has its own simpler copy and keeps it —
// it is a local check harness, not shipping code.)
import { ChildProcess, spawn } from 'child_process';

/**
 * End a child invocation AND everything it started.
 *
 * ⚠️ ON WINDOWS THE THING YOU HOLD IS OFTEN A LAUNCHER, and killing it leaves
 * the real work running. Two measured instances, which is why this is shared:
 *
 *   - **git** (#772 review). An app started from Explorer inherits the machine
 *     PATH, which carries `Git\cmd` — Git for Windows' `cmd\git.exe`, a small
 *     program that starts the real `mingw64\bin\git.exe` as a CHILD and waits.
 *     `execFile`'s `timeout` kills the process it spawned, i.e. the launcher,
 *     and the real git runs on: measured with a git busy on something other
 *     than stdin, one `git.exe` survived every kill through the launcher and
 *     none survived the direct binary. (The first probe used a git blocked on
 *     stdin, which exits by itself when the dead launcher's pipe closes — it
 *     passed for the wrong reason, and a git stuck on a slow disk is not
 *     reading stdin.)
 *   - **the `claude` CLI** (#758). `resolveCliPath` returns `claude.cmd` on
 *     Windows, so `execSpec` hands us **cmd.exe** and the 230 MB `claude.exe`
 *     is its child. A one-shot label run that has to be abandoned must not
 *     leave that child holding a model call.
 *   - **the interactive stream session** (#719). The same `cmd.exe` →
 *     `claude.exe` shape, held for the whole life of a session. It uses this
 *     only as a backstop, after stdin EOF has had a chance to end the CLI
 *     cleanly (see `StreamSession.kill`).
 *
 * `taskkill /T` takes the tree.
 *
 * POSIX has no launcher layer: the binary is the binary, and `kill` ends it.
 * What it does not end is anything that binary itself started — an fsmonitor
 * hook, a clean filter — which is #776's subject: those should not be running
 * at all.
 */
export function killTree(child: ChildProcess, onDone?: () => void): void {
  // `onDone` fires once, when the kill has been carried out or has failed over
  // to the fallback. App quit needs it (#719). `taskkill` is our own child, and
  // libuv puts every child in a kill-on-close job object, so an app that exits
  // straight after spawning it can take the killer down before it has killed
  // anything.
  let doneFired = false;
  const done = (): void => {
    if (doneFired) return;
    doneFired = true;
    try {
      onDone?.();
    } catch {
      /* the caller's problem; this may be running in a timer callback */
    }
  };
  if (process.platform === 'win32' && child.pid !== undefined) {
    // EVERY failure of the tree kill falls back to killing the one process we
    // hold — the launcher at least goes, as it did before — and none of them
    // may throw: this runs in a timer callback in Electron main (review, round
    // 2). `spawn` reports some failures as an 'error' event and THROWS others
    // (ENOMEM and friends); taskkill can also start and then fail ("Access is
    // denied", a partial tree).
    //
    // A PID-reuse window remains and is accepted: the caller checked the
    // process had not exited, but taskkill opens the PID tens of milliseconds
    // later, and Node may have reaped it in between. Narrowing that would mean
    // matching image names, for odds that are very small.
    const fallback = (): void => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      } finally {
        done();
      }
    };
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', fallback);
      killer.on('exit', (code) => {
        if (code !== 0) fallback();
        else done();
      });
    } catch {
      fallback();
    }
    return;
  }
  try {
    child.kill();
  } finally {
    done();
  }
}
