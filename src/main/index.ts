import { app, BrowserWindow, shell } from 'electron';
import path from 'path';
import { loadWindowState, trackWindowState, windowOptionsFrom } from './window-state';
import { LogSink, createLogger } from './log/logger';
import { registerBuiltinContributions } from './bootstrap';
import { registry } from './extensibility/registry';

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

function createWindow(): BrowserWindow {
  const state = loadWindowState();
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
      additionalArguments: [`--switchboard-version=${app.getVersion()}`],
    },
  });

  if (state.isMaximized) win.maximize();
  trackWindowState(win);
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
    registerBuiltinContributions();
    log.app.info('contributions registered', { manifests: registry.manifests() });
    createWindow();
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
