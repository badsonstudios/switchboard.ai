// MAIN's contribution vocabulary (§5.23). The registry mechanics live in
// src/shared/extensibility/registry.ts and are shared with the renderer; what
// each process can contribute is its own business, and this file is main's
// half of that. Contracts here may reference main-only concepts freely.
import { SlashCommand } from '../../shared/slash-commands';
import { CapabilityManifest } from '../../shared/extensibility/registry';

/**
 * Provider adapter contract v0 (§5.3). The full interface grows in P1-E2-02;
 * v0 covers what a session manager needs to spawn a CLI.
 */
export interface ProviderAdapter {
  manifest: CapabilityManifest;
  /** Build the spawn recipe for a session in `cwd`. */
  buildSpawn(options: SpawnOptions): SpawnRecipe;
  /**
   * The CLI's builtin slash commands, for the composer autocomplete
   * (P2-E10-07, §5.17). Optional: a provider without the concept degrades to
   * scanned project/user commands only.
   */
  slashCommands?(): SlashCommand[];
}

export interface SpawnOptions {
  cwd: string;
  /** switchboard's own session id — used to key per-session state on disk */
  sessionId: string;
  /** directory for per-session generated state (settings files etc.) */
  stateDir: string;
  /** provider-native session id to resume */
  resumeSessionId?: string;
  /** autonomy profile (§5.9): how much the session may do unprompted */
  autonomy?: 'plan' | 'ask' | 'auto-edit' | 'full-auto';
  /** extra settings to inject at spawn (S-02 mechanism); hooks land in E2-05 */
  settings?: Record<string, unknown>;
}

export interface SpawnRecipe {
  command: string;
  args: string[];
  /** env DELTAS applied over a scrubbed process env (see S-01 findings) */
  env: Record<string, string | undefined>;
}

/**
 * Main's contribution points.
 *
 * `event-source` used to sit here as a v0 seam for the §5.12 event stream. It
 * was deleted in P2-E15-02 (AR-P2-13): nothing registered into it and nothing
 * consumed it, anywhere in the tree. A contribution point with nothing behind
 * it is a guess about the future rather than a seam — it shaped nothing except
 * this type map. Re-adding it next to a real registrant (the §5.14 status
 * monitor) is a smaller job than keeping a contract no implementation has ever
 * had to satisfy.
 */
// A type alias, NOT `interface ... extends ContributionMap`: extending the map
// inherits its index signature, which makes `keyof C` collapse to `string` and
// silently stops checking point names — a typo, or a RENDERER point registered
// here, would both compile. An object type alias satisfies the constraint
// through its implicit index signature without acquiring one of its own.
export type MainContributions = {
  'provider-adapter': ProviderAdapter;
};
