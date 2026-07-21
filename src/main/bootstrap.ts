// Bootstrap: the ONLY module allowed to import contributors directly — it
// populates the registry; everyone else resolves through it (§5.23).
import { registry } from './extensibility/registry';
import { claudeAdapter } from './providers/claude';
import { fakeAdapter } from './providers/fake';

export function registerBuiltinContributions(): void {
  // e2e tests swap the real CLI for a shell-in-a-PTY (hermetic, no login)
  if (process.env.SWITCHBOARD_FAKE_PROVIDER === '1') {
    registry.register('provider-adapter', fakeAdapter);
    return;
  }
  registry.register('provider-adapter', claudeAdapter);
}
