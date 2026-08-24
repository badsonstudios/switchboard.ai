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
import { asDisplayString } from '../../shared/display-string';
import { ToolCategory, toolCategory } from '../../shared/tool-taxonomy';

/**
 * What rode along with a prompt (#491, P2-E10-09/10).
 *
 * COUNTED OFF THE MESSAGE, never off composer state. The composer's chip strip
 * clears itself on send, so by the time this block exists the only surviving
 * record of what was attached is the message's own `content` array — which is
 * also the only record that is TRUE: it is what went on the wire, on both
 * transports (the CLI's `--replay-user-messages` echo, and the JSONL line the
 * same turn is written to). A count taken from the composer would be a claim
 * about our intent; this is a claim about the send.
 *
 * TWO NUMBERS, because the wire has two block types and they are not the same
 * thing to a reader scrolling back: an `image` is something the model LOOKED
 * at, a `document` is something it READ (a PDF, or a text file sent as its
 * contents — see `shared/prompt-attachments.ts`). Collapsing them into one
 * "3 attachments" would be honest about the number and vague about the turn.
 */
export interface FeedAttachments {
  /** `image` content blocks — a pasted screenshot or a dropped picture */
  images: number;
  /** `document` content blocks — a PDF, or a text file sent as its contents */
  documents: number;
}

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
  /**
   * user: the attachments this prompt carried, when it carried any (#491).
   *
   * ABSENT, not zeroed, for the overwhelmingly common plain-text prompt — so a
   * block with nothing attached is byte-for-byte the block this file has always
   * produced, and every pinned shape in the suite stays pinned.
   */
  attachments?: FeedAttachments;
  /** thinking: how long it lasted (set when the next block lands) */
  durationMs?: number;
  /** true when the line came from a subagent transcript */
  sidechain: boolean;
  ts?: string;
  /**
   * The identity the MESSAGE gave this block, when it gave it one (P2-E17,
   * #458): `tool:<tool_use id>` or `msg:<message id>`.
   *
   * WHAT IT IS FOR. Session find scans the transcript FILE and then has to say
   * which block on screen a hit belongs to. That join used to be made on
   * kind + timestamp + tool name, which works only while both sides read the
   * same file: a Direct session's Feed is built from the STREAM, where the only
   * timestamp available is the moment the message reached us, so nothing lined
   * up and §5.31's flagship gesture — click a hit, land on the block — was dead
   * on the app's default transport.
   *
   * These two ids are the fields that are the SAME on both sides, and neither is
   * ours: `tool_use.id` and `message.id` are the Anthropic API's, written into
   * the JSONL and handed to us over stream-json inside the very same `message`
   * object (verified against the Claude Code VS Code extension, whose own
   * transcript→stream converter passes `message` through verbatim).
   *
   * OPTIONAL ON PURPOSE, and safe when absent. A user prompt carries no id, and
   * a source that stopped sending one would take jumping back to where it was
   * rather than send a hit anywhere wrong — `search.ts` refuses an ambiguous or
   * disagreeing id rather than resolving it.
   */
  srcId?: string;
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

/**
 * How much of each field a derivation keeps (P2-E17-01).
 *
 * The caps used to be constants spliced in at five call sites, which was right
 * while the Feed was the only consumer. Session find is a SECOND consumer with
 * a different answer to the same question: §5.31 says a find "searches
 * everything, including what the view is hiding", and `DETAIL_CAP` hides
 * exactly the tail of a tool result where an error string lives. Searching the
 * capped text would be the same confident lie as searching the DOM, one layer
 * down.
 *
 * A PARAMETER rather than a second extractor, deliberately: the caps change how
 * LONG a field is and nothing else, so every derivation produces the same
 * intents, in the same order, with the same `toolUseId`s and the same `srcId`s —
 * which is the whole of what block identity rests on. A search that re-derived
 * blocks its own way could not hand E17-02 a seq the Feed agrees with. Note
 * `srcId` is NOT capped by any of these: it is identity, not text, and an
 * identity-only pass that dropped it would be identity-only in name. Nor is
 * `attachments` (#491), for the same reason and one more: it is a COUNT, so
 * there is no length to trim — and it is what decides whether an
 * attachment-only turn produces a block at all, which every pass has to agree
 * on or the ordinals drift.
 */
