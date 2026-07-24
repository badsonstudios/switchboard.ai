import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { SlashCommand } from '../shared/slash-commands';

const versionArg = process.argv.find((a) => a.startsWith('--switchboard-version='));
const seedArg = process.argv.find((a) => a.startsWith('--switchboard-seed-panels='));
const seedSessionArg = process.argv.find((a) => a.startsWith('--switchboard-seed-session='));

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
}

// The bridge grows with each subsystem. Every surface is promise/event based.
const api = {
  appVersion: versionArg ? versionArg.split('=')[1] : 'unknown',
  platform: process.platform,
  /** scripted-check seam: pre-populate N placeholder cards at boot */
  seedPanels: seedArg ? Number(seedArg.split('=')[1]) || 0 : 0,
  /** scripted-check seam: auto-create one real session in this folder */
  seedSessionFolder: seedSessionArg ? seedSessionArg.split('=').slice(1).join('=') : '',
  workspace: {
    getLayout: (): Promise<unknown> => ipcRenderer.invoke('workspace:getLayout'),
    setLayout: (layout: unknown): void => ipcRenderer.send('workspace:setLayout', layout),
    getUi: (): Promise<unknown> => ipcRenderer.invoke('workspace:getUi'),
    setUi: (ui: unknown): void => ipcRenderer.send('workspace:setUi', ui),
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
  /** sandbox-safe path for a dropped File (drag-folder-onto-window, E3-04) */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  sessions: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('sessions:pickFolder'),
    isDirectory: (p: string): Promise<boolean> => ipcRenderer.invoke('sessions:isDirectory', p),
    create: (opts: {
      cardId: string;
      folder: string;
      title: string;
      autonomy?: 'plan' | 'ask' | 'auto-edit' | 'full-auto';
      groupId?: string;
    }): Promise<
      SessionRecordDto & {
        cardId: string;
        priorUsage?: { input: number; output: number; cacheRead: number; cacheCreate: number };
        priorModel?: string;
        autonomy?: 'plan' | 'ask' | 'auto-edit' | 'full-auto';
        taskLabel?: string;
      }
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
    rename: (id: string, title: string): Promise<SessionRecordDto | undefined> =>
      ipcRenderer.invoke('sessions:rename', id, title),
    onStatus: (cb: (change: unknown) => void): (() => void) => {
      const h = (_e: unknown, c: unknown) => cb(c);
      ipcRenderer.on('sessions:status', h);
      return () => ipcRenderer.removeListener('sessions:status', h);
    },
    onUsage: (cb: (snap: unknown) => void): (() => void) => {
      const h = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on('sessions:usage', h);
      return () => ipcRenderer.removeListener('sessions:usage', h);
    },
    onPermissionRequest: (
      cb: (r: {
        requestId: string;
        sessionId: string;
        cardId?: string;
        tool: string;
        input: Record<string, unknown>;
      }) => void
    ): (() => void) => {
      const h = (
        _e: unknown,
        r: {
          requestId: string;
          sessionId: string;
          cardId?: string;
          tool: string;
          input: Record<string, unknown>;
        }
      ) => cb(r);
      ipcRenderer.on('sessions:permissionRequest', h);
      return () => ipcRenderer.removeListener('sessions:permissionRequest', h);
    },
    decidePermission: (requestId: string, decision: 'allow' | 'deny', reason?: string): Promise<boolean> =>
      ipcRenderer.invoke('sessions:decidePermission', requestId, decision, reason),
    /** future gated calls for this LIVE session answer 'allow' in main (P2 #19) */
    allowAllSession: (liveId: string): Promise<void> =>
      ipcRenderer.invoke('sessions:allowAllSession', liveId),
    pendingPermissions: (): Promise<
      Array<{
        requestId: string;
        sessionId: string;
        cardId?: string;
        tool: string;
        input: Record<string, unknown>;
      }>
    > => ipcRenderer.invoke('sessions:pendingPermissions'),
    onPermissionResolved: (cb: (r: { requestId: string }) => void): (() => void) => {
      const h = (_e: unknown, r: { requestId: string }) => cb(r);
      ipcRenderer.on('sessions:permissionResolved', h);
      return () => ipcRenderer.removeListener('sessions:permissionResolved', h);
    },
    onExited: (cb: (e: { sessionId: string; code: number; crashed: boolean }) => void): (() => void) => {
      const h = (_e: unknown, x: { sessionId: string; code: number; crashed: boolean }) => cb(x);
      ipcRenderer.on('sessions:exited', h);
      return () => ipcRenderer.removeListener('sessions:exited', h);
    },
  },
  groups: {
    list: (): Promise<Array<{ id: string; name: string; color: string; notifyScope?: string }>> =>
      ipcRenderer.invoke('groups:list'),
    palette: (): Promise<string[]> => ipcRenderer.invoke('groups:palette'),
    create: (opts: { name: string; color?: string }): Promise<{ id: string; name: string; color: string }> =>
      ipcRenderer.invoke('groups:create', opts),
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
  },
  preflight: {
    check: (): Promise<{
      cliPath: string | null;
      version: string | null;
      configPresent: boolean;
      ok: boolean;
    }> => ipcRenderer.invoke('preflight:check'),
  },
  git: {
    status: (folder: string): Promise<unknown> => ipcRenderer.invoke('git:status', folder),
    fileVersions: (folder: string, file: string): Promise<{ original: string; modified: string }> =>
      ipcRenderer.invoke('git:fileVersions', folder, file),
  },
  notifications: {
    getPrefs: (): Promise<{ enabled: boolean; osToasts?: boolean; quietStart?: string; quietEnd?: string }> =>
      ipcRenderer.invoke('notifications:getPrefs'),
    // merge-patch: send only the prefs you're changing (review P1 #13)
    setPrefs: (p: {
      enabled?: boolean;
      osToasts?: boolean;
      quietStart?: string;
      quietEnd?: string;
    }): Promise<{ enabled: boolean; osToasts?: boolean; quietStart?: string; quietEnd?: string }> =>
      ipcRenderer.invoke('notifications:setPrefs', p),
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
  transcripts: {
    blocks: (liveId: string): Promise<unknown[]> => ipcRenderer.invoke('transcripts:blocks', liveId),
    onBlock: (cb: (payload: { sessionId: string; block: unknown }) => void): (() => void) => {
      const h = (_e: unknown, p: { sessionId: string; block: unknown }) => cb(p);
      ipcRenderer.on('sessions:feedBlock', h);
      return () => ipcRenderer.removeListener('sessions:feedBlock', h);
    },
    onReset: (cb: (payload: { sessionId: string }) => void): (() => void) => {
      const h = (_e: unknown, p: { sessionId: string }) => cb(p);
      ipcRenderer.on('sessions:feedReset', h);
      return () => ipcRenderer.removeListener('sessions:feedReset', h);
    },
  },
  pty: {
    attach: (id: string): Promise<string | null> => ipcRenderer.invoke('pty:attach', id),
    detach: (id: string): void => ipcRenderer.send('pty:detach', id),
    input: (id: string, data: string): void => ipcRenderer.send('pty:input', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    onData: (id: string, cb: (d: string) => void): (() => void) => {
      const channel = `pty:data:${id}`;
      const h = (_e: unknown, d: string) => cb(d);
      ipcRenderer.on(channel, h);
      return () => ipcRenderer.removeListener(channel, h);
    },
  },
};

contextBridge.exposeInMainWorld('switchboard', api);

export type SwitchboardApi = typeof api;
