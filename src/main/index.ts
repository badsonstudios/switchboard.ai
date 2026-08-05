import { app, BrowserWindow, Menu, screen, session, shell } from 'electron';
import path from 'path';
import { windowOptionsFrom, WindowState } from './window-state';
import { WorkspaceStore, displayFingerprint } from './workspace/store';
import os from 'os';
import { LogSink, createLogger } from './log/logger';
import { registerBuiltinContributions } from './bootstrap';
import { registry } from './extensibility';
import { PtyService } from './pty/pty-service';
import { StreamService } from './transport/stream-service';
import { StreamPermissions } from './sessions/stream-permissions';
import { StreamCommands } from './sessions/stream-commands';
import { StreamFeed } from './feed/stream-feed';
import { SessionManager } from './sessions/session-manager';
import { HookListener } from './hooks/hook-listener';
import { TranscriptWatcher } from './transcripts/watcher';
import { registerSessionIpc } from './sessions/ipc';
import { registerGroupIpc } from './workspace/group-ipc';
import { IpcBroker } from './ipc/broker';
import { allCapabilities, Channel } from '../shared/ipc/capabilities';
import { EventFeed } from './events/feed';
import { Notifier } from './events/notifier';
import { GitService } from './git/git-service';
import { runPreflight } from './preflight';
import { startStaticServer, StaticServer } from './static-server';
import { installCspHeaders } from './csp';
import { parsePopoutFeatures } from './popout-bounds';
import { scanSlashCommands } from './capabilities/slash-commands';
import { buildMenuTemplate } from './app-menu';
import { UpdateService, FEED_ENV, isAllowedReleaseUrl } from './update/service';
import { installTerminalAccelerators, makeAcceleratorDeps } from './terminal-accelerators';
import {
  Box,
  groupIdFromFrameName,
  isUsableBox,
  LivePopout,
  patchPopoutPositions,
  resolvePopoutBounds,
} from './popout-geometry';
import { dialog } from 'electron';
import { buildIdentity, isReleaseBuild, windowTitle } from '../shared/build-identity';

/** Stamped in at build time (P2-E15-15); constant for the process lifetime. */
const BUILD_IDENTITY = buildIdentity();
/** The name the OS window carries when there is nothing unusual to report. */
const APP_NAME = 'switchboard';

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