export interface DerivationCaps {
  /** user / assistant / thinking prose, and local-command output */
  text: number;
  /** the tool input JSON, and a tool_result's output. 0 skips building it */
  detail: number;
  /** the tool row's one-line summary and its `description`. These were two
   *  independently written `120`s before this type existed and are one number
   *  from now on — the same value, and now coupled on purpose: both are "the
   *  one line a tool row shows", and a reason to move one is a reason to move
   *  the other */
  summary: number;
  /** the old/new string previews the inline diff renders */
  edit: number;
  /** how many TodoWrite items are kept */
  todos: number;
}

/** What the Feed renders — the caps this module has always applied. */
export const DISPLAY_CAPS: DerivationCaps = {
  text: TEXT_CAP,
  detail: DETAIL_CAP,
  summary: 120,
  edit: 1500,
  todos: 30,
};

/** Everything, uncapped — what a find must see (P2-E17-01, §5.31). */
export const FULL_CAPS: DerivationCaps = {
  text: Infinity,
  detail: Infinity,
  summary: Infinity,
  edit: Infinity,
  todos: Infinity,
};

/**
 * Shape only: same intents, same order, same ids, no text built at all.
 *
 * The search engine derives EVERY line to keep its block ordinal in step with
 * the Feed's `seq`, but only the lines whose raw JSON could possibly contain the
 * term need their text. `detail: 0` is the one that pays: it skips a
 * `JSON.stringify` of the whole tool input per tool call, which is the single
 * most expensive thing derivation does and is pure waste on a line already known
 * not to match.
 */
export const IDENTITY_ONLY_CAPS: DerivationCaps = {
  text: 0,
  detail: 0,
  summary: 0,
  edit: 0,
  todos: 0,
};

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
export function deriveIntents(
  entry: Record<string, unknown>,
  caps: DerivationCaps = DISPLAY_CAPS
): BlockIntent[] {
  // CLI-internal lines are not conversation. FIRST, ahead of every shape test:
  // it used to sit behind the `message` check, which was harmless while only
  // `user`/`assistant` were read and stops being so the moment another entry
  // type is (a `system` line carries `isMeta` too).
  if (entry.isMeta === true) return [];
  const ts = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;

  const local = localCommandText(entry);
  if (local !== null) {
    return [{ t: 'block', block: { kind: 'assistant', text: local.slice(0, caps.text), ts } }];
  }

  const message = entry.message as { content?: unknown; role?: string; id?: unknown } | undefined;
  if (!message) return [];

  if (entry.type === 'user') return userIntents(message, ts, caps);
  if (entry.type === 'assistant' && Array.isArray(message.content)) {
    // The API message's own id, and the reason it is read HERE rather than by
    // either caller: it is the one field a prose block can be identified by
    // across the two transports, and both callers hand this function the same
    // `message` object (see `FeedBlock.srcId`).
    return assistantIntents(
      message.content,
      ts,
      caps,
      typeof message.id === 'string' ? message.id : undefined
    );
  }
  return [];
}

/**
 * How many attachments this user message carried (#491).
 *
 * TOP-LEVEL ITEMS ONLY, and that is the whole of what makes the count
 * trustworthy. A top-level `image` or `document` in a USER message is a file
 * the user attached — through our composer (`shared/prompt-attachments.ts` ->
 * `userMessage`), or through the CLI's own paste path, which is where the three
 * such lines in this repo's real transcript fixture came from long before the
 * composer existed. All of those are the same fact and all are honest to count.
 *
 * What a top-level item can NEVER be is a tool's output. A `Read` of a `.png`
 * comes back as an image NESTED inside the `tool_result` item's own `content`,
 * which this loop does not open — so "Claude looked at a file" cannot be
 * rendered as "the user attached one".
 *
 * `undefined` rather than `{ images: 0, documents: 0 }` when there is nothing:
 * see `FeedBlock.attachments`.
 *
 * The element type is nullable because this module is "tolerant by
 * construction" (see `deriveIntents`) — the array is untrusted output from
 * another process and a hole in it is not a throw.
 */
