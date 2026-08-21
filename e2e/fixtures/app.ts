// Launch the built Electron app under Playwright, fully isolated: a temp HOME
// so it never touches the real ~/.claude.json or workspace, the fake provider
// (shell-in-a-PTY, no claude login), and the S-01 env landmines scrubbed.
import {
  _electron as electron,
  ElectronApplication,
  expect,
  Locator,
  Page,
  test,
} from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync, spawn } from 'child_process';

/**
 * Kill an entire process tree.
 *
 * A popped-out Electron window is a child process and node-pty spawns its own
 * children; `app.process().kill()` only reaps the main pid, leaving
 * grandchildren that keep the Playwright worker alive (the "Worker teardown
 * timeout" seen on CI). Take out the whole tree — on BOTH platforms, which
 * until #235 this said but only Windows did:
 *
 * - **win32:** `taskkill /T` walks the child table. A real tree kill, unchanged.
 * - **POSIX:** a NEGATIVE pid signals the whole process GROUP, where plain
 *   `kill -9 <pid>` reached only the leader and left every child behind.
 *
 * The group kill works because the pid we hold is a group LEADER, and that is
 * not our doing: `_electron.launch()` exposes no spawn options at all (no
 * `detached`, no `stdio` — see its `LaunchOptions`), so we could not ask for one
 * even if we wanted to. Playwright asks for us. Its `launchProcess()` spawns
 * with `detached: process.platform !== 'win32'`, commented in its own source as
 * "makes child process a leader of a new process group, making it possible to
 * kill child process tree with `.kill(-pid)`", and reaps with exactly
 * `process.kill(-pid, 'SIGKILL')` / `taskkill /pid X /T /F` — i.e. this function
 * is now the same two calls Playwright itself would make on the handle it gave
 * us. (playwright-core 1.61.1, `lib/coreBundle.js`; verified in the installed
 * copy, not from memory.)
 *
 * `process.kill` rather than spawning `/bin/kill`: no subprocess per teardown
 * (~160 specs' worth), no dependency on a binary being on PATH, and no shell
 * quoting to get the leading `-` past.
 *
 * The bare-pid FALLBACK catches ESRCH from the group kill, and note which case
 * that mostly is: `close()` calls this AFTER `gracefulClose()`, so the usual
 * teardown has already reaped the tree and "no such group" and "already dead"
 * are the same errno to us. The fallback costs one no-op syscall there. What it
 * BUYS is the other reading: if Playwright ever drops `detached`, `-pid` would
 * name nothing and a single-call version would silently reap NOTHING — strictly
 * worse than the bug this replaces. The fallback makes the old behaviour the
 * floor. It is errno-blind on purpose (EPERM lands there too); fail-open test
 * infra should not be parsing errnos to decide whether to try harder.
 *
 * Never throws: by the time teardown runs the tree is usually already gone, and
 * a throw here would fail a test that has already passed.
 *
 * Exported for `app.test.ts`, which asserts BOTH branches on EVERY CI leg —
 * hence `platform` as an argument, the `launchSpec()` shape and #127's lesson:
 * read the ambient platform inside and the win32 case passes vacuously on the
 * ubuntu runner, and the POSIX case on the Windows one, which is precisely how
 * this function's POSIX half stayed wrong from the day it was written.
 */
export function killTree(
  pid: number | undefined,
  platform: NodeJS.Platform = process.platform
): void {
  if (!pid) return;
  if (platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * `app.close()` bounded by a timeout, never throwing. `killTree` is the backstop
 * for whatever it did not manage, so every failure here is survivable.
 *
 * Two callers, two budgets: 12s for a healthy teardown (it closes in well under
 * a second; the headroom is for a slow popout child) and much less for a launch
 * that has already failed.
 *
 * The timer is CLEARED on the winning path — a dangling 12s handle keeps Node's
 * event loop alive that long after the race is decided, which on the last test
 * of a worker is 12s of nothing.
 *
 * Not to be confused with `quit-confirm.spec.ts`'s own `closeWithin`, which
 * reports whether a modal blocked the close and never kills anything.
 */
async function gracefulClose(app: ElectronApplication, budgetMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('close timeout')), budgetMs);
      }),
    ]);
  } catch {
    /* fall through to the tree kill */
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// electron's main export is the path to its binary when require()d in Node.
// LAZY: `app.test.ts` imports this module under vitest, where the binary is
// neither needed nor necessarily downloaded — at module scope this throws
// "Electron failed to install correctly" and takes the unit suite with it.
function electronPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron') as string;
}

const ROOT = path.resolve(__dirname, '..', '..');

/* ---- temp directories ------------------------------------------------------
 *
 * Every folder this fixture makes — the isolated homes and the project folders
 * `tempProjectFolder()` hands out — is registered here and deleted by
 * `cleanup()`. Until #213 NEITHER was reliably removed: `tempProjectFolder()`
 * had no teardown at all across its ~127 call sites (20,593 orphaned
 * `sb-e2e-proj-*` directories counted in one developer's %TEMP%, still growing
 * ~190 per full run), and the home's `rmSync` swallowed every failure without
 * ever retrying (2,062 orphaned `sb-e2e-*` homes — Electron userData trees, so
 * they dominate the disk cost).
 *
 * Register-what-you-make, rather than an rm at the end of a test, because the
 * end of a test is exactly what a failing assertion skips.
 */

/** Made and not yet deleted. Per Playwright WORKER — module state, one process. */
const pendingDirs = new Set<string>();

/**
 * Apps launched and not yet closed.
 *
 * The sweep waits for this to reach zero, and that guard is the reason it is
 * safe to delete folders this app did not itself create: a live app has a
 * session whose cwd IS one of these folders, and on Linux (no mandatory
 * locking) an rm would quietly succeed and pull the ground out from under a
 * running test. No spec in the suite currently holds two apps at once, so in
 * practice this never defers anything — it is here so that the first one that
 * does is not broken by this file.
 */
let liveApps = 0;

/** Track a directory the caller made, so `cleanup()` will remove it. */
export function registerTempDir(dir: string): string {
  pendingDirs.add(dir);
  return dir;
}

/**
 * Delete every registered directory. Never throws; requeues what would not go.
 *
 * The requeue is the part that matters on Windows, and it is worth writing down
 * because the obvious alternative does not work (measured for #180, PR #212):
 * `maxRetries` does NOT cover a lock on the directory itself. Node's recursive
 * rm only enters its retry loop after the not-empty recursion, so an `EBUSY`
 * off the very first `rmdir` — precisely what a process still holding the
 * folder as its cwd produces — is rethrown untouched. A folder that will not go
 * therefore stays pending and is retried by the next `cleanup()`, by which time
 * the process that held it is long gone. `maxRetries` still earns its place: it
 * covers the ENOTEMPTY/EPERM path a scanner holding one file inside the tree
 * produces.
 *
 * Async `fs.promises.rm`, not `rmSync`: that retry ladder sleeps ~5s, and a
 * synchronous one would spend it blocking the worker inside Playwright's hook
 * budget.
 *
 * And it never throws — a throw here would fail a test that has already passed.
 * Fail-open applies to test infrastructure too: a directory that will not go is
 * a housekeeping problem, not a broken run.
 */
export async function sweepTempDirs(): Promise<void> {
  if (liveApps > 0) {
    // Say so. A handle that is launched and never closed wedges this counter
    // above zero for the rest of the worker, and every later sweep silently
    // becomes a no-op — the whole run reverts to leaking with nothing in the
    // log to say it did, which is precisely the invisible failure #213 exists
    // to remove. One line beats a silent return.
    if (pendingDirs.size > 0) {
      console.warn(`[fixture] temp-dir sweep skipped: ${liveApps} app(s) still open`);
    }
    return;
  }
  for (const dir of [...pendingDirs]) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      pendingDirs.delete(dir);
    } catch {
      /* stays pending — the next cleanup() tries again */
    }
  }
}

