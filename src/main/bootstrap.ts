// Bootstrap: the ONLY module allowed to import contributors directly — it
// populates the registry; everyone else resolves through it (§5.23).
import { registry } from './extensibility';
import { claudeAdapter } from './providers/claude';
import { fakeAdapter } from './providers/fake';
import { fakeStreamAdapter } from './providers/fake-stream';

export function registerBuiltinContributions(): void {
  // e2e tests swap the real CLI for a fake (hermetic: no login, no network).
  // Two of them, one per transport — '1' is the original shell-in-a-PTY and is
  // what all 98 pre-E18 e2e tests select; 'stream' is the stream-json fake
  // (P2-E18-04). Kept as distinct VALUES of one variable rather than two
  // variables so the modes cannot both be on at once and silently race to
  // register the same 'claude-code' id.
  const fake = process.env.SWITCHBOARD_FAKE_PROVIDER;
  if (fake === 'stream') {
    registry.register('provider-adapter', fakeStreamAdapter);
    return;
  }
  if (fake === '1') {
    registry.register('provider-adapter', fakeAdapter);
    return;
  }
  registry.register('provider-adapter', claudeAdapter);
}
