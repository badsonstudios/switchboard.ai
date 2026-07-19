// Bootstrap: the ONLY module allowed to import contributors directly — it
// populates the registry; everyone else resolves through it (§5.23).
import { registry } from './extensibility/registry';
import { claudeAdapter } from './providers/claude';

export function registerBuiltinContributions(): void {
  registry.register('provider-adapter', claudeAdapter);
}
