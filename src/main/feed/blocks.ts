// One Feed block, and the one place a message becomes one (P2-E18-10).
//
// This code used to live inside `TranscriptWatcher.deriveBlocks`, where it was
// reachable only by writing a JSONL file. It moved here because the Feed grew a
// SECOND source: a stream session's typed messages (`StreamFeed`). The epic's
// done-when says "both sources, one renderer, one test matrix" — the cheapest
// way to keep that true is for both sources to run the SAME derivation, so a
// block type cannot render one way from a transcript and another from a stream.
//
// The shapes agree because they are the same shapes. A transcript's `assistant`
// line and the stream's `assistant` message both carry an Anthropic
// `message: { role, content: [...] }`; tool results arrive as `user` messages
// with `tool_result` items on both. The transcript wraps them in file metadata
// (uuid, cwd, gitBranch) that this module simply does not read.
//
// Deliberately pure: no I/O, no state, no logger. It answers "what does this
// message MEAN for the Feed" and hands back intents; applying them — seq
// numbers, the block cap, tool-result stitching — is `FeedBuffer`'s job.
import { ToolCategory, toolCategory } from '../../shared/tool-taxonomy';

/**
 * One rendered unit of the Feed (P2-E12-06, §5.10): derived from a transcript
 * line or a stream message, read-only by construction. `detail` is capped — the
 * Feed is a view, not an archive; the transcript stays the source of truth.
 */
export interface FeedBlock {
  seq: number;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'todos';
  /** user/assistant/thinking prose */
  text?: string;
  tool?: {
    name: string;
    /** presentation class — the renderer dispatches on this, never on the
     *  raw name (PowerShell must render like Bash; review P1 #9) */
    category: ToolCategory;
    summary: string;
    detail?: string;
    /** Bash: the tool call's own description field (block header, E10-06) */
    description?: string;
    /** Edit/Write: structured fields for the inline diff preview (E10-06) */
    filePath?: string;
    oldString?: string;
    newString?: string;
    /** tool_result output, attached when it arrives (block re-emitted) */
    out?: string;
  };
  /** TodoWrite checklist (E10-06) */
  todos?: Array<{ content: string; status: string }>;
  /** thinking: how long it lasted (set when the next block lands) */
  durationMs?: number;
  /** true when the line came from a subagent transcript */
  sidechain: boolean;
  ts?: string;
  /**
   * Tokens are still arriving into this block (P2-E18-10, stream sources only).
   *
   * A transcript block is never streaming: the watcher only ever sees a line
   * that was already written whole. A stream block is, between its first
   * `content_block_delta` and the `assistant` message that supersedes it — and
   * the flag is how "a session that never receives a `result` does not leave a
   * block open for ever" is a checkable claim rather than a hope.
   */
  streaming?: boolean;
}

/** Blocks kept per session (view buffer, not an archive). */
export const BLOCK_CAP = 1000;
export const DETAIL_CAP = 4000;
export const TEXT_CAP = 20_000;

/** A block to add, optionally keyed by the tool_use id whose result it awaits. */
export interface EmitIntent {
  t: 'block';
  block: Omit<FeedBlock, 'seq' | 'sidechain'>;
  /** set for `tool` blocks: the id a later `tool_result` will quote */
  toolUseId?: string;
  /**
   * Where this block sat in its message's `content` array, when the source
   * knows. Only a stream source does, and only it needs it: `stream_event`
   * deltas are addressed by the same index, so this is what lets the final
   * `assistant` message UPDATE the block the deltas built instead of appending
   * a duplicate of it.
   */
  index?: number;
}

/** Output for a tool block emitted earlier — attaches to it, never a new block. */
export interface ToolResultIntent {
  t: 'tool-result';
  toolUseId: string;
  out: string;
}

export type BlockIntent = EmitIntent | ToolResultIntent;

/** CLI plumbing disguised as user text — never conversation. */
export function isPlumbing(text: string): boolean {
  return text.trimStart().startsWith('<local-command-');
}

/** Flatten a tool_result content field (string or text-item array) to text. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((x) => x?.type === 'text' && typeof x.text === 'string')
      .map((x) => x.text)
      .join('\n');
  }
  return '';
}

/**
 * The output of a LOCAL slash command (`/usage`, `/cost`, `/context`), as the
 * JSONL transcript records it (#156, `spike/findings/s-11-local-slash-commands.md`).
 *
 * Measured, not guessed — a real transcript line, read 2026-08-02:
 *
 *     {"type":"system","subtype":"local_command","level":"info",
 *      "content":"<local-command-stdout>You are currently using…</local-command-stdout>"}
 *
 * There is NO `assistant` entry for such a turn, which is exactly why the
 * Session view rendered nothing at all for `/usage` in either transport: the
 * derivation only ever looked at `user` and `assistant`.
 *
 * It becomes an `assistant` block ON PURPOSE, and the choice is load-bearing.
 * Over the stream the identical turn arrives as an ordinary `assistant` message
 * (measured in the same probe), so a distinct block kind would make the same
 * output look different depending on which transport happened to render it —
 * the precise thing "both sources, one renderer" exists to prevent.
 */
function localCommandText(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'system' || entry.subtype !== 'local_command') return null;
  const raw = typeof entry.content === 'string' ? entry.content : '';
  const stripped = raw
    .replace(/^\s*<local-command-stdout>/, '')
    .replace(/<\/local-command-stdout>\s*$/, '')
    .trim();
  return stripped ? stripped : null;
}