// The last net, for everything no `cleanup()` got to: a folder requeued by the
// FINAL cleanup of the run, anything registered while an app was still open,
// and the whole pending set when Playwright discards a worker after a failure.
// One listener per worker process — this module is loaded once. Synchronous by
// necessity (nothing async runs during 'exit') and best-effort by design: at
// this point every app in this worker is gone, so a folder that still will not
// go is a leak nobody can do anything about.
process.on('exit', () => {
  for (const dir of pendingDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      /* best-effort */
    }
  }
});

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
  home: string;
  /**
   * How far this app's windows were shifted off the primary display (#479).
   * `{ x: 0, y: 0 }` unless `SWITCHBOARD_E2E_MONITOR` moved them — see
   * `onTestDisplay`, which is how a spec writes an absolute screen box.
   */
  displayOffset: Point;
  /** close the app but KEEP the home (for relaunch/persistence tests) */
  close: () => Promise<void>;
  /** close the app AND delete the home */
  cleanup: () => Promise<void>;
}

export interface LaunchOptions {
  /** auto-create one fake session in this folder at boot */
  seedFolder?: string;
  /**
   * Open one §5.30 document viewer on this path at boot (P2-E16-02).
   *
   * The seam grants NOTHING: the path still has to be inside the read scope,
   * so a spec pairs it with `seedFolder` and puts the file in that folder.
   */
  seedDocument?: string;
  /** reuse an existing home dir (to relaunch and test persistence) */
  home?: string;
  /** extra env for the main process */
  env?: Record<string, string>;
  /**
   * Run the REAL claude CLI instead of the fake provider: copies the
   * machine's claude credentials (~/.claude.json + ~/.claude/.credentials.json)
   * into the isolated home. Local-only — CI has no login; gate specs with
   * SWITCHBOARD_REAL_E2E=1.
   */
  realClaude?: boolean;
}

/* ---- which monitor the suite runs on (#479) --------------------------------
 *
 * Local e2e runs pop ~160 app windows onto whatever screen the developer is
 * working on. Electron has no headless mode, and a minimized or occluded window
 * throttles rAF — which would break the specs anchored on paint and focus — so
 * the answer is a DIFFERENT screen, not a hidden one: the window stays visible,
 * painting and focusable, just not in the way.
 *
 * `SWITCHBOARD_E2E_MONITOR=<n>` turns it on. **Monitor 1 is always the PRIMARY
 * display**, and 2..N are the rest in the order Electron reports them, so `=2`
 * is guaranteed to be a screen that is not the primary one — `getAllDisplays()`
 * has no documented order, and an index straight into it could land back on the
 * working screen, which is the one outcome that makes the switch pointless.
 * An index past the end (`=2` on a single-display machine, i.e. CI) moves
 * nothing, and unset does not even ask the app a question.
 *
 * THE HONEST LIMITATION: this fixes the visual popping only. Activating a
 * window steals keyboard focus globally on Windows however far away it is, and
 * the focus-dependent specs preclude launching without activation — so typing
 * can still be interrupted. What you get back is a quiet screen.
 */

/** A window rectangle in Electron's screen coordinates. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** One display, reduced to what the pure helpers below need. */
export interface DisplayInfo {
  id: number;
  workArea: Box;
}

/** The env var that turns the move on. One definition, named once. */
export const E2E_MONITOR_ENV = 'SWITCHBOARD_E2E_MONITOR';

// Frozen: one object is handed to every switch-off launch as its
// `displayOffset`, and a shared mutable default is a question nobody should
// have to ask.
const NO_OFFSET: Point = Object.freeze({ x: 0, y: 0 });

/**
 * Resolve `SWITCHBOARD_E2E_MONITOR` against a real display list.
 *
 * Pure and exported so `app.test.ts` can pin the ordering rule without a
 * machine that has two monitors — the whole point being that CI has one.
 *
 * Answers `null` for every "do nothing" case, and they are all the same case to
 * the caller: unset, junk, out of range, or monitor 1 (the primary), which is a
 * legitimate thing to ask for as an A/B and is simply the behaviour we already
 * have.
 */
export function pickTestDisplay(
  displays: DisplayInfo[],
  primaryId: number,
  monitor: string | undefined
): { primary: DisplayInfo; target: DisplayInfo } | null {
  const n = Number(monitor?.trim());
  if (!monitor?.trim() || !Number.isInteger(n) || n < 1) return null;
  const primary = displays.find((d) => d.id === primaryId);
  if (!primary) return null;
  const target = [primary, ...displays.filter((d) => d.id !== primaryId)][n - 1];
  if (!target || target.id === primary.id) return null;
  return { primary, target };
}

/**
 * The same rectangle, on another display: shifted by the two work areas'
 * offset, then clamped so it still fits if the target screen is smaller.
 *
 * Shift rather than centre, so a window that was centred stays centred and the
 * relative geometry a spec asserts is untouched — with one exception worth
 * stating, because it is a real behaviour change and not a rounding one: a
 * SMALLER target display shrinks the window to fit, and a responsive assertion
 * measured against a width (document-peek's cramped/roomy thresholds are the
 * ones in this suite) can legitimately answer differently there than it does on
 * the primary. Fitting beats hanging off the edge, but it is not free.
 */
export function translateToDisplay(bounds: Box, from: Box, to: Box): Box {
  const width = Math.min(bounds.width, to.width);
  const height = Math.min(bounds.height, to.height);
  const clamp = (v: number, lo: number, hi: number): number =>
    Math.round(Math.min(Math.max(v, lo), hi));
  return {
    x: clamp(bounds.x - from.x + to.x, to.x, to.x + to.width - width),
    y: clamp(bounds.y - from.y + to.y, to.y, to.y + to.height - height),
    width,
    height,
  };
}

/** Say which display we landed on ONCE per worker, not once per launch. */
let announcedDisplay = false;

/**
 * Move a freshly launched app's window onto the requested display.
 *
 * Returns the DISPLAY's offset from the primary — which is deliberately NOT
 * "how far this window moved". A relaunch finds the window already over there
 * and moves it nowhere, and `onTestDisplay` still has to answer the same both
 * times or a spec's absolute box would land somewhere different on the second
 * launch. `{0,0}` means "there is no other display in play", nothing else.
 *
 * FAIL-OPEN, like everything else in this fixture: a display query that throws
 * warns and leaves the window where it was. A developer-comfort switch must
 * never be the reason a suite goes red.
 *
 * Popouts need no handling of their own — dockview opens one at
 * `opener.screenX + position.left` (`renderer/src/lib/dock-slot.ts`), so a
 * popout spawned from a moved main window is already on the same screen. What
 * does need handling is a spec that sets an ABSOLUTE box; `onTestDisplay` is
 * for those. `launchSecondInstance` opens no window at all, so it is not in
 * scope here.
 *
 * NO SPEC IS EXEMPT, and that was measured rather than assumed: the audit's one
 * real candidate was `reconnect.spec.ts`, whose margin turns out to be five
 * figures on every monitor of this machine because Windows clamps a refused
 * window position to a fixed ceiling and not to the desktop's edge (the numbers
 * are in that file's header). An opt-out option existed here until that run;
 * nothing needed it, so it is not here. Re-adding one is five lines.
 */
