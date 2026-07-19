import { contextBridge, ipcRenderer } from 'electron';

const versionArg = process.argv.find((a) => a.startsWith('--switchboard-version='));
const seedArg = process.argv.find((a) => a.startsWith('--switchboard-seed-panels='));

// The bridge grows with each subsystem (sessions, hooks, git...). Every
// surface is promise/event based — no sync IPC.
const api = {
  appVersion: versionArg ? versionArg.split('=')[1] : 'unknown',
  platform: process.platform,
  /** scripted-check seam: pre-populate N placeholder cards at boot */
  seedPanels: seedArg ? Number(seedArg.split('=')[1]) || 0 : 0,
  workspace: {
    getLayout: (): Promise<unknown> => ipcRenderer.invoke('workspace:getLayout'),
    setLayout: (layout: unknown): void => ipcRenderer.send('workspace:setLayout', layout),
  },
};

contextBridge.exposeInMainWorld('switchboard', api);

export type SwitchboardApi = typeof api;
