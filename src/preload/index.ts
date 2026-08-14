import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { SlashCommand } from '../shared/slash-commands';
import type { PtyAttachment, PtyChunk } from '../shared/ipc/pty';
import type {
  BindingSnapshot,
  TranscriptSearchRequest,
  TranscriptSearchResult,
} from '../shared/transcripts';
import type { PermissionRequestDto } from '../shared/ipc/permissions';
import type { FileReadResult } from '../shared/ipc/fs';
import type {
  UpdateHandshake,
  UpdateInstallStatus,
  UpdatePrefs,
  UpdateStatus,
} from '../shared/update';
import type { WorkspaceSaveState } from '../shared/workspace';
import type { ServiceHealthPrefs, ServiceHealthStatus } from '../shared/service-health';
import type {
  PushConfig,
  PushPrefs,
  PushSecretKey,
  PushSendResult,
  PushWriteResult,
} from '../shared/push';
import type { AudioPlayCue, AudioSpeakCue, CardSound } from '../shared/sounds';
import { AUDIO_PLAY_CHANNEL, AUDIO_SPEAK_CHANNEL } from '../shared/sounds';

/**
 * The notification prefs, as both directions of `notifications:*` see them.
 * Named rather than inlined three times since P2-E14-05a added two fields —
 * the inline copies had already drifted from main's `NotificationPrefsState`.
 */
interface NotifPrefs {
  enabled: boolean;
  osToasts?: boolean;
  /** per-session cues instead of the plain beep (P2-E14-05a) */
  sounds?: boolean;
  /** spoken announcements (P2-E14-05a) */
  speak?: boolean;
  quietStart?: string;
  quietEnd?: string;
}

const versionArg = process.argv.find((a) => a.startsWith('--switchboard-version='));
const seedArg = process.argv.find((a) => a.startsWith('--switchboard-seed-panels='));
const seedSessionArg = process.argv.find((a) => a.startsWith('--switchboard-seed-session='));
const seedDocArg = process.argv.find((a) => a.startsWith('--switchboard-seed-document='));
const muteAudioArg = process.argv.find((a) => a.startsWith('--switchboard-mute-audio='));

export interface SessionRecordDto {
  id: string;
  identity: {
    title: string;
    folder: string;
    accentColor?: string;
    langBadge?: string;
    providerId: string;
  };
  status: string;
  createdAt: string;
  nativeSessionId?: string;
  pid?: number;
  exitCode: number | null;
  /** which transport hosts this session (P2-E18-08b) */
  transport?: 'pty' | 'stream';
}