async function moveToTestDisplay(app: ElectronApplication): Promise<Point> {
  const monitor = process.env[E2E_MONITOR_ENV];
  // The default and the CI path: not one question asked of the app.
  if (!monitor?.trim()) return NO_OFFSET;
  try {
    const info = await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const bounds = win?.getBounds() ?? null;
      return {
        displays: screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea })),
        primaryId: screen.getPrimaryDisplay().id,
        // the only window in existence this early, but identify it by id rather
        // than by index so the second evaluate cannot address a different one
        winId: win?.id ?? null,
        bounds,
        // WHERE IT ALREADY IS — see the idempotence note below
        onId: bounds ? screen.getDisplayMatching(bounds).id : null,
      };
    });
    const picked = pickTestDisplay(info.displays, info.primaryId, monitor);
    if (!picked) {
      if (!announcedDisplay) {
        announcedDisplay = true;
        console.warn(
          `[fixture] ${E2E_MONITOR_ENV}=${monitor} matched no secondary display ` +
            `(${info.displays.length} display(s); monitor 1 is the primary) — not moving anything`
        );
      }
      return NO_OFFSET;
    }
    const offset = {
      x: picked.target.workArea.x - picked.primary.workArea.x,
      y: picked.target.workArea.y - picked.primary.workArea.y,
    };
    // No window, or no bounds to reason from: nothing moved, so the offset must
    // be zero and not the display's. Reporting the real offset here would be
    // fail-CLOSED in a helper that promises the opposite — `onTestDisplay`
    // would shift every spec box a screen sideways while the window it belongs
    // to sat on the primary, and popout-geometry would fail by a display width
    // instead of degrading to today's behaviour.
    if (info.winId === null || !info.bounds) return NO_OFFSET;
    // IDEMPOTENCE, and it is load-bearing (caught by session.spec's E8-02 case
    // during this item's own gate run). The app PERSISTS window geometry, so
    // the second launch of a relaunch spec restores a window that is already on
    // the target display — translating that from the PRIMARY again shifted it
    // another screen to the right, where the clamp pulled it back to the edge
    // and left it 640px from where launch 1 had it. The popout it then restores
    // is positioned opener-relative, so it inherited the whole error and the
    // spec failed by exactly that 640. Translating from the display the window
    // is ON makes a second application a no-op, whatever the window did in
    // between.
    const from = info.displays.find((d) => d.id === info.onId)?.workArea;
    if (!from) return NO_OFFSET; // same reasoning as the branch above
    if (info.onId !== picked.target.id) {
      const box = translateToDisplay(info.bounds, from, picked.target.workArea);
      await app.evaluate(
        ({ BrowserWindow }, arg) => BrowserWindow.fromId(arg.id)?.setBounds(arg.box),
        { id: info.winId, box }
      );
    }
    if (!announcedDisplay) {
      announcedDisplay = true;
      console.log(
        `[fixture] ${E2E_MONITOR_ENV}=${monitor}: running on the display at ` +
          `${picked.target.workArea.x},${picked.target.workArea.y}`
      );
    }
    return offset;
  } catch (err) {
    console.warn(`[fixture] ${E2E_MONITOR_ENV}: could not move the window — ${String(err)}`);
    return NO_OFFSET;
  }
}

/**
 * An absolute screen box, written for the primary display, moved onto the one
 * this app is actually running on (#479).
 *
 * A spec that parks a window at `{ x: 160, y: 240 }` means "somewhere on the
 * screen this app lives on", not "160px from the primary monitor's corner" —
 * and left untranslated, the box drags the window back onto the developer's
 * working screen, which is the whole thing this switch exists to stop.
 *
 * Deliberately NOT clamped (`translateToDisplay` is): a spec's box is the
 * spec's business, and reconnect.spec's deliberately-off-desktop coordinates
 * must stay deliberately off the desktop.
 *
 * With the switch off — every CI run — the offset is `{0,0}` and this returns
 * its argument's own numbers, so the specs below are byte-identical there.
 */
export function onTestDisplay<T extends Box>(a: LaunchedApp, box: T): T {
  return { ...box, x: box.x + a.displayOffset.x, y: box.y + a.displayOffset.y };
}

/**
 * Point every path the app derives from the profile at `home`, creating the
 * two Windows profile directories the app expects to already exist.
 *
 * Extracted from `launchApp` so a SECOND process can be aimed at the same
 * userData (`launchSecondInstance`) — the single-instance lock is scoped to
 * that directory, so a spec about the lock is only testing anything if both
 * processes resolve it identically. One definition, no drift.
 */
export function applyIsolatedPaths(env: Record<string, string>, home: string): void {
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = path.join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  fs.mkdirSync(env.APPDATA, { recursive: true });
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  // Linux: Electron resolves userData via XDG, NOT $HOME — without these the
  // whole CI worker shares one real profile and state leaks across tests
  // (caught by E12's fresh-profile assertions)
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  env.XDG_CACHE_HOME = path.join(home, '.cache');
  env.XDG_DATA_HOME = path.join(home, '.local', 'share');
}

export interface SecondInstanceResult {
  /** exit code, or null if it had to be killed */
  code: number | null;
  /** how long it took to exit, ms */
  ms: number;
  /** true if it outlived the budget and was killed */
  timedOut: boolean;
  stderr: string;
}

/**
 * Launch a SECOND app process on an existing home and wait for it to exit
 * (#289). What a user does when they double-click the icon again.
 *
 * NOT `launchApp`: Playwright's `_electron.launch()` attaches a debugging
 * connection and then waits for a window, so a process that correctly refuses
 * to open one looks to it like a failed launch — a 30s timeout and an exception
 * instead of the exit code this needs to assert.
 *
 * The env is built the same way `launchApp` builds it (same isolation, same
 * landmine scrub) so both processes resolve the SAME userData. If that ever
 * drifts, the second process takes its own lock, becomes a primary, and never
 * exits — the spec fails on the budget rather than passing vacuously.
 *
 * Deliberately NOT counted in `liveApps`: this resolves only once the process
 * is gone (killed, at the latest), so it cannot be alive while a temp-dir sweep
 * runs — every caller has awaited it by then.
 */
