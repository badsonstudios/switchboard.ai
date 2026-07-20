import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import path from 'path';
import { windowOptionsFrom, WindowState } from './window-state';
import { WorkspaceStore, displayFingerprint } from './workspace/store';
import os from 'os';
import { LogSink, createLogger } from './log/logger';
import { registerBuiltinContributions } from './bootstrap';
import { registry } from './extensibility/registry';
import { PtyService } from './pty/pty-service';
import { SessionManager } from './sessions/session-manager';
import { HookListener } from './hooks/hook-listener';
import { TranscriptWatcher } from './transcripts/watcher';
import { registerSessionIpc } from './sessions/ipc';
import { EventFeed } from './events/feed';
import { Notifier } from './events/notifier';
import { GitService } from './git/git-service';
import { runPreflight } from './preflight';
import { dialog } from 'electron';

// Safe-by-default for every window this app will ever open (§5.29 posture).
app.enableSandbox();

function logsDir(): string {
  try {
    return app.getPath('logs');
  } catch {
    return path.join(app.getPath('userData'), 'logs');
  }
}
let sink: LogSink;
const log = {
  get app() {
    return createLogger(sink, 'app');
  },
  get ui() {
    return createLogger(sink, 'ui');
  },
};

const DEV_URL = process.env.ELECTRON_RENDERER_URL;

function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

let workspace: WorkspaceStore;
let currentWindow: BrowserWindow | null = null;
let busySessions: () => string[] = () => [];
let quitConfirmed = false;

function workAreas() {
  return screen.getAllDisplays().map((d) => d.workArea);
}

// Quit protection (P1-E6-02): intercept the WINDOW close — on Windows the X
// destroys the sole window before before-quit, so guarding there strands
// headless PTYs. Prompt here, then destroy + quit only on confirm.
function confirmCloseWithBusySessions(win: BrowserWindow): boolean {
  if (quitConfirmed) return true;
  if (process.env.SWITCHBOARD_AUTOCLOSE) return true; // scripted smoke: never block
  const busy = busySessions();
  if (busy.length === 0) return true;
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['Quit anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Sessions are mid-task',
    message: `${busy.length} session(s) are mid-task:\n\n${busy.join('\n')}\n\nQuit anyway?`,
  });
  return choice === 0;
}

function trackWindowGeometry(win: BrowserWindow): void {
  let lastNormalBounds = win.getNormalBounds();
  const save = () => {
    if (win.isDestroyed()) return;
    workspace.setWindow({
      bounds: win.isMaximized() ? lastNormalBounds : win.getNormalBounds(),
      isMaximized: win.isMaximized(),
      displayFingerprint: displayFingerprint(workAreas()),
    });
  };
  const onChange = () => {
    if (!win.isMaximized()) lastNormalBounds = win.getNormalBounds();
    save();
  };
  win.on('resize', onChange);
  win.on('move', onChange);
  win.on('maximize', save);
  win.on('unmaximize', save);
  win.on('close', () => {
    save();
    workspace.save(); // flush the debounce before the process dies
  });
}

