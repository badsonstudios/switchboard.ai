// Claude Code provider adapter v0 — registered via the contribution registry
// (§5.23); nothing outside bootstrap may import this module directly.
// The spawn recipe implements the S-01/S-02 verdicts; the full adapter
// (settings generation, validation, hook wiring) lands in P1-E2-02.
import { ProviderAdapter, SpawnOptions, SpawnRecipe } from '../extensibility/contributions';

export const claudeAdapter: ProviderAdapter = {
  manifest: {
    id: 'claude-code',
    displayName: 'Claude Code',
    version: '0.1.0',
    capabilities: ['sessions.spawn'],
  },

  buildSpawn(options: SpawnOptions): SpawnRecipe {
    const args: string[] = [];
    if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
    return {
      // P1-E2-02 resolves this to an absolute path before spawn (S-01:
      // PATH-relative .cmd with cwd=user project is a planted-binary footgun)
      command: 'claude.cmd',
      args,
      env: {
        // S-01 landmines: never let these leak into a hosted session
        ELECTRON_RUN_AS_NODE: undefined,
        ELECTRON_NO_ATTACH_CONSOLE: undefined,
      },
    };
  },
};