export async function launchSecondInstance(
  home: string,
  budgetMs = 20_000
): Promise<SecondInstanceResult> {
  const env = { ...process.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE; // would run the main script as plain node — no lock, no app
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.NoDefaultCurrentDirectoryInExePath;
  delete env.SWITCHBOARD_AUTOCLOSE;
  delete env.SWITCHBOARD_TRANSPORT; // the same scrub `launchApp` does (#381)
  env.SWITCHBOARD_NO_QUIT_CONFIRM = '1';
  env.SWITCHBOARD_MUTE_AUDIO = '1'; // the same scrub `launchApp` does (P2-E14-05a)
  env.SWITCHBOARD_FAKE_PROVIDER = '1';
  applyIsolatedPaths(env, home);

  // `--no-sandbox` on Linux, because that is what every OTHER app in this suite
  // is launched with and this one has to match: Playwright unshifts the flag
  // itself for Electron on linux unless `chromiumSandbox` was asked for
  // (playwright-core 1.61.1 `lib/coreBundle.js`, in `launch()` — read in the
  // installed copy). Without it, CI's Electron aborts before it runs a line of
  // our JS: "The SUID sandbox helper binary was found, but is not configured
  // correctly", because nothing in the workflow chowns `chrome-sandbox` to
  // root. That abort is not this app refusing to start twice, but it looks
  // exactly like one from the exit code.
  const args = process.platform === 'linux' ? ['--no-sandbox', ROOT] : [ROOT];
  const started = Date.now();
  const child = spawn(electronPath(), args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (b: Buffer) => {
    stderr += b.toString();
  });
  child.stdout?.resume(); // drain: a full pipe would block the child

  return await new Promise<SecondInstanceResult>((resolve) => {
    const done = (code: number | null, timedOut: boolean): void => {
      clearTimeout(timer);
      resolve({ code, ms: Date.now() - started, timedOut, stderr });
    };
    const timer = setTimeout(() => {
      // it did not leave on its own — reap the tree so the temp home can still
      // be deleted, and let the caller assert on `timedOut`
      killTree(child.pid);
      done(null, true);
    }, budgetMs);
    child.on('exit', (code) => done(code, false));
    child.on('error', () => done(null, false)); // spawn failed; `code: null` fails the spec
  });
}

/**
 * Launch the app on an isolated home, with the PTY-only fake CLI.
 *
 * THE `[pty]` TAG (P2-E18-18, #404) — the one place it is defined.
 *
 * Unless `env.SWITCHBOARD_FAKE_PROVIDER` says otherwise, this sets it to `'1'`:
 * the terminal-only fake. Since #381 the host ASKS every session for `stream`
 * (Direct is the default transport), and that fake answers with a PTY recipe —
 * an adapter that cannot speak stream-json is honoured, so `session-manager.ts`
 * falls back. **Every session launched through here therefore runs on the PTY,
 * which is no longer the configuration most users are in.** The refusal itself
 * is pinned by `stream-transport.spec.ts` → "a PTY session still gets a real
 * terminal"
 * and by `providers/fake.test.ts`, so it cannot change meaning silently.
 *
 * Most specs do not care: a rail reorder or a palette row behaves the same on
 * either transport, and running them on the PTY is an implementation detail.
 * Some specs DO care — they assert a live `.xterm`, or they drive a subsystem
 * the stream path switches off (the hook-hold permission path,
 * `hooks/hook-listener.ts`; the transcript-derive feed, `deriveFeed:
 * record.transport !== 'stream'` in `sessions/ipc.ts`). Those cannot pass as
 * written on the app's default transport, so their green must not be read as
 * default-mode coverage.
 *
 * **Those carry a literal `[pty]` prefix in their `describe`/`test` title**, and
 * their file header carries a `TRANSPORT SCOPE` note saying what is
 * PTY-by-construction and where the Direct counterpart lives — the
 * `stream*.spec.ts` family: `stream.spec.ts` (the turn loop),
 * `stream-transport.spec.ts`, `stream-resume.spec.ts`,
 * `stream-permissions.spec.ts`, `stream-trust.spec.ts`,
 * `stream-approval.spec.ts`, `stream-attention.spec.ts`, `stream-feed.spec.ts`.
 *
 * Tag at the HIGHEST level that is wholly PTY-scoped, and only there — a
 * `describe` when every test under it is, individual tests when the group is
 * mixed, never both. So an UNtagged test in a tagged `describe` does not exist;
 * an untagged test in a file whose OTHER tests are tagged is
 * transport-independent and merely happens to run on the PTY.
 *
 * The tag is plain text in the title, not a Playwright `tag:` option, so it
 * shows up in every reporter and in failure output; `playwright test --grep
 * '\[pty\]'` (or `--grep-invert`) filters on it. Nothing in CI greps titles.
 */
export async function launchApp(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.NoDefaultCurrentDirectoryInExePath;
  // A timed self-quit inherited from the shell would kill the app mid-test for
  // reasons no failure message would ever mention. Same family as the landmines
  // above: scrub it, and let a spec that wants it pass it in `opts.env`.
  delete env.SWITCHBOARD_AUTOCLOSE;
  // Same reasoning, and newly worth having since #381 made Direct the default
  // and `SWITCHBOARD_TRANSPORT=pty` the documented way back to a terminal: a
  // developer with it exported in their shell would silently run the whole
  // suite on the other transport, and the two specs that assert the DEFAULT
  // would fail on a 30s locator timeout with nothing pointing at the cause.
  // Scrubbed here, before `opts.env`, so a spec that means it can still ask.
  delete env.SWITCHBOARD_TRANSPORT;
  // Teardown must never meet a modal (#185). Quitting with a session in
  // `working` / `needs-input` / `needs-permission` raises the busy-sessions
  // confirmation — a main-process `showMessageBoxSync`, which blocks the close
  // path with no page for Playwright to click. Nothing reached a busy status
  // before, so nothing hit it; the first spec that quits mid-work would have
  // hung the whole suite. Set on every launch, deliberately BEFORE `opts.env`
  // so the one spec that exercises the dialog can turn it back off by passing
  // `SWITCHBOARD_NO_QUIT_CONFIRM: ''` (see quit-confirm.spec.ts).
  env.SWITCHBOARD_NO_QUIT_CONFIRM = '1';
  // No spec may make a NOISE (P2-E14-05a). Per-session cues and spoken
  // announcements reach a real speaker through the renderer, and this suite
  // runs on the machine its owner is working at — a run that chimed eight
  // times and read four sentences out loud is a run nobody starts twice.
  // Muted, the sink still LOGS, so `sounds.spec.ts` proves the whole chain
  // (right rule, right card, right cue) and only the last inch is silent. Set
  // on every launch and BEFORE `opts.env`, like the two above, so a spec that
  // genuinely wants audio can still ask for it.
  env.SWITCHBOARD_MUTE_AUDIO = '1';
  // No test may talk to the real release feed (P2-E19-03). `off` disables the
  // update check entirely, so nothing in the suite makes a live call to
  // github.com or reaches for this machine's real `gh` credentials — and no
  // spec grows a surprise dialog the day a release exists. `update.spec.ts`
  // overrides this with its own local stub feed; set BEFORE `opts.env`, like
  // the quit-confirm line above, so it can.
  env.SWITCHBOARD_UPDATE_FEED = 'off';
  // Same rule for the provider status page (P2-E14-07): `off` means the poller
  // never runs, so no spec in this suite reaches status.anthropic.com and no
  // window grows a dot whose colour depends on somebody else's afternoon.
  // `service-health.spec.ts` points it at its own local stub; set BEFORE
  // `opts.env` so it can.
  env.SWITCHBOARD_STATUS_FEED = 'off';
  if (opts.realClaude) {
    // The one env var that would make "realClaude" a lie (#384). It is set in
    // the `else` branch below and never here, so nothing in this file turns the
    // fake on for a real launch — but a developer with `SWITCHBOARD_FAKE_PROVIDER`
    // exported in their shell inherits it through the `...process.env` spread
    // above, and every assertion in `real-claude.spec.ts` would then be made
    // against the fake. The fake's reply QUOTES THE PROMPT BACK, so a spec that
    // asks for a token and looks for it would still pass. Same family as the
    // `SWITCHBOARD_TRANSPORT` scrub (#381), and the same reason: a spec whose
    // whole point is which provider answered must not be decidable by the shell.
    delete env.SWITCHBOARD_FAKE_PROVIDER;
    // Claude Code SKIPS writing conversation transcripts when it detects a
    // test environment (persistence guard found via GH research 2026-07-23;
    // escape hatch below). Also scrub the Playwright worker markers it may
    // sniff — they'd leak into the hosted CLI through the app's env.
    env.TEST_ENABLE_SESSION_PERSISTENCE = '1';
    delete env.PLAYWRIGHT_TEST; // the test-detection smoking gun (env diff 2026-07-23)
    delete env.TEST_WORKER_INDEX;
    delete env.TEST_PARALLEL_INDEX;
    delete env.PLAYWRIGHT_TEST_BASE_URL;
    delete env.PWDEBUG;
    // real CLI in the isolated home: bring the credentials over (copies —
    // the temp home is deleted afterwards, the real profile is untouched)
    const realHome = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
    for (const rel of ['.claude.json', path.join('.claude', '.credentials.json')]) {
      const src = path.join(realHome, rel);
      const dst = path.join(home, rel);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        // pre-seeded homes win — lets tests supply a minimal config
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
  } else {
    env.SWITCHBOARD_FAKE_PROVIDER = '1';
  }
  applyIsolatedPaths(env, home);
  if (opts.seedFolder) env.SWITCHBOARD_SEED_SESSION = opts.seedFolder;
  if (opts.seedDocument) env.SWITCHBOARD_SEED_DOCUMENT = opts.seedDocument;
  Object.assign(env, opts.env);

  let app: ElectronApplication;
  let window: Page;
  // The same handle as the CATCH sees it — where it is honestly optional,
  // because the throw may have come from `launch()` itself.
  let launched: ElectronApplication | undefined;
  // Captured HERE, the instant `launch()` returns, and NOT inside `close()`.
  // `app.process()` throws ("Cannot read properties of undefined") once
  // Playwright has torn its connection down, so reading it during teardown
  // breaks any spec that closed the app itself — e.g. one timing the close to
  // prove a modal is not blocking it (#185), whose afterEach then died on the
  // way to deleting the home. Reading it eagerly also keeps the tree kill
  // working in exactly that case, which a try/catch around the late read would
  // have given up on — and it is what lets the FAILURE path below kill a
  // half-started Electron at all (#230): by the time `firstWindow()` has
  // rejected, `app.process()` is exactly the thing that may no longer answer.
  let pid: number | undefined;
  try {
    launched = await electron.launch({
      executablePath: electronPath(),
      args: [ROOT],
      cwd: ROOT,
      env,
    });
    app = launched;
    pid = app.process()?.pid;
    window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
  } catch (err) {
    // #230: reap the half-started Electron before anything else in here.
    //
    // `electron.launch()` can succeed and `firstWindow()` still time out — a
    // main process that came up far enough for Playwright to attach and then
    // never opened a window. Nothing used to kill that process: no handle was
    // returned, so no `close()`/`cleanup()` ever ran for it, and it outlived the
    // whole suite holding its temp home open (one source of the un-deletable
    // `sb-e2e-` orphans #213 counted).
    //
    // THE HAMMER GOES FIRST, unlike `close()`. Two reasons, both specific to
    // failing here: an `await` on this path can be ABANDONED — a launch that
    // throws usually fails the test, Playwright restarts the worker, and a
    // teardown parked in `app.close()` when that happens never reaches the kill,
    // in exactly the wedged-main-process case that burns the whole budget. And
    // killing promptly keeps the pid-recycle window (`fixtures/stream-session.ts`)
    // short
    // rather than waiting out a graceful close that may already have reaped it.
    // Killing before the `rmSync` below is also what lets that removal succeed
    // on Windows, where the live process holds the folder open.
    //
    // The graceful half still runs, and is not redundant: it is the ONLY reaper
    // when `app.process()` gave us no pid, and it lets Playwright drop its own
    // driver-side registration rather than discover the death. A launch that
    // failed inside `electron.launch()` itself leaves neither handle nor pid —
    // Playwright reaps that one, it owns the spawn.
    killTree(pid);
    if (launched) await gracefulClose(launched, 5_000);
    // launch failed BEFORE a handle was returned — afterEach cleanup() never
    // runs, so scrub here or the copied real credentials outlive the test on
    // disk (review P1-test #17; credentials-never-in-files rule). While the
    // app runs, the copy is a deliberate, documented exception: cleanup()
    // deletes the whole home afterwards.
    if (opts.realClaude) {
      for (const rel of ['.claude.json', path.join('.claude', '.credentials.json')]) {
        try {
          fs.rmSync(path.join(home, rel), { force: true });
        } catch {
          /* best-effort */
        }
      }
    }
    if (!opts.home) {
      // the temp home is ours — remove it wholesale, and put it on the pending
      // list first so a half-started Electron still holding it is retried by
      // the next cleanup() rather than leaked (#213)
      registerTempDir(home);
      try {
        fs.rmSync(home, { recursive: true, force: true });
        pendingDirs.delete(home);
      } catch {
        /* best-effort — stays pending */
      }
    }
    throw err;
  }

  // Off the working screen, if this developer asked for that (#479). After the
  // launch try/catch and never inside it: this cannot throw (it swallows its
  // own failures), so it must not be able to route a launch into the reaping
  // path either.
  const displayOffset = await moveToTestDisplay(app);

  liveApps++;
  let counted = true; // close() is called twice by any spec that also cleans up

  const close = async () => {
    // app.close() can hang if the process (or a popout child) is slow to exit;
    // race it with a timeout so one slow teardown never stalls the worker.
    await gracefulClose(app, 12_000);
    // Always reap the whole tree afterwards: a popped-out window and node-pty
    // children can outlive app.close() and hold the Playwright worker open.
    killTree(pid);
    if (counted) {
      counted = false;
      liveApps--;
    }
  };

  return {
    app,
    window,
    home,
    displayOffset,
    close,
    cleanup: async () => {
      try {
        await close();
      } finally {
        // Registered HERE and not at launch: `close()` deliberately keeps the
        // home (relaunch/persistence specs reuse it), and a home on the pending
        // list could be swept between the two launches. `cleanup()` is the call
        // that means "done with this home" — the same moment the old `rmSync`
        // fired. Deleted with retries and requeued if Windows still holds it,
        // which the old one did neither of (#213).
        registerTempDir(home);
        await sweepTempDirs();
      }
    },
  };
}

/**
 * Replace a text box's contents the way a user does: select all, then type.
 *
 * NOT `fill('')` followed by typing. MEASURED on this app's composer (#145), by
 * reading React's own fiber next to the DOM value:
 *
 *   box.fill('')                  -> react="/compact "  dom=""   (still diverged
 *                                    after a 500ms settle — not a flush race)
 *   box.fill('some prompt text')  -> react="some prompt text" dom=same
 *
 * So an EMPTY fill leaves the component's state stale indefinitely, while a
 * non-empty one does not — which is why the suite's other `fill(...)` call sites
 * are fine and only CLEARING has to be keystrokes.
 *
 * The internal reason is NOT pinned down, and the obvious story is wrong: for a
 * textarea, Playwright's `fill` does not assign `.value` at all (it selects the
 * text and then issues `insertText`, or `press('Delete')` when the value is
 * empty), so "React's value tracker swallowed a property assignment" does not
 * explain it. Recorded as behaviour, not as theory.
 *
 * What it costs is a window in which the component's idea of the draft is stale
 * while the box looks empty. The next keystroke heals it — so the pattern
 * usually works, and therefore usually hides — but anything that re-renders or
 * restores the controlled value first puts the old text back, with the caret
 * after it, so the "replacement" is appended to the old draft instead. Typing
 * over a selection never opens that window.
 */
export async function retype(box: Locator, text: string): Promise<void> {
  await box.press('ControlOrMeta+a');
  await box.pressSequentially(text);
}

/**
 * Tab out of the focused conversation region and land on the composer — past
 * the ONE control that is allowed to sit between them (#524).
 *
 * WHY THIS EXISTS. `#174` says the conversation is a single tab stop and the
 * composer is the next one, so a long transcript can never bury it. `#442` then
 * put the "↓ Jump to latest" control in exactly that gap, on purpose:
 * `FeedView.tsx` — "the conversation is one tab stop and the composer is the
 * next; a control between them is reached with one Tab from the feed and one
 * Shift+Tab from the composer". It renders only while the feed is unpinned AND
 * overflowing, so whether it is in the tab order is a function of the WINDOW
 * SIZE — and the #174 walks were written before it existed.
 *
 * That is the whole of #524, measured in this worktree on 2026-08-15:
 *
 *   * window 1024x686 (the windows-latest desktop, 1024x768 less its taskbar —
 *     the geometry `feed-tail-pin.spec.ts` states to the pixel): the `!tools`
 *     turn is 337px in a 254px feed, the walk's `Home` leaves it off-tail, the
 *     control renders, and the final Tab lands on it. `toBeFocused()` on the
 *     composer then reports the CI failure verbatim — "Received: inactive".
 *   * the same walk at 1024x768 (feed 336px, nothing overflows): no control, no
 *     extra stop, green. Which is why one machine saw it and the other did not.
 *
 * So the walk has to know which order it is in. It does NOT get to relax the
 * destination: callers still assert `toBeFocused()` on the composer themselves,
 * and anything other than the jump control landing in the gap throws here
 * rather than being tabbed past — a NEW stop between the conversation and the
 * composer is the #174 regression this helper must never hide.
 *
 * NOT A WINDOW-ACTIVATION GUARD, and #524 was dispatched as one — the reading
 * being that "inactive" meant the runner had stolen OS focus. It cannot mean
 * that: Playwright sends `Emulation.setFocusEmulationEnabled` to every main
 * frame it attaches to, including Electron's (it only skips it for
 * `connectOverCDP({ noDefaults })`, which `electron.launch()` does not use), so
 * `document.hasFocus()` — the second half of its `toBeFocused` — is pinned true
 * whatever the desktop is doing. Measured the same day: with the window
 * MINIMIZED, `BrowserWindow.isFocused()` is false and `document.hasFocus()` is
 * still true. Re-activating the window before a focus assertion would therefore
 * be dead code; please do not add it back.
 *
 * @returns which order this run was in — for a caller that wants to say so.
 */
export async function tabFromFeedToComposer(w: Page): Promise<'direct' | 'past-jump'> {
  await w.keyboard.press('Tab');
  const landed = await w.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el?.hasAttribute('data-feed-jump-latest')) return 'jump';
    if (el instanceof HTMLTextAreaElement && /Prompt this session/.test(el.placeholder))
      return 'composer';
    return `${el?.tagName ?? 'NONE'} "${(el?.textContent ?? '').trim().slice(0, 40)}"`;
  });
  if (landed === 'composer') return 'direct';
  if (landed !== 'jump')
    throw new Error(
      `Tab out of the conversation region landed on ${landed} — expected the composer, or ` +
        `#442's "↓ Jump to latest" control and then the composer. A new tab stop between the ` +
        `conversation and the composer is the #174 regression this helper exists NOT to hide.`
    );
  await w.keyboard.press('Tab');
  return 'past-jump';
}

