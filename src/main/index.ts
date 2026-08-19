import {
  app,
  BrowserWindow,
  Menu,
  net,
  Notification,
  safeStorage,
  screen,
  session,
  shell,
} from 'electron';
import path from 'path';
import { windowOptionsFrom, WindowState } from './window-state';
import { WorkspaceStore, displayFingerprint } from './workspace/store';
import os from 'os';
import { LogSink, createLogger } from './log/logger';
import { registerBuiltinContributions } from './bootstrap';
import { registry } from './extensibility';
import { PtyService } from './pty/pty-service';
import { StreamService } from './transport/stream-service';
import { createDiagnosticLogger } from './transport/diagnostics';
import { parsePreferredTransport, TRANSPORT_ENV_VAR } from './transport/preferred-transport';
import { StreamPermissions } from './sessions/stream-permissions';
import { StreamCommands } from './sessions/stream-commands';
import { StreamFeed } from './feed/stream-feed';
import { SessionManager } from './sessions/session-manager';
import { HookListener } from './hooks/hook-listener';
import { TranscriptWatcher } from './transcripts/watcher';
import { registerSessionIpc, SessionIpcHandle } from './sessions/ipc';
import { registerGroupIpc } from './workspace/group-ipc';
import { registerFsIpc } from './fs/ipc';
import { ReadScope } from './fs/read-scope';
import { IpcBroker } from './ipc/broker';
import { allCapabilities, Channel } from '../shared/ipc/capabilities';
import { EventFeed } from './events/feed';
import { Notifier, quietWindowOf } from './events/notifier';
import {
  ACTION_OS_TOAST,
  ACTION_PUSH,
  ACTION_SOUND,
  ACTION_SPEAK,
  ACTION_WEBHOOK,
  defaultRules,
  inQuietWindow,
  visibilityAcross,
} from './events/rules';
import type { QuietState } from '../shared/quiet-hours';
import { RuleActionRegistry, RulesEngine } from './events/rules-engine';
import {
  answerableFromToast,
  DECIDE_BUTTONS,
  DECIDE_BUTTON_LABELS,
  PermissionToasts,
  permissionSummary,
  toastActionsSupported,
} from './events/permission-toast';
import { registerRulesIpc } from './events/rules-ipc';
import { DEFAULT_SOUND } from '../shared/sounds';
import { SoundActions } from './events/sound-actions';
import { createRendererAudioSink } from './events/audio-sink';
import { registerSoundIpc } from './events/sound-ipc';
import { PushActions } from './events/push-actions';
import { registerPushIpc } from './events/push-ipc';
import { SecretStore } from './secrets/store';
import { GitService } from './git/git-service';
import { runPreflight } from './preflight';
import { startStaticServer, StaticServer } from './static-server';
import { installCspHeaders } from './csp';
import { parsePopoutFeatures } from './popout-bounds';
import { scanSlashCommands } from './capabilities/slash-commands';
import { buildMenuTemplate } from './app-menu';
import { UpdateService, FEED_ENV, isAllowedReleaseUrl } from './update/service';
import { UpdateInstaller, UPDATE_DIR_NAME, resolveHandshake, resolveOffer } from './update/install';
import { launchInstaller } from './update/installer';
import type { UpdateHandshake, UpdateInstallStatus } from '../shared/update';
import { ServiceHealthService } from './health/service';
import { SERVICE_STATUS_FEED_ENV } from './health/statuspage';
import { installTerminalAccelerators, makeAcceleratorDeps } from './terminal-accelerators';
import type { ContextMenuDeps } from './context-menu';
import { installContextMenu, makeContextMenuDeps, sanitizeContextMenuLabels } from './context-menu';
import type { ContextMenuLabels } from '../shared/context-menu';
import { DEFAULT_CONTEXT_MENU_LABELS } from '../shared/context-menu';
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
import { acquireInstanceLock, focusRunningWindow, sleepSync } from './single-instance';

/* ---- ONE switchboard per user profile (#289) -------------------------------
 *
 * FIRST, deliberately — above every other statement in this file, because the
 * only thing that makes the lock worth having is that it is taken before
 * anything touches `userData`. Nothing below this point may move above it, and
 * `single-instance.test.ts` pins that textually.
 *
 * What a second instance does WITHOUT the lock is not "two windows, mildly
 * confusing": both instances derive the same fixed `stateDir` from `userData`,
 * so the newcomer's startup sweep deletes the first instance's LIVE hook token
 * files (#282). The first app keeps running and looks fine, but every hook the
 * CLI fires at it now 401s — no status flips, no native-id binding, no
 * permission holds — and the only symptom is a log full of `hook request
 * rejected`. Fail-open becomes fail-BLIND. The workspace store is the same
 * story with a slower fuse: two processes with the same `workspace.json` open,
 * last writer wins, layouts and session records silently lost on quit.
 *
 * The lock is scoped to the userData directory (Chromium's ProcessSingleton),
 * which is why the e2e fixture's per-test isolated homes each get their own and
 * the suite is unaffected — see `e2e/single-instance.spec.ts`.
 */
