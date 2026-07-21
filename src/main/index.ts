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
import { registerGroupIpc } from './workspace/group-ipc';
import { EventFeed } from './events/feed';
import { Notifier } from './events/notifier';
import { GitService } from './git/git-service';
import { runPreflight } from './preflight';
import { startStaticServer, StaticServer } from './static-server';
import { parsePopoutFeatures } from './popout-bounds';
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
// In production the renderer is served over loopback http (not file://) so
// dockview's same-origin-http pop-out works (E8). Set at startup.
let RENDERER_ORIGIN: string | null = null;
let staticServer: StaticServer | null = null;

/** The origin the renderer is served from (dev server or our loopback http). */
function rendererOrigin(): string | null {
  if (DEV_URL) return new URL(DEV_URL).origin;
  return RENDERER_ORIGIN;
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** dockview's popout window: our own same-origin popout.html. */
function isPopoutUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.pathname.endsWith('popout.html')) return false;
    const origin = rendererOrigin();
    return !!origin && u.origin === origin;
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

  // external links open in the OS browser (http/https only), never in-app.
  // The ONE in-app window we allow is dockview's same-origin popout window
  // (tearing a session card into its own OS window, E8) — scoped narrowly to
  // our own popout.html so this stays a controlled allowance, not an open door.
  win.webContents.setWindowOpenHandler(({ url, features }) => {
    const popout = isPopoutUrl(url);
    // Electron ignores the position/size in window.open's `features` string
    // unless we copy them onto the created window. dockview passes screen-
    // absolute left/top/width/height there, so without this a popout cascades
    // to a default spot and ignores its saved position (E8-04 multi-monitor).
    const bounds = popout ? parsePopoutFeatures(features) : {};
    log.ui.info('window-open requested', { url, popout, bounds }); // E8 diagnostic
    if (popout) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          backgroundColor: '#242933',
          ...bounds,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // surface renderer console into the main log (E8 diagnostic + general debug)
  win.webContents.on('console-message', (...args: unknown[]) => {
    const d = args[0] as { message?: string; level?: unknown } | undefined;
    const message = typeof d === 'object' && d?.message !== undefined ? d.message : args[1];
    log.ui.info('renderer console', { message: String(message).slice(0, 500) });
  });
  // no top-frame navigation away from our own content
  win.webContents.on('will-navigate', (event, url) => {
    const origin = rendererOrigin();
    if (!origin || !url.startsWith(origin)) event.preventDefault();
  });

  if (DEV_URL) {
    void win.loadURL(DEV_URL);
  } else if (RENDERER_ORIGIN) {
    void win.loadURL(`${RENDERER_ORIGIN}/index.html`);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html')); // fallback
  }
  return win;
}

app
  .whenReady()
  .then(async () => {
    sink = new LogSink({ dir: logsDir() });
    log.app.info('app ready', { version: app.getVersion(), platform: process.platform });
    // serve the packaged renderer over loopback http so dockview pop-out works
    if (!DEV_URL) {
      try {
        staticServer = await startStaticServer(path.join(__dirname, '../renderer'));
        RENDERER_ORIGIN = staticServer.origin;
        log.app.info('renderer served over loopback', { origin: RENDERER_ORIGIN });
      } catch (err) {
        log.app.error('static server failed; falling back to file://', { error: String(err) });
      }
    }
    workspace = new WorkspaceStore(path.join(app.getPath('userData'), 'workspace.json'));
    workspace.load();
    // renderer <-> workspace layout persistence (E3-01)
    ipcMain.handle('workspace:getLayout', () => workspace.getLayout());
    ipcMain.on('workspace:setLayout', (_e, layout: unknown) => workspace.setLayout(layout));
    // renderer-owned UI state (E12-08): focus, view tabs, prefs
    ipcMain.handle('workspace:getUi', () => workspace.getUi());
    ipcMain.on('workspace:setUi', (_e, ui: unknown) => workspace.setUi(ui));
    // display work areas — for popout-position rescue on restore (E8-02)
    ipcMain.handle('app:workAreas', () => screen.getAllDisplays().map((d) => d.workArea));
    // display reconnected (docking back at the desk) — the renderer may offer
    // to restore rescued popouts; NEVER restores automatically (E8-06, §7)
    screen.on('display-added', () => {
      const win = currentWindow;
      if (win && !win.isDestroyed()) {
        win.webContents.send('app:displaysChanged', screen.getAllDisplays().map((d) => d.workArea));
      }
    });
    // move a popout window to a restored display (E8-06 accept). Done here:
    // the DOM's window.moveTo clamps to currently-known screens mid-hotplug,
    // BrowserWindow.setBounds does not. The popout is identified by its
    // current position, which the renderer reads off the DOM window it owns.
    ipcMain.handle(
      'app:movePopout',
      (_e, from: { x: number; y: number }, to: { left: number; top: number; width: number; height: number }) => {
        if (
          typeof from?.x !== 'number' ||
          typeof from?.y !== 'number' ||
          typeof to?.left !== 'number' ||
          typeof to?.top !== 'number' ||
          !Number.isFinite(to.width) ||
          !Number.isFinite(to.height)
        )
          return false;
        const candidates = BrowserWindow.getAllWindows().filter((w) => w !== currentWindow && !w.isDestroyed());
        const hit = candidates.find((w) => {
          const b = w.getBounds();
          return Math.abs(b.x - from.x) <= 40 && Math.abs(b.y - from.y) <= 40;
        });
        if (!hit) return false;
        hit.setBounds({
          x: Math.round(to.left),
          y: Math.round(to.top),
          width: Math.round(to.width),
          height: Math.round(to.height),
        });
        return true;
      }
    );
    // persistent groups (E12-01)
    registerGroupIpc(workspace);
    registerBuiltinContributions();
    log.app.info('contributions registered', { manifests: registry.manifests() });

    // session core (E2) bootstrap
    const stateDir = path.join(app.getPath('userData'), 'sessions');
    const ptys = new PtyService();
    const manager = new SessionManager(registry, ptys, createLogger(sink, 'sessions'), stateDir);
    const hooks = new HookListener({
      stateDir,
      manager,
      log: createLogger(sink, 'hooks'),
      // hold policy (E10-03): gate by the session's own autonomy
      autonomyFor: (id) => manager.get(id)?.autonomy,
    });
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
      repoRoot: (folder) => gitService.root(folder),
    });
    app.on('quit', () => {
      ptys.killAll();
      hooks.stop();
      transcripts.stop();
      staticServer?.close();
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
