// Claude's stream-json frames -> the host's neutral session events (E40 item
// 03, #1286). Declared through the adapter's `events` capability by BOTH the
// real Claude adapter and the fake stream adapter, so every e2e replays
// Claude's real frames through this file.
//
// This is the only place on the EVENT path that may read a Claude frame. The
// Feed, the status machine, the pump's native-id bookkeeping and service
// health used to read them directly; each of their Claude-specific readings
// moved here unchanged, and what they receive now is `sessions/engine-events.ts`.
// The CONTROL path — `can_use_tool` answers, `control_response`, the model,
// mode and slash-command stores — still reads raw frames, and is #1287.
//
// PURE AND STATELESS for Claude: every piece of state the old readers kept
// (the Feed's assembly map, the `/clear` latch) belongs to the consumer and
// stayed there. The translator only says what each frame MEANS.
//
// ---------------------------------------------------------------------------
// STATUS, MEASURED (moved from `sessions/stream-status.ts`), from S-11's own
// run (spike/findings/artifacts/s11/longrun-events.ndjson), not reasoned by
// analogy with the PTY:
//
//   spawn                       ms=14
//   heartbeat (we SENT a prompt) ms=2026
//   init                         ms=2048     <- 22ms AFTER our send
//
// and on every subsequent turn the same order. **The CLI emits NOTHING at
// spawn.** `system:init` always FOLLOWS a user message, once per TURN — so it
// becomes a `conversation` event (the resume identity) and NEVER an activity:
// reading it as "the session started" would reset the session on every turn.
// Readiness comes from the spawn succeeding, which is the pump's, not ours.
// ---------------------------------------------------------------------------
import { deriveIntents } from '../feed/blocks';
import type { EventCapability } from '../extensibility/contributions';
import type {
  ChunkKind,
  EngineEvent,
  EngineTranslator,
  TranslatorHooks,
} from '../sessions/engine-events';

/**
 * Frame types that are understood and say nothing on the event path. Listed
 * rather than defaulted so a NEW frame type is a decision someone makes, not
 * a silent no-op — an unlisted type is reported once through `onUnknown`.
 *
 * - `control_request` other than `can_use_tool` (`hook_callback`,
 *   `mcp_message`) is plumbing; `control_response` / `control_cancel_request`
 *   belong to the control path (#1287), which reads them raw.
 * - `rate_limit_event`, `transcript_mirror`, `active_goal`, `keep_alive`:
 *   measured (S-10, S-11), not lifecycle. S-11 saw 0 keep_alives in 8 hours,
 *   so nothing may be built on its cadence.
 */
const UNDERSTOOD_SILENT = new Set([
  'control_response',
  'control_cancel_request',
  'rate_limit_event',
  'transcript_mirror',
  'active_goal',
  'keep_alive',
]);

/**
 * `stream:<label>` in the transition log — exactly the cause string the pump
 * wrote before the seam, so a person reading a log across the change sees
 * the same words (`stream:assistant`, `stream:result:success`).
 */
function labelOf(type: string, m: Record<string, unknown>): string {
  return typeof m.subtype === 'string' && m.subtype ? `${type}:${m.subtype}` : type;
}

/**
 * Does this `result` mean "the turn ended badly"? (Moved from
 * `health/corroboration.ts`.)
 *
 * The CLI's `result` message carries `is_error` and an `error_*` subtype; a
 * failed turn is otherwise indistinguishable from a finished one (the session
 * status machine deliberately treats both as `done` — a failed turn IS over).
 * So this is the only place the difference is read, and it reads exactly the
 * two fields the protocol documents rather than sniffing text.
 *
 * Returns `true` for an errored result, `false` for a clean one, and `null`
 * for every other message — "not a verdict" has to be distinguishable from
 * "a good verdict" or every `stream_event` would count as a recovery.
 */