const isPrimaryInstance = acquireInstanceLock({
  tryLock: () => app.requestSingleInstanceLock(),
  sleep: sleepSync,
  // `process.env` and not the `DEV_URL` const below: this runs during module
  // evaluation, where that const is still in its temporal dead zone. Same
  // variable, and it is set by exactly one thing — electron-vite's dev server —
  // which is exactly the case that needs the retry (see acquireInstanceLock).
  retryForMs: process.env.ELECTRON_RENDERER_URL ? 3_000 : 0,
});
if (!isPrimaryInstance) {
  // `requestSingleInstanceLock()` has ALREADY told the primary we are here (the
  // notification is part of taking the lock, not of quitting), so there is
  // nothing left to do but leave — before a log file is opened, before the
  // workspace store is read, before the hook listener sweeps anything.
  // Pre-message-loop, Electron's `quit()` exits the process outright; the guard
  // at the top of `whenReady` below is the belt to this pair of braces.
  app.quit();
} else {
  app.on('second-instance', () => {
    try {
      // The window is the answer 99% of the time. `currentWindow` is set by
      // createWindow() and nulled when it closes, so this is also the "still
      // booting" case — null until the first window exists.
      if (focusRunningWindow(currentWindow)) {
        if (sink) log.app.info('second launch focused the running window');
        return;
      }
      // No window to raise. On macOS the app survives its last window and only
      // `activate` reopens one — a second launch is the other way a user asks
      // for that, and doing nothing would look like a dead app. Guarded on
      // `isReady` because createWindow() needs the workspace store, which the
      // bootstrap has not built yet if a second launch races our own startup.
      if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow();
    } catch (err) {
      // A second launch must never be able to take the running app down. The
      // log line is best-effort too: `sink` does not exist until `whenReady`.
      if (sink) log.app.warn('second-instance handling failed', { error: String(err) });
    }
  });
}

/** Stamped in at build time (P2-E15-15); constant for the process lifetime. */
const BUILD_IDENTITY = buildIdentity();
/** The name the OS window carries when there is nothing unusual to report. */
const APP_NAME = 'switchboard.ai';

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
/**
 * **The notification stack's one clock** (P2-E14-05b).
 *
 * Quiet hours made time a rule CONDITION, and a condition that each consumer
 * read from its own `new Date()` would be a condition that three code paths can
 * disagree about — the beep, the rules and the record all deciding
 * independently whether it is 06:59 or 07:00. `RulesEngine` and `Notifier` both
 * take this function, and the trigger carries the Date it returned, so the pure
 * evaluator never calls a clock at all and every case is a table test.
 */
const clock = (): Date => new Date();
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

/**
 * `SWITCHBOARD_MUTE_AUDIO=1` — behave exactly as though the cue was played, and
 * play nothing (P2-E14-05a). For the e2e suite, which runs on the machine its
 * owner is sitting at.
 *
 * NON-PACKAGED BUILDS ONLY, the rule `SWITCHBOARD_BIND_GIVEUP_MS` and the
 * update feed already follow: a stray variable in a user's environment must
 * never be able to silence the shipped app's notifications.
 */