function countAttachments(
  items: readonly ({ type?: string } | null | undefined)[]
): FeedAttachments | undefined {
  let images = 0;
  let documents = 0;
  for (const c of items) {
    if (c?.type === 'image') images++;
    else if (c?.type === 'document') documents++;
  }
  return images > 0 || documents > 0 ? { images, documents } : undefined;
}

function userIntents(
  message: { content?: unknown },
  ts: string | undefined,
  caps: DerivationCaps
): BlockIntent[] {
  const out: BlockIntent[] = [];
  // a real prompt is a string (or text items); tool_result items attach their
  // output to the originating tool block (E10-06 OUT sections).
  // <local-command-*> wrappers (the caveat preamble, and the stdout echo the
  // CLI writes back as a user line) are plumbing, not conversation (Dan
  // 2026-07-22) — the stdout itself reaches the Feed as `system:local_command`
  // above, with the wrapper stripped.
  if (typeof message.content === 'string' && message.content.trim()) {
    if (isPlumbing(message.content)) return out;
    out.push({ t: 'block', block: { kind: 'user', text: message.content.slice(0, caps.text), ts } });
    return out;
  }
  if (!Array.isArray(message.content)) return out;
  const items = message.content as Array<{
    type?: string;
    text?: string;
    tool_use_id?: string;
    content?: unknown;
  }>;
  const attachments = countAttachments(items);
  // The counts belong to the MESSAGE, so exactly ONE block wears them — the
  // first prose block, which is the prompt the attachments were sent with.
  // (`userMessage` puts attachments first and the typed text last, so in
  // practice there is exactly one candidate; the flag is what keeps a message
  // that somehow held two from claiming the same pictures twice.)
  let marked = false;
  for (const [index, c] of items.entries()) {
    if (c?.type === 'text' && c.text?.trim() && !isPlumbing(c.text)) {
      const mark = attachments !== undefined && !marked ? { attachments } : {};
      marked = true;
      out.push({
        t: 'block',
        block: { kind: 'user', text: c.text.slice(0, caps.text), ts, ...mark },
        index,
      });
    } else if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') {
      out.push({
        t: 'tool-result',
        toolUseId: c.tool_use_id,
        out: toolResultText(c.content).slice(0, caps.detail),
      });
    }
  }
  // AN ATTACHMENT-ONLY TURN, and the reason this branch is not a nicety.
  // "Look at this" typed into nothing but a pasted screenshot is a legitimate
  // prompt — the composer's send button lights up for it on purpose — and
  // `userMessage` sends no text block at all for it. Until #491 the loop above
  // therefore produced NOTHING, so the Feed showed no trace whatsoever that a
  // turn had been taken: the reply arrived under no prompt. The block stands
  // for the attachments themselves, so it carries no text and no `index` —
  // there is no single content item it sits at.
  //
  // THE ONE ASSUMPTION, stated rather than hidden: that the CLI writes such a
  // turn to the JSONL as an ordinary `user` line, the way it writes every other
  // one. If it instead marked it `isMeta` / `isVisibleInTranscriptOnly`, the
  // transcript would derive one block fewer than the stream and session find's
  // file ordinals would run one behind the Feed's `seq` for the rest of that
  // session. UNMEASURED — the repo's real fixture happens to contain only the
  // image+text shape — and deliberately not guessed at either way. It fails
  // SAFE if the assumption is wrong: `search.ts` refuses an anchor whose shape
  // disagrees rather than resolving it, so hits stay snippet-only instead of
  // jumping somewhere wrong (`search.test.ts` pins the in-step case).
  if (attachments !== undefined && !marked) {
    out.push({ t: 'block', block: { kind: 'user', ts, attachments } });
  }
  return out;
}