export function turnOutcome(msg: unknown): boolean | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as { type?: unknown; subtype?: unknown; is_error?: unknown };
  if (m.type !== 'result') return null;
  if (m.is_error === true) return true;
  if (typeof m.subtype === 'string' && m.subtype.startsWith('error')) return true;
  return false;
}

/**
 * Could this `assistant` message have been built by `stream_event` deltas?
 * (Moved from `feed/stream-feed.ts`; becomes `MessageEvent.unstreamed`.)
 *
 * `true` means it could not, and therefore that it must not claim a block the
 * deltas opened.
 *
 * ── THE BUG (#978) ────────────────────────────────────────────────────────
 *
 * A local slash command (`/usage`, `/cost`, `/context`) arrives as a bare
 * `system:init -> assistant -> result`: no `message_start`, no deltas, no
 * `message_stop`. So it never reaches the Feed's end-of-message, which is the
 * only thing that CLEARS its assembly map — the turn's end deliberately does
 * not (#154: an interrupted turn's `assistant` can arrive after its own
 * `result`).
 *
 * If anything is still sitting in that map, the Feed's claim fallback hands it
 * over: the fallback takes ANY open block of a superseding kind, because the
 * real CLI reports content index 0 on every `assistant` message of a
 * multi-block turn. The local command's text then REPLACES that block's text,
 * in place — text the user has already read, silently overwritten.
 *
 * ── THE TWO MARKERS, AND WHY BOTH ─────────────────────────────────────────
 *
 * `local_command_run` / `local_command_source` are the CLI stating that the
 * turn was a local command. They are the precise signal and the one to prefer —
 * MEASURED on 2.1.280, `spike/findings/978-local-slash-commands-on-stream.md`.
 * They are also NEW: S-11 captured the same turn on 2.1.220 and neither field
 * was there.
 *
 * `model: "<synthetic>"` is the older, broader one, and it generalises the rule
 * rather than merely widening CLI coverage: `<synthetic>` is the CLI saying no
 * model produced this message. Nothing a model did not produce can be the
 * completion of a token stream, because there were no tokens.
 *
 * ⚠️ THE BREADTH WAS CHECKED AGAINST THE BINARY, not reasoned about (the
 * standing rule, `docs/reference-implementations.md`). In CLI 2.1.280
 * `<synthetic>` appears in exactly three assistant builders — a
 * `PushNotification` tool_use, a `"(no content)"` / `"No response requested."`
 * text message, and one generic — and **all three construct their `content`
 * inline**. None re-sends text that deltas produced, so this guard cannot
 * strand a streamed block or duplicate a reply. `local_command_source` is
 * emitted by one builder only, which the CLI's own schema calls *"the
 * local-command twin"*; it cannot ride on a model turn.
 *
 * The residual risk is the generic builder, whose `content` comes from its
 * callers. If one ever re-sent streamed content, the Feed would APPEND a block
 * rather than replace one — an extra block, never lost text.
 *
 * DELIBERATELY NOT a check for "were there any deltas this turn?". That is the
 * same fact one inference further away, and it would need turn-scoped state;
 * the Feed's assembly map outliving the tokens is load-bearing, and reading it
 * as "a stream happened" is how the two facts get collapsed again.
 */
export function wasNeverStreamed(msg: Record<string, unknown>): boolean {
  if (msg.local_command_run != null || msg.local_command_source != null) return true;
  const message = msg.message;
  if (typeof message !== 'object' || message === null) return false;
  return (message as Record<string, unknown>).model === '<synthetic>';
}

