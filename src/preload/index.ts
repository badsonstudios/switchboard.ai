import { contextBridge, ipcRenderer, webUtils } from 'electron';

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
  },
  /** sandbox-safe path for a dropped File (drag-folder-onto-window, E3-04) */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  sessions: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('sessions:pickFolder'),
    isDirectory: (p: string): Promise<boolean> => ipcRenderer.invoke('sessions:isDirectory', p),
    create: (opts: {
      folder: string;
      title: string;
      autonomy?: 'plan' | 'ask' | 'auto-edit' | 'full-auto';
    }): Promise<SessionRecordDto> => ipcRenderer.invoke('sessions:create', opts),
    list: (): Promise<SessionRecordDto[]> => ipcRenderer.invoke('sessions:list'),
    kill: (id: string): Promise<void> => ipcRenderer.invoke('sessions:kill', id),
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
    onExited: (cb: (e: { sessionId: string; code: number; crashed: boolean }) => void): (() => void) => {
      const h = (_e: unknown, x: { sessionId: string; code: number; crashed: boolean }) => cb(x);
      ipcRenderer.on('sessions:exited', h);
      return () => ipcRenderer.removeListener('sessions:exited', h);
    },
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
    getPrefs: (): Promise<{ enabled: boolean; quietStart?: string; quietEnd?: string }> =>
      ipcRenderer.invoke('notifications:getPrefs'),
    setPrefs: (p: {
      enabled: boolean;
      quietStart?: string;
      quietEnd?: string;
    }): Promise<{ enabled: boolean; quietStart?: string; quietEnd?: string }> =>
      ipcRenderer.invoke('notifications:setPrefs', p),
  },
  feed: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('feed:list'),
    onEvent: (cb: (e: unknown) => void): (() => void) => {
      const h = (_e: unknown, ev: unknown) => cb(ev);
      ipcRenderer.on('feed:event', h);
      return () => ipcRenderer.removeListener('feed:event', h);
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
