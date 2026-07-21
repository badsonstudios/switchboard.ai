// Launch the built Electron app under Playwright, fully isolated: a temp HOME
// so it never touches the real ~/.claude.json or workspace, the fake provider
// (shell-in-a-PTY, no claude login), and the S-01 env landmines scrubbed.
import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

// electron's main export is the path to its binary when require()d in Node
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as string;

const ROOT = path.resolve(__dirname, '..', '..');

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
  home: string;
  cleanup: () => Promise<void>;
}

export interface LaunchOptions {
  /** auto-create one fake session in this folder at boot */
  seedFolder?: string;
  /** extra env for the main process */
  env?: Record<string, string>;
}

export async function launchApp(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.NoDefaultCurrentDirectoryInExePath;
  env.SWITCHBOARD_FAKE_PROVIDER = '1';
  // isolate every path the app derives from the profile
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = appData;
  env.LOCALAPPDATA = localAppData;
  if (opts.seedFolder) env.SWITCHBOARD_SEED_SESSION = opts.seedFolder;
  Object.assign(env, opts.env);

  const app = await electron.launch({ executablePath: electronPath, args: [ROOT], cwd: ROOT, env });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  return {
    app,
    window,
    home,
    cleanup: async () => {
      // app.close() can hang if the process is slow to exit; force-kill as a
      // backstop so a single slow teardown never fails the whole worker
      try {
        await Promise.race([
          app.close(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 12_000)),
        ]);
      } catch {
        try {
          app.process()?.kill();
        } catch {
          /* already gone */
        }
      }
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/** A throwaway folder to point a session at (git-repo optional). */
export function tempProjectFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-proj-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# e2e\n');
  return dir;
}
