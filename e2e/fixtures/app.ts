// Launch the built Electron app under Playwright, fully isolated: a temp HOME
// so it never touches the real ~/.claude.json or workspace, the fake provider
// (shell-in-a-PTY, no claude login), and the S-01 env landmines scrubbed.
import { _electron as electron, ElectronApplication, Locator, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync, spawnSync } from 'child_process';

// Kill an entire process tree. A popped-out Electron window is a child process
// and node-pty spawns its own children; app.process().kill() only reaps the
// main pid, leaving grandchildren that keep the Playwright worker alive (the
// "Worker teardown timeout" seen on CI). Take out the whole tree.
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      spawnSync('kill', ['-9', String(pid)], { stdio: 'ignore' });
    }
  } catch {
    /* already gone */
  }
}

// electron's main export is the path to its binary when require()d in Node
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as string;

const ROOT = path.resolve(__dirname, '..', '..');

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

export async function launchApp(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });

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
  // isolate every path the app derives from the profile
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = appData;
  env.LOCALAPPDATA = localAppData;
  // Linux: Electron resolves userData via XDG, NOT $HOME — without these the
  // whole CI worker shares one real profile and state leaks across tests
  // (caught by E12's fresh-profile assertions)
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  env.XDG_CACHE_HOME = path.join(home, '.cache');
  env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  if (opts.seedFolder) env.SWITCHBOARD_SEED_SESSION = opts.seedFolder;
  Object.assign(env, opts.env);

  let app: ElectronApplication;
  let window: Page;
  try {
    app = await electron.launch({ executablePath: electronPath, args: [ROOT], cwd: ROOT, env });
    window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
  } catch (err) {
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
      // the temp home is ours — remove it wholesale
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    throw err;
  }

  // Captured HERE, at launch, not inside close(). `app.process()` throws
  // ("Cannot read properties of undefined") once Playwright has torn its
  // connection down, so reading it during teardown breaks any spec that closed
  // the app itself — e.g. one timing the close to prove a modal is not blocking
  // it (#185), whose afterEach then died on the way to deleting the home.
  // Reading it eagerly also keeps the tree kill working in exactly that case,
  // which a try/catch around the late read would have given up on.
  const pid = app.process()?.pid;

  const close = async () => {
    // app.close() can hang if the process (or a popout child) is slow to exit;
    // race it with a timeout so one slow teardown never stalls the worker.
    try {
      await Promise.race([
        app.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 12_000)),
      ]);
    } catch {
      /* fall through to the tree kill */
    }
    // Always reap the whole tree afterwards: a popped-out window and node-pty
    // children can outlive app.close() and hold the Playwright worker open.
    killTree(pid);
  };

  return {
    app,
    window,
    home,
    close,
    cleanup: async () => {
      await close();
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        /* best-effort */
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
  await window.getByRole('button', { name: 'Terminal' }).click();
}

/**
 * Set §5.8's global presentation policy from the titlebar chip (P2-E9-06).
 *
 * The chip CYCLES, so this walks it to the label rather than guessing a click
 * count — which also means it keeps working if the default or the order changes.
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
 * Stop cards from folding away when a prompt is submitted (P2-E9-06).
 *
 * The DEFAULT policy is auto-collapse: submitting from the composer gives that
 * card's dock slot back and leaves a row in the collapsed strip. That is the
 * product behaviour, and `presentation-policy.spec.ts` is where it is asserted.
 *
 * Every OTHER spec that submits a prompt is testing the composer, the feed, the
 * terminal or the stream transport, and for those a card that leaves the
 * workspace half-way through is noise — it fails as "element was detached from
 * the DOM", which says nothing about the thing under test. Call this after
 * launching in any spec that submits a prompt and then keeps looking at the
 * card.
 */
export async function keepCardsVisible(window: Page): Promise<void> {
  await setPresentationPolicy(window, 'Keep visible');
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

/** A throwaway folder to point a session at (git-repo optional). */
export function tempProjectFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-proj-'));
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
  const port = Number(
    /"msg":"hook listener up".*?"port":(\d+)/.exec(fs.readFileSync(logFile, 'utf8'))![1]
  );
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