/**
 * One `stream_event` frame's content events (the activity is emitted by the
 * caller, for every frame, sidechain or not).
 *
 * ⚠️ A SIDECHAIN FRAME CARRIES NO CONTENT HERE, and #977 is why that is not a
 * gap. A subagent's words reach the Feed from its own transcript file, which
 * the watcher tails and derives (`deriveFeed: 'sidechains'`); dropping them
 * here is what stops the same text arriving twice. Measured on the PATH CLI
 * 2.1.280, **zero** `stream_event` frames carried a `parent_tool_use_id`, with
 * or without `--forward-subagent-text`
 * (`spike/findings/e18-977-stream-sidechains.md`).
 *
 * The assembly rule these events serve — deltas open and grow a block, the
 * `assistant` message replaces it at the same address — is the Feed's, and is
 * documented there. What is Claude's, and lives here:
 *
 * - the event's `index` is the address; absent reads as 0;
 * - `content_block_start` carries the block's type and, for a tool call, its
 *   `name` WHOLE and its `id`. A missing type reads as text (the CLI's to send;
 *   we do not get to require it). The tool's `id` is INFERRED from the
 *   Anthropic streaming shape, not measured — S-11 recorded a thinking/text
 *   turn only — and fails open: no id, no early address;
 * - `input_json_delta` and `signature_delta` carry nothing renderable. A tool
 *   row built from half-written JSON is worse than one that appears a beat
 *   later, so tool INPUT comes from the `assistant` message only.
 */
function streamEventContent(m: Record<string, unknown>): EngineEvent[] {
  const ev = m.event as Record<string, unknown> | undefined;
  if (!ev || typeof ev.type !== 'string') return [];
  if (m.parent_tool_use_id != null) return [];
  const index = typeof ev.index === 'number' ? ev.index : 0;
  switch (ev.type) {
    case 'message_start':
      return [{ type: 'message-start' }];
    case 'content_block_start': {
      const cb = ev.content_block as Record<string, unknown> | undefined;
      const type = typeof cb?.type === 'string' ? cb.type : 'text';
      if (type === 'text' || type === 'thinking') {
        return [{ type: 'chunk-open', index, kind: type }];
      }
      if (type === 'tool_use' && typeof cb?.name === 'string') {
        return [
          {
            type: 'tool-call-start',
            index,
            name: cb.name,
            ...(typeof cb.id === 'string' ? { toolCallId: cb.id } : {}),
          },
        ];
      }
      // a content type we cannot render at all: no block is invented for it
      return [];
    }
    case 'content_block_delta': {
      const delta = ev.delta as { type?: string; text?: string; thinking?: string } | undefined;
      const piece =
        delta?.type === 'text_delta'
          ? delta.text
          : delta?.type === 'thinking_delta'
            ? delta.thinking
            : undefined;
      if (typeof piece !== 'string' || piece === '') return [];
      const kind: ChunkKind = delta?.type === 'thinking_delta' ? 'thinking' : 'text';
      return [{ type: 'chunk', index, kind, text: piece }];
    }
    case 'content_block_stop':
      return [{ type: 'chunk-close', index }];
    case 'message_stop':
      return [{ type: 'message-end' }];
    default:
      // message_delta, ping: nothing for the Feed
      return [];
  }
}

/**
 * An `assistant` or `user` message as a neutral `message` event, or nothing
 * for a sidechain one (see `streamEventContent` — #977; without
 * `--forward-subagent-text`, which we deliberately do not pass, the only
 * sidechain message that arrives is the subagent's SEEDING prompt anyway).
 *
 * The stream carries no timestamp of its own, and the Feed shows one (and
 * times thinking blocks by it). Ours is stamped HERE, the moment the frame is
 * read — honest to the millisecond for a message we have just received.
 */
function messageEvent(role: 'assistant' | 'user', m: Record<string, unknown>): EngineEvent[] {
  if (m.parent_tool_use_id != null) return [];
  const entry = { ...m, timestamp: new Date().toISOString() };
  return [
    {
      type: 'message',
      role,
      unstreamed: role === 'assistant' && wasNeverStreamed(m),
      derive: (caps, ctx) => deriveIntents(entry, caps, ctx),
    },
  ];
}

