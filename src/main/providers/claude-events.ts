// Claude's stream-json frames -> the host's neutral session events (E40 item
// 03, #1286). Declared through the adapter's `events` capability by BOTH the
// real Claude adapter and the fake stream adapter, so every e2e replays
// Claude's real frames through this file.
//
// This is the only place on the EVENT path that may read a Claude frame. The
// Feed, the status machine, the pump's native-id bookkeeping and service
// health used to read them directly; each of their Claude-specific readings
// moved here unchanged, and what they receive now is `sessions/engine-events.ts`.
// Since E40 item 04 (#1287) it also says what the CONTROL frames announce: a
// `can_use_tool` becomes a `permission-request` carrying the ask (and a
// `control_cancel_request` a `permission-withdrawn`), `system:init` /
// `commands_changed` the command list, `system:init.model` the model, and
// `system:status.permissionMode` the mode. Each reading moved here from the
// store that used to make it (`stream-permissions`, `stream-commands`,
// `stream-model`, `stream-mode`), unchanged. ANSWERING is not this file's:
// replies (`control_response`) are correlated by Claude's controls
// (`claude-controls.ts`), which the pump hands every frame.
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
import { compactionSummaryText, deriveIntents } from './claude-transcript';
import { asDisplayString } from '../../shared/display-string';
import type { CliCommand } from '../../shared/slash-commands';
import { autonomyFromPermissionMode } from './claude-modes';
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
 *   `mcp_message`) is plumbing; `control_response` is a REPLY, correlated by
 *   Claude's controls (`claude-controls.ts`), not an event.
 * - `rate_limit_event`, `transcript_mirror`, `active_goal`, `keep_alive`:
 *   measured (S-10, S-11), not lifecycle. S-11 saw 0 keep_alives in 8 hours,
 *   so nothing may be built on its cadence.
 * - `command_lifecycle` (#1328, first seen 2026-10-17): a per-message progress
 *   frame, `{ command_uuid, state }` with state one of queued / started /
 *   completed / cancelled / discarded / refused, read out of the PATH CLI's own
 *   zod schema. It only arrives for messages sent WITH a uuid, and the VS Code
 *   extension reads it for one thing: a terminal state counts towards "idle".
 *   Our status machine already gets that from `result` and the hooks, so it is
 *   understood and adds nothing here. If a feature ever needs per-message
 *   delivery (cancelled vs completed), this is the frame that carries it.
 */
const UNDERSTOOD_SILENT = new Set([
  'control_response',
  'rate_limit_event',
  'transcript_mirror',
  'active_goal',
  'keep_alive',
  'command_lifecycle',
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
  // A compaction's summary (#1374): measured on the stream as the `user` frame
  // straight after `system:compact_boundary`, flagged only `isSynthetic`
  // (`spike/findings/1026-not-for-the-live-view.md` §3). Carried beside the
  // message, not derived: whether it belongs to a divider is the Feed's call.
  const summary = role === 'user' ? compactionSummaryText(m) : null;
  return [
    {
      type: 'message',
      role,
      unstreamed: role === 'assistant' && wasNeverStreamed(m),
      derive: (caps, ctx) => deriveIntents(entry, caps, ctx),
      ...(summary === null ? {} : { compactionSummary: summary }),
    },
  ];
}

/**
 * The `activity` for an output frame, marked `sidechain` when a subagent sent
 * it (#1340). In the #1268 capture a BACKGROUND subagent's `assistant` frame
 * arrived after its parent turn's `result`: it is the session working, but it
 * is not a turn, and no `result` will come for it.
 */
function activityOf(type: string, m: Record<string, unknown>): EngineEvent {
  return m.parent_tool_use_id != null
    ? { type: 'activity', label: labelOf(type, m), sidechain: true }
    : { type: 'activity', label: labelOf(type, m) };
}

function finite(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** What a field the translator could not use WAS, for the skip log. */
function kind(v: unknown): string {
  return v === undefined ? 'absent' : typeof v;
}

/** `{a: undefined}` -> `{}`, so an event never carries a key it has no value for. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * What one Claude frame means, or `null` for a frame type this translator does
 * not know (the caller reports it once).
 */
export function translateClaudeFrame(
  m: Record<string, unknown>,
  skipped?: TranslatorHooks['onSkipped']
): EngineEvent[] | null {
  const type = typeof m.type === 'string' ? m.type : '';
  switch (type) {
    case 'system': {
      // `init` arrives once per TURN with the conversation's `session_id` —
      // the resume identity (E18-05, #404). `&& id` rejects the empty string,
      // as every consumer always did: learning '' would make the first REAL id
      // look like a change.
      //
      // It also carries the CLI's slash-command list (P2-E18-09) and the model
      // the session is running (#721) — the only frame that says either, once
      // per TURN, and nothing can ask for them. Each is its own event so a
      // store reads only its own; an absent or unusable field sends nothing
      // and the store keeps what it had.
      if (m.subtype === 'init') {
        const out: EngineEvent[] = [];
        const id = typeof m.session_id === 'string' ? m.session_id : '';
        if (id) out.push({ type: 'conversation', id });
        const commands = commandsEvent(m.slash_commands);
        if (commands) out.push(commands);
        else skipped?.('stream command list ignored: not an array', { subtype: 'init', got: kind(m.slash_commands) });
        if (typeof m.model === 'string' && m.model.trim()) out.push({ type: 'model', id: m.model });
        else skipped?.('stream init model ignored', { got: kind(m.model) });
        return out;
      }
      // A plugin or skill change mid-session re-advertises the WHOLE list
      // under `commands` (not `slash_commands` — a different key on a
      // different subtype).
      if (m.subtype === 'commands_changed') {
        const commands = commandsEvent(m.commands);
        if (!commands) {
          skipped?.('stream command list ignored: not an array', { subtype: 'commands_changed', got: kind(m.commands) });
        }
        return commands ? [commands] : [];
      }
      // The mode the CLI says it is in (#1072): it leaves plan mode by itself
      // when a plan is approved, and announces it here. `status` carries other
      // things too and may carry no mode at all, so an absent field says
      // nothing; a mode we have no name for (`auto`, `dontAsk`) is not sent —
      // a stale chip beats a wrong one (P6).
      if (m.subtype === 'status') {
        if (m.permissionMode === undefined) return [];
        const mode = autonomyFromPermissionMode(m.permissionMode);
        if (!mode) {
          skipped?.('stream status mode ignored', {
            got: typeof m.permissionMode === 'string' ? m.permissionMode.slice(0, 40) : typeof m.permissionMode,
          });
        }
        return mode ? [{ type: 'mode', mode }] : [];
      }
      // The CLI's running BACKGROUND tasks, the whole list, re-sent whenever it
      // changes (#1359). Read from the binary: a state-diff listener compares
      // the running-task list before and after every state change and sends
      // this on any difference — not only on a kill. Shape MEASURED in #1268's
      // capture (`spike/probes/1268/captures/subagent.json`):
      //   {type:"system", subtype:"background_tasks_changed",
      //    tasks:[{task_id, task_type:"local_agent", description}]}
      // and `tasks: []` once the backgrounded subagent was gone. A `tasks` that
      // is not a list says nothing.
      if (m.subtype === 'background_tasks_changed') {
        if (!Array.isArray(m.tasks)) {
          skipped?.('stream background task list ignored: not an array', { got: kind(m.tasks) });
          return [];
        }
        return [{ type: 'background-work', running: m.tasks.length }];
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
      // post_turn_summary / local_command: informational
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
      // for the Feed. A sidechain one says so (#1340): it does not open a turn.
      return [activityOf(type, m), ...streamEventContent(m)];

    case 'assistant':
      return [activityOf(type, m), ...messageEvent('assistant', m)];

    case 'user':
      // Our own replay (`--replay-user-messages`) and tool results. Content,
      // not lifecycle: no activity.
      return messageEvent('user', m);

    case 'result':
      // The turn is over. This is stream mode's `Stop` hook.
      //
      // NO `usage` EVENT, deliberately (#1288). `result.usage` is per turn and
      // has no cache-write split, no thinking share and no subagent files;
      // Claude's usage is its transcript ledger, which has all three. One
      // usage path per provider — see `UsageEvent`.
      return [{ type: 'turn-end', failed: turnOutcome(m) === true, label: labelOf(type, m) }];

    case 'control_request': {
      // `can_use_tool` is the CLI handing us a decision. Other control
      // requests (`hook_callback`, `mcp_message`) are plumbing and must not
      // move the status. ANSWERING it is Claude's `approvals` control
      // (`claude-controls.ts`), which echoes `requestId` back.
      const req = m.request as Record<string, unknown> | undefined;
      return req?.subtype === 'can_use_tool' ? [permissionRequest(m, req)] : [];
    }

    case 'control_cancel_request':
      // The CLI took a `can_use_tool` back before anyone answered it.
      return [{ type: 'permission-withdrawn', requestId: asDisplayString(m.request_id) }];

    default:
      return UNDERSTOOD_SILENT.has(type) ? [] : null;
  }
}

/**
 * The ask out of a `can_use_tool` — field for field what `StreamPermissions`
 * read off the frame before #1287, with the same defaults. The id is at the
 * TOP level on this direction (the reply nests its id; see
 * `readControlResponse`), and an id-less request still becomes an event with
 * `requestId: ''`: the status says the CLI is waiting, as it always did, and
 * the router declines to hold what it cannot answer.
 */
function permissionRequest(m: Record<string, unknown>, req: Record<string, unknown>): EngineEvent {
  return {
    type: 'permission-request',
    requestId: asDisplayString(m.request_id),
    tool: asDisplayString(req.tool_name, 'unknown'),
    input: (req.input as Record<string, unknown>) ?? {},
    ...defined({
      reason: typeof req.decision_reason === 'string' ? req.decision_reason : undefined,
      reasonType: typeof req.decision_reason_type === 'string' ? req.decision_reason_type : undefined,
      displayName: typeof req.display_name === 'string' ? req.display_name : undefined,
      suggestions: Array.isArray(req.permission_suggestions)
        ? (req.permission_suggestions as Array<Record<string, unknown>>)
        : undefined,
    }),
  };
}

/**
 * A command list off `system:init.slash_commands` or `commands_changed.commands`,
 * or `null` when the field is not a list (the store keeps what it had).
 *
 * TWO SPELLINGS, BOTH MEASURED (moved from `stream-commands.ts`): bare names
 * in `system:init`, `{name, description, argumentHint}` in `commands_changed`.
 * An unreadable entry is dropped and counted rather than failing the list.
 */
function commandsEvent(list: unknown): EngineEvent | null {
  if (!Array.isArray(list)) return null;
  const commands = list.map(parseCommand).filter((c): c is CliCommand => c !== null);
  return { type: 'commands', commands, dropped: list.length - commands.length };
}

function parseCommand(entry: unknown): CliCommand | null {
  if (typeof entry === 'string') return entry.trim() ? { name: entry } : null;
  if (entry && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    if (typeof o.name !== 'string' || !o.name.trim()) return null;
    return {
      name: o.name,
      description: typeof o.description === 'string' ? o.description : undefined,
    };
  }
  return null;
}

/** The `events` capability both Claude adapters declare. */
export const claudeEvents: EventCapability = {
  createTranslator(hooks: TranslatorHooks): EngineTranslator {
    const reported = new Set<string>();
    return (frame) => {
      const events = translateClaudeFrame(frame, hooks.onSkipped);
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
