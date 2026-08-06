// Launch the built Electron app under Playwright, fully isolated: a temp HOME
// so it never touches the real ~/.claude.json or workspace, the fake provider
// (shell-in-a-PTY, no claude login), and the S-01 env landmines scrubbed.
import { _electron as electron, ElectronApplication, Locator, Page } from '@playwright/test';
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
  /** close the app but KEEP the home (for relaunch/persistence tests) */
  close: () => Promise<void>;
  /** close the app AND delete the home */
  cleanup: () => Promise<void>;
}

export interface LaunchOptions {
  /** auto-create one fake session in this folder at boot */
  seedFolder?: string;
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
  env.SWITCHBOARD_NO_QUIT_CONFIRM = '1';
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
  // Teardown must never meet a modal (#185). Quitting with a session in
  // `working` / `needs-input` / `needs-permission` raises the busy-sessions
  // confirmation — a main-process `showMessageBoxSync`, which blocks the close
  // path with no page for Playwright to click. Nothing reached a busy status
  // before, so nothing hit it; the first spec that quits mid-work would have
  // hung the whole suite. Set on every launch, deliberately BEFORE `opts.env`
  // so the one spec that exercises the dialog can turn it back off by passing
  // `SWITCHBOARD_NO_QUIT_CONFIRM: ''` (see quit-confirm.spec.ts).
  env.SWITCHBOARD_NO_QUIT_CONFIRM = '1';
  // No test may talk to the real release feed (P2-E19-03). `off` disables the
  // update check entirely, so nothing in the suite makes a live call to
  // github.com or reaches for this machine's real `gh` credentials — and no
  // spec grows a surprise dialog the day a release exists. `update.spec.ts`
  // overrides this with its own local stub feed; set BEFORE `opts.env`, like
  // the quit-confirm line above, so it can.
  env.SWITCHBOARD_UPDATE_FEED = 'off';
  if (opts.realClaude) {
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
    // killing promptly keeps the pid-recycle window (`stream.spec.ts`) short
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

/** Switch to the Terminal tab (always present, last — 2026-07-22). */
export async function showTerminal(window: Page): Promise<void> {
  await window.getByRole('tab', { name: 'Terminal' }).click();
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

export async function poll<T>(fn: () => T | null, timeoutMs = 25_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('poll timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
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