/**
 * How many popped-out groups the app would PERSIST right now.
 *
 * Not the same thing as `app.windows().length`, and a test that quits without
 * settling needs this one. A popout's OS window exists the moment `window.open`
 * returns, but dockview only appends the group to the serialized layout once the
 * child window has finished LOADING — and the main process's quit-time geometry
 * flush can only PATCH popout entries the renderer already sent it, never invent
 * one. Quit in between and a layout with no popout in it is what gets saved, so
 * the window never comes back.
 *
 * MEASURED (#165): the gap is small. Polling this straight after the window
 * count reached 2 found it already registered in 10/10 runs, including 8 with
 * every core saturated, so this closes a real hole but is NOT known to be the
 * cause of that issue's flake. Waiting on the durable thing instead of the
 * visible one is right regardless of which race bites.
 *
 * Reads main's own copy over IPC (`workspace:getLayout`), i.e. exactly the
 * object that would be written to disk — not the file, which the store debounces
 * by 500 ms and would make this poll answer "not yet" for reasons that have
 * nothing to do with registration.
 */
export async function registeredPopouts(a: LaunchedApp): Promise<number> {
  const layout = (await a.window.evaluate(() => window.switchboard.workspace.getLayout())) as {
    popoutGroups?: unknown;
  } | null;
  return Array.isArray(layout?.popoutGroups) ? layout.popoutGroups.length : 0;
}

