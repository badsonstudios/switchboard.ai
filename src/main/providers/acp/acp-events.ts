// ACP `session/update` -> the host's neutral session events (E40 item 06,
// #1289). The CONTENT half of the ACP engine: what the Feed should show. The
// lifecycle half (turn ends, the conversation id, permissions) is
// `acp-session.ts`, which owns the JSON-RPC correlation this needs none of.
//
// THE ONE THING ACP DOES NOT GIVE US is Claude's "authoritative message" —
// Claude streams deltas and then re-sends the whole reply, which the Feed
// reconciles at the same index (`feed/stream-feed.ts`). ACP sends chunks and
// nothing after them. So this keeps the open SEGMENT (one run of chunks of one
// kind) and, when it ends, sends the message the Feed expects: `chunk-close`,
// `message-end`, then a `message` carrying the whole text, which claims the
// block the chunks built. A segment ends when the kind changes, the message id
// changes, a tool call or plan arrives, a permission is asked, or the turn ends.
//
// Variant by variant, MEASURED where it says so (`spike/findings/e40-codex-acp.md`
// Q2; the rest from the ACP schema):
//
//   agent_message_chunk   measured (106)  -> text segment
//   agent_thought_chunk   spec            -> thinking segment
//   user_message_chunk    measured (6, only in a `session/load` replay) -> user block
//   tool_call             measured        -> a tool block (a `message`)
//   tool_call_update      measured        -> the tool's result, at completed/failed
//   plan                  spec            -> a todos block
//   available_commands_update  measured   -> `commands`
//   current_mode_update   spec            -> `mode` (via the session's map)
//   config_option_update  spec            -> `model` / `mode` (the session reads it)
//   usage_update          measured        -> no event; the context meter's source
//   session_info_update   measured        -> understood, silent
//   anything else                         -> logged once per type, skipped (P6)
import type { BlockIntent, DerivedBlock, EmitIntent } from '../../feed/blocks';
import { userPromptIntent } from '../../feed/blocks';
import type { ToolCategory } from '../../../shared/tool-taxonomy';
import type { CliCommand } from '../../../shared/slash-commands';
import type { EngineEvent } from '../../sessions/engine-events';
import { asObject } from './acp-protocol';

type Obj = Record<string, unknown>;

/** Variants that are understood and say nothing here: another part of the
 *  session reads them (`usage_update`, the config/mode ones) or nothing does
 *  yet (`session_info_update`'s title and Codex's `threadStatus` hint). */
const UNDERSTOOD_ELSEWHERE = new Set([
  'usage_update',
  'session_info_update',
  'current_mode_update',
  'config_option_update',
]);

