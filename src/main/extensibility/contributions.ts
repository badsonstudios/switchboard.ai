// MAIN's contribution vocabulary (§5.23). The registry mechanics live in
// src/shared/extensibility/registry.ts and are shared with the renderer; what
// each process can contribute is its own business, and this file is main's
// half of that. Contracts here may reference main-only concepts freely.
import { SlashCommand } from '../../shared/slash-commands';
import { CapabilityManifest } from '../../shared/extensibility/registry';
import type { AutonomyMode } from '../../shared/sessions';
import type { BusLaunch } from '../bus/launch';
import { TransportKind } from '../transport/transport';

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
 * `mcp` ARRIVED IN P2-E11-03 (#763, 2026-09-08), and the wait was the point.
 * §5.3 listed it from the start, but until E11 there was no Session Bus to
 * attach to, so the field would have been a type with no implementation and no
 * consumer — the exact shape P2-E15-02 deleted `event-source` for (AR-P2-13).
 * It lands here beside its first registrant (`claudeAdapter`) and its first
 * caller (`start-plan.ts`), which is the condition the deferral named.
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
  /**
   * The CLI writes a human-readable TITLE of the conversation into its own
   * transcript, which we display as the task label (§5.11, P2-E7-06). Absent:
   * no line is ever inspected for one and the label is never auto-filled — the
   * folder name stands, which is exactly how the app read before this existed.
   *
   * Separate from `transcripts` on purpose. That one says WHERE the file is;
   * this one says the file contains a title AND how to recognise it. A provider
   * can easily have the first without the second, and the key that carries it
   * (`ai-title`/`aiTitle` for Claude) is undocumented — no contract promises it
   * exists or keeps its name — so the one thing that must not happen is that
   * spelling leaking into shared code as "the" way transcripts carry titles.
   */
  titles?: TitleCapability;
  /** The CLI can resume a previous conversation (§5.25). Absent: every start is
   *  a fresh session, and a persisted native id is simply not used. */
  resume?: ResumeCapability;
  /**
   * The CLI can FORK a conversation — start a new session carrying an existing
   * one's whole history, leaving the original untouched (§5.5 Level 3,
   * P2-E11-12). Absent: the fork surface is not offered at all.
   *
   * SEPARATE FROM `resume`, and the separation is the point. Resume CONTINUES a
   * conversation — measured 2026-08-15 and again here: plain `--resume`
   * re-adopts the id and APPENDS to the same transcript. Fork MINTS a second
   * conversation from the same history. A provider could easily have the first
   * without the second, and conflating them would let a Level 3 gesture fall
   * through to a resume that writes into the source session's transcript —
   * which is precisely the damaging failure #801 names.
   *
   * ⚠️ **LEVEL 3 IS SAME-PROVIDER ONLY.** DESIGN §5.5 records that transcript
   * formats are not interchangeable across vendors, so this must never be
   * reachable from a cross-provider handoff. Declaring the capability is how a
   * provider says "these transcripts are mine and I can fork them"; an adapter
   * that cannot must simply not declare it, and then no code path can offer it.
   */
  fork?: ForkCapability;
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
  /**
   * The CLI can be handed extra MCP servers at spawn, which is how a session
   * reaches the Session Bus (§5.3, §5.4; P2-E11-03). Absent: no config is
   * written, no `--mcp-config` is passed, and the session spawns EXACTLY as it
   * did before this capability existed — asserted as a byte-identical recipe,
   * not merely "no new flag", because that is the claim §5.3 actually makes.
   *
   * A session without it is not broken, it is just alone: no `list_sessions`,
   * and later no read tools and no `send_to_session`.
   */
  mcp?: McpCapability;
}

/**
 * Which conversation is being forked, and WHERE IT LIVES.
 *
 * ⚠️ `sourceFolder` IS THE SOURCE'S FOLDER, NOT THE TARGET'S, and that is the
 * whole reason this is not `ResumeQuery`. A resume always asks about the folder
 * the session is starting in; a fork's defining case is CROSS-FOLDER — session
 * A's conversation adopted by a new session in folder B — so the two questions
 * genuinely differ, and reusing the resume shape here would have sent the
 * lookup to the wrong directory in exactly the case the feature exists for.
 * (Claude's layout derives the directory name from the folder path, so asking
 * about B would look in a directory A's transcript is not in and answer "no".)
 */
export interface ForkQuery {
  /** the transcript root the HOST resolved and will read back from (#432) */
  projectsRoot: string;
  /** the folder the SOURCE conversation belongs to */
  sourceFolder: string;
  /** the conversation being forked FROM */
  sourceSessionId: string;
}

