// One Feed block — the Feed's own vocabulary, which every engine speaks to it
// in (P2-E18-10; neutral since #1303).
//
// WHAT IS HERE: the block, the caps a derivation applies, the intents a
// derivation hands back, a block's origin, and the neutral `ReplayEntry` a
// provider turns one history line into. Applying intents — seq numbers, the
// block cap, tool-result stitching — is `FeedBuffer`'s job.
//
// WHAT IS NOT HERE ANY MORE (#1303): the reading of CLAUDE's lines. The
// derivation that turns a Claude `user` / `assistant` / `system` entry into
// intents (`deriveIntents`) is the Claude provider's, in
// `providers/claude-transcript.ts`. It is still ONE derivation for both of
// Claude's sources — the stream's `message` event derives through it
// (`providers/claude-events.ts`), and so does every transcript line — so a
// block type still cannot render one way from a transcript and another from a
// stream. What changed is who owns it: an engine whose history is not Claude's
// JSONL (an ACP agent's `session/load` replay) brings its own reader rather
// than having its lines read as Claude's.
//
// Deliberately pure: no I/O, no state, no logger.
import type { ToolCategory } from '../../shared/tool-taxonomy';
import type { SettledQuestion } from '../../shared/ask-user-question';
import {
  fitContextSections,
  findContextSections,
  type ContextSection,
} from '../../shared/injected-context';
import { MAX_FEED_PICTURES_PER_BLOCK } from '../../shared/feed-picture';
import type { PictureData } from './picture-data';
import type { McpCall, WebCall } from '../../shared/tool-fold';
import type { AiSwitchMark } from '../../shared/ai-switch';
import type { CompactionMark } from '../../shared/compaction';

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
  /** `ai-switch`: the divider an AI switch draws (#1294) — see `aiSwitch`.
   *  `compaction`: the divider where the conversation was compacted (#1259) */
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'todos' | 'notice' | 'ai-switch' | 'compaction';
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
    /** the result came back marked an error (#1200). Absent = it did not, or
     *  no result has arrived yet. */
    failed?: true;
    /**
     * AskUserQuestion: the questions of the call, structured (#1201). `detail`
     * is a JSON string cut at a display cap, so it cannot be parsed back; a
     * question the user scrolls up to, or one replayed on resume, is drawn
     * from this and from `out`. Absent for every other tool, and for a
     * payload that is not the shape the CLI documents.
     */
    questions?: SettledQuestion[];
    /**
     * The file an edit changes, WHOLE (#1271): `file_path`, or a notebook's
     * `notebook_path`. What a run of edits to one file is compared on. Not
     * `filePath`, which is `file_path` only and decides which box draws the
     * call; and not `summary`, which is cut for display, so two long paths
     * could have read as one file. Absent for every other tool.
     */
    editPath?: string;
    /**
     * An MCP call: which server and which of its tools (#1271). What lets a
     * run of calls to ONE server fold into a row that still names every tool
     * called. Read from the name in `shared/tool-fold`; absent for every
     * other tool.
     */
    mcp?: McpCall;
    /** A web search or fetch: the query, or the site (#1271). */
    web?: WebCall;
    /**
     * The pictures the result carried (#1240): one HANDLE each, in order. The
     * bytes stay in main (`pictures.ts`); the page asks for a thumbnail by
     * handle. Absent, never `[]`, for the result that carried none.
     */
    pictures?: string[];
  };
  /**
   * user: the pictures attached to this prompt (#1240), one handle each. Rides
   * beside `attachments`, which stays the count: a document is counted and has
   * no handle, and so is a picture past the per-message limit.
   */
  pictures?: string[];
  /** TodoWrite checklist (E10-06) */
  todos?: Array<{ content: string; status: string }>;
  /**
   * `notice`: a turn the HARNESS injected, summarised (#704). See `injected.ts`
   * for how one is recognised and why `origin` rather than the text decides it.
   *
   * `raw` is the whole payload and is never omitted — the collapsed row shows a
   * summary, and a summary the user cannot check against the thing it summarises
   * is a claim rather than a report. It is what the expander shows, and it is
   * where the harness's own instruction to the model ("send a PushNotification
   * if…") stays: that sentence is the CLI talking to Claude, and putting it in
   * the one-line row would read as something the user was being told.
   */
  /**
   * `ai-switch`: this card was switched from one AI to another here (#1294).
   * Not from any transcript — the card's own persisted mark, placed in the
   * timeline by `StreamFeed`. The renderer draws a divider; #1295 adds the
   * briefing it carried.
   */
  aiSwitch?: AiSwitchMark;
  /**
   * `compaction`: the conversation was compacted here (#1259) — by the user, or
   * by the CLI on its own. From the CLI's `compact_boundary` frame, never
   * inferred; see `shared/compaction.ts`. The summary is not on the block:
   * only a handle to it, once it arrives (#1374, `summaryId`).
   */
  compaction?: CompactionMark;
  notice?: {
    /** which injected wrapper this was — the renderer dispatches on this */
    source: 'task-notification';
    /** the `<summary>` line, or the first useful line when there was none */
    summary: string;
    /** `completed` / `failed` from `<status>`, or `event` for an `<event>` */
    status?: string;
    /** the payload, verbatim and capped like any other prose */
    raw: string;
    taskId?: string;
    outputFile?: string;
  };
  /**
   * user: the attachments this prompt carried, when it carried any (#491).
   *
   * ABSENT, not zeroed, for the overwhelmingly common plain-text prompt — so a
   * block with nothing attached is byte-for-byte the block this file has always
   * produced, and every pinned shape in the suite stays pinned.
   */
  attachments?: FeedAttachments;
  /**
   * user: the stretches of `text` that are context THIS APP injected (#830).
   *
   * OFFSETS INTO `text`, never a copy of it — which is what keeps the pill
   * honest, and means a renderer that ignores this field renders today's block.
   * The renderer folds these ranges; everything between them is the user's own
   * prose.
   *
   * `text` is what was sent, up to the block's budget. When the budget bites,
   * `fitContextSections` spends it on the user's words first and shortens the
   * SECTION — so the offsets are into the text on this block and nothing else.
   * The transcript keeps every byte, and a find reads the uncapped line.
   *
   * ABSENT, not `[]`, when there are none — the house rule `attachments` states
   * above, and for the same reason: the ordinary prompt's block is byte-for-byte
   * the block this file has always produced.
   *
   * ⚠️ ONLY EVER SET FOR MARKERS THIS APP MINTED. A user can type the marker and
   * a pasted transcript can carry one, so shape alone proves nothing; the guard
   * is `DerivationContext.isMintedRef`, and a derivation that is handed no guard
   * builds no sections at all.
   */
  context?: ContextSection[];
  /** thinking: how long it lasted (set when the next block lands) */
  durationMs?: number;
  /** true when the line came from a subagent transcript */
  sidechain: boolean;
  /**
   * WHICH subagent produced this block (#788) — the CLI's own `agentId`.
   *
   * Absent on the main conversation, and absent on a sidechain block from a
   * transcript older than CLI 2.1.226, which is the whole of the degrade story:
   * no id means no group header and today's plain indent.
   *
   * This is the GROUPING KEY and never the label. Two subagents running at once
   * can share a name — measured, three concurrent `deep-research-specialist`s in
   * one session — so a label cannot separate them and an id must.
   */
  agentId?: string;
  /**
   * The subagent's name (`attributionAgent`), on the blocks that carry one.
   *
   * SPARSER THAN `agentId` ON PURPOSE, because the CLI writes it that way: it
   * is on `assistant` lines only (35,287 of 35,287), while `agentId` is also on
   * `user` and `attachment` lines. A subagent transcript opens with an unnamed
   * `user` line, so the head of a run is routinely anonymous and the NAME OF A
   * RUN IS NOT THE NAME OF ITS FIRST BLOCK — see `feed-groups.ts`, which
   * resolves it from whichever block in the run first has one.
   */
  agentName?: string;
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
  /**
   * How many of one message's pictures are handed on (#1240). ABSENT MEANS
   * NONE, which is every pass but the Feed's: a find does not search pixels
   * and a context package does not carry them, and neither should be holding
   * megabytes of base64 it will never read.
   */
  pictures?: number;
}

