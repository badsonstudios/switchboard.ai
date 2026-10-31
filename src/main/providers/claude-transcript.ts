// Claude's history, read in the Feed's vocabulary (#1303; the derivation itself
// is P2-E18-10's).
//
// ONE DERIVATION, BOTH OF CLAUDE'S SOURCES. A transcript's `assistant` line and
// the stream's `assistant` message both carry an Anthropic
// `message: { role, content: [...] }`; tool results arrive as `user` messages
// with `tool_result` items on both. The transcript wraps them in file metadata
// (uuid, cwd, gitBranch) that this module simply does not read. So the stream's
// `message` event derives through `deriveIntents` (`claude-events.ts`), and so
// does every transcript line — a block type cannot render one way from a
// transcript and another from a stream.
//
// WHY IT LIVES IN THE PROVIDER. Until #1303 this was `feed/blocks.ts`, and the
// Feed's replay (`StreamFeed.hydrate`, `absorbSidechain`) called it on raw
// JSONL entries — so a Claude-shaped parser sat on the event path, reached
// only through the translator for the stream and directly for history. An ACP
// agent's history comes back as `session/load` replay, not as a JSONL on disk
// (`spike/findings/e40-codex-acp.md`, question 5): that is the day DESIGN §5.3
// named for the reader to move behind the seam. The Feed now takes a neutral
// `ReplayEntry`, and `readClaudeTranscriptEntry` below is Claude's reader,
// declared on the adapter's `transcripts` capability.
//
// The host-side transcript readers that are not the Feed's replay — the
// watcher's PTY Feed, session find, `transcript-blocks` — still call
// `deriveIntents` directly; they read Claude's JSONL by definition, and
// `engine-seam.test.ts` lists them exactly.
//
// Deliberately pure: no I/O, no state, no logger. It answers "what does this
// message MEAN for the Feed" and hands back intents.
import { asDisplayString } from '../../shared/display-string';
import { toolCategory } from '../../shared/tool-taxonomy';
import { ASK_USER_QUESTION_TOOL, settledQuestions } from '../../shared/ask-user-question';
import { classifyInjected, describeInjectedTurn } from '../feed/injected';
import { picturesIn } from '../feed/picture-data';
import { mcpCall, webCall } from '../../shared/tool-fold';
import { compactionMarkOfEntry } from '../../shared/compaction';
import {
  DISPLAY_CAPS,
  isPlumbing,
  toolResultText,
  userText,
  type BlockIntent,
  type BlockOrigin,
  type DerivationCaps,
  type DerivationContext,
  type EmitIntent,
  type FeedAttachments,
  type FeedBlock,
  type ReplayEntry,
} from '../feed/blocks';

/**
 * One parsed Claude transcript line as a neutral `ReplayEntry` (#1303) — the
 * `transcripts.readEntry` the Claude adapter (and the fake) declare.
 *
 * Exactly what `StreamFeed.hydrate` and `absorbSidechain` used to read off the
 * line themselves, so the replay is byte-identical:
 *
 *  - `at` is the line's `timestamp`, parsed; absent when it has none readable;
 *  - `origin` is the caller's when it has one (a subagent FILE's line, #1140),
 *    else the line's own `isSidechain` — on any CLI from 2.1.226 on that is
 *    never true in a main transcript (#788), but an older transcript on disk is
 *    still a thing we replay;
 *  - `compactionSummary` is `compactionSummaryText` (#1374);
 *  - `derive` is `deriveIntents`.
 */