export interface ForkCapability {
  /**
   * Is this conversation really there to be forked?
   *
   * Asked BEFORE the id reaches argv, for `ResumeCapability.canResume`'s reason:
   * a stale id makes the CLI exit at spawn and the card crash. Measured
   * behaviour on a missing conversation is a non-zero exit in under a second
   * with `No conversation found with session ID: <id>` — fast and readable, but
   * still a session that never starts, and the user asked for a specific one.
   *
   * MUST NOT THROW; a throw is caught at the call site and degrades the
   * capability to absent for that start, which costs the fork and not the app.
   */
  canFork(query: ForkQuery): boolean;
}

export interface McpCapability {
  /**
   * The MCP config to attach at spawn for `sessionId`, or `null` for "nothing
   * to attach" (which must spawn identically to having no capability at all).
   *
   * THE SAME SPLIT AS `HookCapability.settingsFor`, and for the same reason:
   * the host owns the WIRING — which endpoint, which token file, which binary
   * launches the server — because those are switchboard's. The adapter owns the
   * SHAPE: given the host's launch recipe, express it the way this CLI's config
   * schema expects. Claude's is `{ mcpServers: { <name>: {...} } }`; a provider
   * with a different schema translates here instead of the host learning about
   * it.
   *
   * MUST NOT THROW; a throw is caught at the call site and degrades this
   * capability to absent for the session, because a session that starts without
   * its bus is enormously better than a session that does not start (P6).
   */
  configFor(sessionId: string, host: McpAttachmentHost): Record<string, unknown> | null;
}

/** The slice of the host's bus an adapter may use. */
export interface McpAttachmentHost {
  /**
   * Attach this session to the bus, and answer with how to launch its server —
   * `{ command, args, env }`, ready to drop into whatever the provider's config
   * schema calls a server entry.
   *
   * **NAMED FOR THE SIDE EFFECT, not for the return value.** `busServerFor`
   * would read better at the call site and would be a lie: this does not merely
   * look something up, it OPENS the session's endpoint. Hiding that behind a
   * getter-shaped name is how someone later calls it twice, or calls it to
   * "check", and gets a listener they did not ask for.
   *
   * `null` means the host has no bus for this session (the launch recipe could
   * not be built at all), and the adapter must then attach nothing rather than
   * write a config naming a server that cannot work.
   *
   * ⚠️ **DOES NOT WAIT FOR THE ENDPOINT TO BE LISTENING**, and must not: it is
   * called from inside `SessionManager.create`, which is synchronous end to end
   * and has to stay that way (`sessions/ipc.ts` — an `await` before `create`
   * lets two lazy-spawn calls both pass the reap and breaks one-live-session-
   * per-card). Safe because the paths are derived rather than discovered
   * (`busEndpointFor`) and because the child dials at its FIRST TOOL CALL,
   * seconds later, not at spawn.
   */
  attachSession(sessionId: string): BusLaunch | null;
  /**
   * Give back everything `attachSession` took out, for a session that will
   * never exist.
   *
   * The host calls this itself on a failed start; an adapter has no reason to.
   * It is on this interface rather than hidden because the pair is the
   * documentation: seeing both here is what stops the next reader concluding,
   * as #763's first draft did, that attaching has no side effect worth undoing.
   *
   * Idempotent, and must not throw for an id it does not know.
   */
  releaseSession(sessionId: string): void;
}

export interface TranscriptCapability {
  /** Root directory this provider writes conversations under. Read per session
   *  rather than once at startup, so it can depend on the environment (a
   *  provider may honour a HOME or config override the user changes). */
  projectsRoot(): string;
}