/** How many popout groups a serialized dockview layout carries. */
function popoutGroupCount(layout: unknown): number {
  const groups = (layout as { popoutGroups?: unknown } | null)?.popoutGroups;
  return Array.isArray(groups) ? groups.length : 0;
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
// set by the bootstrap once the broker exists; createWindow() runs again on
// macOS `activate`, so a second window must be granted too (P2-E15-04)
let grantFirstParty: ((win: BrowserWindow) => void) | null = null;
// Outbound pushes from module-level helpers. Set by the bootstrap alongside
// the broker: "every channel goes through the broker, in both directions" is
// only true if the helpers obey it too (P2-E15-04).
let pushToRenderer: ((win: BrowserWindow | null, channel: Channel, payload?: unknown) => void) | null =
  null;
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

/** A positive millisecond count from an env var, or undefined. Junk and
 *  negatives fall through to the caller's default rather than disabling a
 *  timeout by accident. */
function positiveMs(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Is a scripted quit in charge? Then nothing may be put in front of it.
 *
 * TWO vars, deliberately, because the old single one could not express what an
 * automated run actually needs (#185):
 *
 * - `SWITCHBOARD_AUTOCLOSE=<seconds>` arms a TIMED self-quit (smoke checks).
 *   It implies "don't prompt" — a quit nobody is watching must not stop at a
 *   modal — but you cannot ask for the suppression alone without also arming
 *   the timer, and the one value that would (`0`) reads as "off" to anyone
 *   who sees it.
 * - `SWITCHBOARD_NO_QUIT_CONFIRM=1` is the suppression BY ITSELF. This is what
 *   a test harness wants: the app lives until the harness closes it, and the
 *   close is never intercepted. The e2e fixtures set it on every launch.
 *
 * Both are dev/test-only escape hatches; neither is documented to users, and a
 * real install has neither set, so the dialog behaves exactly as before.
 */
function scriptedQuit(): boolean {
  return !!process.env.SWITCHBOARD_NO_QUIT_CONFIRM || !!process.env.SWITCHBOARD_AUTOCLOSE;
}

// Quit protection (P1-E6-02): intercept the WINDOW close — on Windows the X
// destroys the sole window before before-quit, so guarding there strands
// headless PTYs. Prompt here, then destroy + quit only on confirm.
function confirmCloseWithBusySessions(win: BrowserWindow): boolean {
  if (quitConfirmed) return true;
  if (scriptedQuit()) return true; // scripted smoke / e2e: never block
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

/**
 * How a claimed chord (#90) gets from the browser process to the command
 * registry. It always goes to the MAIN window, popout or not: a popout has no
 * preload and runs no JS of its own — dockview adopts the group's DOM into it
 * while the script keeps running in the opener — so the opener is the only
 * place a command can be run at all. `fromPopout` tells the renderer where the
 * keystroke came from, which is what decides whether running the command should
 * pull the main window forward.
 *
 * `acceleratorReadyFor` is the webContents that has actually subscribed. Until
 * it matches the live window, no chord is claimed at all and the keystroke goes
 * where it always would — including for the whole of startup, and for ever if
 * the preload bridge is missing.
 */
let acceleratorReadyFor: number | null = null;
const acceleratorDeps = makeAcceleratorDeps({
  platform: process.platform === 'darwin' ? 'darwin' : 'other',
  renderer: () => {
    const win = currentWindow;
    if (!win || win.isDestroyed()) return { id: null, alive: false };
    return { id: win.webContents.id, alive: !win.webContents.isCrashed() };
  },
  ready: () => acceleratorReadyFor,
  send: (commandId, fromPopout) => {
    if (!pushToRenderer) return false;
    pushToRenderer(currentWindow, 'app:accelerator', { commandId, fromPopout });
    return true;
  },
  onError: (err) => log.app.warn('terminal accelerator failed', { error: String(err) }),
});

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
      pushToRenderer?.(win, 'app:popoutGeometryChanged');
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
    // pre-paint only: --bg (nordic) from tokens.css. A daylight or
    // high-contrast user still gets one dark frame here before the renderer
    // paints. Main can now READ the choice — P2-E15-06 moved it into this
    // store — but not its color: `--bg` lives in the renderer's tokens.css and
    // theme JSON, so closing this needs the token maps somewhere both
    // processes can see. Not worth that today; recorded so the next person
    // knows the blocker moved.
    backgroundColor: '#242933',
    // "Which build is this?" answerable from the TASKBAR, without focusing the
    // window (P2-E15-15). A clean `main` build gets the bare app name; anything
    // else — feature branch, dirty tree, detached, unknown provenance — says so.
    title: windowTitle(APP_NAME, BUILD_IDENTITY),
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

  // The document's <title> would otherwise land on top of the identity above
  // the moment index.html parses — Electron mirrors the page title onto the
  // window by default. Vetoing that is what makes the build suffix survive a
  // load, and it costs nothing: our renderer never sets a title of its own.
  // Scoped to THIS window; popouts keep dockview's page-driven titles.
  win.on('page-title-updated', (e) => {
    e.preventDefault();
  });

  if (state.isMaximized) win.maximize();
  currentWindow = win;
  // First-party holds EVERYTHING. Narrowing our own renderer is a different
  // argument with real behaviour changes; this item's contract is that nothing
  // changes at runtime. Phase 4 grants a plugin host its manifest's set here
  // instead (P2-E15-04).
  grantFirstParty?.(win);
  // The two chords that must survive terminal focus (#90). Installed on the
  // window's contents, so the claim ends at our own windows.
  installTerminalAccelerators(win.webContents, acceleratorDeps(false));
  // A navigating renderer has torn its listener down; nothing may be claimed
  // again until the new one says it is listening.
  win.webContents.on('did-start-loading', () => {
    acceleratorReadyFor = null;
  });
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
        const stored = popoutGroupCount(workspace.getLayout());
        workspace.setLayout(patchPopoutPositions(workspace.getLayout(), live));
        workspace.save(); // the store debounces; nothing else will flush this
        // The flush can only PATCH popout entries the renderer already sent us;
        // it cannot invent one. dockview registers a popout when the child
        // window finishes LOADING, so a quit that beats that registration
        // persists a layout with no popout at all and the window does not come
        // back. Silent before — and indistinguishable from "restore failed" in
        // a log — so say which of the two happened (#165).
        log.ui.info('popout geometry flushed', { live: live.length, stored });
        if (stored < live.length) {
          log.ui.warn('quit beat popout registration — popouts will not be restored', {
            live: live.length,
            stored,
          });
        }
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
          // NO preload here, deliberately. dockview adopts the group's DOM
          // into this window while the JS keeps running in the OPENER, so a
          // popout never makes an IPC call of its own — which is why it is
          // never granted capabilities (P2-E15-04). Adding a preload would make
          // it an ungranted caller: `invoke`s would reject and `on`-channels
          // would be dropped with only a log line, and nobody would connect
          // that to this change. Grant it here if you ever do add one.
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
    // A popped-out session is still a session: the palette and the attention
    // jump have to work from its terminal too (#90, §5.8 — tearing a card off
    // must not remove capability). The claim is per-window, so this window
    // needs its own.
    installTerminalAccelerators(child.webContents, acceleratorDeps(true));
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
    // The build stamp goes in the FIRST log line (P2-E15-15): when a bug report
    // arrives as a log file, "which build produced this?" must be answerable
    // from the top of it rather than inferred from what the code did.
    log.app.info('app ready', {
      version: app.getVersion(),
      platform: process.platform,
      commit: BUILD_IDENTITY.commit ?? 'unknown',
      branch: BUILD_IDENTITY.branch ?? 'detached',
      dirty: BUILD_IDENTITY.dirty,
      builtAt: BUILD_IDENTITY.builtAt ?? 'unknown',
      release: isReleaseBuild(BUILD_IDENTITY),
    });
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
    // Header-based CSP for every window in the default session — main and
    // dockview's popout, dev server and loopback server alike (P2-E15-12,
    // §5.29). Installed before the first window loads: a policy that arrives
    // after the document has parsed is not a policy. The <meta> tag it replaces
    // only ever worked in dev by accident of Vite's injection order.
    installCspHeaders(
      session.defaultSession,
      rendererOrigin,
      !!DEV_URL,
      (err) => log.app.error('csp header listener failed', { error: String(err) })
    );
    // The IPC choke point (P2-E15-04). Every channel registers through it, in
    // both directions; it refuses a call whose caller does not hold the
    // channel's capability. Created BEFORE any registration, and before the
    // first window, so no channel can exist outside it.
    const broker = new IpcBroker(createLogger(sink, 'ipc'));
    grantFirstParty = (win) =>
      broker.grant(win.webContents, { id: 'renderer', capabilities: allCapabilities() });
    pushToRenderer = (win, channel, payload) => broker.send(win, channel, payload);
    workspace = new WorkspaceStore(
      path.join(app.getPath('userData'), 'workspace.json'),
      createLogger(sink, 'workspace')
    );
    workspace.load();
    // renderer <-> workspace layout persistence (E3-01)
    broker.handle('workspace:getLayout', () => workspace.getLayout());
    broker.on('workspace:setLayout', (_e, layout: unknown) => {
      // Once the close is confirmed, the main process has already stamped the
      // authoritative popout geometry (#86). A renderer tearing down still
      // emits layout changes as dockview disposes, and those carry the stale
      // positions we just corrected — ignore them.
      // A layout the renderer sent just BEFORE the close can still be in flight
      // and get dropped here — considered, and deliberately still dropped
      // (#165). Taking it back would mean guessing "fresh" from "teardown
      // remnant" by shape, and a remnant arrives mid-disposal: popouts still
      // listed while grid panels have already gone. Persisting one of those
      // would lose real cards on EVERY quit to save a popout only in the rare
      // case of quitting in the same breath as tearing one off. Say when it
      // happens instead — it was silent, and a dropped layout is one of the few
      // ways a popout can fail to come back.
      if (quitConfirmed) {
        const dropped = popoutGroupCount(layout);
        if (dropped > 0) log.ui.info('layout dropped after quit', { popouts: dropped });
        return;
      }
      workspace.setLayout(layout);
    });
    // The file on disk came from a NEWER switchboard.ai, so the store loaded it
    // read-only and will refuse every write this run (#110). That refusal was
    // log-only, which is the silent half of a data-loss story — the renderer
    // reads this to say so on screen instead (#168). Latched at load, so one
    // read at boot is the whole answer; nothing pushes a change.
    broker.handle('workspace:isReadOnly', () => workspace.isReadOnly());
    // renderer-owned UI state (E12-08): focus, view tabs, prefs
    broker.handle('workspace:getUi', () => workspace.getUi());
    broker.on('workspace:setUi', (_e, ui: unknown) => workspace.setUi(ui));
    // the renderer is listening for claimed chords (#90) — until this arrives,
    // nothing is taken from the page
    broker.on('app:acceleratorReady', (e) => {
      acceleratorReadyFor = e.sender.id;
    });
    // display work areas — for popout-position rescue on restore (E8-02)
    broker.handle('app:workAreas', () => screen.getAllDisplays().map((d) => d.workArea));
    // display reconnected (docking back at the desk) — the renderer may offer
    // to restore rescued popouts; NEVER restores automatically (E8-06, §7)
    screen.on('display-added', () => {
      const win = currentWindow;
      if (win && !win.isDestroyed()) {
        pushToRenderer?.(
          win,
          'app:displaysChanged',
          screen.getAllDisplays().map((d) => d.workArea)
        );
      }
    });
    // move a popout window to a restored display (E8-06 accept). Done here:
    // the DOM's window.moveTo clamps to currently-known screens mid-hotplug,
    // BrowserWindow.setBounds does not. The popout is identified by its
    // current position, which the renderer reads off the DOM window it owns.
    broker.handle('app:movePopout',
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
          pushToRenderer?.(w, 'app:popoutGeometryChanged');
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
    registerGroupIpc(workspace, broker);
    registerBuiltinContributions();
    log.app.info('contributions registered', { manifests: registry.manifests() });

    // Which provider a brand-new card runs on: the first REGISTERED adapter.
    // Registration order is precedence (P2-E15-02), and bootstrap is the only
    // module that registers — so swapping the default is a bootstrap edit, not
    // a string spread through the session core. Existing cards keep the
    // provider they were created with (see planSessionStart).
    const defaultProviderId = (): string => {
      const first = registry.list('provider-adapter')[0];
      if (!first) throw new Error('no provider adapter registered — bootstrap did not run');
      return first.manifest.id;
    };

    // session core (E2) bootstrap
    const stateDir = path.join(app.getPath('userData'), 'sessions');
    const ptys = new PtyService();
    // The stream transport, finally constructed (P2-E18-08a). Every item before
    // this one drove StreamService from tests; nothing in the app had ever made
    // one. It sits BESIDE PtyService, which is the whole shape of the migration.
    const streams = new StreamService();
    const manager = new SessionManager(registry, ptys, createLogger(sink, 'sessions'), stateDir, {
      stream: streams,
    });
    // can_use_tool -> the approval bar (P2-E18-07). Answers go back on the same
    // session's transport, which only the manager can reach.
    const streamPermissions = new StreamPermissions(
      (sessionId, msg) => manager.sendToTransport(sessionId, msg),
      createLogger(sink, 'permissions')
    );
    manager.onStreamMessage((sessionId, msg) => streamPermissions.offer(sessionId, msg));
    // the CLI's own slash-command list, off the same stream (P2-E18-09).
    //
    // A SEPARATE subscription, not a second call inside the one above: the
    // manager wraps each listener in its own try/catch so "a broken subscriber
    // must never take the pump down" (P6). Two offers sharing one listener
    // would put them back in the same blast radius — a throw from the
    // permission router would silently stop the command list updating, for ever
    // and with no symptom but a stale popup.
    const streamCommands = new StreamCommands(createLogger(sink, 'sessions'));
    manager.onStreamMessage((sessionId, msg) => streamCommands.offer(sessionId, msg));
    // The Feed, off the same stream (P2-E18-10). A THIRD subscription, for the
    // reason spelled out above: one listener per consumer, one blast radius
    // each. This one carries the most traffic by far — S-11 counted 719
    // `stream_event`s against 27 `assistant` messages in a working day.
    const streamFeed = new StreamFeed(createLogger(sink, 'sessions'));
    manager.onStreamMessage((sessionId, msg) => streamFeed.offer(sessionId, msg));
    // A turn that never produced a `result` must not leave a block claiming to
    // still be filling in (#140). The session's exit is the last honest moment
    // to say so.
    manager.onSessionExit((e) => streamFeed.finalize(e.sessionId));
    const hooks = new HookListener({
      stateDir,
      manager,
      log: createLogger(sink, 'hooks'),
      // hold policy (E10-03): gate by the session's own autonomy + folder
      autonomyFor: (id) => manager.get(id)?.autonomy,
      cwdFor: (id) => manager.get(id)?.identity.folder,
      // a stream session's permissions ride can_use_tool, never a held hook
      transportFor: (id) => manager.get(id)?.transport,
      // Is there anyone to ask? A destroyed window or a crashed renderer means
      // no (P2-E15-09). A RELOADING renderer is neither, so the pending-holds
      // replay path still gets its chance — that case must not regress.
      hasLiveWindow: () => {
        const w = currentWindow;
        return !!w && !w.isDestroyed() && !w.webContents.isCrashed();
      },
    });
    onRendererLost = (reason) => hooks.releaseHeld(reason);
    // Only the DEFAULT provider's root, and only as a seed for "files that were
    // already on disk before we started" — every session brings the root its own
    // provider declared (P2-E15-01). Undefined when the default provider has no
    // transcripts, in which case nothing is watched anyway. Guarded because this
    // is contributor code running before the first window exists: an adapter
    // that throws here would take startup down with it.
    let seedRoot: string | undefined;
    try {
      seedRoot = registry
        .resolve('provider-adapter', defaultProviderId())
        ?.capabilities?.transcripts?.projectsRoot();
    } catch (err) {
      log.app.warn('default provider transcripts root failed', { error: String(err) });
    }
    const transcripts = new TranscriptWatcher({
      projectsRoot: seedRoot,
      log: createLogger(sink, 'transcripts'),
      // Test-only: the real deadline is 45s, which no e2e should sit through.
      // Read only in a dev/test build, so the shipped binary has no env var
      // that can move a user-visible deadline (P2-E15-10).
      bindGiveUpMs: app.isPackaged ? undefined : positiveMs(process.env.SWITCHBOARD_BIND_GIVEUP_MS),
    });
    void hooks.start().catch((err) => {
      // hooks are an accelerator, not the authority — start-failure degrades
      log.app.error('hook listener failed to start', { error: String(err) });
    });
    // ── update checks (P2-E19-03, §E19) ──────────────────────────────────
    //
    // The ONE outbound network call this app makes, and the only host it may
    // reach is the release feed. Everything about it is fail-open: no token
    // means no checks (silently), a dead feed means a log line, and a check in
    // flight at quit writes nothing.
    const updates = new UpdateService({
      currentVersion: app.getVersion(),
      getPrefs: () => workspace.getUpdatePrefs(),
      setPrefs: (patch) => workspace.setUpdatePrefs(patch),
      // `currentWindow` is reassigned on macOS re-activate, so this reads it
      // fresh — the convention every other push in this file follows.
      push: (status) => pushToRenderer?.(currentWindow, 'update:status', status),
      log: createLogger(sink, 'updates'),
      // Dev/test only. A packaged build has no environment variable that can
      // move its update feed (the P2-E15-10 rule for SWITCHBOARD_BIND_GIVEUP_MS).
      feedOverride: app.isPackaged ? undefined : process.env[FEED_ENV],
    });
    updates.start();
    broker.handle('update:check', (_e, opts: { manual?: boolean } = {}) =>
      // `push: false` — this caller gets the answer as the return value, and
      // pushing as well would open the dialog twice.
      updates.check(opts?.manual === true, { push: false })
    );
    broker.handle('update:getPrefs', () => workspace.getUpdatePrefs());
    broker.handle('update:setPrefs', (_e, p: { autoCheck?: boolean; skippedVersion?: string }) => {
      // Narrowed by hand rather than passed through: `lastCheck` is the
      // service's own bookkeeping and must not be settable from the renderer.
      if (typeof p?.autoCheck === 'boolean') workspace.setUpdatePrefs({ autoCheck: p.autoCheck });
      if (typeof p?.skippedVersion === 'string') updates.skip(p.skippedVersion);
      return workspace.getUpdatePrefs();
    });
    broker.handle('update:openExternal', (_e, url: string) => {
      // The strings that reach here came out of a release body we rendered, so
      // the allowlist is tight and lives next to the checker (§5.29).
      if (!isAllowedReleaseUrl(url)) {
        log.app.warn('refused to open a link from the update dialog', { url: String(url).slice(0, 200) });
        return false;
      }
      // `openExternal` REJECTS when the OS has no handler for the scheme. An
      // unhandled rejection in main is an "A JavaScript error occurred" modal
      // — the exact opposite of fail-open, from a button whose worst case
      // should be "nothing happened".
      void shell
        .openExternal(url)
        .catch((err: unknown) => log.app.warn('could not open the release page', { error: String(err) }));
      return true;
    });

    // own the menu BEFORE the first window: Electron's default one registers
    // Ctrl+W (closes the window and every session in it) and Ctrl+R (reloads
    // the renderer mid-session) in the browser process, ahead of the
    // renderer's command registry (E9-01)
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildMenuTemplate(process.platform, {
          // A menu click has no return path to the caller, so this one PUSHES
          // — and swallows its own failure: `push` reaches `webContents.send`,
          // which throws if the window died between the click and the answer,
          // and an unhandled rejection in main is an error modal.
          checkForUpdates: () =>
            void updates
              .check(true, { push: true })
              .catch((err: unknown) =>
                log.app.warn('menu update check failed', { error: String(err) })
              ),
        })
      )
    );
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
    broker.handle('preflight:check', () => runPreflight());
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
    broker.handle('git:status', (_e, folder: string) =>
      knownFolder(folder) ? gitService.status(folder) : { isRepo: false, files: [] }
    );
    broker.handle('git:fileVersions', (_e, folder: string, file: string) => {
      // scope to a known folder AND forbid escaping it (path traversal)
      if (!knownFolder(folder)) return { original: '', modified: '' };
      const resolved = path.resolve(folder, file);
      if (resolved !== path.resolve(folder) && !resolved.startsWith(path.resolve(folder) + path.sep)) {
        return { original: '', modified: '' };
      }
      return gitService.fileVersions(folder, file);
    });
    broker.handle('notifications:getPrefs', () => workspace.getNotificationPrefs());
    broker.handle('notifications:setPrefs', (_e, p) => {
      workspace.setNotificationPrefs(p);
      return workspace.getNotificationPrefs();
    });
    broker.handle('settings:getAutoTrust', () => workspace.getAutoTrust());
    broker.handle('settings:setAutoTrust', (_e, on: boolean) => {
      workspace.setAutoTrust(on === true);
      return workspace.getAutoTrust();
    });
    registerSessionIpc({
      manager,
      ptys,
      streamPermissions,
      streamCommands,
      streamFeed,
      hooks,
      transcripts,
      feed,
      broker,
      log: createLogger(sink, 'ipc'),
      getWindow: () => currentWindow, // reassigned on macOS re-activate
      autoTrust: () => workspace.getAutoTrust(),
      persist: {
        list: () => workspace.listSessions(),
        upsert: (s) => workspace.upsertSession(s),
        remove: (cardId) => workspace.removeSession(cardId),
      },
      capabilitiesOf: (providerId) =>
        registry.resolve('provider-adapter', providerId)?.capabilities,
      isRegisteredProvider: (providerId) => !!registry.resolve('provider-adapter', providerId),
      defaultProviderId,
      repoRoot: (folder) => gitService.root(folder),
      slashCommands: (folder, providerId) =>
        scanSlashCommands(
          { cwd: folder, userClaudeDir: path.join(os.homedir(), '.claude') },
          registry.resolve('provider-adapter', providerId)?.slashCommands?.() ?? [],
          // `warn`: everything this callback carries is a scan that failed and
          // fell open to a shorter list. The line you grep for after "my
          // commands vanished" should not sit at info among routine chatter.
          (msg) => log.app.warn(msg)
        ),
      // Env-selected until P2-E18-08b (#149) gives it a per-session setting —
      // the same way the two fakes are selected, and deliberately NOT a UI
      // control yet, because a half-wired mode with a switch on it invites
      // being switched.
      preferredTransport: () =>
        process.env.SWITCHBOARD_TRANSPORT === 'stream' ? 'stream' : undefined,
    });
    app.on('quit', () => {
      ptys.killAll();
      streams.killAll();
      hooks.stop();
      transcripts.stop();
      updates.stop(); // kills the daily timer; a check in flight becomes a no-op
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
