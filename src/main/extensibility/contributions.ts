// Extensibility seams v0 (§5.23): every pluggable surface goes through a
// contribution point + capability manifest, even while everything is
// in-process. The seam is the product decision; out-of-process loading can
// arrive later without rewiring consumers.
import { SlashCommand } from '../../shared/slash-commands';

/** What a contributor declares about itself. */
export interface CapabilityManifest {
  /** unique id, kebab-case, e.g. "claude-code" */
  id: string;
  displayName: string;
  version: string;
  /** capability strings, e.g. "sessions.spawn", "events.emit" */
  capabilities: string[];
}

/** Known contribution points (grows with the app). */
export type ContributionPointId = 'provider-adapter' | 'event-source';

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

/** Event-source contract v0 (feeds the §5.12 event stream). */
export interface EventSource {
  manifest: CapabilityManifest;
  /** subscribe returns an unsubscribe */
  subscribe(listener: (event: ContributedEvent) => void): () => void;
}

export interface ContributedEvent {
  sourceId: string;
  sessionId?: string;
  kind: string;
  at: string; // ISO
  data?: unknown;
}

/** Map from contribution point to its contract type. */
export interface ContributionContracts {
  'provider-adapter': ProviderAdapter;
  'event-source': EventSource;
}