/**
 * What one message means for the Feed. Tolerant by construction: an unknown
 * shape produces an empty list, never a throw — both callers are reading
 * untrusted output from another process.
 */
export function deriveIntents(entry: Record<string, unknown>): BlockIntent[] {
  // CLI-internal lines are not conversation. FIRST, ahead of every shape test:
  // it used to sit behind the `message` check, which was harmless while only
  // `user`/`assistant` were read and stops being so the moment another entry
  // type is (a `system` line carries `isMeta` too).
  if (entry.isMeta === true) return [];
  const ts = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;

  const local = localCommandText(entry);
  if (local !== null) {
    return [{ t: 'block', block: { kind: 'assistant', text: local.slice(0, TEXT_CAP), ts } }];
  }

  const message = entry.message as { content?: unknown; role?: string } | undefined;
  if (!message) return [];

  if (entry.type === 'user') return userIntents(message, ts);
  if (entry.type === 'assistant' && Array.isArray(message.content)) {
    return assistantIntents(message.content, ts);
  }
  return [];
}

function userIntents(message: { content?: unknown }, ts: string | undefined): BlockIntent[] {
  const out: BlockIntent[] = [];
  // a real prompt is a string (or text items); tool_result items attach their
  // output to the originating tool block (E10-06 OUT sections).
  // <local-command-*> wrappers (the caveat preamble, and the stdout echo the
  // CLI writes back as a user line) are plumbing, not conversation (Dan
  // 2026-07-22) — the stdout itself reaches the Feed as `system:local_command`
  // above, with the wrapper stripped.
  if (typeof message.content === 'string' && message.content.trim()) {
    if (isPlumbing(message.content)) return out;
    out.push({ t: 'block', block: { kind: 'user', text: message.content.slice(0, TEXT_CAP), ts } });
    return out;
  }
  if (!Array.isArray(message.content)) return out;
  for (const [index, c] of (
    message.content as Array<{
      type?: string;
      text?: string;
      tool_use_id?: string;
      content?: unknown;
    }>
  ).entries()) {
    if (c?.type === 'text' && c.text?.trim() && !isPlumbing(c.text)) {
      out.push({ t: 'block', block: { kind: 'user', text: c.text.slice(0, TEXT_CAP), ts }, index });
    } else if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') {
      out.push({
        t: 'tool-result',
        toolUseId: c.tool_use_id,
        out: toolResultText(c.content).slice(0, DETAIL_CAP),
      });
    }
  }
  return out;
}

function assistantIntents(content: unknown[], ts: string | undefined): BlockIntent[] {
  const out: BlockIntent[] = [];
  for (const [index, c] of (
    content as Array<{
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      id?: unknown;
      input?: Record<string, unknown>;
    }>
  ).entries()) {
    if (c?.type === 'text' && c.text?.trim()) {
      out.push({
        t: 'block',
        block: { kind: 'assistant', text: c.text.slice(0, TEXT_CAP), ts },
        index,
      });
    } else if (c?.type === 'thinking' && c.thinking?.trim()) {
      out.push({
        t: 'block',
        block: { kind: 'thinking', text: c.thinking.slice(0, TEXT_CAP), ts },
        index,
      });
    } else if (c?.type === 'tool_use' && typeof c.name === 'string') {
      out.push(toolIntent(c, index, ts));
    }
  }
  return out;
}

function toolIntent(
  c: { name?: string; id?: unknown; input?: Record<string, unknown> },
  index: number,
  ts: string | undefined
): EmitIntent {
  const name = String(c.name);
  const input = c.input ?? {};
  const toolUseId = typeof c.id === 'string' ? c.id : undefined;
  // TodoWrite renders as a checklist block, not a raw tool row (E10-06)
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    const todos = (input.todos as Array<{ content?: unknown; status?: unknown }>)
      .slice(0, 30)
      .map((td) => ({ content: String(td?.content ?? ''), status: String(td?.status ?? '') }));
    return { t: 'block', block: { kind: 'todos', todos, ts }, index };
  }
  const primary =
    input.file_path ??
    input.path ??
    input.notebook_path ??
    input.command ??
    input.description ??
    input.pattern;
  const summary = typeof primary === 'string' ? primary.slice(0, 120) : '';
  let detail: string | undefined;
  try {
    detail = JSON.stringify(input, null, 2)?.slice(0, DETAIL_CAP);
  } catch {
    detail = undefined;
  }
  const tool: NonNullable<FeedBlock['tool']> = {
    name,
    category: toolCategory(name),
    summary,
    detail,
  };
  // structured fields for the rich blocks (E10-06)
  if (typeof input.description === 'string') tool.description = input.description.slice(0, 120);
  if (typeof input.file_path === 'string') tool.filePath = input.file_path;
  if (typeof input.old_string === 'string') tool.oldString = input.old_string.slice(0, 1500);
  if (typeof input.new_string === 'string') tool.newString = input.new_string.slice(0, 1500);
  if (name === 'Write' && typeof input.content === 'string') {
    tool.newString = input.content.slice(0, 1500);
  }
  return { t: 'block', block: { kind: 'tool', tool, ts }, index, toolUseId };
}