function audioMuted(): boolean {
  return !app.isPackaged && !!process.env.SWITCHBOARD_MUTE_AUDIO;
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

/**
 * Right-click edit menus (#526).
 *
 * The labels are the renderer's — it owns i18next — and arrive on
 * `app:contextMenuLabels` at boot and on every language change. English until
 * then: a window exists before its renderer has mounted, and a right-click in
 * that gap must still get a working menu.
 */
let contextMenuLabels: ContextMenuLabels = DEFAULT_CONTEXT_MENU_LABELS;
// The menu is anchored to the window that was clicked. The ROLES act on the
// FOCUSED webContents — which is that same window, popout included, because
// clicking it focused it.
const contextMenuDeps: ContextMenuDeps = makeContextMenuDeps({
  labels: () => contextMenuLabels,
  windowFor: (contents) => BrowserWindow.fromWebContents(contents),
  build: (template) => Menu.buildFromTemplate(template),
  onError: (err) => log.ui.warn('context menu failed', { error: String(err) }),
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
        `--switchboard-seed-document=${process.env.SWITCHBOARD_SEED_DOCUMENT ?? ''}`,
        // The renderer plays two cues main never sends it — the card menu's
        // preview and the "hear what you just turned on" sample — so the mute
        // has to reach this side too, or a muted e2e run still makes a noise.
        `--switchboard-mute-audio=${audioMuted() ? 1 : 0}`,
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
  // Cut/Copy/Paste/Select All on right-click (#526). Electron provides no
  // default menu, so without this every right-click in the app does nothing.
  installContextMenu(win.webContents, contextMenuDeps);
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
          // it an ungranted caller, and since #346 that fails QUIETLY: every
          // `invoke` RESOLVES an `IpcRefusal` (`shared/ipc/refusal.ts`) that the
          // renderer's code is not checking for, so a card list arrives as a
          // refusal object rather than as a rejection, and `on`-channels are
          // dropped with only a log line. Grant it here if you ever add one.
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
    // ...and its right-click menus (#526). `context-menu` is per-webContents
    // too, so a popped-out composer would otherwise be the one text box in the
    // app you cannot paste into with the mouse.
    installContextMenu(child.webContents, contextMenuDeps);
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
    // A losing instance must not reach ONE line of this: the very next
    // statement creates a log file under `userData`, and everything after it
    // reads or writes state the running instance owns (#289). Belt to the
    // `app.quit()` above — which, called before the message loop starts, exits
    // the process outright, so in practice this is never reached. It is here
    // because "in practice" is doing a lot of work in that sentence, and the
    // cost of being wrong is the silent hook-blinding this item exists to fix.
    if (!isPrimaryInstance) return;
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
      createLogger(sink, 'workspace'),
      // Saving started failing, or started working again (#207). Pushed rather
      // than polled because — unlike read-only, which latches at load — this
      // changes while the user is looking at the window, and the notice has to
      // come DOWN as well as up. `currentWindow` is read at call time, so a
      // change before the window exists simply has nowhere to go; the window
      // reads `workspace:saveState` when it mounts and catches up.
      (state) => pushToRenderer?.(currentWindow, 'workspace:saveStateChanged', state)
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
    // The other half of the same story (#207): the file is writable in
    // principle, but the writes are failing — a full disk, a permission, an
    // anti-virus sitting on the folder. Unlike read-only this comes and goes,
    // so it is pushed on `workspace:saveStateChanged` too; this read is what a
    // window that opened mid-failure uses to catch up.
    broker.handle('workspace:saveState', () => workspace.saveState());
    // renderer-owned UI state (E12-08): focus, view tabs, prefs
    broker.handle('workspace:getUi', () => workspace.getUi());
    broker.on('workspace:setUi', (_e, ui: unknown) => workspace.setUi(ui));
    // the renderer is listening for claimed chords (#90) — until this arrives,
    // nothing is taken from the page
    broker.on('app:acceleratorReady', (e) => {
      acceleratorReadyFor = e.sender.id;
    });
    // The four right-click labels, already translated (#526). Main has no
    // i18n; the renderer publishes them at boot and on every language change.
    // Sanitized rather than trusted — they become items in a NATIVE menu.
    broker.on('app:contextMenuLabels', (_e, raw: unknown) => {
      contextMenuLabels = sanitizeContextMenuLabels(raw);
      // Said out loud because the failure is otherwise SILENT: a renamed
      // channel, a caller without `app.window`, a preload that did not load —
      // every one of them leaves the menus in English for ever with nothing
      // anywhere to read. One line at boot answers "did the labels arrive?".
      log.ui.info('context menu labels received', { paste: contextMenuLabels.paste });
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
    // Bring a popped-out window to the front (#571).
    //
    // THE RENDERER CANNOT DO THIS, and that is the whole bug. `focusSession`
    // has asked for it since E9-01 — it calls `location.getWindow()?.focus()`
    // on the popout's DOM window — but `window.focus()` does not raise an OS
    // window on Windows, so clicking a popped-out session in the rail focused
    // the panel inside a window that stayed buried. The intent was right and
    // the mechanism was never able to carry it.
    //
    // `groupId` names a window MAIN ITSELF made: `popoutWindows` is filled from
    // `did-create-window` and keyed by the dockview group in the frame name, so
    // a renderer-supplied id can only ever select a window we already opened, or
    // nothing (#531's rule, reused rather than re-argued).
    //
    // NOTHING HERE TOUCHES THE OTHER DIRECTION, deliberately: focusing the main
    // window still leaves popouts where they are. The owner asked for that to
    // stay, and it stays because raising is only ever done on an explicit
    // request for a particular session — never on window focus.
    broker.handle('app:raisePopout', (_e, groupId: unknown) => {
      if (typeof groupId !== 'string' || !groupId) return false;
      const hit = popoutWindows.find((p) => p.groupId === groupId);
      const win = hit && !hit.win.isDestroyed() ? hit.win : null;
      if (!win) return false;
      // minimized counts as "behind": restore before raising, or focus() on a
      // minimized window is a taskbar flash and nothing else
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return true;
    });
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
    registerGroupIpc(workspace, broker, createLogger(sink, 'workspace'));
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
    // ...with its diagnostics pointed at the log (#449). Every parse failure,
    // overlong line, stderr byte and dead-pipe write this transport noticed
    // between E18-03 and now was produced and dropped, because nothing ever
    // passed the callback. `transport/diagnostics.ts` records the reasoning for
    // the log rather than the Events panel, and why deleting the emitter would
    // have been the wrong half of the choice.
    const streams = new StreamService({
      onDiagnostic: createDiagnosticLogger(createLogger(sink, 'transport')),
    });
    const manager = new SessionManager(registry, ptys, createLogger(sink, 'sessions'), stateDir, {
      stream: streams,
    });
    // Last run's session state directories, taken NOW (#290) — before
    // `registerSessionIpc` (far below), which is the only door a session can be
    // spawned through, so no session of ours can exist and no directory on disk
    // can belong to a live process. That placement is the sweep's safety
    // argument together with the single-instance lock this bootstrap takes at
    // its first statement, and it is NOT free to move below
    // `registerSessionIpc`; `single-instance.test.ts` pins the order.
    //
    // Wrapped for the same reason the seed-root probe and `resolveHandshake`
    // below are: this runs inside the bootstrap's promise chain, whose `.catch`
    // exits the process. Disk housekeeping must never be the thing that stops
    // the app from starting, and that guarantee should not depend on
    // `session-state.ts` staying throw-free for ever.
    //
    // `HookListener.start` sweeps the same tree for stray `hook-token` files a
    // beat later — that one still earns its place, for the directories this
    // sweep is too young to take.
    try {
      manager.sweepOrphanStateDirs();
    } catch (err) {
      log.app.warn('session state dir sweep failed', { error: String(err) });
    }
    // Is there anyone to ask? A destroyed window or a crashed renderer means no
    // (P2-E15-09). A RELOADING renderer is neither, so the pending-holds replay
    // path still gets its chance — that case must not regress.
    //
    // ONE expression, shared by both permission channels (#319). They ask the
    // same question and must not be able to answer it differently: two copies
    // that drifted would mean one channel failing open while the other parked
    // the CLI, which is the exact bug #319 exists to close.
    const hasLiveWindow = (): boolean => {
      const w = currentWindow;
      return !!w && !w.isDestroyed() && !w.webContents.isCrashed();
    };
    // can_use_tool -> the approval bar (P2-E18-07). Answers go back on the same
    // session's transport, which only the manager can reach.
    const streamPermissions = new StreamPermissions(
      (sessionId, msg) => manager.sendToTransport(sessionId, msg),
      // …and the answer ends `needs-permission` immediately, rather than when
      // the CLI next speaks (#310). Same collaborator the hook path gets.
      (sessionId, ev) => manager.apply(sessionId, ev),
      createLogger(sink, 'permissions'),
      // …and it fails open like a hook hold does (#319). Without these a closed
      // window parked a `can_use_tool` for EVER — no timeout, no liveness gate,
      // and nothing to release what was already held.
      { hasLiveWindow }
    );
    manager.onStreamMessage((sessionId, msg) => streamPermissions.offer(sessionId, msg));
    // "Allow all (this session)" means no hold, no needs-permission event and
    // no beep — including in Direct mode (#319). The router answers the call;
    // only the pump can stop the status that rings the bell. See
    // `setPermissionHoldSuppressor`.
    manager.setPermissionHoldSuppressor((sessionId) => streamPermissions.isAllowAll(sessionId));
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
    // ── provider service health (P2-E14-07, §5.14) ────────────────────────
    //
    // The FOURTH subscription to the same stream, for the reason spelled out
    // above: one listener per consumer, one blast radius each. This one reads
    // exactly one thing — whether a turn ended in an error — because "several
    // sessions failing at once" is the local half of "is it me or is it them?",
    // and a failed turn is otherwise indistinguishable from a finished one.
    const health = new ServiceHealthService({
      getPrefs: () => workspace.getServiceHealthPrefs(),
      // `currentWindow` is reassigned on macOS re-activate, so this reads it
      // fresh — the convention every other push in this file follows.
      push: (status) => pushToRenderer?.(currentWindow, 'health:status', status),
      log: createLogger(sink, 'health'),
      // Dev/test only, and the reason no test in this repo ever reaches the
      // real status page. Same P2-E15-10 rule as the update feed: a packaged
      // build has no environment variable that can move a user-visible
      // endpoint.
      feedOverride: app.isPackaged ? undefined : process.env[SERVICE_STATUS_FEED_ENV],
      // "no polling when offline is detected" (§5.14). Electron's own answer,
      // not a heuristic of ours.
      isOnline: () => net.isOnline(),
      probeDeps: { userAgent: app.getVersion() },
    });
    manager.onStreamMessage((sessionId, msg) => health.noteStreamMessage(sessionId, msg));
    // A session that is gone stops corroborating anything.
    manager.onSessionExit((e) => health.forgetSession(e.sessionId));
    const hooks = new HookListener({
      stateDir,
      manager,
      log: createLogger(sink, 'hooks'),
      // hold policy (E10-03): gate by the session's own autonomy + folder
      autonomyFor: (id) => manager.get(id)?.autonomy,
      cwdFor: (id) => manager.get(id)?.identity.folder,
      // a stream session's permissions ride can_use_tool, never a held hook
      transportFor: (id) => manager.get(id)?.transport,
      // shared with the stream channel — see its declaration above
      hasLiveWindow,
    });
    // BOTH channels, always (#319). The hook path has failed open on a lost
    // renderer since P2-E15-09; the stream path had no equivalent at all, so a
    // closed window left its `can_use_tool` parked with no deadline behind it.
    //
    // Isolated from each other on purpose: this runs while the window is going
    // away, both halves answer somebody who is BLOCKED, and a throw out of the
    // first one must not be why the second never ran. Same argument as
    // `tearDownStep`'s in sessions/ipc.ts.
    onRendererLost = (reason) => {
      for (const [what, release] of [
        ['hooks', () => hooks.releaseHeld(reason)],
        ['stream', () => streamPermissions.releaseHeld(reason)],
      ] as const) {
        try {
          release();
        } catch (err) {
          log.app.error('releasing held permissions failed', { channel: what, error: String(err) });
        }
      }
    };
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
    const feedOverride = app.isPackaged ? undefined : process.env[FEED_ENV];
    // `off` is a switch, not a feed. Only a URL widens what the installer is
    // allowed to talk to (see `allowLoopback` below).
    const feedUrlOverride = feedOverride && feedOverride.trim() !== 'off' ? feedOverride : undefined;
    const updateLog = createLogger(sink, 'updates');
    // ── the post-update handshake (E19-04) ───────────────────────────────
    //
    // FIRST, before anything else in this block: it reads and clears a flag the
    // PREVIOUS run wrote just before it quit, and it is the only evidence that
    // the install went through — the process that could have reported it is the
    // one that was replaced. Held in a local for the renderer to collect when
    // it mounts.
    //
    // Wrapped, like the provider-adapter probe above and for the same reason:
    // this runs inside the bootstrap's promise chain, whose `.catch` exits the
    // process. Nothing in the update path is allowed to be the thing that stops
    // the app from starting.
    let handshake: UpdateHandshake | null = null;
    try {
      handshake = resolveHandshake({
        currentVersion: app.getVersion(),
        getPrefs: () => workspace.getUpdatePrefs(),
        setPrefs: (patch) => workspace.setUpdatePrefs(patch),
        log: updateLog,
      });
    } catch (err) {
      log.app.warn('the post-update handshake could not be resolved', { error: String(err) });
    }
    // The download/verify/install half (E19-04). Constructed before the
    // service, which asks it whether an install is running before it prompts.
    // One definition: the directory we stage into is also the ONLY directory
    // `launchInstaller` will execute from, and two spellings of it would make
    // that containment check a coincidence rather than a guarantee.
    const updateDir = path.join(app.getPath('temp'), UPDATE_DIR_NAME);
    const installer = new UpdateInstaller({
      currentVersion: app.getVersion(),
      updateDir,
      getPrefs: () => workspace.getUpdatePrefs(),
      setPrefs: (patch) => workspace.setUpdatePrefs(patch),
      push: (status) => pushToRenderer?.(currentWindow, 'update:installStatus', status),
      log: updateLog,
      // A stub feed serves its assets over http on loopback and wants no
      // credentials. Both are gated on a feed override that names a URL —
      // `off` disables checks entirely and must not quietly widen what the
      // downloader will talk to. A packaged build can set neither, so the
      // shipped app downloads over https from the API host only, with a
      // locally-resolved token, exactly as §E19 requires.
      allowLoopback: !!feedUrlOverride,
      skipToken: !!feedUrlOverride,
      quitAndRun: (file) => {
        // An update is a quit, so it asks the same question the X button asks
        // — a mid-task session deserves the same warning either way. Answering
        // "cancel" here means nothing is executed at all (`install.ts` rolls
        // the pending version back), which is why the confirmation comes
        // BEFORE the spawn and not after it.
        const win = currentWindow;
        if (win && !win.isDestroyed() && !confirmCloseWithBusySessions(win)) return 'declined';
        // The e2e seam. Non-packaged builds only, like every other one: the
        // suite drives this path end to end and must not actually run an
        // installer or take the app down mid-suite.
        if (!app.isPackaged && process.env.SWITCHBOARD_UPDATE_NO_LAUNCH) {
          updateLog.info('install launch suppressed by the test seam', { file });
          return 'quit';
        }
        // FLUSH, before anything can replace this process. `setUpdatePrefs`
        // debounces by 500ms, and the pending version is the whole handshake:
        // relying on some other subsystem's close handler to get it to disk
        // would make the feature's core deliverable depend on an unrelated
        // refactor never happening.
        workspace.save();
        if (!launchInstaller(file, { updateDir })) return 'failed';
        quitConfirmed = true;
        app.quit();
        return 'quit';
      },
    });
    // Stale installers are ~120 MB each. Nothing can be downloading yet — this
    // runs before the first window — so the sweep is unconditional.
    void installer
      .sweep()
      .catch((err: unknown) => log.app.warn('the installer sweep failed', { error: String(err) }));
    const updates = new UpdateService({
      currentVersion: app.getVersion(),
      getPrefs: () => workspace.getUpdatePrefs(),
      setPrefs: (patch) => workspace.setUpdatePrefs(patch),
      // `currentWindow` is reassigned on macOS re-activate, so this reads it
      // fresh — the convention every other push in this file follows.
      push: (status) => pushToRenderer?.(currentWindow, 'update:status', status),
      log: updateLog,
      // Dev/test only. A packaged build has no environment variable that can
      // move its update feed (the P2-E15-10 rule for SWITCHBOARD_BIND_GIVEUP_MS).
      feedOverride,
      installBusy: () => installer.busy(),
    });
    updates.start();
    broker.handle('update:check', (_e, opts: { manual?: boolean } = {}) =>
      // `push: false` — this caller gets the answer as the return value, and
      // pushing as well would open the dialog twice.
      updates.check(opts?.manual === true, { push: false })
    );
    // ── the install (E19-04) ─────────────────────────────────────────────
    //
    // No arguments: main installs the release IT found. The renderer asking
    // "install this URL" would be the renderer choosing what gets executed, and
    // the whole capability is built the other way round.
    broker.handle('update:install', async (): Promise<UpdateInstallStatus> => {
      const offered = updates.lastResult();
      // The renderer's dialog is showing something main no longer believes — a
      // window left open across a release being withdrawn (#315). Answer
      // honestly, and with the RIGHT reason: `no-offer` says the offer is gone,
      // where the `no-asset` this used to return blamed the release's files.
      const decision = resolveOffer(offered);
      if (!decision.ok) {
        updateLog.warn('an install was requested with no release on offer', {
          // The distinction the UI does not carry, kept where it is useful.
          state: offered?.state ?? 'never-checked',
          reason: offered?.reason,
        });
        return decision.status;
      }
      return installer.install(decision.offer);
    });
    broker.handle('update:cancelInstall', () => {
      installer.cancel();
    });
    broker.handle('update:handshake', () => {
      // ONE-SHOT. A second window (macOS re-activate, a reopened popout) is not
      // a second update, and being congratulated twice for one install reads as
      // a bug in the thing whose whole job is to be trustworthy about versions.
      const answer = handshake;
      handshake = null;
      return answer;
    });
    broker.handle('update:getPrefs', () => workspace.getUpdatePrefs());
    broker.handle('update:setPrefs', (_e, p: { autoCheck?: boolean; skippedVersion?: string }) => {
      // Narrowed by hand rather than passed through: `lastCheck` is the
      // service's own bookkeeping and must not be settable from the renderer.
      if (typeof p?.autoCheck === 'boolean') workspace.setUpdatePrefs({ autoCheck: p.autoCheck });
      if (typeof p?.skippedVersion === 'string') updates.skip(p.skippedVersion);
      return workspace.getUpdatePrefs();
    });
    // ── provider service health (P2-E14-07) ──────────────────────────────
    //
    // A mounting window asks once; everything after that arrives on
    // `health:status`. `start()` polls immediately, so the first answer is on
    // its way before the window has finished asking.
    broker.handle('health:get', () => health.current());
    broker.handle('health:getPrefs', () => workspace.getServiceHealthPrefs());
    broker.handle('health:setPrefs', (_e, p: { poll?: boolean }) => {
      if (typeof p?.poll === 'boolean') {
        workspace.setServiceHealthPrefs({ poll: p.poll });
        // start or stop the timer to match — turning it off must actually stop
        // the traffic, not just grey out a checkbox
        health.prefsChanged();
      }
      return workspace.getServiceHealthPrefs();
    });
    health.start();
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
          // File > Open File… (#569) rides the ACCELERATOR CHANNEL, which
          // already exists to do exactly this: carry a command id from the
          // browser process to the renderer, which runs it from the registry
          // (#90). So the menu item and the palette entry are the same command
          // — one dialog, one read-scope grant, one placement rule — rather
          // than a second copy of the sequence living up here.
          //
          // `fromPopout: false`: the click came from the application menu,
          // which belongs to the main window, so running it must not raise a
          // popout the user was not looking at.
          openFile: (from) => {
            // THROUGH THE SAME GATE THE CHORDS USE, not around it (#569 review).
            // `deliver` refuses until the renderer has actually subscribed
            // (`acceleratorReadyFor`), which is a real window: one exists before
            // its renderer mounts, and `did-start-loading` resets the flag on
            // every reload. Pushing directly skipped that check, so a click
            // during startup landed nowhere and said nothing.
            //
            // `fromPopout` is computed from the window Electron reports, not
            // assumed: the application menu is SHARED with popped-out session
            // windows, so File > Open File… exists in them too, and a click
            // there must not open a viewer in a main window nobody is looking
            // at.
            const fromPopout = !!from && from !== currentWindow;
            if (!acceleratorDeps(fromPopout).deliver('view.openFile')) {
              // Not a crash and not silence: a menu item that did nothing is
              // exactly what someone greps for afterwards.
              log.app.warn('menu open-file could not reach the renderer', { fromPopout });
            }
          },
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

    // ── the notification rules engine (P2-E14-03, §5.9) ──────────────────
    //
    // Assembled here because this is the only file allowed to touch
    // `Notification`; everything above it (`events/rules.ts`,
    // `events/rules-engine.ts`) is pure and testable without electron.
    const rulesLog = createLogger(sink, 'rules');

    // ── P2-E14-04: the toast can ANSWER, not just announce ────────────────
    //
    // Late-bound onto `sessionIpc` exactly like `cardIdForLive` below, for the
    // same reason: the toast's decision must be the app's ONE decision path
    // (`sessions/ipc.ts`), and that closure does not exist until
    // `registerSessionIpc` returns a few dozen lines further down. Nothing can
    // ask before then — a toast needs a permission, a permission needs a
    // session, and no session exists yet.
    let sessionIpcRef: SessionIpcHandle | null = null;
    const permissionToasts = new PermissionToasts({
      decide: (requestId, decision) =>
        sessionIpcRef?.decidePermission(requestId, decision) ?? false,
      reveal: (cardId) => {
        // Raise the window FIRST (the same helper a second launch uses, which
        // is the one place that knows restore-then-show-then-focus is three
        // different fixes), then tell the renderer which card to land on.
        focusRunningWindow(currentWindow);
        if (cardId) broker.send(currentWindow, 'sessions:revealCard', { cardId });
      },
      log: rulesLog,
    });
    // A verdict from ANY surface — the approval bar, the Events panel's inline
    // buttons, the batch band, a session teardown releasing its holds, or the
    // toast itself — withdraws the toast. Both routers, because a permission
    // rides whichever transport its session is on and the toast cannot tell.
    hooks.onPermissionResolved((requestId) => permissionToasts.withdraw(requestId));
    streamPermissions.onPermissionResolved((requestId) =>
      permissionToasts.withdraw(requestId)
    );

    const ruleActions = new RuleActionRegistry(rulesLog);
    ruleActions.register(ACTION_OS_TOAST, (action, ctx) => {
      // Whether the OS can display a notification at all is an ENVIRONMENT
      // fact, not a decision this rule made: a Linux box with no notification
      // daemon (a CI container, say) reports `false` here forever. So the two
      // facts are logged separately — the rule fired, and this is whether the
      // desktop took it. A silent early return was the one outcome that could
      // not be debugged, and "why didn't it pop?" is a real support question.
      const shown = Notification.isSupported();
      // P2-E14-04. The request this toast is about, if it is about one at all.
      // Resolved HERE rather than carried on the rule, because whether a
      // permission is still held is a fact about right now: between the event
      // and this line the bar may already have answered it, and a toast
      // offering Allow for a question nobody is holding is worse than no toast.
      //
      // The rule can opt OUT (`buttons: false`) and nothing else about the
      // payload changes — deliberately not opt-in, because the payload is also
      // the dedup key (`plannedActions`), and a default rule that carried
      // `buttons` while a user's hand-written toast rule did not would produce
      // TWO toasts for one permission. Opt-out also happens to be the right
      // default: there is no sane rule that says "tell me, but do not let me
      // answer".
      const req =
        ctx.event.kind === 'needs-permission' && action.buttons !== false
          ? (sessionIpcRef?.pendingPermissionFor(ctx.event.sessionId) ?? null)
          : null;
      // A QUESTION gets no buttons (#563). `answerableFromToast` carries the
      // measurement: an allow with no answers is read by the CLI as "the user
      // did not answer", so Allow here would silently discard the question
      // rather than grant it. The click path below still raises the card, which
      // is the only place the question can actually be answered.
      const decidable = !!req && answerableFromToast(req) && toastActionsSupported(process.platform);
      if (shown) {
        const toast = new Notification({
          title: ctx.title,
          body: ctx.body,
          silent: true, // the Notifier's beep is the sound cue
          ...(decidable
            ? {
                actions: DECIDE_BUTTONS.map((d) => ({
                  type: 'button' as const,
                  text: DECIDE_BUTTON_LABELS[d],
                })),
              }
            : {}),
        });
        // A toast the desktop refused is not a toast: without this line the
        // failure is invisible, and "it worked yesterday" has nowhere to look.
        toast.on('failed', (_e, error) =>
          rulesLog.warn('the desktop refused an OS toast', { ruleId: ctx.rule.id, error })
        );
        if (req) {
          const requestId = req.requestId;
          // `details.actionIndex` rather than the positional argument, which
          // electron.d.ts marks deprecated.
          if (decidable) {
            toast.on('action', (details) => permissionToasts.press(requestId, details.actionIndex));
          }
          // Clicking the BODY is a shortcut, never a verdict — wired on every
          // platform, because it is the whole gesture on Linux and the fallback
          // wherever the buttons do not render.
          toast.on('click', () => permissionToasts.activate(requestId, ctx.cardId));
          // Deliberately NOT unhooked on `close`: a Windows toast that times
          // out fires `close` and then sits in the Action Center, where
          // `close()` still removes it. See `PermissionToasts.withdraw`.
          permissionToasts.track(requestId, toast);
        }
        toast.show();
      }
      // The e2e proof that a rule reached the toast action
      // (`e2e/rules.spec.ts`, `e2e/permission-toast.spec.ts`) — and the line to
      // grep after "why did/didn't it pop".
      rulesLog.info('os toast rule fired', {
        kind: ctx.event.kind,
        cardId: ctx.cardId ?? '',
        visibility: ctx.visibility,
        ruleId: ctx.rule.id,
        shown,
        // How many Allow/Deny buttons went on it, and which request they
        // answer. Zero with a requestId present means this desktop cannot
        // carry buttons — the click path is what the user gets.
        buttons: decidable ? DECIDE_BUTTONS.length : 0,
        requestId: req?.requestId ?? '',
      });
    });
    // ── the two channels that leave the machine (P2-E14-06, §5.9 + §5.29) ──
    //
    // Assembled here for the same reason the toast is: this file owns the
    // electron singletons, and `safeStorage` is one. Everything below it —
    // the store, the senders, the deciding — is plain TypeScript that a unit
    // test drives with a fake crypto and a fake `fetch`.
    //
    // Both actions are registered UNCONDITIONALLY, configured or not: an
    // unregistered type is logged as "this build has no handler for it" on
    // every event, which is a lie about the build. The handlers themselves
    // resolve to "not configured" in silence, which is the truth about the
    // machine.
    const pushLog = createLogger(sink, 'push');
    const secretStore = new SecretStore({
      dir: app.getPath('userData'),
      crypto: safeStorage,
      log: pushLog,
    });
    const pushActions = new PushActions({
      secrets: secretStore,
      getPrefs: () => workspace.getPushPrefs(),
      log: pushLog,
      userAgent: app.getVersion(),
    });
    ruleActions.register(ACTION_PUSH, pushActions.pushHandler);
    ruleActions.register(ACTION_WEBHOOK, pushActions.webhookHandler);
    // ── the two channels that stay in the room (P2-E14-05a, §5.9 + §5.11) ──
    //
    // A cue that says WHICH card wants you, and a voice that says it out loud.
    // Both are drop-ins on the same seam as the four above: no rule field, no
    // change to the matcher. The noise itself happens in a renderer window —
    // main has no audio device, Chromium does (`events/audio-sink.ts`).
    //
    // `SWITCHBOARD_MUTE_AUDIO=1` makes the sink log instead of sounding, for
    // the e2e suite, which runs on the machine its owner is sitting at.
    // Non-packaged builds only — the same rule `SWITCHBOARD_BIND_GIVEUP_MS`
    // and the update feed follow, so a stray variable in a user's environment
    // can never silence the shipped app.
    const audioSink = createRendererAudioSink<{
      isDestroyed: () => boolean;
      isCrashed: () => boolean;
      win: BrowserWindow;
    }>({
      // The MAIN window only, and this is not an oversight. A dockview popout
      // (E8) loads `popout.html`, which ships no script of ours on purpose —
      // dockview adopts the group's DOM into it from the opener, so the JS that
      // would receive `audio:play` lives in the main window's realm and nowhere
      // else. Listing a popout here would make the sink answer "taken" for a
      // window that cannot play anything, which is worse than answering
      // "nobody took it": the latter beeps.
      windows: () => [
        currentWindow
          ? {
              isDestroyed: () => currentWindow!.isDestroyed(),
              // a renderer that died leaves this window object alive; see
              // `AudioWindow`. Read through a wrapper because `webContents`
              // itself throws once the window really is destroyed.
              isCrashed: () => currentWindow!.webContents.isCrashed(),
              win: currentWindow,
            }
          : null,
      ],
      send: (w, channel, payload) => broker.send(w.win, channel as 'audio:play', payload),
      muted: audioMuted(),
      log: rulesLog,
    });
    const soundActions = new SoundActions({
      sink: audioSink,
      soundFor: (cardId) => (cardId ? workspace.cardSound(cardId).id : DEFAULT_SOUND.id),
      // The beep the notifier stopped making while cues are on. Without it, an
      // event whose cue reached nobody would be completely silent.
      fallback: () => shell.beep(),
      log: rulesLog,
    });
    ruleActions.register(ACTION_SOUND, soundActions.soundHandler);
    ruleActions.register(ACTION_SPEAK, soundActions.speakHandler);
    // Assigned the moment `registerSessionIpc` returns, a few dozen lines
    // below; until then no session exists, so no event can ask.
    let cardIdForLive: (liveId: string) => string | null = () => null;
    // P2-E7-06 x P2-E14-03 integration (train/2026-08-13): toast titles
    // prefer the card's task label over the session title — the label answers
    // WHAT is waiting, the title answers WHICH. Late-bound exactly like
    // cardIdForLive above; a suppressed auto label returns undefined here too.
    let labelForLive: (sessionId: string) => string | undefined = () => undefined;
    const rules = new RulesEngine({
      getRules: () => workspace.listRules(),
      // ── quiet hours (P2-E14-05b, §5.9) ──
      //
      // The window is read per event like the rules are, so editing it in the
      // dialog takes effect on the next event with nothing to restart. WHICH
      // channels it holds is not decided here — it is per action audience, in
      // `rules.ts` (`quietHolds`), where a table test can reach it.
      getQuietWindow: () => quietWindowOf(workspace.getNotificationPrefs()),
      now: clock,
      // Held events are written down for #483's missed-events digest. Bounded
      // FIFO in the store; the engine only hands over the record.
      onSuppressed: (record) => workspace.recordSuppressed(record),
      // The built-ins are synthesized per event from the switches, push and
      // webhook included — so turning the phone on in the setup dialog takes
      // effect on the next event with nothing to persist and no rule to write.
      getDefaultRules: () => {
        const push = workspace.getPushPrefs();
        // `sounds` and `speak` ride in on the spread — they are notification
        // prefs, so flipping either chip changes the next event with nothing
        // persisted and no rule rewritten, exactly like the toast switch.
        return defaultRules({
          ...workspace.getNotificationPrefs(),
          push: push.push,
          webhook: push.webhook,
        });
      },
      cardIdFor: (liveId) => cardIdForLive(liveId),
      // Every window, not just the main one: a popped-out card (E8) is a
      // window the user can be looking at while the main one is minimized.
      getVisibility: () => visibilityAcross([currentWindow, ...popoutWindows.map((p) => p.win)]),
      titleFor: (e) =>
        labelForLive(e.sessionId) ??
        manager.get(e.sessionId)?.identity.title ??
        'switchboard.ai',
      // P2-E14-04: a permission toast NAMES what it would allow. "needs
      // permission" beside an Allow button asks the user to grant a tool call
      // they cannot see, which is the one thing an off-screen decision path may
      // not do — the promise is that answering from the toast is the same
      // decision they would have made at the bar (§5.9, P6). Every other kind
      // keeps the plain wording.
      bodyFor: (e) => {
        if (e.kind === 'needs-permission') {
          const req = sessionIpcRef?.pendingPermissionFor(e.sessionId);
          if (req) return permissionSummary(req);
        }
        return e.kind.replace(/-/g, ' ');
      },
      registry: ruleActions,
      log: rulesLog,
    });
    registerRulesIpc({
      broker,
      log: rulesLog,
      store: workspace,
      knownCard: (cardId) => workspace.listSessions().some((s) => s.id === cardId),
    });
    registerSoundIpc({
      broker,
      log: rulesLog,
      store: workspace,
      knownCard: (cardId) => workspace.listSessions().some((s) => s.id === cardId),
      onUnplayable: (channel) => soundActions.unplayable(channel),
    });
    registerPushIpc({
      broker,
      log: pushLog,
      store: workspace,
      secrets: secretStore,
      actions: pushActions,
    });

    const notifier = new Notifier({
      getWindow: () => currentWindow,
      getPrefs: () => workspace.getNotificationPrefs(),
      rules,
      // The same `clock` the engine got: the beep and the rules deciding it is
      // a different time of day is the kind of bug nobody would think to look
      // for (P2-E14-05b).
      now: clock,
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
    // `fs:read` — the document viewer's door to a file (P2-E16-01, §5.30).
    //
    // The roots are the folders of the sessions that are OPEN, and "open" here
    // means EVERY CARD in the workspace, not just the ones with a live process:
    // the daily case this epic exists for is reading `PROGRESS.md` for a
    // project whose card is sitting there suspended, and a scope built from
    // `manager.list()` alone would refuse exactly that. `knownFolder` above is
    // narrower on purpose — a git status shells out against a live session's
    // repo — and the two are different questions, so they are two lists.
    const fsLog = createLogger(sink, 'fs');
    const readScope = new ReadScope({
      sessionFolders: () => [
        ...manager.list().map((s) => s.identity.folder),
        ...workspace.listSessions().map((s) => s.identity.folder),
      ],
      log: fsLog,
    });
    // P2-E16-02 hands the same object the picker: `Open file…` is the only
    // thing that widens this scope, so the widening lives WITH the scope rather
    // than in a second module that would need a reference to it. `getWindow` is
    // the modal's parent, and is a thunk for the reason every other one here is
    // — `currentWindow` is reassigned on macOS re-activate.
    // …and P2-E16-04 hands back a handle, because the live-re-render watch owns
    // OS resources (one directory watch and one stat timer per open document)
    // that have to go down with the app like every other watcher here.
    const fsIpc = registerFsIpc({
      broker,
      log: fsLog,
      scope: readScope,
      getWindow: () => currentWindow,
    });
    broker.handle('notifications:getPrefs', () => workspace.getNotificationPrefs());
    broker.handle('notifications:setPrefs', (_e, p) => {
      workspace.setNotificationPrefs(p);
      return workspace.getNotificationPrefs();
    });
    // P2-E14-05b. Quiet hours' whole job is to do nothing, which makes it the
    // one feature a user cannot tell is working — so the dialog can ask whether
    // the window is open RIGHT NOW (main owns the clock) and how many events it
    // has held. The list itself belongs to #483's digest; this is the count.
    broker.handle('notifications:quietState', (): QuietState => {
      const prefs = workspace.getNotificationPrefs();
      const window = quietWindowOf(prefs);
      return {
        window,
        active: inQuietWindow(window, clock()),
        heldCount: workspace.countSuppressed(),
      };
    });
    broker.handle('settings:getAutoTrust', () => workspace.getAutoTrust());
    broker.handle('settings:setAutoTrust', (_e, on: boolean) => {
      workspace.setAutoTrust(on === true);
      return workspace.getAutoTrust();
    });
    const sessionIpc: SessionIpcHandle = registerSessionIpc({
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
      // #531: a folder picker opened from a popped-out session is parented to
      // THAT window. `popoutWindows` is main's own registry, filled from
      // `did-create-window` and keyed by the dockview group in the frame name
      // — so a renderer-supplied id can only ever select a window we already
      // made, or nothing.
      getPopoutWindow: (groupId) => {
        const hit = popoutWindows.find((p) => p.groupId === groupId);
        return hit && !hit.win.isDestroyed() ? hit.win : null;
      },
      autoTrust: () => workspace.getAutoTrust(),
      autoLabels: () => workspace.getAutoLabels(),
      setAutoLabels: (on) => workspace.setAutoLabels(on),
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
      // The app-wide override, below a card's own choice and above the default
      // (#381). Read per call rather than once at boot; the parse itself, and
      // the reason a typo has to warn, live in `transport/preferred-transport.ts`.
      preferredTransport: () =>
        parsePreferredTransport(process.env[TRANSPORT_ENV_VAR], log.app.warn),
    });
    // the live -> card join the rules engine scopes by (P2-E14-03)
    cardIdForLive = sessionIpc.cardIdFor;
    labelForLive = sessionIpc.labelFor;
    // …and the permission half a toast needs to name and answer a hold
    // (P2-E14-04). Same late binding, same reason.
    sessionIpcRef = sessionIpc;
    app.on('quit', () => {
      // A toast offering Allow for a session that is being torn down is a
      // button that can only disappoint. Take them down with the app.
      permissionToasts.withdrawAll();
      ptys.killAll();
      streams.killAll();
      hooks.stop();
      transcripts.stop();
      fsIpc.stop(); // the document viewers' file watches (P2-E16-04)
      updates.stop(); // kills the daily timer; a check in flight becomes a no-op
      health.stop(); // same, for the status-page poll
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
