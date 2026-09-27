// Bootstrap: the ONLY module allowed to import contributors directly — it
// populates the registry; everyone else resolves through it (§5.23).
import { registry } from './extensibility';
import { claudeAdapter } from './providers/claude';
import { fakeStreamAdapter } from './providers/fake-stream';

export function registerBuiltinContributions(): void {
  // e2e tests swap the real CLI for a fake (hermetic: no login, no network).
  //
  // ONE FAKE SINCE #952. There were two, one per transport: `'1'` selected the
  // original shell-in-a-PTY fake (`providers/fake.ts`) and `'stream'` selected
  // the stream-json fake (P2-E18-04). The PTY one spawned `cmd.exe` / `sh` in a
  // real node-pty, which is a thing that cannot exist any more.
  //
  // BOTH SPELLINGS STILL SELECT A FAKE, deliberately. `'1'` is written into
  // dozens of specs, and the failure mode of dropping it would be an e2e run
  // that silently launched against the REAL `claude` binary with the user's
  // login — slow, non-hermetic, and spending tokens. Accepting any truthy value
  // and answering with the only fake there is fails safe.
  if (process.env.SWITCHBOARD_FAKE_PROVIDER) {
    registry.register('provider-adapter', fakeStreamAdapter);
    return;
  }
  registry.register('provider-adapter', claudeAdapter);
}