// The bridge grows with each subsystem. Every surface is promise/event based.
//
// WHAT THE RETURN TYPES BELOW PROMISE (#346). They describe what the HANDLER
// answers, and they are exact for THIS bridge: the broker answers an
// `IpcRefusal` instead when a caller lacks the channel's capability, and this
// renderer is granted every capability, so it cannot be refused. They are
// deliberately not widened by `| IpcRefusal` — see `shared/ipc/refusal.ts` for
// the argument. If this preload ever stops being first-party, or first-party
// stops holding `allCapabilities()`, these types become a lie and an
// `isIpcRefusal` check belongs here.
const api = {
  appVersion: versionArg ? versionArg.split('=')[1] : 'unknown',
  platform: process.platform,
  /** scripted-check seam: pre-populate N placeholder cards at boot */
  seedPanels: seedArg ? Number(seedArg.split('=')[1]) || 0 : 0,
  /** scripted-check seam: auto-create one real session in this folder */
  seedSessionFolder: seedSessionArg ? seedSessionArg.split('=').slice(1).join('=') : '',
  /**
   * scripted-check seam: open one document viewer at boot (P2-E16-02).
   *
   * It grants NOTHING — the path still has to be inside the read scope, so a
   * spec seeds a session folder and points this at a file within it. That is
   * deliberate: a seam that widened the scope would be a seam that could be
   * used to test the scope away.
   */
  seedDocument: seedDocArg ? seedDocArg.split('=').slice(1).join('=') : '',
  workspace: {
    getLayout: (): Promise<unknown> => ipcRenderer.invoke('workspace:getLayout'),
    setLayout: (layout: unknown): void => ipcRenderer.send('workspace:setLayout', layout),
    getUi: (): Promise<unknown> => ipcRenderer.invoke('workspace:getUi'),
    setUi: (ui: unknown): void => ipcRenderer.send('workspace:setUi', ui),
    /**
     * The workspace file was written by a newer switchboard.ai, so nothing
     * this run changes will be saved (#110/#168). Fixed at load — one read.
     */
    isReadOnly: (): Promise<boolean> => ipcRenderer.invoke('workspace:isReadOnly'),
    /**
     * Can the workspace file still be written? (#207)
     *
     * Not the same question as `isReadOnly`, which is about the file being
     * from the future and is fixed for the run. This one is about the WRITES
     * failing — a full disk, a permission, something holding the file — and it
     * comes and goes, so read it once on mount and then follow
     * `onSaveStateChanged`.
     */
    saveState: (): Promise<WorkspaceSaveState> => ipcRenderer.invoke('workspace:saveState'),
    /** saving started failing, or started working again (#207) */
    onSaveStateChanged: (cb: (s: WorkspaceSaveState) => void): (() => void) => {
      const h = (_e: unknown, s: WorkspaceSaveState): void => cb(s);
      ipcRenderer.on('workspace:saveStateChanged', h);
      return () => ipcRenderer.removeListener('workspace:saveStateChanged', h);
    },
  },
  /** display work areas, for popout-position rescue on restore (E8-02) */
  workAreas: (): Promise<Array<{ x: number; y: number; width: number; height: number }>> =>
    ipcRenderer.invoke('app:workAreas'),
  /** move the popout window currently at `from` to `to` (E8-06 restore) */
  movePopout: (
    from: { x: number; y: number },
    to: { left: number; top: number; width: number; height: number }
  ): Promise<boolean> => ipcRenderer.invoke('app:movePopout', from, to),
  /** a display was (re)connected — new work areas (E8-06 reconnect offer) */
  onDisplaysChanged: (
    cb: (areas: Array<{ x: number; y: number; width: number; height: number }>) => void
  ): (() => void) => {
    const h = (_e: unknown, areas: Array<{ x: number; y: number; width: number; height: number }>) =>
      cb(areas);
    ipcRenderer.on('app:displaysChanged', h);
    return () => ipcRenderer.removeListener('app:displaysChanged', h);
  },
  /**
   * One of the two chords claimed above the renderer was pressed (#90) — in
   * this window or in a popout, which runs no JS of its own. The payload names
   * a command in the registry; the renderer runs it there.
   */
  onAccelerator: (
    cb: (p: { commandId: string; fromPopout: boolean }) => void
  ): (() => void) => {
    const h = (_e: unknown, p: { commandId: string; fromPopout: boolean }): void => cb(p);
    ipcRenderer.on('app:accelerator', h);
    // Tell main someone is listening. Until this lands it claims no chord at
    // all, so a keystroke is never taken from the page with nothing to act on
    // it — the fail-open rule, at the one moment it is easy to break (#90).
    ipcRenderer.send('app:acceleratorReady');
    return () => ipcRenderer.removeListener('app:accelerator', h);
  },
  /** a popout window was moved or resized — re-save the layout (#86) */
  onPopoutGeometryChanged: (cb: () => void): (() => void) => {
    const h = (): void => cb();
    ipcRenderer.on('app:popoutGeometryChanged', h);
    return () => ipcRenderer.removeListener('app:popoutGeometryChanged', h);
  },
  /** sandbox-safe path for a dropped File (drag-folder-onto-window, E3-04) */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  /**
   * Sessions and their cards. These do NOT reject when main refuses (#347, and
   * #326 for `groups:*`): a call main declines RESOLVES `null`, having logged
   * why, so a caller that forgets a `.catch()` — which is most callers in this
   * app — cannot turn an ordinary UI gesture into an unhandled renderer
   * rejection. `null` means "nothing happened"; re-read the truth and show it.
   * Why this shape and not a `.catch()` policy: `main/sessions/ipc.ts`, top of
   * file. Most of this surface was already shaped that way — `setTransport`
   * answers `{ ok, reason }`, `submitPrompt` and `interrupt` answer `false`.
   */
  sessions: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('sessions:pickFolder'),
    isDirectory: (p: string): Promise<boolean> => ipcRenderer.invoke('sessions:isDirectory', p),
    /**
     * Start (or `--resume`) the live session for a card.
     *
     * Resolves NULL when the session did not start: `cardId`/`folder` missing,
     * a folder that is not a directory (a card whose folder was moved, deleted
     * or unplugged — the reachable one), or a spawn the provider could not do.
     * The reason is in the app log. It can still REJECT if the wiring AFTER a
     * successful spawn fails, which is a bug rather than a refusal and would
     * leave a live session behind, so callers keep a `.catch` too —
     * `SessionGrid`'s spawn effect reads both and treats them the same.
     */
    create: (opts: {
      cardId: string;
      folder: string;
      title: string;
      autonomy?: 'plan' | 'ask' | 'auto-edit' | 'full-auto';
      groupId?: string;
    }): Promise<
      | (SessionRecordDto & {
          cardId: string;
          priorUsage?: { input: number; output: number; cacheRead: number; cacheCreate: number };
          priorModel?: string;
          autonomy?: 'plan' | 'ask' | 'auto-edit' | 'full-auto';
          taskLabel?: string;
        })
      | null
    > => ipcRenderer.invoke('sessions:create', opts),
    list: (): Promise<SessionRecordDto[]> => ipcRenderer.invoke('sessions:list'),
    /** composer autocomplete data (E10-07): builtins + project/user commands */
    slashCommands: (liveId: string): Promise<SlashCommand[]> =>
      ipcRenderer.invoke('sessions:slashCommands', liveId),
    cards: (): Promise<
      Array<{
        cardId: string;
        title: string;
        folder: string;
        accent?: string;
        badge?: string;
        status: string;
        liveId?: string;
        groupId?: string;
        autoKey?: string;
        taskLabel?: string;
      }>
    > => ipcRenderer.invoke('sessions:cards'),
    knownCards: (): Promise<Array<{ cardId: string; identity: SessionRecordDto['identity'] }>> =>
      ipcRenderer.invoke('sessions:knownCards'),
    renameCard: (cardId: string, title: string): Promise<void> =>
      ipcRenderer.invoke('sessions:renameCard', cardId, title),
    closeCard: (cardId: string): Promise<void> => ipcRenderer.invoke('sessions:closeCard', cardId),
    dropLive: (cardId: string): Promise<void> => ipcRenderer.invoke('sessions:dropLive', cardId),
    setTaskLabel: (cardId: string, label: string): Promise<void> =>
      ipcRenderer.invoke('sessions:setTaskLabel', cardId, label),
    setAutonomy: (cardId: string, autonomy: string): Promise<void> =>
      ipcRenderer.invoke('sessions:setAutonomy', cardId, autonomy),
    /**
     * Choose a card's transport (P2-E18-08b). Applies to the NEXT spawn, like
     * autonomy: the CLI cannot change either on a live session. `pending` is
     * true when a session is running under this card right now, so the UI can
     * say the change is queued rather than implying it took effect.
     */
    setTransport: (
      cardId: string,
      transport: 'pty' | 'stream'
    ): Promise<{ ok: boolean; reason?: string; pending?: boolean }> =>
      ipcRenderer.invoke('sessions:setTransport', cardId, transport),
    /**
     * Rename a LIVE session by its live id.
     *
     * Resolves NULL when nothing was renamed — an id this app does not know, or
     * an argument main refused (#347). No caller yet: the rail and the palette
     * rename by CARD id via `renameCard`, which is what survives a restart.
     */
    rename: (id: string, title: string): Promise<SessionRecordDto | null> =>
      ipcRenderer.invoke('sessions:rename', id, title),
    onStatus: (cb: (change: unknown) => void): (() => void) => {
      const h = (_e: unknown, c: unknown) => cb(c);
      ipcRenderer.on('sessions:status', h);
      return () => ipcRenderer.removeListener('sessions:status', h);
    },
    /**
     * A card gained or lost its live session (#170) — re-read `cards()`.
     *
     * Signal only: no payload, because the list is `cards()` and nothing else.
     * Why this exists at all is in `main/sessions/ipc.ts`, above `bindLive`.
     */
    onCardsChanged: (cb: () => void): (() => void) => {
      const h = (): void => cb();
      ipcRenderer.on('sessions:cardsChanged', h);
      return () => ipcRenderer.removeListener('sessions:cardsChanged', h);
    },
    /**
     * A card's task label changed (P2-E7-06) — usually because the CLI wrote a
     * title into its transcript and nothing in the renderer asked for it.
     *
     * Carries the value, unlike `onCardsChanged`: the grid's card header keeps
     * its label in local state, so there is nothing there to re-read, and
     * `cards()` resolves a git root per card — far too expensive to run every
     * time one string moves. `label` is undefined when the card has none to
     * show, which includes an auto label the user has switched off.
     */
    onTaskLabel: (cb: (p: { cardId: string; label?: string }) => void): (() => void) => {
      const h = (_e: unknown, p: { cardId: string; label?: string }) => cb(p);
      ipcRenderer.on('sessions:taskLabel', h);
      return () => ipcRenderer.removeListener('sessions:taskLabel', h);
    },
    onUsage: (cb: (snap: unknown) => void): (() => void) => {
      const h = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on('sessions:usage', h);
      return () => ipcRenderer.removeListener('sessions:usage', h);
    },
    onPermissionRequest: (cb: (r: PermissionRequestDto) => void): (() => void) => {
      const h = (_e: unknown, r: PermissionRequestDto) => cb(r);
      ipcRenderer.on('sessions:permissionRequest', h);
      return () => ipcRenderer.removeListener('sessions:permissionRequest', h);
    },
    decidePermission: (requestId: string, decision: 'allow' | 'deny', reason?: string): Promise<boolean> =>
      ipcRenderer.invoke('sessions:decidePermission', requestId, decision, reason),
    /**
     * Submit a prompt on the session's OWN transport (P2-E18-08a).
     *
     * Resolves FALSE when that session has no typed-message transport — i.e.
     * the PTY, which needs the bracketed paste and delayed CR instead. The
     * caller falls back. Deliberately shaped as try-then-fall-back so the
     * renderer never has to know which transport a session is on.
     */
    submitPrompt: (sessionId: string, text: string): Promise<boolean> =>
      ipcRenderer.invoke('sessions:submitPrompt', sessionId, text),
    /**
     * Interrupt the running turn (#154). Resolves FALSE for a PTY session,
     * whose interrupt is an Esc keystroke; the caller falls back.
     */
    interrupt: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('sessions:interrupt', sessionId),
    /** future gated calls for this LIVE session answer 'allow' in main (P2 #19) */
    allowAllSession: (liveId: string): Promise<void> =>
      ipcRenderer.invoke('sessions:allowAllSession', liveId),
    pendingPermissions: (): Promise<PermissionRequestDto[]> =>
      ipcRenderer.invoke('sessions:pendingPermissions'),
    onPermissionResolved: (cb: (r: { requestId: string }) => void): (() => void) => {
      const h = (_e: unknown, r: { requestId: string }) => cb(r);
      ipcRenderer.on('sessions:permissionResolved', h);
      return () => ipcRenderer.removeListener('sessions:permissionResolved', h);
    },
    /**
     * Main asks for a card to be brought to the front (P2-E14-04).
     *
     * Today's only sender is a click on the OS toast for a held permission —
     * the gesture that has to work when the app is not focused, and the only
     * gesture at all on a desktop whose toasts cannot carry buttons. It is a
     * request to move the SCREEN; it never carries a verdict.
     */
    onRevealCard: (cb: (r: { cardId: string }) => void): (() => void) => {
      const h = (_e: unknown, r: { cardId: string }) => cb(r);
      ipcRenderer.on('sessions:revealCard', h);
      return () => ipcRenderer.removeListener('sessions:revealCard', h);
    },
    onExited: (cb: (e: { sessionId: string; code: number; crashed: boolean }) => void): (() => void) => {
      const h = (_e: unknown, x: { sessionId: string; code: number; crashed: boolean }) => cb(x);
      ipcRenderer.on('sessions:exited', h);
      return () => ipcRenderer.removeListener('sessions:exited', h);
    },
  },
  /**
   * Persistent groups (E12). These do NOT reject on bad input (#326): a
   * mutation that main refuses RESOLVES `null`, having logged why, so a caller
   * that forgets a `.catch()` — which is every caller in this app — cannot turn
   * an ordinary UI gesture into an unhandled renderer rejection. `null` means
   * "nothing changed"; re-read `list()` and show the truth. Why this shape and
   * not a `.catch()` policy: `main/workspace/group-ipc.ts`, top of file.
   */
  groups: {
    list: (): Promise<Array<{ id: string; name: string; color: string; notifyScope?: string }>> =>
      ipcRenderer.invoke('groups:list'),
    palette: (): Promise<string[]> => ipcRenderer.invoke('groups:palette'),
    /** resolves NULL when the name is blank or the color is not #rrggbb */
    create: (opts: {
      name: string;
      color?: string;
    }): Promise<{ id: string; name: string; color: string } | null> =>
      ipcRenderer.invoke('groups:create', opts),
    /** resolves NULL for an unknown group or a patch main refuses */
    update: (
      id: string,
      patch: { name?: string; color?: string; notifyScope?: string }
    ): Promise<{ id: string; name: string; color: string; notifyScope?: string } | null> =>
      ipcRenderer.invoke('groups:update', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('groups:delete', id),
    setSessionGroup: (cardId: string, groupId: string | null): Promise<void> =>
      ipcRenderer.invoke('groups:setSessionGroup', cardId, groupId),
  },
  settings: {
    getAutoTrust: (): Promise<boolean> => ipcRenderer.invoke('settings:getAutoTrust'),
    setAutoTrust: (on: boolean): Promise<boolean> => ipcRenderer.invoke('settings:setAutoTrust', on),
    /** Fill blank task labels from the CLI's own conversation title (P2-E7-06).
     *  Off hides every auto label at once and drops toast text back to the
     *  session title — the screen-share switch (§5.11). */
    getAutoLabels: (): Promise<boolean> => ipcRenderer.invoke('settings:getAutoLabels'),
    setAutoLabels: (on: boolean): Promise<boolean> =>
      ipcRenderer.invoke('settings:setAutoLabels', on),
  },
  preflight: {
    check: (): Promise<{
      cliPath: string | null;
      version: string | null;
      configPresent: boolean;
      ok: boolean;
    }> => ipcRenderer.invoke('preflight:check'),
  },
  /**
   * Update checks (P2-E19-03). `check` runs one and RESOLVES with the answer;
   * `onStatus` hears the ones nobody in this window asked for — the daily
   * timer, and the Help ▸ Check for Updates… menu item.
   */
  update: {
    check: (opts: { manual?: boolean } = {}): Promise<UpdateStatus> =>
      ipcRenderer.invoke('update:check', opts),
    onStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
      const h = (_e: unknown, s: UpdateStatus): void => cb(s);
      ipcRenderer.on('update:status', h);
      return () => ipcRenderer.removeListener('update:status', h);
    },
    getPrefs: (): Promise<UpdatePrefs> => ipcRenderer.invoke('update:getPrefs'),
    /** merge-patch; `lastCheck` is main's own bookkeeping and is not settable */
    setPrefs: (p: { autoCheck?: boolean; skippedVersion?: string }): Promise<UpdatePrefs> =>
      ipcRenderer.invoke('update:setPrefs', p),
    /** resolves FALSE for anything that is not an https GitHub URL */
    openExternal: (url: string): Promise<boolean> =>
      ipcRenderer.invoke('update:openExternal', url),
    /**
     * Download, verify and install the release main last offered (E19-04).
     *
     * Takes NO arguments on purpose. The renderer does not choose what gets
     * downloaded or executed — main installs the release it found itself, and
     * a URL crossing this bridge would be a URL the renderer could choose.
     *
     * Resolves with the terminal status; progress arrives on `onInstallStatus`.
     */
    install: (): Promise<UpdateInstallStatus> => ipcRenderer.invoke('update:install'),
    /** stop the download in flight; a no-op when there is none */
    cancelInstall: (): Promise<void> => ipcRenderer.invoke('update:cancelInstall'),
    onInstallStatus: (cb: (s: UpdateInstallStatus) => void): (() => void) => {
      const h = (_e: unknown, s: UpdateInstallStatus): void => cb(s);
      ipcRenderer.on('update:installStatus', h);
      return () => ipcRenderer.removeListener('update:installStatus', h);
    },
    /**
     * The previous run installed something — what happened? Null on an
     * ordinary launch. Main clears the flag at startup, so this answers the
     * same for every window and for every call within one run.
     */
    handshake: (): Promise<UpdateHandshake | null> => ipcRenderer.invoke('update:handshake'),
  },
  /**
   * Files, read-only and scope-checked in main (P2-E16-01, §5.30).
   *
   * This one does NOT follow the `null`-and-log convention: it answers a result
   * union, because "that file is gone" and "you may not read that" are
   * different things for the viewer to say and a bare null collapses them.
   * Every refusal is already in the app log by the time this resolves — the
   * caller does not have to log it again, only render it.
   */
  files: {
    /** absolute path in, at most `MAX_FILE_READ_BYTES` of decoded text out */
    read: (p: string): Promise<FileReadResult> => ipcRenderer.invoke('fs:read', p),
    /**
     * The native `Open file…` dialog (P2-E16-02). Resolves the chosen path, or
     * null if the user cancelled. Choosing a file also GRANTS it: main adds it
     * to the read scope before answering, so the `read` that follows succeeds.
     */
    pickFile: (): Promise<string | null> => ipcRenderer.invoke('fs:pickFile'),
    /**
     * A link out of a rendered document, into the user's browser. Resolves
     * FALSE for any scheme but `http`, `https` and `mailto` — a `javascript:`
     * or `file:` href does nothing at all.
     */
    openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('fs:openExternal', url),
    /**
     * §5.30's escape hatch: hand the file to whatever the OS has registered for
     * it. Scope-checked in main against the same roots as `read`, so this can
     * only be aimed at a file the caller could already have read.
     */
    openPath: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:openPath', p),
    /** Show the file in the OS file manager. Scope-checked like `openPath`. */
    reveal: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:reveal', p),
  },
  git: {
    status: (folder: string): Promise<unknown> => ipcRenderer.invoke('git:status', folder),
    fileVersions: (folder: string, file: string): Promise<{ original: string; modified: string }> =>
      ipcRenderer.invoke('git:fileVersions', folder, file),
  },
  notifications: {
    getPrefs: (): Promise<NotifPrefs> => ipcRenderer.invoke('notifications:getPrefs'),
    // merge-patch: send only the prefs you're changing (review P1 #13)
    setPrefs: (p: Partial<NotifPrefs>): Promise<NotifPrefs> =>
      ipcRenderer.invoke('notifications:setPrefs', p),
  },
  /**
   * Per-session sounds and spoken announcements (P2-E14-05a, §5.9 + §5.11).
   *
   * Three of these four are ordinary asks. `onPlay` / `onSpeak` are the
   * opposite direction — main telling THIS window to make a noise, because
   * main has no audio device and Chromium does.
   */
  sounds: {
    /**
     * Play nothing, anywhere (P2-E14-05a). Main's own mute covers the cues it
     * pushes; this covers the two the renderer plays by itself — the card
     * menu's preview and the sample on switching announcements on.
     */
    muted: muteAudioArg?.split('=')[1] === '1',
    /** which cue this card rings, and whether the user pinned it */
    get: (cardId: string): Promise<CardSound | null> => ipcRenderer.invoke('sounds:get', cardId),
    /** pin a cue, or `null` to hand the card back to auto; resolves to the truth */
    set: (cardId: string, sound: string | null): Promise<CardSound | null> =>
      ipcRenderer.invoke('sounds:set', cardId, sound),
    onPlay: (cb: (c: AudioPlayCue) => void): (() => void) => {
      const h = (_e: unknown, c: AudioPlayCue): void => cb(c);
      ipcRenderer.on(AUDIO_PLAY_CHANNEL, h);
      return () => ipcRenderer.removeListener(AUDIO_PLAY_CHANNEL, h);
    },
    onSpeak: (cb: (c: AudioSpeakCue) => void): (() => void) => {
      const h = (_e: unknown, c: AudioSpeakCue): void => cb(c);
      ipcRenderer.on(AUDIO_SPEAK_CHANNEL, h);
      return () => ipcRenderer.removeListener(AUDIO_SPEAK_CHANNEL, h);
    },
  },
  /**
   * Notification rules (P2-E14-03, §5.9). The renderer's whole write surface
   * in v1 is the per-session "notify when done" checkbox — main mints the rule
   * itself, so the renderer never names an event, a condition or an action.
   */
  rules: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('rules:list'),
    /** is this card's "notify when done" box ticked? */
    notifyWhenDone: (cardId: string): Promise<boolean> =>
      ipcRenderer.invoke('rules:notifyWhenDone', cardId),
    /** tick/untick it; resolves to the state the STORE now holds */
    setNotifyWhenDone: (cardId: string, on: boolean): Promise<boolean> =>
      ipcRenderer.invoke('rules:setNotifyWhenDone', cardId, on),
  },
  events: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('events:list'),
    ack: (sessionId: string): Promise<void> => ipcRenderer.invoke('events:ack', sessionId),
    dismiss: (sessionId: string): Promise<void> => ipcRenderer.invoke('events:dismiss', sessionId),
    /** the FULL current list on every change (adds, replacements, removals) */
    onChanged: (cb: (list: unknown[]) => void): (() => void) => {
      const h = (_e: unknown, l: unknown[]) => cb(l);
      ipcRenderer.on('events:changed', h);
      return () => ipcRenderer.removeListener('events:changed', h);
    },
  },
  /**
   * Provider service health (P2-E14-07, §5.14) — "is it me or is it them?".
   *
   * READ-ONLY, both halves: the status page's own verdict and this machine's
   * corroboration arrive in one record. `get` is what a mounting window asks;
   * everything after that arrives on `onStatus`.
   */
  health: {
    get: (): Promise<ServiceHealthStatus> => ipcRenderer.invoke('health:get'),
    onStatus: (cb: (s: ServiceHealthStatus) => void): (() => void) => {
      const h = (_e: unknown, s: ServiceHealthStatus): void => cb(s);
      ipcRenderer.on('health:status', h);
      return () => ipcRenderer.removeListener('health:status', h);
    },
    getPrefs: (): Promise<ServiceHealthPrefs> => ipcRenderer.invoke('health:getPrefs'),
    setPrefs: (p: { poll?: boolean }): Promise<ServiceHealthPrefs> =>
      ipcRenderer.invoke('health:setPrefs', p),
  },
  /**
   * Phone push + webhook (P2-E14-06, §5.9 + §5.29).
   *
   * **Write-only for credentials.** `setSecret` puts a value into the OS
   * credential store and there is no call that reads one back — `getConfig`
   * answers with booleans. That is the point of the boundary: this side of it
   * renders documents it did not write, and a compromise here must not be able
   * to walk off with the user's Pushover token.
   */
  push: {
    getConfig: (): Promise<PushConfig> => ipcRenderer.invoke('push:getConfig'),
    /** answers the new config AND whether the write happened — see PushWriteResult */
    setPrefs: (p: Partial<PushPrefs>): Promise<PushWriteResult> =>
      ipcRenderer.invoke('push:setPrefs', p),
    /** store one credential; an empty string forgets it */
    setSecret: (key: PushSecretKey, value: string): Promise<PushWriteResult> =>
      ipcRenderer.invoke('push:setSecret', key, value),
    /** send one now, whatever the switches say — the dialog's Send test */
    test: (channel: 'push' | 'webhook'): Promise<PushSendResult> =>
      ipcRenderer.invoke('push:test', channel),
  },
  transcripts: {
    blocks: (liveId: string): Promise<unknown[]> => ipcRenderer.invoke('transcripts:blocks', liveId),
    // binding state for a (re)mounting panel — the live pushes ride
    // `sessions:usage`, but a panel that mounts between transitions would
    // otherwise show "no conversation yet" over a session that failed to bind
    // half an hour ago (P2-E15-10)
    binding: (liveId: string): Promise<BindingSnapshot | null> =>
      ipcRenderer.invoke('transcripts:binding', liveId),
    /**
     * Session find (P2-E17-01, §5.31) — scan the transcript FILE in main.
     *
     * Scope is the `sessionIds` list, so §10's cross-session search is this
     * call with more ids rather than a second channel. A hit that carries no
     * `seq` is in a block the view buffer has evicted: readable in the results
     * list, not jump-to-able in place (the recorded v1 boundary).
     */
    search: (req: TranscriptSearchRequest): Promise<TranscriptSearchResult> =>
      ipcRenderer.invoke('transcripts:search', req),
    onBlock: (cb: (payload: { sessionId: string; block: unknown }) => void): (() => void) => {
      const h = (_e: unknown, p: { sessionId: string; block: unknown }) => cb(p);
      ipcRenderer.on('sessions:feedBlock', h);
      return () => ipcRenderer.removeListener('sessions:feedBlock', h);
    },
    onReset: (cb: (payload: { sessionId: string; cause?: 'clear' }) => void): (() => void) => {
      const h = (_e: unknown, p: { sessionId: string; cause?: 'clear' }) => cb(p);
      ipcRenderer.on('sessions:feedReset', h);
      return () => ipcRenderer.removeListener('sessions:feedReset', h);
    },
  },
  pty: {
    // resolves with { epoch, snapshot } — the epoch tells the renderer which
    // buffered chunks are newer than the snapshot (#117, shared/ipc/pty.ts)
    attach: (id: string): Promise<PtyAttachment | null> => ipcRenderer.invoke('pty:attach', id),
    detach: (id: string): void => ipcRenderer.send('pty:detach', id),
    input: (id: string, data: string): void => ipcRenderer.send('pty:input', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    onData: (id: string, cb: (chunk: PtyChunk) => void): (() => void) => {
      const channel = `pty:data:${id}`;
      const h = (_e: unknown, chunk: PtyChunk) => cb(chunk);
      ipcRenderer.on(channel, h);
      return () => ipcRenderer.removeListener(channel, h);
    },
  },
};

contextBridge.exposeInMainWorld('switchboard', api);

export type SwitchboardApi = typeof api;