/**
 * Raw session statuses as MAIN holds them, keyed by card title.
 *
 * Not interchangeable with what the DOM shows. The presentation layer folds
 * `starting` into the same `working` ramp the urgency lamp and the rail rows
 * paint, so `data-status="working"` cannot tell "about to start" from
 * "mid-task" — and only the second is in the busy set the quit confirmation
 * asks about (#185). This reads `sessions.list()`: the same record list
 * main's own `busySessions()` filters.
 */
export async function sessionStatuses(a: LaunchedApp): Promise<Map<string, string>> {
  const records = (await a.window.evaluate(() => window.switchboard.sessions.list())) as Array<{
    identity: { title: string };
    status: string;
  }>;
  return new Map(records.map((r) => [r.identity.title, r.status]));
}

/**
 * Put the app AWAY — no window of ours focused — and PROVE it stuck (#538).
 *
 * Every `WHEN_AWAY` rule (the toast, the voice, push) is gated on the user not
 * looking at us, so five specs opened with a bare
 * `BrowserWindow.getAllWindows()[0].blur()` and then waited for `isFocused()`
 * to go false. That is a fire-and-forget command with a passive wait behind it,
 * and on Windows the command can simply not take: deactivating a window means
 * handing the foreground to the next window in the Z-order, and when that
 * neighbour is itself mid-destruction — routine on a machine running several
 * Electron suites at once — the request is dropped. Nothing re-sent it, so the
 * spec then sat out its whole timeout waiting for a state change that had
 * already been lost.
 *
 * MEASURED (#538, under ~4x load): the blur normally lands in **1-5 ms**, and
 * in the one repeat that failed it never landed at all — `isFocused()` was
 * still true 15 s later. So the failure is a DROPPED command, not a slow one,
 * which is exactly why this re-issues the blur on every attempt instead of
 * waiting longer. A longer timeout cannot deliver a message nobody re-sent.
 *
 * EVERY window, not `[0]`: the rules ask `visibilityAcross(...)`, so a single
 * focused popout is enough to keep the whole app "in front of the user" and
 * hold every away-rule back.
 *
 * Throws — with the state it could not reach — rather than returning a boolean:
 * a spec that carried on from here would go on to prove its rule fired for a
 * reason it did not have.
 */
export async function blurApp(a: LaunchedApp, timeoutMs = 15_000): Promise<void> {
  await pollAsync(
    async () => {
      const stillFocused = await a.app.evaluate(({ BrowserWindow }) => {
        const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
        for (const w of wins) w.blur();
        return wins.filter((w) => w.isFocused()).length;
      });
      return stillFocused === 0 ? true : null;
    },
    `the app never went away: a window still reports isFocused() after repeatedly asking every window to blur (${timeoutMs}ms)`,
    timeoutMs
  );
}

/**
 * Skip a test that needs a REAL second OS window (#462, hoisted).
 *
 * dockview's pop-out is `window.open` -> a second BrowserWindow, which is
 * reliable on Windows and macOS and flaky under the headless xvfb display Linux
 * CI runs: second-window creation intermittently never completes (the E8 specs
 * carried this skip from the day they were written). Coverage is preserved on
 * the two platforms where multi-window works — including Windows, Dan's primary
 * target.
 *
 * Lived as FOUR copy-pasted local helpers (`session`, `urgency`, `diff`,
 * `document-peek`) with three different skip messages, so a CI report could not
 * be searched for one of them. One place, one wording; each spec imports it.
 */
export function skipPopoutOnLinux(): void {
  test.skip(
    process.platform === 'linux',
    'dockview popout opens a 2nd OS window — unreliable under headless xvfb; covered on Windows + macOS'
  );
}

/** Switch to the Terminal tab (always present, last — 2026-07-22). */
export async function showTerminal(window: Page): Promise<void> {
  await window.getByRole('tab', { name: 'Terminal' }).click();
}

/**
 * Open the events drawer (P2-E14-01, Shape B).
 *
 * The Events panel is no longer a permanent column: it is a drawer, collapsed
 * by default to a tab on the workspace's right edge. So every spec that asserts
 * anything about the queue's ROWS has to open it first — and, importantly, has
 * to keep doing so for the assertions that count rows DOWN. `toHaveCount(0)`
 * against a shut drawer passes for the wrong reason: there is nothing in the
 * DOM to count, whatever the feed thinks.
 *
 * Idempotent, because several specs open it inside a helper that a test may
 * have already called. Clicking a second time would shut it again.
 */
/**
 * "The turn completed" — the state machine reporting a `result` message off the
 * stream, i.e. the CLI closed the turn rather than the text merely arriving.
 *
 * This used to be read as the word **"Done."** on the Events panel's row, in
 * both the fake-stream specs and the real-CLI lane. The word is still there,
 * but the panel is a drawer now and shut by default (P2-E14-01), so a page-text
 * match for it fails in the positive case and passes vacuously in the negative
 * one. The same fact is on the collapsed tab, which is always on screen: a
 * `done` event is the only thing a one-session turn queues, so it is both the
 * whole count and the hottest kind.
 *
 * Opening the drawer instead would be worse — these tests go on to type into
 * the composer, and the drawer overlays the workspace.
 *
 * Shared out of `stream.spec.ts` rather than copied because the copy is exactly
 * what went wrong: `real-claude.spec.ts` is opt-in behind `SWITCHBOARD_REAL_E2E`
 * and its two assertions were missed by the first sweep, so nothing caught them.
 */
export async function expectTurnCompleted(window: Page, timeout = 30_000): Promise<void> {
  const tab = window.getByTestId('events-tab');
  await expect(tab).toHaveAttribute('data-count', '1', { timeout });
  await expect(tab).toHaveAttribute('data-hottest', 'done');
}

/** ...and its negative: nothing has been queued at all, so no turn has ended */
export async function expectTurnStillRunning(window: Page): Promise<void> {
  await expect(window.getByTestId('events-tab')).toHaveAttribute('data-count', '0');
}

export async function openEventsDrawer(window: Page): Promise<void> {
  const tab = window.getByTestId('events-tab');
  await tab.waitFor({ state: 'visible', timeout: 25_000 });
  if ((await tab.getAttribute('aria-expanded')) !== 'true') await tab.click();
  await window.getByTestId('events-drawer').waitFor({ state: 'visible', timeout: 15_000 });
}

/**
 * Set §5.8's global presentation policy from the titlebar chip (P2-E9-06).
 *
 * The chip CYCLES, so this walks it to the label rather than guessing a click
 * count — which also means it keeps working if the default or the order changes.
 *
 * The DEFAULT is `always-visible` (decision 2026-08-04): submitting a prompt
 * moves nothing, so a spec that submits and then keeps looking at the card needs
 * no setup at all. Opting IN to auto-collapse / auto-hide is what needs a click,
 * and `presentation-policy.spec.ts` is where those are asserted.
 */