function assistantIntents(
  content: unknown[],
  ts: string | undefined,
  caps: DerivationCaps,
  messageId?: string
): BlockIntent[] {
  const out: BlockIntent[] = [];
  // A MESSAGE id, not a block id, and the difference matters — measured on the
  // 4,697-line real transcript this repo ships as a fixture:
  //
  //  * one API message is written as SEVERAL lines, one content item each (0
  //    multi-item assistant lines; `StreamFeed.claim` records the same shape
  //    for stream-json). All of them repeat the one `message.id`: of 884
  //    distinct ids, **583 span more than one line**, up to 8. So this is NOT
  //    unique per line and must not be read as though it were.
  //  * what makes it serviceable anyway is that a TOOL block never wears it —
  //    `toolIntent` prefers the `tool_use` id, which is unique across the whole
  //    conversation — so a `msg:` id only ever has to tell PROSE blocks apart,
  //    and a message rarely produces two of those. Measured: **331 prose
  //    blocks, 330 distinct ids, exactly one id worn by two blocks.**
  //  * and that one is not a wrong jump. A repeated id repeats on BOTH sides,
  //    and `search.ts` refuses an ambiguous anchor rather than picking one.
  const srcId = messageId !== undefined ? { srcId: `msg:${messageId}` } : {};
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
        block: { kind: 'assistant', text: c.text.slice(0, caps.text), ts, ...srcId },
        index,
      });
    } else if (c?.type === 'thinking' && c.thinking?.trim()) {
      out.push({
        t: 'block',
        block: { kind: 'thinking', text: c.thinking.slice(0, caps.text), ts, ...srcId },
        index,
      });
    } else if (c?.type === 'tool_use' && typeof c.name === 'string') {
      out.push(toolIntent(c, index, ts, caps));
    }
  }
  return out;
}

function toolIntent(
  c: { name?: string; id?: unknown; input?: Record<string, unknown> },
  index: number,
  ts: string | undefined,
  caps: DerivationCaps
): EmitIntent {
  const name = String(c.name);
  const input = c.input ?? {};
  const toolUseId = typeof c.id === 'string' ? c.id : undefined;
  // A tool call's id in preference to its message's: it is unique across the
  // whole conversation, so it identifies this block even when the message it
  // belongs to produced several (see `FeedBlock.srcId`).
  const srcId = toolUseId !== undefined ? { srcId: `tool:${toolUseId}` } : {};
  // TodoWrite renders as a checklist block, not a raw tool row (E10-06)
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    const todos = (input.todos as Array<{ content?: unknown; status?: unknown }>)
      .slice(0, caps.todos)
      .map((td) => ({
        content: asDisplayString(td?.content),
        status: asDisplayString(td?.status),
      }));
    // No `toolUseId` on the intent (a checklist has no OUT section to await),
    // but it still gets the identity: it is a block find can be asked to reach.
    return { t: 'block', block: { kind: 'todos', todos, ts, ...srcId }, index };
  }
  const primary =
    input.file_path ??
    input.path ??
    input.notebook_path ??
    input.command ??
    input.description ??
    input.pattern;
  const summary = typeof primary === 'string' ? primary.slice(0, caps.summary) : '';
  let detail: string | undefined;
  try {
    // `detail: 0` means nobody will read it, and building it is the most
    // expensive thing in this file — a full `JSON.stringify` of the tool input.
    // Skipping it is what makes the search engine's identity-only pass cheap.
    detail = caps.detail === 0 ? undefined : JSON.stringify(input, null, 2)?.slice(0, caps.detail);
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
  if (typeof input.description === 'string') {
    tool.description = input.description.slice(0, caps.summary);
  }
  if (typeof input.file_path === 'string') tool.filePath = input.file_path;
  if (typeof input.old_string === 'string') tool.oldString = input.old_string.slice(0, caps.edit);
  if (typeof input.new_string === 'string') tool.newString = input.new_string.slice(0, caps.edit);
  if (name === 'Write' && typeof input.content === 'string') {
    tool.newString = input.content.slice(0, caps.edit);
  }
  return { t: 'block', block: { kind: 'tool', tool, ts, ...srcId }, index, toolUseId };
}
