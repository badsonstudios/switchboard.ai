// THE NEUTRAL CONTROL CONTRACT (E40 item 04, #1287; design record
// `docs/plans/e40-multi-ai-design.md` §3).
//
// "What you can do to" a session, in words that belong to no AI: answer a
// permission request, interrupt the turn, list and switch models, read and set
// effort, read the context fill, the mode, slash commands, the live MCP verbs —
// and the plumbing under them (send a prompt, correlate a reply). Each provider
// implements these behind its adapter's `controls` capability; Claude's are
// `providers/claude-controls.ts`, and nothing outside `src/main/providers/`
// builds a provider's control frames any more (`engine-seam.test.ts` pins it).
//
// THE DECLARATION IS THE SHAPE. A member of `SessionControls` that is present
// is a control this session has; one that is absent is a control it does not,
// and the composer greys it out with "Not available with <AI>"
// (`declaredControls` -> `sessions:controls`). There is no second list to keep
// in step with the implementation — the implementation is the list.
//
// SHAPED SO AN ACP PROVIDER CAN DECLARE EXACTLY WHAT IT MEASURED
// (`spike/findings/e40-codex-acp.md`, Codex over ACP):
//
//   approvals    `session/request_permission` answered by `optionId`, chosen
//                by option KIND: `allow` -> `allow_once`, `deny` ->
//                `reject_once` (there is no `reject_always`, measured).
//                `updatedInput` and the denial `message` have no ACP field;
//                an ACP provider drops them.
//   interrupt    `session/cancel` (a notification; the prompt answers
//                `stopReason: "cancelled"`).
//   models       `configOptions` `category:"model"`, switched with
//                `session/set_config_option`; the reply is the truth (no
//                update notification followed, measured).
//   effort       `configOptions` `category:"thought_level"`, same verb.
//   modes        `session/set_mode` — a LIVE switch, which Claude does not
//                have (it applies `--permission-mode` at the next start), so
//                `ModeControl.set` is optional.
//   slashCommands  `available_commands_update`; a command is sent as prompt
//                text, as it is for Claude.
//   contextUsage `usage_update {used, size}` is pushed, not asked — an ACP
//                provider would answer `get()` from the last one it saw.
//   mcp          none of the live verbs exists over ACP; not declared.
//
// FAIL-OPEN (P6). A control a provider lacks is answered `unsupported` by the
// manager, never thrown. A control method that throws is caught at the call
// site, logged, and answered as a refusal; the session carries on.
//
// MAIN-ONLY. What crosses IPC is the verdicts (`shared/control.ts`) and the
// declaration's names (`shared/engine-controls.ts`).
import { ENGINE_CONTROLS, type EngineControl } from '../../shared/engine-controls';
import type { ControlVerdict } from '../../shared/control';
import type { AutonomyMode } from '../../shared/sessions';
import type { PromptAttachment } from '../../shared/prompt-attachments';

/**
 * How a person answered a permission request, in the host's words.
 *
 * `allow` carries the input the tool should run with — the request's own, or
 * the answers to a question (`AskUserQuestion`, #563). `deny` carries the
 * sentence the AI is told. A provider whose wire has no room for one of these
 * drops it rather than inventing a field.
 */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/** Answer the engine's permission requests. */
export interface ApprovalControl {
  /**
   * Send the answer to request `requestId` (the engine's own id, as the
   * `permission-request` event carried it). `false` when it could not be
   * written — the session's transport has gone.
   */
  answer(requestId: string, decision: PermissionDecision): boolean;
}

/** Stop the running turn. */
export interface InterruptControl {
  /** `false` when the request could not be written. */
  interrupt(): boolean;
}

/** List the session's models and switch between them. */
export interface ModelControl {
  /** `{ models: [{ value, displayName?, … }] }` — `shared/models.ts`'s shape */
  list(): Promise<ControlVerdict>;
  /** `model` is untrusted: validate it before the wire */
  set(model: unknown): Promise<ControlVerdict>;
}

/** How hard the model thinks. */
export interface EffortControl {
  /** `{ effort, levels, model? }` — `shared/effort.ts`'s `EffortState`, plus
   *  the model the same answer named, when it did (#1174) */
  get(): Promise<ControlVerdict>;
  /** verified by effect; a level that did not take is `refused` */
  set(level: unknown): Promise<ControlVerdict>;
}

/** How full the context window is. */
export interface ContextUsageControl {
  /** `shared/context-usage.ts`'s `ContextUsage`, numbers only */
  get(): Promise<ControlVerdict>;
}

