// THE NEUTRAL SESSION EVENT MODEL (E40 item 03, #1286; design record
// `docs/plans/e40-multi-ai-design.md` §3).
//
// "What happened" in a session, in words that belong to no AI. Each engine
// translates its own wire format into these — Claude's stream-json translator
// is `providers/claude-events.ts`, declared through the adapter's `events`
// capability — and everything downstream of the pump (the Feed, the status
// machine via `stream-status.ts`, service health) reads ONLY these. None of
// those modules may read a provider's frames; `engine-seam.test.ts` pins it.
//
// WHAT IS NOT HERE, ON PURPOSE: the CONTROLS (approve/deny, interrupt, model,
// mode, slash commands). Those are "what you can do to it" — provider methods
// declared through the adapter's `controls` capability (E40 item 04, #1287;
// `sessions/engine-controls.ts`). What IS here is what the engine ANNOUNCES
// about them: a request waiting on a decision (`permission-request`, which
// carries the ask, and `permission-withdrawn`), the commands it offers
// (`commands`), the model it is on (`model`) and the mode it is in (`mode`).
// The permission router and the command, model and mode stores read these
// through `onEngineEvent`, like the Feed; answering goes back through
// `SessionControls`.
//
// SHAPED SO AN ACP TRANSLATOR CAN TARGET IT (§4). ACP's `session/update`
// variants land as: `agent_message_chunk` / `agent_thought_chunk` -> `chunk`
// (opened and closed by the translator, which owns the index); `tool_call` ->
// `tool-call-start` plus a `message` carrying the tool block; `tool_call_update`
// with output -> a `message` carrying a tool result; `plan` -> a `message`
// carrying a todos block; a `session/prompt` response -> `turn-end`;
// `session/request_permission` -> `permission-request`;
// `available_commands_update` -> `commands`; `current_mode_update` (or a
// `session/set_mode` reply) -> `mode`; the model in `session/new`'s
// `models.currentModelId` or a `set_config_option` reply -> `model`.
//
// MAIN-ONLY. Nothing here crosses IPC: `message.derive` is a function, and the
// Feed's blocks, not these, are what the renderer receives.
import type { BlockIntent, DerivationCaps, DerivationContext } from '../feed/blocks';
import type { CliCommand } from '../../shared/slash-commands';
import type { AutonomyMode } from '../../shared/sessions';
import type { PlanLimitWindow } from '../../shared/usage-report';

/**
 * The engine is producing output for the running turn — the status machine's
 * cue that a turn is under way even if we did not see it start (a resumed
 * conversation continuing, a message the engine had queued).
 *
 * `label` names what the engine actually sent, for the transition log ONLY
 * (`stream:<label>`), so a person reading why a status moved can still tell
 * which frame moved it. Nothing may branch on it.
 */
export interface ActivityEvent {
  type: 'activity';
  label: string;
  /**
   * The output is a SUBAGENT's, not the main conversation's (#1340) — for
   * Claude, a frame carrying a `parent_tool_use_id`. Status treats it like any
   * output; only the turn tracking ignores it (no turn end is owed for it).
   * Absent means the main conversation's.
   */
  sidechain?: true;
}

/** The engine named the native conversation this turn runs in (the resume id). */
export interface ConversationEvent {
  type: 'conversation';
  id: string;
}

/**
 * The engine says it threw the conversation away (a clear). `discarded` is the
 * conversation it names as the one being dropped, when it names one.
 */
export interface ConversationResetEvent {
  type: 'conversation-reset';
  discarded?: string;
}

/** A new reply begins: whatever the last one left open is over. */
export interface MessageStartEvent {
  type: 'message-start';
}

/** Tokens have stopped for every block of the current reply. */
export interface MessageEndEvent {
  type: 'message-end';
}

/** What kind of prose a streamed block holds. */
export type ChunkKind = 'text' | 'thinking';

/**
 * A streamed block opens at `index` within the current reply. `index` is the
 * engine's address for the block; later chunks and the closing `message` use
 * the same one.
 */
export interface ChunkOpenEvent {
  type: 'chunk-open';
  index: number;
  kind: ChunkKind;
}

