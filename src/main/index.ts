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

function workAreas() {
  return screen.getAllDisplays().map((d) => d.workArea);
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
  trackWindowGeometry(win);
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
    const win = createWindow();
    const feed = new EventFeed();
    const notifier = new Notifier({
      getWindow: () => win,
      getPrefs: () => workspace.getNotificationPrefs(),
      titleFor: (sessionId) => manager.get(sessionId)?.identity.title ?? 'switchboard',
      bodyFor: (e) => e.kind.replace(/-/g, ' '),
    });
    feed.onEvent((e) => notifier.handle(e));
    ipcMain.handle('notifications:getPrefs', () => workspace.getNotificationPrefs());
    ipcMain.handle('notifications:setPrefs', (_e, p) => {
      workspace.setNotificationPrefs(p);
      return workspace.getNotificationPrefs();
    });
    registerSessionIpc({
      manager,
      ptys,
      hooks,
      transcripts,
      feed,
      log: createLogger(sink, 'ipc'),
      getWindow: () => win,
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