function createWindow(): BrowserWindow {
  const state: WindowState = workspace.restoreWindow(workAreas());
  const win = new BrowserWindow({
    ...windowOptionsFrom(state),
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#242933', // pre-paint only: --bg (nordic) from tokens.css
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `--switchboard-version=${app.getVersion()}`,
        `--switchboard-seed-panels=${process.env.SWITCHBOARD_SEED_PANELS ?? 0}`,
        `--switchboard-seed-session=${process.env.SWITCHBOARD_SEED_SESSION ?? ''}`,
      ],
    },
  });

  if (state.isMaximized) win.maximize();
  currentWindow = win;
  trackWindowGeometry(win);
  win.on('close', (e) => {
    if (!confirmCloseWithBusySessions(win)) {
      e.preventDefault();
      return;
    }
    quitConfirmed = true;
  });
  win.once('ready-to-show', () => {
    win.show();
    log.ui.info('window shown', { restored: !!state.bounds, maximized: state.isMaximized });
  });

  // external links open in the OS browser (http/https only), never in-app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // no top-frame navigation away from our own content
  win.webContents.on('will-navigate', (event, url) => {
    if (!DEV_URL || !url.startsWith(DEV_URL)) event.preventDefault();
  });

  if (DEV_URL) {
    void win.loadURL(DEV_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  return win;
}

app
  .whenReady()
  .then(() => {
    sink = new LogSink({ dir: logsDir() });
    log.app.info('app ready', { version: app.getVersion(), platform: process.platform });
    workspace = new WorkspaceStore(path.join(app.getPath('userData'), 'workspace.json'));
    workspace.load();
    // renderer <-> workspace layout persistence (E3-01)
    ipcMain.handle('workspace:getLayout', () => workspace.getLayout());
    ipcMain.on('workspace:setLayout', (_e, layout: unknown) => workspace.setLayout(layout));
    registerBuiltinContributions();
    log.app.info('contributions registered', { manifests: registry.manifests() });

    // session core (E2) bootstrap
    const stateDir = path.join(app.getPath('userData'), 'sessions');
    const ptys = new PtyService();
    const manager = new SessionManager(registry, ptys, createLogger(sink, 'sessions'), stateDir);
    const hooks = new HookListener({ stateDir, manager, log: createLogger(sink, 'hooks') });
    const transcripts = new TranscriptWatcher({
      projectsRoot: path.join(os.homedir(), '.claude', 'projects'),
      log: createLogger(sink, 'transcripts'),
    });
    void hooks.start().catch((err) => {
      // hooks are an accelerator, not the authority — start-failure degrades
      log.app.error('hook listener failed to start', { error: String(err) });
    });
    createWindow(); // sets currentWindow; IPC/notifier read it via closure
    const feed = new EventFeed();
    const notifier = new Notifier({
      getWindow: () => currentWindow,
      getPrefs: () => workspace.getNotificationPrefs(),
      titleFor: (sessionId) => manager.get(sessionId)?.identity.title ?? 'switchboard',
      bodyFor: (e) => e.kind.replace(/-/g, ' '),
    });
    feed.onEvent((e) => notifier.handle(e));
    ipcMain.handle('preflight:check', () => runPreflight());
    busySessions = () =>
      manager
        .list()
        .filter((s) => ['working', 'needs-input', 'needs-permission'].includes(s.status))
        .map((s) => `• ${s.identity.title} (${s.status})`);

    // git handlers are scoped to KNOWN session folders (§5.29): a compromised
    // renderer must not turn these into an arbitrary-file-read primitive
    const knownFolder = (folder: string): boolean =>
      manager.list().some((s) => path.resolve(s.identity.folder) === path.resolve(folder));
    const gitService = new GitService();
    ipcMain.handle('git:status', (_e, folder: string) =>
      knownFolder(folder) ? gitService.status(folder) : { isRepo: false, files: [] }
    );
    ipcMain.handle('git:fileVersions', (_e, folder: string, file: string) => {
      // scope to a known folder AND forbid escaping it (path traversal)
      if (!knownFolder(folder)) return { original: '', modified: '' };
      const resolved = path.resolve(folder, file);
      if (resolved !== path.resolve(folder) && !resolved.startsWith(path.resolve(folder) + path.sep)) {
        return { original: '', modified: '' };
      }
      return gitService.fileVersions(folder, file);
    });
    ipcMain.handle('notifications:getPrefs', () => workspace.getNotificationPrefs());
    ipcMain.handle('notifications:setPrefs', (_e, p) => {
      workspace.setNotificationPrefs(p);
      return workspace.getNotificationPrefs();
    });
    ipcMain.handle('settings:getAutoTrust', () => workspace.getAutoTrust());
    ipcMain.handle('settings:setAutoTrust', (_e, on: boolean) => {
      workspace.setAutoTrust(on === true);
      return workspace.getAutoTrust();
    });
    registerSessionIpc({
      manager,
      ptys,
      hooks,
      transcripts,
      feed,
      log: createLogger(sink, 'ipc'),
      getWindow: () => currentWindow, // reassigned on macOS re-activate
      autoTrust: () => workspace.getAutoTrust(),
      persist: {
        list: () => workspace.listSessions(),
        upsert: (s) => workspace.upsertSession(s),
        remove: (cardId) => workspace.removeSession(cardId),
      },
      projectsRoot: path.join(os.homedir(), '.claude', 'projects'),
    });
    app.on('quit', () => {
      ptys.killAll();
      hooks.stop();
      transcripts.stop();
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // SWITCHBOARD_AUTOCLOSE=<seconds>: scripted smoke checks (spike pattern)
    const autoclose = Number(process.env.SWITCHBOARD_AUTOCLOSE);
    if (Number.isFinite(autoclose) && autoclose > 0) {
      setTimeout(() => app.quit(), autoclose * 1000);
    }
  })
  .catch((err) => {
    console.error('fatal: app failed to start', err);
    app.exit(1);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('quit', () => {
  if (sink) log.app.info('app quit');
});
