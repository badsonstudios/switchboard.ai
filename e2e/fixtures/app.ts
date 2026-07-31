// Launch the built Electron app under Playwright, fully isolated: a temp HOME
// so it never touches the real ~/.claude.json or workspace, the fake provider
// (shell-in-a-PTY, no claude login), and the S-01 env landmines scrubbed.
import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
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

  const close = async () => {
    const pid = app.process()?.pid;
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

/** Switch to the Terminal tab (always present, last — 2026-07-22). */
export async function showTerminal(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Terminal' }).click();
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