/** A tool call opens at `index`, its name known, its input not yet. */
export interface ToolCallStartEvent {
  type: 'tool-call-start';
  index: number;
  name: string;
  /** the id a later tool result will quote, when the engine says it this early */
  toolCallId?: string;
}

/** A message or thought chunk. Never empty. */
export interface ChunkEvent {
  type: 'chunk';
  index: number;
  kind: ChunkKind;
  text: string;
}

/** The block at `index` stops taking tokens. */
export interface ChunkCloseEvent {
  type: 'chunk-close';
  index: number;
}

/**
 * The authoritative content of one message: text, thinking, tool calls, tool
 * results, a todo list / plan, a user prompt.
 *
 * Expressed in the Feed's OWN neutral vocabulary — `BlockIntent`, i.e. the
 * same block kinds the renderer draws — and supplied as a function rather than
 * as data because two of the inputs are the host's, not the engine's: the
 * display caps, and the #830 forgery guard that decides whether a context
 * marker in a prompt is one this app minted. The engine supplies HOW its
 * content becomes blocks; the Feed supplies the context. `derive` must not
 * throw and must not have side effects; it may be called once.
 *
 * `unstreamed` (assistant only): no tokens built this message, so it must not
 * claim a block that streamed chunks opened (#978). A local command's output
 * is the measured case.
 */
export interface MessageEvent {
  type: 'message';
  role: 'assistant' | 'user';
  unstreamed: boolean;
  derive(caps: DerivationCaps, ctx: DerivationContext): BlockIntent[];
}

/**
 * The turn is over. `failed` is the error signal: a failed turn is finished,
 * not running (the status machine treats both as done), and this is the only
 * place the difference is carried. `label` is as on `ActivityEvent`.
 */
export interface TurnEndEvent {
  type: 'turn-end';
  failed: boolean;
  label: string;
}

/**
 * The engine is waiting on a decision from a person, and what it is asking.
 *
 * The status machine reads only that it happened (`permission-held`); the
 * permission router reads the ask and answers it through the provider's
 * `approvals` control, naming `requestId` (#1287). Field by field this is what
 * the router used to read off Claude's `can_use_tool` itself, with the same
 * defaults, so a standing grant that covers a request is decided on exactly
 * the same values it always was.
 */
export interface PermissionRequestEvent {
  type: 'permission-request';
  /**
   * The ENGINE'S OWN id for this request — what the answer must name. `''`
   * when the engine sent none: the request cannot be answered, and the router
   * drops it (the status still says it is waiting, as it always did). A
   * string even where the wire's id is a number: ACP's first request id is
   * `0`, measured (`spike/findings/e40-codex-acp.md` Q3).
   */
  requestId: string;
  /** the tool asking, `'unknown'` when the engine did not say */
  tool: string;
  /** the tool's input as the engine sent it (`{}` when absent) */
  input: Record<string, unknown>;
  /** why the engine is asking, in its own words */
  reason?: string;
  /** the engine's own classification of `reason` */
  reasonType?: string;
  /** a human name for the tool, when the engine has one */
  displayName?: string;
  /** the engine's suggested standing rules, passed through unread */
  suggestions?: Array<Record<string, unknown>>;
}

/**
 * The engine took a request back before anyone answered it (the CLI cancelled
 * the tool call). Nothing to answer any more; the router lets it go.
 */
export interface PermissionWithdrawnEvent {
  type: 'permission-withdrawn';
  requestId: string;
}

/**
 * How many BACKGROUND tasks the engine has running right now (#1359): helpers
 * that outlive the turn that started them — a backgrounded subagent, a
 * background command. A REPLACEMENT, sent whenever the set changes, so
 * `running: 0` means "none is left". The status machine reads it: with no main
 * turn running, it is the only thing that says a helper's work is over.
 */
export interface BackgroundWorkEvent {
  type: 'background-work';
  running: number;
}

/**
 * The commands this engine offers right now, in full — a REPLACEMENT, not a
 * delta. `dropped` counts entries the translator could not read (logged by the
 * store, at debug).
 */
export interface CommandsEvent {
  type: 'commands';
  commands: CliCommand[];
  dropped: number;
}

/** The model the engine says this session is running. Never empty. */
export interface ModelEvent {
  type: 'model';
  id: string;
}