export function readClaudeTranscriptEntry(entry: Record<string, unknown>, origin?: BlockOrigin): ReplayEntry {
  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  const summary = compactionSummaryText(entry);
  return {
    ...(Number.isFinite(at) ? { at } : {}),
    origin: origin ?? { sidechain: entry.isSidechain === true },
    ...(summary !== null ? { compactionSummary: summary } : {}),
    derive: (caps, ctx) => deriveIntents(entry, caps, ctx),
  };
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
 * Does the CLI say this entry is NOT FOR THE LIVE VIEW (#1026)?
 *
 * A NEW DROP RULE, not a second spelling of `isMeta`'s, and it gets its own
 * argument: `isMeta` says "the loop wrote this"; this says "this is stored,
 * and a live view does not show it".
 *
 * ── WHAT IT IS, MEASURED (`spike/findings/1026-not-for-the-live-view.md`) ───
 *
 * A COMPACTION. When the CLI compacts a conversation (the user's `/compact`,
 * or on its own when the window fills), it writes the summary that replaces
 * the history as a `user` message: "This session is being continued from a
 * previous conversation that ran out of context…", thousands of characters.
 * Nobody typed it. Until this rule the Feed drew it as a prompt: a pill under
 * a NEW PROMPT divider, in the prompt list, on both transports.
 *
 *   * IN THE TRANSCRIPT it carries `isCompactSummary: true` and
 *     `isVisibleInTranscriptOnly: true`. Counted over every conversation on
 *     this machine: 16 lines in 13 files, CLI 2.1.261 to 2.1.288, and all 16
 *     are that summary. Nothing else has ever carried either flag here.
 *   * ON THE STREAM it carries neither. The CLI's internal -> wire converter
 *     writes ONE field for a user message, read off the PATH binary (2.1.288):
 *
 *         isSynthetic: e.isMeta || e.isVisibleInTranscriptOnly
 *                      || e.isCompactSummary || undefined
 *
 *     and that is what arrived (`spike/probes/1026/`, real CLI, switchboard's
 *     own flags): the summary as a `user` frame with `isSynthetic: true` and
 *     `isReplay: false`. So on the wire the three flags the transcript keeps
 *     apart are one, in camelCase, and it is the only spelling that reaches
 *     us. `isSynthetic` is also the documented one: the Agent SDK's user
 *     message type declares it.
 *
 * ── WHY EVERY SPELLING BELOW IS HERE ────────────────────────────────────────
 *
 * The rule has to give ONE answer for the same message whichever way it
 * arrived ("both sources, one renderer"). On the wire, `isSynthetic` is the
 * OR of three flags; so the transcript side drops the same three: `isMeta`
 * (the line above this function's call), and the two here. A summary made by
 * "summarize up to here" is `isCompactSummary` WITHOUT
 * `isVisibleInTranscriptOnly`, and still `isSynthetic` on the wire: it has to
 * be dropped from a transcript too, or the same turn would be a prompt on one
 * transport and nothing on the other.
 *
 * `is_visible_in_transcript_only` and `is_compact_summary` are the snake_case
 * twins the CLI DECLARES on its wire schema ("@internal True when the message
 * is stored in the transcript but not rendered in the live UI"). They occur
 * twice each in the whole binary, the schema and a string table, and no
 * converter writes them: unreachable from our spawn today, by reading. They
 * are honoured for #997's reason, a guard on a declared field.
 *
 * ── AND WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────
 *
 * `is_virtual` / `isVirtual`, the other field #1026 names. The CLI describes
 * it as "Display-only: rendered in the UI but filtered before API send": the
 * opposite instruction. A message so marked is one a live view SHOWS. It has
 * never appeared in a transcript on this machine (0 hits) or on our stream,
 * and the Feed's default, to render it, is already what it asks for.
 *
 * `=== true` throughout, for `isMeta`'s reason: these arrive from another
 * process, and a truthy test would drop a line over a non-empty string.
 * `isSynthetic` is read on `user` entries only, which is the only shape the
 * converter writes it on.
 */
function isNotForTheLiveView(entry: Record<string, unknown>): boolean {
  if (entry.isVisibleInTranscriptOnly === true || entry.is_visible_in_transcript_only === true) return true;
  if (entry.isCompactSummary === true || entry.is_compact_summary === true) return true;
  return entry.type === 'user' && entry.isSynthetic === true;
}

/**
 * The text of a compaction's SUMMARY, when this entry is one (#1374) — or null.
 *
 * NOT A DERIVATION, and that is the point: `deriveIntents` still drops this
 * entry (#1026, `isNotForTheLiveView`), so it never becomes a block. This only
 * lets a caller keep the CLI's own words beside the divider the boundary drew
 * (`FeedBuffer.attachCompactionSummary`), for the user to open on request.
 *
 * BOTH SPELLINGS, for `isNotForTheLiveView`'s reason: the transcript marks it
 * `isCompactSummary` (camel; the snake twin is the declared wire field), the
 * stream marks it only `isSynthetic` on a `user` frame. `isSynthetic` is ALSO
 * the wire's spelling of `isMeta`, so this alone cannot tell a summary from
 * other loop-written text — which is why the buffer attaches it ONLY to a
 * divider pushed immediately before, and never on its own say-so. An explicit
 * `isMeta` / `is_meta` is refused outright.
 *
 * The text is the CLI's, verbatim: a string, or the text items of an array
 * joined by blank lines. Nothing is synthesised; no text is no summary.
 */
export function compactionSummaryText(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'user') return null;
  if (entry.isMeta === true || entry.is_meta === true) return null;
  const flagged =
    entry.isCompactSummary === true || entry.is_compact_summary === true || entry.isSynthetic === true;
  if (!flagged) return null;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .flatMap((c) =>
        c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' && typeof (c as { text?: unknown }).text === 'string'
          ? [(c as { text: string }).text]
          : []
      )
      .join('\n\n');
  }
  return text.trim() === '' ? null : text;
}

/**
 * What one message means for the Feed. Tolerant by construction: an unknown
 * shape produces an empty list, never a throw — both callers are reading
 * untrusted output from another process.
 */
export function deriveIntents(
  entry: Record<string, unknown>,
  caps: DerivationCaps = DISPLAY_CAPS,
  ctx: DerivationContext = {}
): BlockIntent[] {
  // CLI-internal lines are not conversation. FIRST, ahead of every shape test:
  // it used to sit behind the `message` check, which was harmless while only
  // `user`/`assistant` were read and stops being so the moment another entry
  // type is (a `system` line carries `isMeta` too).
  //
  // ⚠️ BOTH SPELLINGS, AND THAT IS NOT DEFENSIVENESS — IT IS THE CONTRACT
  // (#997). `isMeta` is the TRANSCRIPT spelling; the STREAM spells the same
  // flag `is_meta`, and this function is the only reader of it for both
  // transports. The CLI says so in its own code twice over (read off the PATH
  // binary 2.1.280, `spike/findings/997-is-meta-on-the-stream.md`):
  //
  //   * its outbound wire schemas declare `is_meta` as an optional literal
  //     `true` on the `user` shape ("synthesized by the loop (not user
  //     keyboard input)") AND on the `assistant` shape ("synthesized by the
  //     loop (not a model response)");
  //   * its own wire->internal ingest converter opens with
  //     `if (r.is_meta === true) return []` and then writes `isMeta: false`
  //     into the internal shape — one function, both spellings, so the rename
  //     is the transport boundary rather than a version drift.
  //
  // MEASURED 2026-09-30 against CLI 2.1.280 with switchboard's exact flag
  // list: NO `is_meta` frame arrived (`spike/probes/997/`). The census over
  // that session's whole stream found only `isReplay` and `is_error`. So this
  // clause changes nothing observable today and is a guard on a declared
  // field, not a fix for a bug anyone has seen — see the findings note for
  // why the frame the issue was filed about (a `PushNotification` `tool_use`
  // with `is_meta: true`) is unreachable from a non-interactive spawn.
  //
  // The `=== true` on both is load-bearing for the same reason it always was:
  // these arrive from another process, and a truthy test would drop a line
  // over a non-empty string.
  if (entry.isMeta === true || entry.is_meta === true) return [];
  if (isNotForTheLiveView(entry)) return [];
  const ts = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;

  // A COMPACTION'S BOUNDARY (#1259): the transcript's spelling of the frame the
  // stream sends as `system:compact_boundary` (that one is translated in
  // `providers/claude-events.ts` and drawn by `StreamFeed`). Its summary, the
  // next line, is dropped just above (#1026); this is the mark of where it
  // happened. A `system` line has no `message`, so it is read before that test.
  const compaction = compactionMarkOfEntry(entry);
  if (compaction) return [{ t: 'block', block: { kind: 'compaction', compaction, ts } }];

  const local = localCommandText(entry);
  if (local !== null) {
    return [{ t: 'block', block: { kind: 'assistant', text: local.slice(0, caps.text), ts } }];
  }

  const message = entry.message as { content?: unknown; role?: string; id?: unknown } | undefined;
  if (!message) return [];

  if (entry.type === 'user') return userIntents(entry, message, ts, caps, ctx);
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

/**
 * A user-role turn the harness wrote, as a block (#704).
 *
 * `null` when this text is a person speaking, which is the overwhelmingly
 * common answer and the safe one: the decision lives in `injected.ts`, with the
 * measurements behind it.
 *
 * NO `text` FIELD, deliberately. The payload rides on `notice.raw` instead, and
 * the difference is not cosmetic — `text` is what every prose reader in the app
 * treats as words a person or the model produced (`search.ts` collects it,
 * `transcript-blocks.ts` labels it, the markdown fallback renderer would set it
 * as HTML). Leaving the XML in `text` would keep it classified as prose
 * everywhere except the one renderer that was taught otherwise, which is the
 * shape of the bug rather than the fix. Each of those readers is given a
 * `notice` branch instead.
 */
function noticeIntent(
  entry: Record<string, unknown>,
  text: string,
  ts: string | undefined,
  caps: DerivationCaps,
  index?: number
): EmitIntent | null {
  const source = classifyInjected(entry, text);
  if (source === null) return null;
  const payload = text.trim();
  return {
    t: 'block',
    block: {
      kind: 'notice',
      notice: {
        ...describeInjectedTurn(source, payload, caps.summary),
        raw: payload.slice(0, caps.text),
      },
      ts,
    },
    ...(index === undefined ? {} : { index }),
  };
}

function userIntents(
  entry: Record<string, unknown>,
  message: { content?: unknown },
  ts: string | undefined,
  caps: DerivationCaps,
  ctx: DerivationContext
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
    // A harness-injected turn is not a prompt (#704). Tested BEFORE the prompt
    // block is built, and after `isPlumbing`, which keeps the three injected
    // shapes in one order: `isMeta` (dropped whole, in `deriveIntents`),
    // `<local-command-*>` (dropped here), then this one — which is SHOWN,
    // because unlike the other two it is content the user wants, wearing the
    // wrong clothes.
    const notice = noticeIntent(entry, message.content, ts, caps);
    if (notice) return [notice];
    out.push({ t: 'block', block: { kind: 'user', ...userText(message.content, caps, ctx), ts } });
    return out;
  }
  if (!Array.isArray(message.content)) return out;
  const items = message.content as Array<{
    type?: string;
    text?: string;
    tool_use_id?: string;
    is_error?: unknown;
    content?: unknown;
  }>;
  const attachments = countAttachments(items);
  // The pictures themselves (#1240), for the one block that wears the count.
  // TOP-LEVEL items only, as the count is: a picture nested in a `tool_result`
  // is the tool's, and is collected with that result below.
  const attached = picturesIn(items, caps.pictures ?? 0);
  const shown = attached.length > 0 ? { pictures: attached } : {};
  // The counts belong to the MESSAGE, so exactly ONE block wears them — the
  // first prose block, which is the prompt the attachments were sent with.
  // (`userMessage` puts attachments first and the typed text last, so in
  // practice there is exactly one candidate; the flag is what keeps a message
  // that somehow held two from claiming the same pictures twice.)
  let marked = false;
  for (const [index, c] of items.entries()) {
    if (c?.type === 'text' && c.text?.trim() && !isPlumbing(c.text)) {
      // The same test the string branch makes, because the same turn can arrive
      // either way: the transcript writes these as a plain string (9 of 9 in the
      // real fixture) and the stream's user messages carry text ITEMS. One rule,
      // both shapes — the alternative is a notification that renders correctly
      // on one transport and as raw XML on the other, which is precisely what
      // "both sources, one renderer" exists to prevent.
      //
      // It does NOT take the attachment mark. A harness turn did not attach
      // anything; if a message somehow carried both, the pictures stay with the
      // fallback block below rather than being claimed by the notification.
      const notice = noticeIntent(entry, c.text, ts, caps, index);
      if (notice) {
        out.push(notice);
        continue;
      }
      const mark = attachments !== undefined && !marked ? { attachments } : {};
      const pictures = attachments !== undefined && !marked ? shown : {};
      marked = true;
      out.push({
        t: 'block',
        block: { kind: 'user', ...userText(c.text, caps, ctx), ts, ...mark },
        index,
        ...pictures,
      });
    } else if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') {
      const returned = picturesIn(c.content, caps.pictures ?? 0);
      out.push({
        ...(returned.length > 0 ? { pictures: returned } : {}),
        t: 'tool-result',
        toolUseId: c.tool_use_id,
        out: toolResultText(c.content).slice(0, caps.detail),
        // the CLI's own flag, not a reading of the text. Measured on 3,153
        // shell results in 25 real transcripts: every "Exit code N" result
        // carried it, and so did the 21 that failed without one (blocked by
        // the harness, declined for want of an answer). And on the live
        // stream it is on every result, true or false. Both in
        // `spike/findings/1200-is-error-on-a-tool-result.md`.
        ...(c.is_error === true ? { failed: true as const } : {}),
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
  // one. If it instead marked it `isMeta` / `isVisibleInTranscriptOnly` (which
  // `deriveIntents` drops, the second since #1026), the
  // transcript would derive one block fewer than the stream and session find's
  // file ordinals would run one behind the Feed's `seq` for the rest of that
  // session. UNMEASURED — the repo's real fixture happens to contain only the
  // image+text shape — and deliberately not guessed at either way. It fails
  // SAFE if the assumption is wrong: `search.ts` refuses an anchor whose shape
  // disagrees rather than resolving it, so hits stay snippet-only instead of
  // jumping somewhere wrong (`search.test.ts` pins the in-step case).
  if (attachments !== undefined && !marked) {
    out.push({ t: 'block', block: { kind: 'user', ts, attachments }, ...shown });
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
  // what a run of these folds BY (#1271): the server, or what was looked up.
  // Capped like every other string that rides a block.
  if (tool.category === 'edit') {
    const edited = input.file_path ?? input.notebook_path;
    if (typeof edited === 'string' && edited !== '') tool.editPath = edited;
  }
  const mcp = mcpCall(name, input);
  if (mcp) tool.mcp = { server: mcp.server.slice(0, caps.summary), tool: mcp.tool.slice(0, caps.summary) };
  const web = webCall(name, input);
  if (web) {
    tool.web =
      web.kind === 'search'
        ? { kind: 'search', query: web.query.slice(0, caps.summary) }
        : { kind: 'page', host: web.host.slice(0, caps.summary) };
  }
  if (typeof input.old_string === 'string') tool.oldString = input.old_string.slice(0, caps.edit);
  if (typeof input.new_string === 'string') tool.newString = input.new_string.slice(0, caps.edit);
  if (name === 'Write' && typeof input.content === 'string') {
    tool.newString = input.content.slice(0, caps.edit);
  }
  // a question is read back as a question, not as its payload (#1201). Not
  // for the identity-only pass (`detail: 0`), which reads none of it.
  if (name === ASK_USER_QUESTION_TOOL && caps.detail !== 0) {
    const questions = settledQuestions(input);
    if (questions) tool.questions = questions;
  }
  return { t: 'block', block: { kind: 'tool', tool, ts, ...srcId }, index, toolUseId };
}
