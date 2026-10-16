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
// mode, slash commands). Those are "what you can do to it", and they are E40
// item 04 (#1287). `permission-request` below is only the EVENT half of an
// approval — the fact that the engine is waiting — which the status machine
// has always needed; answering it stays on the control path.
//
// SHAPED SO AN ACP TRANSLATOR CAN TARGET IT (§4). ACP's `session/update`
// variants land as: `agent_message_chunk` / `agent_thought_chunk` -> `chunk`
// (opened and closed by the translator, which owns the index); `tool_call` ->
// `tool-call-start` plus a `message` carrying the tool block; `tool_call_update`
// with output -> a `message` carrying a tool result; `plan` -> a `message`
// carrying a todos block; a `session/prompt` response -> `turn-end`;
// `session/request_permission` -> `permission-request`. Mode and command
// updates are controls-shaped and belong with #1287.
//
// MAIN-ONLY. Nothing here crosses IPC: `message.derive` is a function, and the
// Feed's blocks, not these, are what the renderer receives.
import type { BlockIntent, DerivationCaps, DerivationContext } from '../feed/blocks';

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
 * The engine is waiting on a decision from a person. The EVENT half of an
 * approval only — answering it is a control (#1287).
 */
export interface PermissionRequestEvent {
  type: 'permission-request';
}

/**
 * The engine compacted the conversation's context. Token counts as the engine
 * reported them, when it did. No consumer yet: carried so per-AI surfaces
 * (#1288) do not have to reach for a provider's frames to learn it.
 */
export interface CompactionEvent {
  type: 'compaction';
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
}

/**
 * What the turn cost in tokens, as the engine reported it. No consumer yet —
 * usage is still read from Claude's transcripts; per-AI usage is #1288.
 */
export interface UsageEvent {
  type: 'usage';
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
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
}
