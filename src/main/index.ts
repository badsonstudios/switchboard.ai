import { app, BrowserWindow, ipcMain, Menu, screen, shell } from 'electron';
import path from 'path';
import { windowOptionsFrom, WindowState } from './window-state';
import { WorkspaceStore, displayFingerprint } from './workspace/store';
import os from 'os';
import { LogSink, createLogger } from './log/logger';
import { registerBuiltinContributions } from './bootstrap';
import { registry } from './extensibility';
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
import { scanSlashCommands } from './capabilities/slash-commands';
import { buildMenuTemplate } from './app-menu';
import {
  Box,
  groupIdFromFrameName,
  isUsableBox,
  LivePopout,
  patchPopoutPositions,
  resolvePopoutBounds,
} from './popout-geometry';
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
// Called when the main window's renderer is gone — closed OR crashed. Module-
// level rather than wired once in the bootstrap because createWindow() runs
// again on macOS `activate`, and the second window needs the same teardown as
// the first (P2-E15-09).
let onRendererLost: ((reason: string) => void) | null = null;
// live popout windows, tagged with the dockview group each one hosts (#86).
// The GROUP ID is what matches them to the serialized layout — creation order
// famously doesn't, because dockview registers a popout when its window has
// finished loading, not when it opened.
const popoutWindows: Array<{ win: BrowserWindow; groupId?: string }> = [];
// true while a saved layout is being restored: dockview reopens popouts ~100ms
// apart, so a geometry nudge during that window would make the renderer
// serialize a layout that is missing the popouts still to come (#86)
let restoringLayout = false;
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

// Popout positions as they were on disk AT BOOT. Snapshotted because the
// renderer rewrites the layout while it restores — and at that moment the
// popout windows don't exist yet, so the stored positions are momentarily gone.
// Reading them later would find nothing to match against (#86).
let bootPopoutBoxes: Box[] = [];
/** dockview staggers popout restores ~100ms apart; allow generous slack */
const RESTORE_SETTLE_MS = 10_000;

function snapshotPopoutBoxes(): void {
  try {
    const layout = workspace.getLayout() as { popoutGroups?: Array<{ position?: Box | null }> } | null;
    bootPopoutBoxes = (layout?.popoutGroups ?? []).map((g) => g.position).filter(isUsableBox);
  } catch {
    bootPopoutBoxes = []; // geometry is a nicety — never block startup
  }
  // The snapshot only exists to recognise the restore burst. Keeping it around
  // would let a pop-out torn off an hour later collide with a dead popout's old
  // rect and teleport onto it, so it expires with the restore.
  restoringLayout = bootPopoutBoxes.length > 0;
  if (restoringLayout) {
    const done = setTimeout(() => {
      bootPopoutBoxes = [];
      restoringLayout = false;
    }, RESTORE_SETTLE_MS);
    done.unref?.();
  }
}

/** would this rect land on a display the user actually has? */
function boundsOnAnyDisplay(b: Partial<{ x: number; y: number; width: number; height: number }>): boolean {
  if (typeof b.x !== 'number' || typeof b.y !== 'number') return true; // nothing to judge
  const w = typeof b.width === 'number' ? b.width : 0;
  const h = typeof b.height === 'number' ? b.height : 0;
  return workAreas().some(
    (a) => b.x! < a.x + a.width - 80 && b.x! + w > a.x + 80 && b.y! < a.y + a.height - 40 && b.y! + h > a.y + 20
  );
}

/** popout positions as last persisted, in the order dockview restores them */
function storedPopoutBoxes(): Box[] {
  return bootPopoutBoxes;
}

/**
 * Tell the renderer a popout moved or resized, so it re-serializes the layout
 * with fresh geometry (#86). Debounced: a drag emits a burst of events, and
 * each notification costs a full layout serialize + store write.
 *
 * We deliberately send a bare nudge rather than the bounds themselves — the
 * renderer owns the mapping from OS window to dockview popout group, and
 * asking it to re-read its own truth keeps one source of that truth.
 */
function watchPopoutGeometry(child: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const nudge = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // during a restore the renderer would serialize a layout missing the
      // popouts still to come — the flush at close covers that window instead
      if (restoringLayout) return;
      const win = currentWindow;
      if (win && !win.isDestroyed()) win.webContents.send('app:popoutGeometryChanged');
    }, 250);
    timer.unref?.();
  };
  // moved/resized are the settled events but are darwin+win32 only; move/resize
  // fire everywhere (and continuously), which the debounce above absorbs
  child.on('moved', nudge);
  child.on('resized', nudge);
  child.on('move', nudge);
  child.on('resize', nudge);
  child.on('closed', () => clearTimeout(timer));
}

