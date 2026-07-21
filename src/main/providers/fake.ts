// Fake provider for e2e tests (SWITCHBOARD_FAKE_PROVIDER=1). Spawns the OS
// shell in a real PTY instead of the claude CLI — a genuine interactive
// terminal we can type into and assert on, with no CLI login and no network,
// so UI tests are hermetic and CI-safe. Registered under the 'claude-code' id
// the UI uses, replacing the real adapter in test mode only.
import { ProviderAdapter, SpawnRecipe } from '../extensibility/contributions';

export const fakeAdapter: ProviderAdapter = {
  manifest: {
    id: 'claude-code',
    displayName: 'Fake (test)',
    version: '0.0.0',
    capabilities: ['sessions.spawn'],
  },
  buildSpawn(): SpawnRecipe {
    return {
      command: process.platform === 'win32' ? 'cmd.exe' : 'sh',
      args: [],
      env: {
        // S-01 landmines: never leak these into the hosted shell
        ELECTRON_RUN_AS_NODE: undefined,
        ELECTRON_NO_ATTACH_CONSOLE: undefined,
      },
    };
  },
};
