import { contextBridge } from 'electron';

// The bridge grows with each subsystem (sessions, hooks, git...). Scaffold
// exposes only inert metadata to prove the isolation wiring works.
const versionArg = process.argv.find((a) => a.startsWith('--switchboard-version='));

const api = {
  appVersion: versionArg ? versionArg.split('=')[1] : 'unknown',
  platform: process.platform,
};

contextBridge.exposeInMainWorld('switchboard', api);

export type SwitchboardApi = typeof api;