/**
 * The session has an autonomy mode the host can show and choose.
 *
 * `set` is OPTIONAL and Claude's has none: its mode is `--permission-mode`,
 * applied at the next start from the card's setting (§5.9), and the CLI
 * announces where it really is through `mode` events. An engine with a live
 * switch (ACP `session/set_mode`) declares `set`, and the mode chip
 * (`sessions:setAutonomy`) calls it on the live session as well as storing the
 * card's choice for the next start (E40 item 06, #1289).
 */
export interface ModeControl {
  set?(mode: AutonomyMode): Promise<ControlVerdict>;
}

/**
 * The engine runs `/commands` typed as a prompt, and advertises which
 * (`commands` events). No methods: a command TRAVELS as prompt text, which is
 * `SessionControls.prompt`. Declaring it is what keeps Compact and Clear live.
 */
export type SlashCommandControl = Record<string, never>;

/** The live MCP verbs (#729, #734). Names are untrusted; validate them. */
export interface McpControl {
  status(): Promise<ControlVerdict>;
  toggle(serverName: unknown, enabled: unknown): Promise<ControlVerdict>;
  reconnect(serverName: unknown): Promise<ControlVerdict>;
  authenticate(serverName: unknown): Promise<ControlVerdict>;
  clearAuth(serverName: unknown): Promise<ControlVerdict>;
}

/**
 * One session's controls, built at spawn by `ControlCapability.createControls`.
 *
 * Every member optional. The ones keyed by an `EngineControl` name are the
 * DECLARATION (see the header); the rest are plumbing the host needs whatever
 * the AI, and are not in the grey-out vocabulary.
 */
export interface SessionControls {
  approvals?: ApprovalControl;
  interrupt?: InterruptControl;
  models?: ModelControl;
  effort?: EffortControl;
  contextUsage?: ContextUsageControl;
  modes?: ModeControl;
  slashCommands?: SlashCommandControl;
  mcp?: McpControl;
  /**
   * Send one user turn. Plumbing rather than a declared control — every engine
   * takes a prompt — but it is the provider's, because the turn's FRAME is a
   * wire format (Claude's `user` message with its `uuid` and `origin`).
   * Absent or `false`: the prompt did not go.
   */
  prompt?: (text: string, attachments: readonly PromptAttachment[]) => boolean;
  /**
   * Every inbound frame of this session, after the translator has had it —
   * how a provider correlates the REPLIES to what its controls asked. Must
   * not throw (a throw is caught and logged per frame).
   */
  receive?: (frame: Record<string, unknown>) => void;
  /**
   * The session is going: settle everything in flight now (as `session-gone`)
   * rather than at a timeout. Idempotent.
   *
   * These three are PROPERTY signatures, not method shorthands, for #663's
   * reason (`TitleCapability.titleFrom`): the host reads each slot as a value
   * before calling it, and none of them is promised a `this`.
   */
  forget?: () => void;
}

/** The slice of a session a provider's controls may use. */
export interface ControlSession {
  /** switchboard's id for the live session — for logs and correlation */
  readonly id: string;
  /**
   * Write one frame to the session's transport. `false` when the handle has
   * no typed channel or is gone.
   */
  send(frame: unknown): boolean;
  /**
   * Hand a frame of the PROVIDER'S OWN making to this session's translator and
   * controls, exactly as if the engine had sent it (E40 item 06, #1289).
   *
   * For the events only the provider can know about: an engine that does not
   * echo the user's prompt back (ACP; Claude does, `--replay-user-messages`)
   * still has to put the prompt in the Feed, and a cancel that settles held
   * permission requests has to withdraw them. The provider recognises its own
   * frames by identity, so nothing the engine writes can pass as one.
   * Synchronous; a no-op once the session is gone. Optional so a test double
   * need not supply it.
   */
  loopback?(frame: Record<string, unknown>): void;
}

/** The adapter capability: how a provider builds one session's controls. */
export interface ControlCapability {
  /**
   * A fresh set of controls for one session. Called once, at spawn, beside
   * `events.createTranslator`. MUST NOT THROW; a throw is caught at the call
   * site and the session runs with NO controls — it can still be read, and
   * every control answers `unsupported` (P6).
   */
  createControls(session: ControlSession): SessionControls;
}

/**
 * The declaration, as names: which `EngineControl`s these controls have, in
 * `ENGINE_CONTROLS` order. What `sessions:controls` sends the composer.
 */
export function declaredControls(controls: SessionControls | null | undefined): EngineControl[] {
  if (!controls) return [];
  return ENGINE_CONTROLS.filter((name) => controls[name] !== undefined);
}
