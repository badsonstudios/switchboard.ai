import type { SwitchboardApi } from '../../preload';

declare global {
  interface Window {
    switchboard: SwitchboardApi;
  }
}

export {};