export async function setPresentationPolicy(window: Page, label: string): Promise<void> {
  const chip = window.getByTestId('presentation-policy');
  for (let i = 0; i < 4; i++) {
    if ((await chip.innerText()).includes(label)) return;
    await chip.click();
  }
  throw new Error(`the presentation-policy chip never reached "${label}"`);
}

/**
 * The workspace store inside a launched app's isolated home.
 *
 * Electron puts userData somewhere different on each OS, and hard-coding the
 * Windows path is a real trap: it does not throw until a spec that reads the
 * file runs on Linux, and the specs that read it were all Windows-only until
 * `split.spec.ts` (which cost one red CI job to learn). One definition here.
 */
export function workspaceJsonPath(home: string): string {
  const base =
    process.platform === 'win32'
      ? path.join(home, 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : path.join(home, '.config');
  return path.join(base, 'switchboard', 'workspace.json');
}

/* ---- the workspace file, as the specs read it ------------------------------
 *
 * Main treats `layout` and `ui` as OPAQUE blobs — literally `unknown` in
 * `workspace/store.ts`, because they belong to the renderer and main only
 * round-trips them. So there is no shared type to import, and these interfaces
 * are the SPECS' own view of the bytes on disk. That is the right place for
 * them: asserting that shape from the outside is what these tests are for.
 *
 * They are structural SUBSETS on purpose — every field a spec has ever reached
 * for, and nothing else. A field that appears in the file but not here is not a
 * bug; a field here that the app stops writing breaks a spec, which is the
 * point.
 *
 * Why they exist at all: `JSON.parse` returns `any`, and #245 put `e2e/` on the
 * type-checked eslint preset, where an `any` spreading through a spec is an
 * error. It has to stop somewhere. It stops HERE, in one assertion, instead of
 * in the six specs that used to each re-describe a corner of this file inline.
 */

/** A serialized dockview grid node — children on a branch, panels on a leaf. */
export type PersistedGridNode = PersistedGridBranch | PersistedGridLeaf;

export interface PersistedGridBranch {
  type: 'branch';
  size?: number;
  data: PersistedGridNode[];
}

export interface PersistedGridLeaf {
  type: 'leaf';
  size?: number;
  data: { views: string[]; activeView?: string; id?: string };
}

export interface PersistedLayout {
  /** dockview wraps even a single panel, so the ROOT is always a branch */
  grid: { width: number; height?: number; orientation?: string; root: PersistedGridBranch };
  popoutGroups?: PersistedPopoutGroup[];
  /**
   * Panel records by id, each with the `params` blob `addPanel` was given.
   *
   * Reached for by specs that need to doctor a saved panel's params into a
   * shape THIS version of the app would never write — `document-peek.spec`
   * plants a `pinned: true` on a viewer, which is what a layout saved before
   * #530 looks like. `params` is deliberately open (`unknown` values): the
   * whole point of these tests is fields the current code does not have.
   */
  panels?: Record<string, { id?: string; params?: Record<string, unknown> }>;
}

export interface PersistedPopoutGroup {
  position?: { left: number; top: number; width?: number; height?: number } | null;
}

export interface PersistedUi {
  layoutMode?: { mode?: string };
  presentation?: Record<string, { ladder?: string }>;
  presentationPolicy?: { global?: string; cards?: Record<string, string> };
  /** §5.8's focus-stealing policy (P2-E9-10) — global + per-session overrides */
  focusPolicy?: { global?: string; cards?: Record<string, string> };
}

/**
 * The whole file. `layout`/`ui` sit at the top level; `state` is the older
 * nesting, and the specs have always tolerated both by writing `x ?? state?.x`.
 */
export interface PersistedWorkspaceFile {
  layout?: PersistedLayout;
  ui?: PersistedUi;
  state?: { layout?: PersistedLayout; ui?: PersistedUi };
  /** the cards; `nativeSessionId` is the `--resume` identity #404 pins */
  sessions?: Array<{ id?: string; nativeSessionId?: string; transport?: string }>;
}

/** The workspace file for a launched app's home, parsed. */
export function readWorkspaceFile(home: string): PersistedWorkspaceFile {
  return JSON.parse(fs.readFileSync(workspaceJsonPath(home), 'utf8')) as PersistedWorkspaceFile;
}

/** Write a (usually doctored) workspace file back, for the relaunch to read. */
export function writeWorkspaceFile(home: string, ws: PersistedWorkspaceFile): void {
  fs.writeFileSync(workspaceJsonPath(home), JSON.stringify(ws));
}

/**
 * The persisted layout, from whichever nesting this file uses.
 *
 * Throws when there is none, which is what the callers already did one line
 * later — `json.layout ?? json.state.layout` then `.grid` gave a TypeError, so
 * this only changes the message, never whether the test passes.
 */
export function persistedLayout(ws: PersistedWorkspaceFile): PersistedLayout {
  const layout = ws.layout ?? ws.state?.layout;
  if (!layout) throw new Error('the workspace file has no layout');
  return layout;
}

/** The persisted UI blob, from whichever nesting this file uses. See above. */
export function persistedUi(ws: PersistedWorkspaceFile): PersistedUi {
  const ui = ws.ui ?? ws.state?.ui;
  if (!ui) throw new Error('the workspace file has no ui blob');
  return ui;
}

/**
 * The panel ids a serialized grid LEAF holds.
 *
 * The node is a discriminated union — `data` is child nodes on a branch and the
 * panel record on a leaf — so `node.data.views` does not typecheck on an
 * arbitrary node. Untyped, the specs read it anyway and got `undefined` (then a
 * TypeError on the next line) whenever the tree was not the shape assumed.
 */
export function gridLeafViews(node: PersistedGridNode): string[] {
  if (node.type !== 'leaf') throw new Error(`expected a grid leaf, got a ${node.type}`);
  return node.data.views;
}

/**
 * A throwaway folder to point a session at (git-repo optional).
 *
 * Registered for deletion as of #213 — the next `cleanup()` removes it, and
 * every spec that uses this calls `cleanup()` in its `afterEach`. Same
 * signature, same return value: the ~127 call sites need no change.
 *
 * ONE constraint that came with that: call it inside a TEST (or a `beforeEach`),
 * never in `beforeAll` or at module scope. A folder made once and shared by a
 * whole file would be swept by the FIRST test's `cleanup()` and be missing for
 * the second. No spec does this today; a spec that wants a shared fixture
 * directory should make its own and not register it.
 */
export function tempProjectFolder(): string {
  const dir = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-proj-')));
  fs.writeFileSync(path.join(dir, 'README.md'), '# e2e\n');
  return dir;
}

/* ---- driving a DIRECT (stream) session -------------------------------------
 *
 * The stream twin of `hookPoster` below, and it exists for the same reason:
 * a spec needs a session in a particular state, and the honest way to get one
 * is to make the CLI produce it rather than to fake the signal.
 *
 * `hookPoster` cannot serve on this transport. A Direct session's permissions
 * ride `can_use_tool` on the control channel, and its permission-classified
 * hook `Notification` is deliberately DROPPED (#313) — so the POST that puts a
 * PTY session into `needs-permission` does nothing at all here. The stimulus
 * that works is a PROMPT: `!perm`, `!tools`, `!bulk` and friends are scripted
 * into the fake CLI (`providers/fake-stream-protocol.ts`), and everything after
 * the prompt is the shipped article.
 */

/** What `launchDirectToolTurn` hands back. The caller owns all three. */
export interface DirectToolTurn {
  /** the launched app, with one seeded Direct session that has run `!tools` */
  app: LaunchedApp;
  /** the project folder — deliberately NOT registered with the sweep yet */
  folder: string;
  /** `path.basename(folder)`, which is the seeded card's title */
  title: string;
}

/**
 * Launch a Direct session and drive a turn of tool calls through it.
 *
 * The setup dance a Direct-lane spec opens with, extracted from the two copies
 * that had it (`stream-feed.spec.ts`, `find.spec.ts`) before a third arrived
 * (#497). Four parts, each of which is load-bearing:
 *
 * 1. **`mkdtemp`, NOT `tempProjectFolder()`** — that one REGISTERS the folder
 *    with the sweep, and a registered folder is deleted by the first
 *    `cleanup()`. For the `serial` groups that share one app across several
 *    tests, that pulls the ground out from under every test after the first.
 *    The caller registers it in `afterAll` instead, the moment it is safe to
 *    sweep — see the closing move below.
 * 2. **No `SWITCHBOARD_TRANSPORT` anywhere** — Direct is the default since
 *    #381, and a spec about the default must not name it.
 *    `SWITCHBOARD_FAKE_PROVIDER: 'stream'` asks for the dual-capable fake and
 *    nothing else.
 * 3. **The Terminal-tab probe** — it really IS Direct. Without it a group could
 *    quietly become a second transcript test that happens to pass.
 * 4. **The `!tools` turn** — real tool calls in the shape the CLI emits them
 *    (`providers/fake-stream-protocol.ts`), and the fake writes the same turn
 *    to a JSONL transcript as the real CLI does in stream mode (S-10). Those
 *    are the two sides anything joining stream to file has to line up.
 *
 * `prefix` is the `mkdtemp` prefix, so name it after the spec: it is what
 * identifies a temp folder that outlived a crashed run.
 *
 * Raises the CALLING hook's timeout to 120s — launching an app and driving a
 * tool turn is most of the runtime of any spec that starts here, and every
 * caller wanted it. Call it first in the hook; a caller that wants a different
 * budget can set its own afterwards.
 *
 * The closing move belongs to the caller, and is exactly:
 *
 * ```ts
 * test.afterAll(async () => {
 *   if (folder) registerTempDir(folder);  // safe to sweep only now
 *   await a?.cleanup();                   // closes the app first, then sweeps
 * });
 * ```
 *
 * …with one exception this function handles itself: if the launch or any probe
 * THROWS, nothing is assigned, so there is no app handle for that `afterAll` to
 * close — and a leaked one wedges `liveApps` above zero, which makes every
 * later sweep in the worker silently no-op. So the failure path does the same
 * two calls here and rethrows. The guards in the caller are for that path: the
 * `afterAll` still runs, with both bindings unset.
 */
export async function launchDirectToolTurn(prefix: string): Promise<DirectToolTurn> {
  test.setTimeout(120_000);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(folder, 'README.md'), '# e2e\n');
  const title = path.basename(folder);
  const app = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
  try {
    const w = app.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // it really is Direct — see (3) above
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });
    await w.getByRole('tab', { name: 'Session', exact: true }).first().click();

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!tools');
    await box.press('Enter');
    await expect(w.locator('[data-feed-box="bash"]')).toBeVisible({ timeout: 30_000 });
  } catch (err) {
    registerTempDir(folder);
    await app.cleanup();
    throw err;
  }
  return { app, folder, title };
}