/** ACP's tool `kind` -> the Feed's presentation class. */
export function categoryOfKind(kind: unknown): ToolCategory {
  switch (kind) {
    case 'execute':
      return 'shell';
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit';
    case 'read':
    case 'search':
    case 'fetch':
      return 'read';
    default:
      return 'other';
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** The text of a content block, when it has one (`{type:"text", text}`). */
function contentText(c: unknown): string | undefined {
  const o = asObject(c);
  return o?.type === 'text' && typeof o.text === 'string' ? o.text : undefined;
}

/**
 * A `tool_call` as a Feed tool block. `toolCallId` is both the result's
 * address (`toolUseId`) and the block's identity (`srcId`), as a Claude
 * `tool_use.id` is.
 *
 * ⚠️ A SHELL CALL CARRIES `{type:"terminal", terminalId}` CONTENT EVEN THOUGH WE
 * DECLARED `terminal:false` (measured), and no output ever follows it. That
 * content is ignored: we never offered to carry a terminal, so we never wait
 * for one. The command comes from `rawInput.command`, the exit code from the
 * update's `_meta.terminal_exit` (see `toolResult`).
 */
export function toolBlock(u: Obj, caps: { detail: number; summary: number; edit: number }): EmitIntent | null {
  const id = str(u.toolCallId);
  if (!id) return null;
  const input = asObject(u.rawInput) ?? {};
  const name = str(u.title) ?? str(u.kind) ?? 'tool';
  const location = asObject(Array.isArray(u.locations) ? u.locations[0] : undefined);
  const command = Array.isArray(input.command)
    ? input.command.filter((p) => typeof p === 'string').join(' ')
    : input.command;
  const primary = command ?? location?.path ?? input.path ?? input.file_path ?? u.title;
  const tool: NonNullable<DerivedBlock['tool']> = {
    name,
    category: categoryOfKind(u.kind),
    summary: typeof primary === 'string' ? primary.slice(0, caps.summary) : '',
  };
  if (caps.detail !== 0 && Object.keys(input).length > 0) {
    try {
      tool.detail = JSON.stringify(input, null, 2)?.slice(0, caps.detail);
    } catch {
      /* an input that cannot be serialised shows no detail */
    }
  }
  // An edit's diff, when the agent sent one (`{type:"diff", path, oldText, newText}`).
  for (const c of Array.isArray(u.content) ? u.content : []) {
    const d = asObject(c);
    if (d?.type !== 'diff' || typeof d.path !== 'string') continue;
    tool.filePath = d.path;
    tool.editPath = d.path;
    if (typeof d.oldText === 'string') tool.oldString = d.oldText.slice(0, caps.edit);
    if (typeof d.newText === 'string') tool.newString = d.newText.slice(0, caps.edit);
    break;
  }
  return {
    t: 'block',
    block: { kind: 'tool', tool, srcId: `tool:${id}` },
    index: 0,
    toolUseId: id,
  };
}

/**
 * A finished tool call's output, or `null` while it is still running.
 *
 * What it says, in order: the text the content carried; a line per diff; the
 * exit code from `_meta.terminal_exit` (measured — the only shell result Codex
 * sends); failing all of those, `rawOutput` (an MCP call's result). `failed`
 * is the status's word, not a reading of the text.
 */
export function toolResult(u: Obj, detailCap: number): BlockIntent | null {
  const id = str(u.toolCallId);
  if (!id || (u.status !== 'completed' && u.status !== 'failed')) return null;
  const parts: string[] = [];
  for (const c of Array.isArray(u.content) ? u.content : []) {
    const o = asObject(c);
    if (o?.type === 'content') {
      const t = contentText(o.content);
      if (t) parts.push(t);
    } else if (o?.type === 'diff' && typeof o.path === 'string') {
      parts.push(`Edited ${o.path}`);
    }
  }
  const exit = asObject(asObject(u._meta)?.terminal_exit)?.exit_code;
  if (typeof exit === 'number') parts.push(`Exit code ${exit}`);
  if (parts.length === 0 && u.rawOutput !== undefined && u.rawOutput !== null) {
    const raw = u.rawOutput;
    const result = asObject(asObject(raw)?.result);
    const fromMcp = Array.isArray(result?.content)
      ? result.content
          .map(contentText)
          .filter((t): t is string => !!t)
          .join('\n')
      : '';
    if (typeof raw === 'string') parts.push(raw);
    else if (fromMcp) parts.push(fromMcp);
    else {
      try {
        parts.push(JSON.stringify(raw, null, 2) ?? '');
      } catch {
        /* nothing readable */
      }
    }
  }
  return {
    t: 'tool-result',
    toolUseId: id,
    out: parts.join('\n').slice(0, detailCap),
    ...(u.status === 'failed' ? { failed: true as const } : {}),
  };
}

/** `available_commands_update` as a `commands` event (a REPLACEMENT list). */
export function commandsEvent(u: Obj): EngineEvent | null {
  if (!Array.isArray(u.availableCommands)) return null;
  const commands: CliCommand[] = [];
  for (const c of u.availableCommands) {
    const o = asObject(c);
    const name = str(o?.name)?.replace(/^\//, '');
    if (!name) continue;
    commands.push({
      name,
      ...(typeof o?.description === 'string' ? { description: o.description } : {}),
    });
  }
  return {
    type: 'commands',
    commands,
    dropped: u.availableCommands.length - commands.length,
  };
}

type SegmentKind = 'text' | 'thinking' | 'user';

interface Segment {
  kind: SegmentKind;
  text: string;
  messageId?: string;
}

/**
 * One session's content translation. Stateful (the open segment, the tool
 * calls already shown), so one per session.
 */
export class AcpContent {
  private segment: Segment | undefined;
  /** tool calls already drawn, so a re-sent `tool_call` does not draw twice */
  private readonly tools = new Set<string>();
  /** results already attached, so a second terminal update does not re-attach */
  private readonly finished = new Set<string>();

  /**
   * One `session/update`'s `update` object. `null` for a variant this does not
   * know (the caller reports it once); `[]` for one it knows and has nothing
   * to say about.
   */
  update(u: Obj): EngineEvent[] | null {
    const variant = typeof u.sessionUpdate === 'string' ? u.sessionUpdate : '';
    switch (variant) {
      case 'agent_message_chunk':
        return this.chunk('text', u);
      case 'agent_thought_chunk':
        return this.chunk('thinking', u);
      case 'user_message_chunk':
        return this.chunk('user', u);
      case 'tool_call':
        return this.toolCall(u);
      case 'tool_call_update':
        return this.toolCallUpdate(u);
      case 'plan':
        return [...this.flush(), ...this.plan(u)];
      case 'available_commands_update': {
        const ev = commandsEvent(u);
        return ev ? [ev] : [];
      }
      default:
        return UNDERSTOOD_ELSEWHERE.has(variant) ? [] : null;
    }
  }

  /** The user's own prompt (ACP does not echo it back), after whatever was open. */
  userPrompt(text: string): EngineEvent[] {
    const ts = new Date().toISOString();
    return [
      ...this.flush(),
      {
        type: 'message',
        role: 'user',
        unstreamed: false,
        derive: (caps, ctx) => {
          const intent = userPromptIntent(text, ts, caps, ctx);
          return intent ? [intent] : [];
        },
      },
    ];
  }

  /**
   * A visible line for something that went wrong — a failed prompt, a session
   * that could not be opened. Drawn as the AI's reply, because it IS what came
   * back; the words are the agent's own message.
   */
  notice(text: string): EngineEvent[] {
    const ts = new Date().toISOString();
    return [
      ...this.flush(),
      { type: 'message-start' },
      {
        type: 'message',
        role: 'assistant',
        unstreamed: true,
        derive: (caps) => [
          {
            t: 'block',
            block: { kind: 'assistant', text: text.slice(0, caps.text), ts },
          },
        ],
      },
    ];
  }

  /** Close whatever segment is open (see the header). */
  flush(): EngineEvent[] {
    const seg = this.segment;
    this.segment = undefined;
    if (!seg) return [];
    const ts = new Date().toISOString();
    if (seg.kind === 'user') {
      const text = seg.text;
      return [
        {
          type: 'message',
          role: 'user',
          unstreamed: false,
          derive: (caps, ctx) => {
            const intent = userPromptIntent(text, ts, caps, ctx);
            return intent ? [intent] : [];
          },
        },
      ];
    }
    const kind = seg.kind === 'thinking' ? 'thinking' : 'assistant';
    const srcId = seg.messageId !== undefined ? { srcId: `msg:${seg.messageId}` } : {};
    const text = seg.text;
    return [
      { type: 'chunk-close', index: 0 },
      { type: 'message-end' },
      {
        type: 'message',
        role: 'assistant',
        unstreamed: false,
        derive: (caps) =>
          text.trim()
            ? [
                {
                  t: 'block',
                  block: { kind, text: text.slice(0, caps.text), ts, ...srcId },
                  index: 0,
                },
              ]
            : [],
      },
    ];
  }

  private chunk(kind: SegmentKind, u: Obj): EngineEvent[] {
    const piece = contentText(u.content);
    // an image or a resource link: nothing the Feed can draw as prose
    if (piece === undefined || piece === '') return [];
    const messageId = str(u.messageId);
    const out: EngineEvent[] = [];
    const open = this.segment;
    if (
      open &&
      (open.kind !== kind || (messageId !== undefined && open.messageId !== undefined && open.messageId !== messageId))
    ) {
      out.push(...this.flush());
    }
    if (!this.segment) {
      this.segment = {
        kind,
        text: '',
        ...(messageId !== undefined ? { messageId } : {}),
      };
      if (kind !== 'user') out.push({ type: 'message-start' }, { type: 'chunk-open', index: 0, kind });
    }
    this.segment.text += piece;
    if (kind !== 'user') out.push({ type: 'chunk', index: 0, kind, text: piece });
    return out;
  }

  private toolCall(u: Obj): EngineEvent[] {
    const id = str(u.toolCallId);
    if (!id) return [];
    // A tool_call for an id already drawn is an update in all but name.
    if (this.tools.has(id)) return this.toolCallUpdate(u);
    this.tools.add(id);
    const out = [...this.flush(), { type: 'message-start' } as EngineEvent];
    out.push({
      type: 'message',
      role: 'assistant',
      unstreamed: false,
      derive: (caps) => {
        const intent = toolBlock(u, caps);
        return intent
          ? [
              {
                ...intent,
                block: { ...intent.block, ts: new Date().toISOString() },
              },
            ]
          : [];
      },
    });
    // a tool call can arrive already finished (a replay does this)
    const done = this.result(u);
    return done ? [...out, done] : out;
  }

  private toolCallUpdate(u: Obj): EngineEvent[] {
    const done = this.result(u);
    return done ? [...this.flush(), done] : [];
  }

  private result(u: Obj): EngineEvent | null {
    const id = str(u.toolCallId);
    if (!id || this.finished.has(id) || (u.status !== 'completed' && u.status !== 'failed')) return null;
    this.finished.add(id);
    return {
      type: 'message',
      role: 'user',
      unstreamed: false,
      derive: (caps) => {
        const r = toolResult(u, caps.detail);
        return r ? [r] : [];
      },
    };
  }

  private plan(u: Obj): EngineEvent[] {
    if (!Array.isArray(u.entries)) return [];
    const entries = u.entries;
    const ts = new Date().toISOString();
    return [
      { type: 'message-start' },
      {
        type: 'message',
        role: 'assistant',
        unstreamed: false,
        derive: (caps) => [
          {
            t: 'block',
            block: {
              kind: 'todos',
              ts,
              todos: entries.slice(0, caps.todos).map((e) => {
                const o = asObject(e) ?? {};
                return {
                  content: typeof o.content === 'string' ? o.content : '',
                  status: typeof o.status === 'string' ? o.status : 'pending',
                };
              }),
            },
          },
        ],
      },
    ];
  }
}
