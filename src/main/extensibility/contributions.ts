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
   * What this provider can do BEYOND being a process in a terminal (§5.3).
   * Every member optional; a generic adapter declares none and degrades to
   * PTY-only, which §5.3 promises is still useful — any CLI becomes a hostable
   * session.
   *
   * NOT to be confused with `manifest.capabilities`, which is a list of §5.23
   * capability NAMES the IPC broker grants against. That one answers "what may
   * this contributor call"; this one answers "what can this CLI do". They are
   * different vocabularies and deliberately never sit side by side — one is
   * nested under `manifest`.
   */
  capabilities?: ProviderCapabilities;
  /**
   * The CLI's builtin slash commands, for the composer autocomplete
   * (P2-E10-07, §5.17). Optional: a provider without the concept degrades to
   * scanned project/user commands only.
   */
  slashCommands?(): SlashCommand[];
}

/**
 * §5.3's capability objects. The host ASKS these instead of assuming Claude —
 * the whole point of P2-E15-01 (AR-P0-1).
 *
 * `mcp` is deliberately ABSENT. §5.3 lists it, but there is no Session Bus to
 * attach to until E11, so the field would be a type with no implementation and
 * no consumer — the exact shape P2-E15-02 deleted `event-source` for
 * (AR-P2-13). When E11 lands, it arrives here beside its first registrant and
 * its first caller: an `McpAttachment` that writes the provider's MCP config so
 * the session can reach the stdio bus (§5.4 — stdio-only in v1, so it is a file
 * the adapter writes, not a port it dials).
 */
export interface ProviderCapabilities {
  /**
   * The CLI writes structured conversation transcripts we can read (§5.26).
   * Absent: no transcript watch is started at all, so no usage numbers, no
   * Session-view blocks, no plan chip — the session is a terminal and nothing
   * more.
   *
   * Scope, stated plainly: this locates the transcripts, it does not abstract
   * READING them. §5.3 names a `TranscriptReader`; our parser, tailer and block
   * builder are still host-side, shared by every provider that writes the same
   * shape. Moving the reader behind the adapter is a much larger change with no
   * consumer asking for it — the day a provider writes a different transcript
   * FORMAT is the day that becomes worth doing.
   */
  transcripts?: TranscriptCapability;
  /**
   * The CLI can be made to push lifecycle events back to us by injecting
   * settings at spawn (§5.15). Absent: nothing is written and no session token
   * is registered, so status comes from the process alone.
   */
  hooks?: HookCapability;
  /** The CLI can resume a previous conversation (§5.25). Absent: every start is
   *  a fresh session, and a persisted native id is simply not used. */
  resume?: ResumeCapability;
  /**
   * The CLI needs the project folder prepared before it will work there —
   * Claude's per-folder trust acceptance (§5.9). Absent: nothing is done to the
   * folder, which is the right default; a provider that has never heard of
   * `~/.claude.json` must not have it written on its behalf.
   *
   * Not in §5.3's original four. It is here because it is a real Claude-shaped
   * side effect that WAS unconditional in the session-start path, found in
   * review of this item — the same class of assumption as the other three, and
   * the alternative was leaving it undeclared. DESIGN §5.3 amended to match.
   */
  trust?: TrustCapability;
}

export interface TranscriptCapability {
  /** Root directory this provider writes conversations under. Read per session
   *  rather than once at startup, so it can depend on the environment (a
   *  provider may honour a HOME or config override the user changes). */
  projectsRoot(): string;
}

export interface HookCapability {
  /**
   * Settings to inject at spawn for `sessionId`.
   *
   * The host owns the WIRING — the local port, the per-session token file, the
   * forwarder script — because those are switchboard's, not the provider's. The
   * adapter owns the SHAPE: given the host's hook config, express it the way
   * this CLI expects. Claude passes it through unchanged; a provider with a
   * different config schema translates here instead of the host learning about
   * it.
   */
  settingsFor(sessionId: string, host: HookSettingsHost): Record<string, unknown>;
}

/** The slice of the host's hook listener an adapter may use. */
export interface HookSettingsHost {
  buildHookSettings(sessionId: string): Record<string, unknown>;
}

export interface TrustCapability {
  /** Make `folder` usable by this provider. Called only when the app's
   *  auto-trust setting is on; must be idempotent and must fail open.
   *  Returns whether it succeeded — a silent failure here is a trust dialog
   *  the user cannot explain. */
  ensureTrusted(folder: string): boolean;
}

export interface ResumeCapability {
  /**
   * Is `nativeSessionId` actually resumable for this folder?
   *
   * Eligibility only — `buildSpawn` still owns the flag. The check exists
   * because a stale id is not harmless: Claude exits with "No conversation
   * found" and the card crashes on spawn, so the host must be able to fall back
   * to a fresh session BEFORE it commits to resuming.
   */
  canResume(folder: string, nativeSessionId: string): boolean;
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
