// Bootstrap: the ONLY module allowed to import contributors directly — it
// populates the registry; everyone else resolves through it (§5.23).
import { registry } from './extensibility';
import { claudeAdapter } from './providers/claude';
import { fakeStreamAdapter } from './providers/fake-stream';
import { fakeAcpAdapter } from './providers/acp/fake-acp';
import { customAcpProvider } from './providers/acp/custom-acp';
import type { CustomAi } from '../shared/ais';
import { codexAdapter, shouldRegisterCodex } from './providers/codex/codex-provider';

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
    // `acp` (E40 item 06, #1289): the fake ACP agent FIRST, so a new card's
    // default provider is it (the first registered — `defaultProviderId`),
    // with the Claude fake beside it. Every other value is exactly as before.
    if (process.env.SWITCHBOARD_FAKE_PROVIDER === 'acp') registry.register('provider-adapter', fakeAcpAdapter);
    registry.register('provider-adapter', fakeStreamAdapter);
    // `both` (E40 item 13, #1296): the Claude fake FIRST — so it stays the
    // default, as Claude does on a real launch with Codex present — and the
    // fake ACP agent AFTER it, as a second AI to dispatch onto.
    if (process.env.SWITCHBOARD_FAKE_PROVIDER === 'both') registry.register('provider-adapter', fakeAcpAdapter);
    return;
  }
  registry.register('provider-adapter', claudeAdapter);
  // Codex (E40 item 07, #1290): AFTER Claude, so Claude stays the default; a
  // PATH scan only, so startup is never held up (see `shouldRegisterCodex`).
  if (shouldRegisterCodex()) registry.register('provider-adapter', codexAdapter);
}

/**
 * A "Something else" AI (E40 item 08, #1291) — the one kind of provider the
 * USER defines, so it is registered at runtime: every persisted one at
 * startup, and each new one the moment it is added. Here rather than in the
 * catalog so this stays the only module that registers providers. Returns
 * false (and registers nothing) when the id is taken — a custom AI never
 * shadows a built-in.
 */
export function registerCustomAi(ai: CustomAi, clientVersion?: string): boolean {
  if (registry.resolve('provider-adapter', ai.id)) return false;
  registry.register('provider-adapter', customAcpProvider(ai, clientVersion));
  return true;
}

/** Remove a custom AI's provider. Live sessions keep the controls they were
 *  built with; a card that names it falls back to the default at next start
 *  (`start-plan.ts`). Only `custom:` ids can be removed. */
export function unregisterCustomAi(id: string): boolean {
  if (!id.startsWith('custom:')) return false;
  return registry.unregister('provider-adapter', id);
}