/** What the Feed renders — the caps this module has always applied. */
export const DISPLAY_CAPS: DerivationCaps = {
  text: TEXT_CAP,
  detail: DETAIL_CAP,
  summary: 120,
  edit: 1500,
  todos: 30,
  pictures: MAX_FEED_PICTURES_PER_BLOCK,
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

/**
 * The file a tool call touched, if it names one (#766).
 *
 * ONE RULE, TWO CALLERS, AND THAT IS THE WHOLE REASON THIS IS A FUNCTION. The
 * three keys below were written inline in `watcher.ts` (`TranscriptSnapshot.
 * filesTouched`, which the session card reports) and #766's context package
 * needs exactly the same fact for its "files touched" section. Two copies of
 * `file_path ?? path ?? notebook_path` would be two copies for about a week —
 * the day a tool arrives with a fourth key, one of them learns about it and the
 * card and the handoff start disagreeing about the same session in front of the
 * same user.
 *
 * NOT `toolIntent`'s `primary`, which is a different question with a
 * deliberately different answer: that one falls through to `command`,
 * `description` and `pattern` because it is building a one-line LABEL and any
 * of those will do. A shell command is not a file, and folding the two would
 * put `npm test` in a list of files touched.
 *
 * Nor is this `FeedBlock.tool.filePath`, which is `file_path` ONLY and stays
 * that way: the renderer keys its inline diff preview off that field, and
 * widening it would offer a diff for a `Glob` of a directory.
 */
export function touchedPath(input: Record<string, unknown> | undefined): string | undefined {
  const fp = input?.file_path ?? input?.path ?? input?.notebook_path;
  // `fp !== ''` is the one thing the watcher's inline expression did not check,
  // and it is a deliberate (tiny) behaviour change rather than an accident: an
  // empty string is not a file, and the old code would have listed it as one in
  // the card's `filesTouched`. Nothing in the suite depended on that, and no
  // tool the CLI ships sends an empty path — it is closed here because this
  // rule now has two callers and "the empty case" is where two callers diverge.
  return typeof fp === 'string' && fp !== '' ? fp : undefined;
}

/**
 * What only the SOURCE of a line knows, and derivation deliberately cannot see.
 *
 * `sidechain` has always sat on this seam — a derivation (Claude's is
 * `deriveIntents`, `providers/claude-transcript.ts`) reads one line and
 * has no idea which FILE it came out of, which is the whole of the question on
 * the transcript path (`full !== boundFile`). #788 put agent identity on the
 * same seam for the same reason, and made it a type rather than a second
 * positional boolean so that `FeedBuffer.replace` cannot quietly drop half of
 * it: that method re-stamps this group wholesale across a delta→message
 * supersede, and what you forget to carry there survives as `undefined`,
 * invisibly (the #153 shape its own comment warns about).
 */
export interface BlockOrigin {
  sidechain: boolean;
  agentId?: string;
  agentName?: string;
}

/**
 * What `StreamFeed.hydrate` may be told about the entries it is handed (#1140).
 *
 * HERE rather than beside `hydrate`, because `history.ts` builds one and
 * `history.ts` is on the session bus's default read path: importing it from
 * `stream-feed.ts` would put the whole stream Feed on that path too, which
 * `context-package.test.ts` rightly refuses.
 */
export interface HydrateOptions {
  /**
   * When the history was replayed, in epoch ms. A subagent line stamped at or
   * before it is backlog the replay has already accounted for — see
   * `StreamFeed.absorbSidechain`.
   */
  sidechainBacklogBefore?: number;
  /**
   * Blocks that are not in the transcript but belong in its timeline — today
   * the AI-switch divider (#1294). Each lands before the first replayed entry
   * stamped AFTER its `at` (epoch ms), so a divider sits where the switch
   * happened; any left over land after the last entry.
   */
  markers?: readonly FeedMarker[];
}

/**
 * One line of a session's HISTORY, as its provider read it (#1303) — what
 * `StreamFeed.hydrate` replays and `StreamFeed.absorbSidechain` takes.
 *
 * THE SAME SHAPE AS `MessageEvent.derive`, for the same reason. The Feed does
 * not read an engine's history format any more than it reads its stream: the
 * provider says when the line happened, whose it is and what it means, and the
 * Feed applies that. Claude's reader is `readClaudeTranscriptEntry`
 * (`providers/claude-transcript.ts`), declared on the `transcripts`
 * capability; a provider whose history is not a Claude JSONL brings its own,
 * or has none replayed (no fallback, DESIGN §5.3).
 */
export interface ReplayEntry {
  /** When it happened, in epoch ms. Absent when the line carries no readable time. */
  at?: number;
  /**
   * Whose it is. The reader's own answer from the line when the caller knows
   * nothing better; the caller's when it does (a subagent FILE's line, #1140).
   */
  origin: BlockOrigin;
  /**
   * A compaction's summary (#1374): kept beside the divider the line before
   * drew, for the user to open. Such an entry makes NO block.
   */
  compactionSummary?: string;
  /**
   * What the line means for the Feed. The provider's code, so a throw costs
   * that line and never the replay (P6).
   */
  derive(caps: DerivationCaps, ctx: DerivationContext): BlockIntent[];
}

/** A provider's history reader (#1303): one parsed line in, one `ReplayEntry` out. */
export type HistoryEntryReader = (entry: Record<string, unknown>, origin?: BlockOrigin) => ReplayEntry;

/** One block placed in replayed history by time (#1294). */
export interface FeedMarker {
  /** epoch ms */
  at: number;
  block: DerivedBlock;
}

/** A derived block: everything a derivation can know from one line alone. */
export type DerivedBlock = Omit<FeedBlock, 'seq' | keyof BlockOrigin>;

/**
 * Read a block's origin back off it, for carrying across a `replace`.
 *
 * ABSENT, never `undefined`-valued. `{ ...b, agentId: undefined }` is not the
 * same object as `{ ...b }` — it has the own key, `'agentId' in block` is true,
 * and every pinned shape in the suite that predates #788 would stop matching.
 * The house rule is the one `attachments` already follows: a block with nothing
 * to say says nothing.
 */
export function originOf(block: FeedBlock): BlockOrigin {
  return {
    sidechain: block.sidechain,
    ...(block.agentId === undefined ? {} : { agentId: block.agentId }),
    ...(block.agentName === undefined ? {} : { agentName: block.agentName }),
  };
}

/**
 * Assemble a block: a derived body, a seq, and an origin that OVERRULES the
 * body about every field it owns.
 *
 * ⚠️ **THE DELETES ARE THE WHOLE POINT, and a test caught their absence.**
 * `{ ...body, ...origin }` only overrules a field the origin actually carries.
 * `sidechain` is always there, so it was always right; `agentId` and
 * `agentName` are absent when there is no agent — and an absent key overwrites
 * nothing, so a body that carried one kept it. A block could therefore be
 * stamped `sidechain: false` and `agentId: 'x'` at the same time, which is the
 * one combination `agentOriginFor`'s gate exists to make impossible.
 *
 * Nothing produces such a body today — `DerivedBlock` types the fields out of
 * `deriveIntents` (`providers/claude-transcript.ts`). That is exactly why it
 * was worth closing: the guarantee this seam is supposed to make is "the
 * source decides", and a guarantee that holds only because no caller has
 * tried yet is a comment, not a guarantee.
 */
export function stamp(body: DerivedBlock, seq: number, origin: BlockOrigin): FeedBlock {
  const block: FeedBlock = { ...body, seq, ...origin };
  if (origin.agentId === undefined) delete block.agentId;
  if (origin.agentName === undefined) delete block.agentName;
  return block;
}

/** A block to add, optionally keyed by the tool_use id whose result it awaits. */
export interface EmitIntent {
  t: 'block';
  block: DerivedBlock;
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
  /**
   * `user` blocks: the pictures attached to the prompt (#1240), as the message
   * carried them. ON THE INTENT AND NOT ON THE BLOCK, because a block is what
   * crosses to the page and these are the bytes: whoever applies the intent
   * keeps them and puts handles on the block (`FeedBuffer.push`).
   */
  pictures?: PictureData[];
}

/** Output for a tool block emitted earlier — attaches to it, never a new block. */
export interface ToolResultIntent {
  t: 'tool-result';
  toolUseId: string;
  out: string;
  /**
   * The CLI marked this result an error (#1200): a command that exited
   * non-zero, one the harness blocked, one nobody approved. Absent, never
   * `false`, for a result that is not one.
   */
  failed?: true;
  /** the pictures the result carried (#1240); see `EmitIntent.pictures` */
  pictures?: PictureData[];
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
 * What only the LIVE SESSION knows, and a pure derivation cannot work out.
 *
 * The same seam `BlockOrigin` sits on, at the other end of the function: whether
 * a context marker in a user turn is one this app minted is a fact about app
 * state, not about the line. It arrives as a PREDICATE rather than a register so
 * that this module keeps the promise at the top of the file — no state, no I/O —
 * and so that a caller with nothing to check against (session find, the context
 * package, every test that does not care) simply passes nothing and gets the
 * fail-closed answer.
 */
export interface DerivationContext {
  /** #830's forgery guard — `ContextRefs.guardFor(sessionId)` in the app */
  isMintedRef?: (ref: string) => boolean;
}

/**
 * One user turn's prose, capped — and its injected-context sections, if this
 * derivation is allowed to recognise any (#830).
 *
 * ⚠️ **THE CAP IS APPLIED WITH THE SECTIONS IN HAND, NOT BEFORE THEM, and that
 * ordering is the whole of what makes the feature fire.** The obvious version
 * slices to `caps.text` first and looks for markers in the result — and for the
 * case #830 opens with, a mention of a BUSY session, that finds nothing:
 * `queries.ts` caps one session's output at the same 20,000 characters this
 * block is capped at, so the closing marker is the first thing off the end.
 * `fitContextSections` spends the budget on the user's own words first and
 * shortens the section instead. `providers/claude-transcript.test.ts` pins both.
 *
 * `caps.text === 0` is the identity-only pass, which promises no text is built:
 * there is nothing to scan and nobody to show it to. An unguarded derivation
 * (session find, the context package) gets the plain slice it always got.
 */
export function userText(
  raw: string,
  caps: DerivationCaps,
  ctx: DerivationContext
): { text: string; context?: ContextSection[] } {
  if (ctx.isMintedRef === undefined || caps.text <= 0) return { text: raw.slice(0, caps.text) };
  const found = findContextSections(raw, ctx.isMintedRef);
  if (found.length === 0) return { text: raw.slice(0, caps.text) };
  const fitted = fitContextSections(raw, found, caps.text);
  // Absent, never `undefined`-valued — see `FeedBlock.context`.
  return fitted.sections.length === 0
    ? { text: fitted.text }
    : { text: fitted.text, context: fitted.sections };
}

/**
 * A user prompt as a Feed block, from its TEXT alone — for an engine whose wire
 * is not Claude's (E40 item 06, #1289: ACP's `session/prompt` and its
 * `user_message_chunk` replay). The same prose rules a Claude `user` line gets:
 * plumbing is dropped, and only markers this app minted fold into context pills
 * (#830's guard, via `userText`). `null` for nothing to show.
 */
export function userPromptIntent(
  text: string,
  ts: string | undefined,
  caps: DerivationCaps,
  ctx: DerivationContext
): EmitIntent | null {
  if (!text.trim() || isPlumbing(text)) return null;
  return { t: 'block', block: { kind: 'user', ...userText(text, caps, ctx), ts } };
}