/**
 * The mode the engine says this session is in, already in the host's own
 * vocabulary. An engine mode with no host name is not sent: a stale chip
 * beats a wrong one (P6).
 */
export interface ModeEvent {
  type: 'mode';
  mode: AutonomyMode;
}

/**
 * The engine asks the host to KEEP these settings with the conversation
 * (#1317), and to hand them back in `SpawnOptions.resumeSettings` when it is
 * reopened. Sent after a set the agent confirmed, with everything the engine
 * now holds for that conversation (not just the field that changed).
 *
 * Why the host keeps them: an ACP `session/load` resets model and effort to
 * the agent's defaults (measured on Codex, `spike/findings/e40-codex-acp.md`
 * Q5), and the engine's own memory of them dies with the process. The values
 * are the engine's own ids, opaque to the host.
 */
export interface SettingsEvent {
  type: 'settings';
  /** the native conversation they belong to (the resume id) */
  conversation: string;
  model?: string;
  effort?: string;
}

/**
 * The engine compacted the conversation's context. Token counts as the engine
 * reported them, when it did. The Feed draws it as a divider (#1259,
 * `StreamFeed.onCompaction`); `trigger` is `manual` (the user asked) or `auto`
 * (the engine did it on its own), and anything else is drawn without a who.
 */
export interface CompactionEvent {
  type: 'compaction';
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
}

/**
 * What ONE TURN cost, as the engine reported it (#1288). A DELTA: the host adds
 * turns up (`usage/event-usage.ts`). `limits` is not a delta; the latest report
 * replaces the last.
 *
 * ONE USAGE PATH PER PROVIDER. This is the path for an engine that writes no
 * transcript the host can read (Codex over ACP reports per-turn tokens in its
 * `session/prompt` result, `spike/findings/e40-codex-acp.md` Q6). A provider
 * that declares `transcripts` gets its usage from the transcript ledger, which
 * carries detail no per-turn report does (cache writes, thinking, subagent
 * files), and its usage events are ignored — so Claude's translator emits none.
 */
export interface UsageEvent {
  type: 'usage';
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** the part of `outputTokens` spent thinking — inside it, never added */
  thinkingTokens?: number;
  /** the model the turn ran on, as the engine names it — the price lookup's key */
  model?: string;
  /** plan-limit windows, when the engine reports them */
  limits?: PlanLimitWindow[];
}

export type EngineEvent =
  | ActivityEvent
  | ConversationEvent
  | ConversationResetEvent
  | MessageStartEvent
  | MessageEndEvent
  | ChunkOpenEvent
  | ToolCallStartEvent
  | ChunkEvent
  | ChunkCloseEvent
  | MessageEvent
  | TurnEndEvent
  | PermissionRequestEvent
  | PermissionWithdrawnEvent
  | BackgroundWorkEvent
  | CommandsEvent
  | ModelEvent
  | ModeEvent
  | SettingsEvent
  | CompactionEvent
  | UsageEvent;

/**
 * One session's translator: one wire frame in, the neutral events it means out
 * (often none). Built per session by `EventCapability.createTranslator`, so an
 * engine whose wire is stateful (JSON-RPC ids, an ACP chunk index) can keep
 * that state without the host knowing it exists.
 *
 * MUST NOT THROW for a frame it does not understand — it returns `[]` and says
 * so through `onUnknown`. The pump still catches a throw, per frame, so a
 * broken translator costs that frame and never the session (P6).
 */
export type EngineTranslator = (frame: Record<string, unknown>) => EngineEvent[];

export interface TranslatorHooks {
  /**
   * A frame type the translator does not recognise. Called at most ONCE per
   * type per translator, so a chatty unknown frame is one log line, not one
   * per frame.
   */
  onUnknown?(frameType: string): void;
  /**
   * A frame the translator DID understand but could not use — a command list
   * that is not a list, a model that is blank, a mode with no host name — so
   * it sent nothing and the stores keep what they had (#1287). For the log,
   * at debug: the stores logged these themselves when they read the frames,
   * because the symptom otherwise has none (a popup or a chip that quietly
   * stopped tracking the engine). A property, not a method, for #663's reason:
   * the translator hands the slot on as a value.
   */
  onSkipped?: (what: string, fields: Record<string, string>) => void;
}