export interface TitleCapability {
  /**
   * The conversation title carried by ONE already-parsed transcript line, or
   * undefined when this line does not carry one — which is the answer for
   * nearly every line in the file.
   *
   * A per-line reader rather than "read the title out of this file": the host
   * is already tailing, line by line, and handing the adapter the file would
   * make it re-read bytes we have decoded. It also means the title tracks the
   * conversation for free — the CLI revises it and then re-emits the settled
   * value every turn, and the host de-dupes.
   *
   * MUST NOT THROW; if it does, the host degrades this capability to absent for
   * the session rather than losing the transcript (fail-open, P6).
   *
   * A PROPERTY signature, not a method shorthand (#663). This is a plain
   * function slot: the three shipping adapters assign the free function
   * `readAiTitle`, the test doubles assign arrows, and not one of them mentions
   * `this`. A method declaration promises a receiver anyway, which made reading
   * the slot as a value an `unbound-method` error. Type-identical for every
   * implementer; it just stops claiming a `this` that was never used.
   */
  titleFrom: (line: Record<string, unknown>) => string | undefined;
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
  /**
   * Give back what `buildHookSettings` took out, for a session that will never
   * exist (#470).
   *
   * Building settings REGISTERS state against the id — a token in the
   * listener's map — and every ordinary release of it hangs off the session
   * ending. A start that throws before the process exists has no session and
   * therefore no ending, so without this the entry is stranded for the app's
   * lifetime, one per failed start.
   *
   * Not called by adapters: it is on this interface because the host object is
   * what `planSessionStart` holds, and the plan is what carries the undo down
   * to `SessionManager.create`. Must be idempotent and must not throw.
   */
  releaseHookSettings(sessionId: string): void;
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
   * Is this conversation actually resumable?
   *
   * Eligibility only — `buildSpawn` still owns the flag. The check exists
   * because a stale id is not harmless: Claude exits with "No conversation
   * found" and the card crashes on spawn, so the host must be able to fall back
   * to a fresh session BEFORE it commits to resuming.
   *
   * THE HOST SUPPLIES THE ROOT (#432). Deriving one here is what an adapter is
   * specifically not for: `transcripts.projectsRoot()` already declares where
   * this provider's conversations live, and that same string is what a resumed
   * Direct session replays its history from (#395). Two declarations of one
   * contract agree by coincidence — an adapter that ever answered "yes" from a
   * root the host does not read would resume and then show nothing, which is
   * exactly the blank-resume symptom #395 fixed. One resolution, handed to every
   * consumer, cannot disagree with itself.
   */
  canResume(query: ResumeQuery): boolean;
  /**
   * OPTIONAL. This card lost its conversation — is one of yours lying in this
   * folder unclaimed? (#484)
   *
   * Asked only for a card that ONCE HAD a native id and whose whole chain
   * `canResume` has just declined. That is a weaker precondition than it looks,
   * which is why `ownIds` is handed over separately below: `canResume` is a
   * boolean, so "definitely not on disk" and "could not look just now" reach
   * this function as the same no. RE-CHECK `ownIds` and answer `null` unless
   * every one of them is DEFINITIVELY absent — otherwise a file lock that
   * cleared between the two calls would move a card with a perfectly good
   * transcript into a different conversation, which is the very defect this
   * capability was added to repair.
   *
   * The other half of the precondition is the host's and is real: a card that
   * has never held a conversation is never offered one, so a brand-new session
   * in a folder full of history cannot adopt a stranger's.
   *
   * Answering is a guess and the host knows it — the id it hands back is
   * promoted onto the card, and the id the card came in with is kept beneath it,
   * so a wrong guess costs the user one relaunch and destroys nothing. Answer
   * `null` whenever you are not reasonably sure, and NEVER answer from a
   * directory you could not read: "the folder is empty" and "the folder would
   * not open" must not become the same answer, since the second one is
   * temporary and this decision is written down.
   *
   * Absent: a card whose conversation is not where it was recorded simply
   * starts fresh, which is how the app behaved before this existed.
   */
  findOrphaned?(query: OrphanQuery): string | null;
}

/** What the host is asking a provider to look for on a card's behalf (#484). */
export interface OrphanQuery {
  /** the transcript root the host resolved for this session start — the same
   *  string `ResumeQuery` carries, for the same reason */
  projectsRoot: string;
  /** the project folder the session will run in */
  folder: string;
  /**
   * Every id already spoken for by ANOTHER card in the workspace — heads and
   * ancestors alike. Never hand back one of these: two cards pointing at one
   * conversation is a second, quieter kind of loss.
   */
  claimed: string[];
  /**
   * This card's own chain — the ids that were just looked for and not found.
   *
   * Two jobs. It is `claimed` as far as the answer goes ("reattach to the file
   * that is not there" must not be expressible), and it is the list to
   * RE-VERIFY before answering at all: see `findOrphaned`. Separate from
   * `claimed` precisely so the re-verification is possible — merged in, the
   * provider could not tell which ids were its own to check.
   */
  ownIds: string[];
}

/** What the host is deciding about — and, load-bearingly, WHERE it will look. */
export interface ResumeQuery {
  /**
   * The transcript root the host resolved for this session start, from this
   * provider's own `transcripts.projectsRoot()`. The same string it hands the
   * watcher and reads the resumed conversation back from, so an answer of
   * "yes, under this root" is an answer about a file the host will really read.
   *
   * `''` when there is no such root at all: the provider declares no
   * `transcripts` capability, or its call threw, or it returned an unusable
   * empty root. All three mean the same thing to answer from — the host will
   * watch nothing and replay nothing for this session — so a provider that
   * resumes OUT of a transcript has nothing to say yes about. One that resumes
   * on some other authority ignores this and answers from its own knowledge; it
   * just may not answer from a root it invented.
   */
  projectsRoot: string;
  /** the project folder the session will run in */
  folder: string;
  /** the provider-native conversation id persisted on the card */
  nativeSessionId: string;
}

export interface SpawnOptions {
  cwd: string;
  /** switchboard's own session id — used to key per-session state on disk */
  sessionId: string;
  /** directory for per-session generated state (settings files etc.) */
  stateDir: string;
  /** provider-native session id to resume */
  resumeSessionId?: string;
  /**
   * FORK the resumed conversation instead of continuing it (§5.5 Level 3).
   *
   * Only meaningful alongside `resumeSessionId` — there is nothing to fork from
   * otherwise, and the CLI's own help says so (`--fork-session`: *"When
   * resuming, create a new session ID instead of reusing the original (use with
   * --resume or --continue)"*). An adapter that sees this without a resume id
   * must pass neither flag rather than guess.
   *
   * MEASURED, claude 2.1.272 (`spike/findings/e11-801-fork-adoption.md`): with
   * this set, the source transcript is byte-identical afterwards — same sha256,
   * size and mtime — and the new conversation is written into the project
   * directory of the spawn's OWN cwd, which is what makes the cross-folder case
   * work without copying anything.
   */
  forkSession?: boolean;
  /**
   * The id the forked session must take.
   *
   * ⚠️ **MUST BE A VALID UUID.** The CLI validates `--session-id` against
   * `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` (read
   * out of the binary) and refuses anything else — at spawn, which is a card
   * that dies on open rather than a refusal anyone can act on. Validate before
   * building a recipe with this in it.
   *
   * WHY PIN IT AT ALL, when `--fork-session` mints an id by itself: because the
   * host has to know which conversation the new card belongs to. Measured on the
   * stream transport, `system:init.session_id` comes back as exactly this value
   * — so the card binds to the FORK's transcript. Left unpinned, the id is only
   * learned after the fact, and until it arrives the card's only candidate is
   * the SOURCE id, which would bind two cards to one file (#484, #539).
   */
  forkSessionId?: string;
  /** autonomy profile (§5.9): how much the session may do unprompted */
  autonomy?: AutonomyMode;
  /** extra settings to inject at spawn (S-02 mechanism); hooks land in E2-05 */
  settings?: Record<string, unknown>;
  /**
   * MCP servers to attach at spawn (P2-E11-03), already in this provider's own
   * config schema — the `mcp` capability shaped it, the host only carried it.
   *
   * A SECOND CHANNEL RATHER THAN A KEY INSIDE `settings`, deliberately: the CLI
   * takes these as a separate file behind a separate flag (`--mcp-config`, not
   * `--settings`), and folding them together would make the adapter unpick one
   * object into two files. Absent = write no file and pass no flag.
   */
  mcpConfig?: Record<string, unknown>;
  /**
   * The transport the HOST would like (P2-E18-08a). A request, not an order:
   * the adapter answers with what it will actually do in `SpawnRecipe.transport`,
   * because only it knows whether its CLI speaks that protocol. A provider that
   * has never heard of stream-json ignores this and keeps returning a PTY
   * recipe, which is the same degrade-gracefully posture as the §5.3
   * capabilities.
   *
   * Absent = the adapter's own default, which is the PTY for every adapter
   * today.
   */
  transport?: TransportKind;
}

export interface SpawnRecipe {
  command: string;
  args: string[];
  /** env DELTAS applied over a scrubbed process env (see S-01 findings) */
  env: Record<string, string | undefined>;
  /**
   * Which transport hosts this process (P2-E18-02; DESIGN §6 amendment
   * 2026-08-01). Omitted means `'pty'` — every adapter written before E18 keeps
   * working untouched, which is what makes the rest of the epic additive.
   *
   * The ADAPTER decides, not the host: the flags in `args` and the transport
   * are one decision (`--output-format stream-json` is meaningless on a PTY,
   * and a PTY recipe carries none of it). Splitting them across two owners is
   * how they drift apart.
   *
   * An unrecognised value THROWS at spawn rather than falling back — see
   * `UnknownTransportError`.
   */
  transport?: TransportKind;
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