/**
 * Submit a prompt to a card BY TITLE, on that card's own transport (P2-E18-14).
 *
 * The SAME IPC the composer uses (`sessions:submitPrompt`), not a test-only
 * channel — so everything from the CLI's stdin onwards is what a user typing
 * into the box drives. The one thing it skips is what the composer does BEFORE
 * that call: §5.8's auto-minimize (`renderer/src/lib/composer.ts`). Deliberate,
 * and it is the point — a spec about a session you are not looking at must not
 * rearrange the screen on the way in.
 *
 * Why it exists rather than typing into the composer: the composer belongs to
 * the card dockview currently has MOUNTED, and half the behaviours worth
 * testing are about a session you are NOT looking at (a hidden card raising the
 * lamp, a focus policy that must not steal the screen, a second session joining
 * a grouped prompt). Typing is still the right stimulus where the card is on
 * screen, and the specs use it there.
 *
 * The live id is resolved per CALL, not snapshotted: a restart mints a new one,
 * and a prompter that had cached the old one would submit into a corpse and
 * report success (`submitPrompt` answers false for an unknown session — hence
 * the throw, which turns that into a named failure instead of a locator
 * timeout thirty seconds later).
 */
export function streamPrompter(
  a: LaunchedApp
): (title: string, text: string) => Promise<void> {
  return async (title, text) => {
    const liveId = await pollAsync(async () => {
      const cards = (await a.window.evaluate(() => window.switchboard.sessions.cards())) as Array<{
        title: string;
        liveId?: string;
      }>;
      return cards.find((c) => c.title === title)?.liveId ?? null;
    }, `no live session for card "${title}"`);
    const accepted = await a.window.evaluate(
      ([id, t]) => window.switchboard.sessions.submitPrompt(id, t),
      [liveId, text]
    );
    if (!accepted) {
      throw new Error(
        `submitPrompt was refused for "${title}" — a PTY session has no typed-message ` +
          `transport, so this card is not in Direct mode`
      );
    }
  };
}

/** `poll`, for a check that has to await something. */
export async function pollAsync<T>(
  fn: () => Promise<T | null>,
  what = 'poll timed out',
  timeoutMs = 25_000
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(what);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/* ---- driving the REAL hook listener ---------------------------------------
 * Specs that need a session in a particular attention state play the CLI's
 * part: POST the hook event the CLI would have sent, with that session's own
 * token. Nothing is mocked between the state machine and the UI. */

export function findFile(root: string, name: string, depth = 6): string | null {
  if (depth < 0) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) {
      const hit = findFile(full, name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** every session's token file, keyed by the session id its directory is named for */
export function findTokens(root: string, depth = 6): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, left: number): void => {
    if (left < 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === 'hook-token') {
        out.set(path.basename(dir), fs.readFileSync(full, 'utf8').trim());
      } else if (e.isDirectory()) {
        walk(full, left - 1);
      }
    }
  };
  walk(root, depth);
  return out;
}

/**
 * Retry a SYNCHRONOUS check until it answers truthily. `pollAsync`'s twin, and
 * implemented in terms of it rather than beside it: two ten-line copies of the
 * same loop in one file is how the argument orders drift apart, and a caller
 * who passed the timeout to the wrong parameter would get a 25-second wait with
 * a nonsense message instead of a type error.
 */
export async function poll<T>(fn: () => T | null, timeoutMs = 25_000): Promise<T> {
  return pollAsync(() => Promise.resolve(fn()), 'poll timed out', timeoutMs);
}

/**
 * A poster that sends hook events to a card BY TITLE. Waits for the listener
 * to come up and for `expectSessions` tokens to appear, then resolves the
 * live-session-id -> card-title mapping the same way the Events panel does.
 */
export async function hookPoster(
  a: LaunchedApp,
  expectSessions = 1
): Promise<(title: string, body: Record<string, unknown>) => Promise<string>> {
  const logFile = await poll(() => {
    const f = findFile(a.home, 'switchboard.log');
    return f && fs.readFileSync(f, 'utf8').includes('hook listener up') ? f : null;
  });
  // The LAST listener, not the first. The log is appended to across launches
  // and a spec that relaunches into the same home (twoGroups, every persistence
  // test) leaves a dead port at the top of the file — posting to it fails with
  // ECONNREFUSED and looks like a product bug rather than a stale read.
  const ports = [...fs.readFileSync(logFile, 'utf8').matchAll(/"msg":"hook listener up".*?"port":(\d+)/g)];
  const port = Number(ports[ports.length - 1][1]);
  const tokens = await poll(() => {
    const t = findTokens(a.home);
    return t.size >= expectSessions ? t : null;
  });
  const cards = (await a.window.evaluate(() => window.switchboard.sessions.cards())) as Array<{
    title: string;
    liveId?: string;
  }>;
  const titleFor = new Map<string, string>();
  for (const c of cards) if (c.liveId) titleFor.set(c.liveId, c.title);

  return async (title, body) => {
    const sid = [...tokens.keys()].find((k) => titleFor.get(k) === title);
    if (!sid) throw new Error(`no live session for card "${title}"`);
    const r = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-switchboard-token': tokens.get(sid)! },
      body: JSON.stringify(body),
    });
    return r.text();
  };
}