/**
 * Hard-exit backstop (#85). Twice now the main process has survived its own
 * `quit`: no windows, no sockets, teardown done, `app quit` logged — and still
 * breathing, leaving the launcher console open. Unreproducible on demand (a
 * native-handle race: ConPTY threads or a Chromium handle), and invisible to
 * the e2e suite, whose harness force-kills the process tree anyway.
 *
 * Everything durable is already flushed by the time `quit` fires — window
 * geometry saves on close, and workspace.save() flushes its debounce there —
 * so lingering buys nothing. Wait a beat for a graceful exit; if we're still
 * here, say so in the log (recurrence stays visible) and exit hard.
 */
function scheduleForcedExit(): void {
  const timer = setTimeout(() => {
    log.app.warn('still alive after quit — forcing exit', { pid: process.pid });
    app.exit(0);
  }, 1500);
  // never let the backstop itself be the reason the process stays up
  timer.unref?.();
}

function createWindow(): BrowserWindow {
  // A window can close WITHOUT the app quitting (macOS keeps running; the dock
  // icon reopens one). Reset the close-time state or the second window would
  // inherit "we're quitting": layout writes silently dropped for the rest of
  // the session, the busy-sessions prompt skipped, and a boot snapshot that no
  // longer describes what's on disk.
  quitConfirmed = false;
  snapshotPopoutBoxes();
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
    // Last word on popout geometry (#86). The renderer's own save races the
    // teardown — and dockview's position poll may not have caught the last
    // drag at all — so stamp the live rects over the stored layout here, where
    // we own both the windows and the store. Content rects, because the popout
    // is reopened with useContentSize.
    try {
      const live: LivePopout[] = popoutWindows
        .filter((p) => !p.win.isDestroyed())
        .map((p) => {
          // Mixed on purpose, matching what dockview stores and what Electron
          // consumes on restore: OUTER origin (window.screenX) with the CONTENT
          // size (innerWidth/innerHeight), reopened with useContentSize.
          const outer = p.win.getBounds();
          const content = p.win.getContentBounds();
          return {
            groupId: p.groupId,
            box: { left: outer.x, top: outer.y, width: content.width, height: content.height },
          };
        });
      if (live.length > 0) {
        workspace.setLayout(patchPopoutPositions(workspace.getLayout(), live));
        workspace.save(); // the store debounces; nothing else will flush this
      }
    } catch (err) {
      // geometry is a nicety; never let it block a close
      log.app.warn('popout geometry flush failed', { error: String(err) });
    }
  });
  // A window that can no longer answer a permission hold has to say so.
  // Sessions keep running (the PTYs live in main), so anything already parked
  // must fail open right here — otherwise it sits out the full 300s with
  // nothing able to decide it (P2-E15-09).
  //
  // TWO ways to lose the renderer, and only one of them closes the window:
  win.on('closed', () => {
    // guard on identity: a stray second window must not release the live
    // window's holds, and the app shouldn't keep a destroyed BrowserWindow
    if (win !== currentWindow) return;
    currentWindow = null;
    onRendererLost?.('main window closed');
  });
  // a CRASHED renderer leaves the window open with dead contents — hasLiveWindow
  // catches later calls, but this is what frees the ones already parked
  win.webContents.on('render-process-gone', (_e, details) => {
    if (win === currentWindow) onRendererLost?.(`renderer gone: ${details.reason}`);
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
    const asked = popout ? parsePopoutFeatures(features) : {};
    // dockview adds the opener's origin to the SAVED (already absolute)
    // position when restoring — see resolvePopoutBounds (#86)
    // getBounds(), not getContentBounds(): dockview reads the opener's
    // `window.screenX`, which Electron reports as the OUTER frame origin
    const opener = win.isDestroyed() ? { x: 0, y: 0 } : win.getBounds();
    const resolved = popout
      ? resolvePopoutBounds(asked, opener, storedPopoutBoxes())
      : { bounds: asked, matchedIndex: -1 };
    const { matchedIndex } = resolved;
    // Sanity net, independent of the matching above: if the rect we're about to
    // use sits on no display at all, drop the position and let the OS place the
    // window. Better a window in the wrong place than one you can't reach.
    const bounds =
      popout && !boundsOnAnyDisplay(resolved.bounds)
        ? { width: resolved.bounds.width, height: resolved.bounds.height }
        : resolved.bounds;
    log.ui.info('window-open requested', { url, popout, asked, bounds, restored: matchedIndex >= 0 });
    if (popout) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          backgroundColor: '#242933',
          ...bounds,
          // dockview persists the popout's INNER size (innerWidth/innerHeight);
          // without this Electron would read those as the OUTER frame size and
          // the window would lose the frame's worth of pixels on every
          // save/restore cycle — a popout that shrinks a little each launch (#86)
          useContentSize: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Popout geometry is only durable if something notices the window moved.
  // dockview notices via a debounced requestAnimationFrame poll of screenX —
  // which throttles in a backgrounded window, i.e. exactly while you drag a
  // popout on another monitor. Quit before it fires and the STALE (usually
  // open-time) position is what gets restored: #86, a popout coming back
  // straddling two monitors. Electron's own move/resize events are
  // authoritative and fire regardless of focus, so drive the save from those.
  win.webContents.on('did-create-window', (child, details) => {
    if (!isPopoutUrl(details.url)) return;
    const entry = { win: child, groupId: groupIdFromFrameName(details.frameName) };
    popoutWindows.push(entry);
    child.on('closed', () => {
      const i = popoutWindows.indexOf(entry);
      if (i >= 0) popoutWindows.splice(i, 1);
    });
    watchPopoutGeometry(child);
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
    ipcMain.on('workspace:setLayout', (_e, layout: unknown) => {
      // Once the close is confirmed, the main process has already stamped the
      // authoritative popout geometry (#86). A renderer tearing down still
      // emits layout changes as dockview disposes, and those carry the stale
      // positions we just corrected — ignore them.
      if (quitConfirmed) return;
      workspace.setLayout(layout);
    });
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
        // the move must survive a quit that follows immediately (#86)
        setTimeout(() => {
          const w = currentWindow;
          if (w && !w.isDestroyed()) w.webContents.send('app:popoutGeometryChanged');
        }, 300).unref?.();
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
      // hold policy (E10-03): gate by the session's own autonomy + folder
      autonomyFor: (id) => manager.get(id)?.autonomy,
      cwdFor: (id) => manager.get(id)?.identity.folder,
      // Is there anyone to ask? A destroyed window or a crashed renderer means
      // no (P2-E15-09). A RELOADING renderer is neither, so the pending-holds
      // replay path still gets its chance — that case must not regress.
      hasLiveWindow: () => {
        const w = currentWindow;
        return !!w && !w.isDestroyed() && !w.webContents.isCrashed();
      },
    });
    onRendererLost = (reason) => hooks.releaseHeld(reason);
    const transcripts = new TranscriptWatcher({
      projectsRoot: path.join(os.homedir(), '.claude', 'projects'),
      log: createLogger(sink, 'transcripts'),
    });
    void hooks.start().catch((err) => {
      // hooks are an accelerator, not the authority — start-failure degrades
      log.app.error('hook listener failed to start', { error: String(err) });
    });
    // own the menu BEFORE the first window: Electron's default one registers
    // Ctrl+W (closes the window and every session in it) and Ctrl+R (reloads
    // the renderer mid-session) in the browser process, ahead of the
    // renderer's command registry (E9-01)
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(process.platform)));
    snapshotPopoutBoxes(); // before the renderer can rewrite the layout (#86)
    createWindow(); // sets currentWindow; IPC/notifier read it via closure
    const feed = new EventFeed();
    const notifier = new Notifier({
      getWindow: () => currentWindow,
      getPrefs: () => workspace.getNotificationPrefs(),
      titleFor: (sessionId) => manager.get(sessionId)?.identity.title ?? 'switchboard',
      bodyFor: (e) => e.kind.replace(/-/g, ' '),
    });
    feed.onEvent((e) => {
      if (e) notifier.handle(e); // null = pure removal, nothing to announce
    });
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
      slashCommands: (folder, providerId) =>
        scanSlashCommands(
          { cwd: folder, userClaudeDir: path.join(os.homedir(), '.claude') },
          registry.resolve('provider-adapter', providerId)?.slashCommands?.() ?? [],
          (msg) => log.app.info(msg)
        ),
    });
    app.on('quit', () => {
      ptys.killAll();
      hooks.stop();
      transcripts.stop();
      staticServer?.close();
      scheduleForcedExit();
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