function finite(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** `{a: undefined}` -> `{}`, so an event never carries a key it has no value for. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * What one Claude frame means, or `null` for a frame type this translator does
 * not know (the caller reports it once).
 */
export function translateClaudeFrame(m: Record<string, unknown>): EngineEvent[] | null {
  const type = typeof m.type === 'string' ? m.type : '';
  switch (type) {
    case 'system': {
      // `init` arrives once per TURN with the conversation's `session_id` —
      // the resume identity (E18-05, #404). `&& id` rejects the empty string,
      // as every consumer always did: learning '' would make the first REAL id
      // look like a change.
      if (m.subtype === 'init') {
        const id = typeof m.session_id === 'string' ? m.session_id : '';
        return id ? [{ type: 'conversation', id }] : [];
      }
      // `/compact`'s marker (#748 probe 3; shape in
      // `spike/findings/1026-not-for-the-live-view.md`):
      //   compact_metadata: {trigger: "manual", pre_tokens, post_tokens}
      if (m.subtype === 'compact_boundary') {
        const meta = (m.compact_metadata ?? {}) as Record<string, unknown>;
        return [
          {
            type: 'compaction',
            ...defined({
              trigger: typeof meta.trigger === 'string' ? meta.trigger : undefined,
              preTokens: finite(meta.pre_tokens),
              postTokens: finite(meta.post_tokens),
            }),
          },
        ];
      }
      // status / commands_changed / post_turn_summary / local_command:
      // informational, or the control path's (#1287)
      return [];
    }

    case 'conversation_reset':
      // The CLI saying, in as many words, that it threw the conversation away
      // (#748). `session_id` names the conversation being DISCARDED;
      // `new_conversation_id` is deliberately not carried — one measured
      // exchange had it match neither side (see `StreamFeed.onConversationReset`).
      return [
        {
          type: 'conversation-reset',
          ...(typeof m.session_id === 'string' ? { discarded: m.session_id } : {}),
        },
      ];

    case 'stream_event':
      // Output is arriving: an activity for EVERY frame (sidechain included —
      // a subagent working is the session working), then whatever it means
      // for the Feed.
      return [{ type: 'activity', label: labelOf(type, m) }, ...streamEventContent(m)];

    case 'assistant':
      return [{ type: 'activity', label: labelOf(type, m) }, ...messageEvent('assistant', m)];

    case 'user':
      // Our own replay (`--replay-user-messages`) and tool results. Content,
      // not lifecycle: no activity.
      return messageEvent('user', m);

    case 'result': {
      // The turn is over. This is stream mode's `Stop` hook.
      const out: EngineEvent[] = [
        { type: 'turn-end', failed: turnOutcome(m) === true, label: labelOf(type, m) },
      ];
      // usage: {input_tokens, output_tokens, cache_read_input_tokens} — the
      // shape the fake replays from a captured result frame
      const u = m.usage;
      if (u && typeof u === 'object') {
        const usage = u as Record<string, unknown>;
        out.push({
          type: 'usage',
          ...defined({
            inputTokens: finite(usage.input_tokens),
            outputTokens: finite(usage.output_tokens),
            cacheReadTokens: finite(usage.cache_read_input_tokens),
          }),
        });
      }
      return out;
    }

    case 'control_request': {
      // `can_use_tool` is the CLI handing us a decision. Other control
      // requests (`hook_callback`, `mcp_message`) are plumbing and must not
      // move the status. ANSWERING it is the control path's (#1287).
      const req = m.request as { subtype?: unknown } | undefined;
      return req?.subtype === 'can_use_tool' ? [{ type: 'permission-request' }] : [];
    }

    default:
      return UNDERSTOOD_SILENT.has(type) ? [] : null;
  }
}

/** The `events` capability both Claude adapters declare. */
export const claudeEvents: EventCapability = {
  createTranslator(hooks: TranslatorHooks): EngineTranslator {
    const reported = new Set<string>();
    return (frame) => {
      const events = translateClaudeFrame(frame);
      if (events !== null) return events;
      const type = typeof frame.type === 'string' ? frame.type : '(no type)';
      if (!reported.has(type)) {
        reported.add(type);
        hooks.onUnknown?.(type);
      }
      return [];
    };
  },
};
