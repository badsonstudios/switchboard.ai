// The Feed, fed by typed messages (P2-E18-10).
//
// Same blocks, better source. In PTY mode the Feed is built by tailing the
// JSONL transcript — a file poll, so text arrives in bursts a poll apart and
// nothing renders until the CLI has flushed a whole message. In stream mode the
// CLI hands us the same content as it produces it, and `--include-partial-messages`
// turns that into `stream_event` token deltas.
//
// What this class does NOT do is decide what a block IS. That is `blocks.ts`,
// shared with the watcher, so the two sources cannot drift apart.
//
// ---------------------------------------------------------------------------
// THE ASSEMBLY RULE, and why it is not "render every message you see".
//
// A turn's text arrives TWICE: once as `stream_event` deltas, and again in the
// `assistant` message that closes it. Rendering both duplicates every reply.
// The shipped VS Code extension solves it the same way this does — its
// assembler builds a partial message from `message_start` /
// `content_block_start` / `content_block_delta`, addressed by the event's
// `index`, and the message that follows supersedes it at the same indices
// (`r.content[t.index] = …` in the SDK's own accumulator; read out of the
// bundle 2026-08-02, per the standing rule).
//
// So: deltas OPEN a block and grow it; the `assistant` message REPLACES its
// text at the same `seq` and retires it. The renderer's `upsertBlock` is keyed
// on seq (see `lib/feed.ts`), so the block the user has been watching fill in
// is the one that finalises — it never jumps, and it is never duplicated.
//
// THE ASSEMBLY MAP OUTLIVES THE TOKENS, deliberately. "Still taking tokens" and
// "still the block this message index refers to" are different facts with
// different lifetimes: the first ends at `content_block_stop`, `message_stop` or
// `result`; the second not until the `assistant` message has been reconciled
// against it, or a new message has started. Collapsing them duplicates replies —
// the deltas' block would be retired, and the message would then find nothing to
// update and append a second copy. It costs a review round to find, because in
// the happy path both copies read the same.
//
// Tool INPUT is the deliberate exception to streaming. It arrives as
// `input_json_delta` — fragments of half-written JSON — and a tool row built
// from half a path is worse than one that appears a beat later. The row itself
// still opens on `content_block_start`, which carries the tool's NAME whole:
// that is what keeps a `[tool_use, text]` message rendering in the order the
// model produced it, since a streamed block takes its seq when it opens.
//
// ONE MESSAGE TYPE NEVER REACHES HERE and is worth naming: `system:local_command`.
// A local slash command (`/usage`) is written to the JSONL under that type, but
// on the stream it is an ORDINARY `assistant` message (measured, S-11) — so the
// shared derivation's handling of it is the transcript path's, not ours. #156 is
// fixed on both, by different routes to the same block.
// ---------------------------------------------------------------------------
import { Logger } from '../log/logger';
import { toolCategory } from '../../shared/tool-taxonomy';
import { FeedBlock, TEXT_CAP, deriveIntents } from './blocks';
import { FeedBuffer } from './buffer';

/**
 * May the message's block at this index take over the one the deltas opened?
 *
 * Same kind, always. The one asymmetry is `tool` -> `todos`: a `TodoWrite` call
 * opens as an ordinary tool row (that is all `content_block_start` says it is)
 * and the message reveals it to be a checklist.
 *
 * A DISAGREEMENT is refused rather than resolved, and that is the point. If the
 * deltas built prose at index 0 and the message calls index 0 a tool call, the
 * two are not the same message — the deltas belonged to a turn that ended
 * without one. Taking the message's word there would silently delete text the
 * user has already read; appending instead costs an extra block in a case that
 * should not happen.
 */
function supersedes(streamed: FeedBlock, kind: FeedBlock['kind']): boolean {
  if (streamed.kind === kind) return true;
  return streamed.kind === 'tool' && kind === 'todos';
}

interface StreamedSession {
  buffer: FeedBuffer;
  /**
   * Blocks the CURRENT message's deltas built, by content index. Cleared when
   * that message is reconciled (or abandoned), NOT when its tokens stop.
   */
  assembling: Map<number, FeedBlock>;
  /** the conversation id the CLI last claimed, so a NEW one can reset the view */
  conversationId?: string;
}

export class StreamFeed {
  private readonly sessions = new Map<string, StreamedSession>();
  private readonly blockListeners = new Set<(sessionId: string, b: FeedBlock) => void>();
  private readonly resetListeners = new Set<(sessionId: string, cause?: 'clear') => void>();

  /** Optional so a test can construct one bare; the app always passes it. */
  constructor(private readonly log?: Logger) {}

  /** Feed one typed message from one stream session. */
  offer(sessionId: string, msg: Record<string, unknown>): void {
    switch (typeof msg.type === 'string' ? msg.type : '') {
      case 'stream_event':
        return this.onStreamEvent(sessionId, msg);
      case 'assistant':
      case 'user':
        return this.onMessage(sessionId, msg);
      case 'result':
        // The turn is over — nothing more will arrive for whatever it left
        // open. This is the ordinary way a turn ends; `finalize` is also called
        // when the session exits, which is the way it is not.
        return this.finalize(sessionId);
      case 'system':
        return this.onSystem(sessionId, msg);
      default:
        // rate_limit_event, transcript_mirror, control_request, keep_alive:
        // not content. Defaulted explicitly so a NEW message type is somebody's
        // decision rather than a silent no-op.
        return;
    }
  }

  /**
   * A `system` message. Only one of them concerns the Feed.
   *
   * `system:init` arrives ONCE PER TURN (S-11 measured 26 for 25 turns), so it
   * must never be read as "the session started" — the fact every item in this
   * epic has to respect. What it CAN tell us is that the conversation was
   * REPLACED: `/clear` mints a fresh id, and the extension bundle keys its own
   * "wipe the view" on exactly this comparison. Guarded on having seen a
   * previous id, so a session's first init never resets anything.
   */
  private onSystem(sessionId: string, msg: Record<string, unknown>): void {
    if (msg.subtype !== 'init') return;
    const id = typeof msg.session_id === 'string' ? msg.session_id : undefined;
    if (!id) return;
    const s = this.ensure(sessionId);
    if (s.conversationId === undefined || s.conversationId === id) {
      s.conversationId = id;
      return;
    }
    s.conversationId = id;
    s.buffer.reset();
    s.assembling.clear();
    this.log?.info('stream feed reset: the CLI started a new conversation', { sessionId });
    for (const l of this.resetListeners) {
      try {
        l(sessionId, 'clear');
      } catch (err) {
        this.log?.error('feed reset listener threw', { sessionId, error: String(err) });
      }
    }
  }

  private onStreamEvent(sessionId: string, msg: Record<string, unknown>): void {
    const ev = msg.event as Record<string, unknown> | undefined;
    if (!ev || typeof ev.type !== 'string') return;
    // Sidechain content is explicitly out of scope for this item (E18-13 owns
    // it, behind the S-11 probes) — but a subagent's tokens must not be
    // interleaved into the main conversation's blocks in the meantime, which is
    // exactly what ignoring `parent_tool_use_id` here would do.
    if (msg.parent_tool_use_id != null) return;
    const s = this.ensure(sessionId);
    const index = typeof ev.index === 'number' ? ev.index : 0;
    switch (ev.type) {
      case 'message_start':
        // A new message supersedes whatever the last one left behind — it may
        // have ended without an `assistant` message, or without a `result`.
        this.endMessage(s);
        return;
      case 'content_block_start':
        this.open(s, index, ev.content_block as Record<string, unknown> | undefined);
        return;
      case 'content_block_delta': {
        const delta = ev.delta as { type?: string; text?: string; thinking?: string } | undefined;
        const piece =
          delta?.type === 'text_delta'
            ? delta.text
            : delta?.type === 'thinking_delta'
              ? delta.thinking
              : undefined;
        // input_json_delta and signature_delta carry nothing renderable. A tool
        // row built from half-written JSON is worse than one that appears a
        // beat later, so tool INPUT comes from the `assistant` message only.
        if (typeof piece !== 'string' || piece === '') return;
        // Opened lazily when needed: `content_block_start` is the CLI's to send
        // and we do not get to require it. A delta with no block is still text
        // the user should see.
        const block =
          this.streamingAt(s, index) ??
          this.open(s, index, { type: delta?.type === 'thinking_delta' ? 'thinking' : 'text' });
        if (!block) return;
        block.text = ((block.text ?? '') + piece).slice(0, TEXT_CAP);
        s.buffer.update(block);
        return;
      }
      case 'content_block_stop':
        this.stopStreaming(s, s.assembling.get(index));
        return;
      case 'message_stop':
        // Tokens have stopped. The assembly map has NOT expired: the
        // `assistant` message still has to find these blocks. See the header.
        this.closeStreaming(s);
        return;
      default:
        return;
    }
  }

  /** An `assistant` or `user` message: the authoritative version of a turn. */
  private onMessage(sessionId: string, msg: Record<string, unknown>): void {
    // See `onStreamEvent`: sidechain rendering is E18-13, and until it lands a
    // subagent's messages must not be mistaken for the session's own.
    if (msg.parent_tool_use_id != null) return;
    const s = this.ensure(sessionId);
    // The stream carries no timestamp of its own, and the Feed shows one (and
    // times thinking blocks by it). Ours is honest to the millisecond for a
    // message we have just received — more than a transcript's is.
    const entry = { ...msg, timestamp: new Date().toISOString() };
    const isAssistant = msg.type === 'assistant';
    for (const intent of deriveIntents(entry)) {
      if (intent.t === 'tool-result') {
        s.buffer.attachResult(intent.toolUseId, intent.out);
        continue;
      }
      // Only an assistant message can complete streamed deltas; a replayed
      // `user` message shares the index space with nothing.
      const candidate =
        isAssistant && intent.index !== undefined ? s.assembling.get(intent.index) : undefined;
      const streamed = candidate && supersedes(candidate, intent.block.kind) ? candidate : undefined;
      const block = streamed
        ? // ALWAYS emitted, never conditionally: by now the block is usually
          // already `streaming: false` (content_block_stop got there first), and
          // an emit gated on that would leave the renderer showing the last
          // delta for ever while the main process held the finished text.
          s.buffer.replace(streamed, {
            ...intent.block,
            // keep the block's own start time — it is when the reply BEGAN, and
            // a thinking block's duration is measured from it
            ts: streamed.ts ?? intent.block.ts,
            streaming: false,
          })
        : s.buffer.push({ ...intent.block, streaming: false }, false);
      // Drop the reconciled index. `replace` hands back a NEW object, so an
      // entry left pointing at the old one would be re-emitted by the
      // end-of-message sweep below — overwriting the finished block in the
      // renderer with the empty shell the deltas started from.
      if (streamed) s.assembling.delete(intent.index as number);
      if (intent.toolUseId) s.buffer.remember(intent.toolUseId, block);
    }
    // The message is complete: every block it named is final, and anything the
    // deltas opened that it did NOT name was never going to be completed.
    if (isAssistant) this.endMessage(s);
  }

  /**
   * Close every block still taking tokens.
   *
   * Called on `result` — the ordinary end of a turn — and, the case the
   * done-when names, when a session EXITS without ever sending one. After it,
   * no block in this session claims to be streaming, and the next turn's deltas
   * start a fresh one.
   *
   * It does NOT expire the assembly map. A `result` can arrive before the
   * `assistant` message (an interrupted turn is the measured case, #154), and
   * forgetting the map there would make that message append a second copy of a
   * reply that is already on screen.
   */
  finalize(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) this.closeStreaming(s);
  }

  /** Tokens have stopped arriving, for every block of the current message. */
  private closeStreaming(s: StreamedSession): void {
    for (const b of s.assembling.values()) this.stopStreaming(s, b);
  }

  /** The current message is over: close it AND forget which blocks were its. */
  private endMessage(s: StreamedSession): void {
    this.closeStreaming(s);
    s.assembling.clear();
  }

  private stopStreaming(s: StreamedSession, block: FeedBlock | undefined): void {
    if (!block || block.streaming !== true) return;
    block.streaming = false;
    s.buffer.update(block);
  }

  /** The block at this index IF it is still taking tokens. */
  private streamingAt(s: StreamedSession, index: number): FeedBlock | undefined {
    const b = s.assembling.get(index);
    return b?.streaming === true ? b : undefined;
  }

  /**
   * Start a block for one content index.
   *
   * The `content_block` the CLI sends carries the block's type and, for a tool
   * call, its `name` — whole, not as partial JSON. Opening a tool row here is
   * what keeps a message's blocks in the ORDER the model produced them: a
   * streamed block takes its seq when it opens, so a `[tool_use, text]` message
   * that opened only the text would render the two the wrong way round. The row
   * is a shell — name only — until the `assistant` message fills in its input.
   *
   * Returns undefined for a content type we cannot render at all, rather than
   * inventing a block for it.
   */
  private open(
    s: StreamedSession,
    index: number,
    cb: Record<string, unknown> | undefined
  ): FeedBlock | undefined {
    // Never reuse a block that has stopped: a turn that ended without an
    // `assistant` message leaves its entry in the map (see `finalize`), and
    // appending the next turn's tokens to it would grow one endless bubble.
    const streaming = this.streamingAt(s, index);
    if (streaming) return streaming;
    const type = typeof cb?.type === 'string' ? cb.type : 'text';
    let seed: Omit<FeedBlock, 'seq' | 'sidechain'>;
    if (type === 'text' || type === 'thinking') {
      seed = { kind: type === 'thinking' ? 'thinking' : 'assistant', text: '' };
    } else if (type === 'tool_use' && typeof cb?.name === 'string') {
      seed = { kind: 'tool', tool: { name: cb.name, category: toolCategory(cb.name), summary: '' } };
    } else {
      return undefined;
    }
    const block = s.buffer.push({ ...seed, ts: new Date().toISOString(), streaming: true }, false);
    s.assembling.set(index, block);
    return block;
  }

  private ensure(sessionId: string): StreamedSession {
    const found = this.sessions.get(sessionId);
    if (found) return found;
    const created: StreamedSession = {
      buffer: new FeedBuffer((b) => this.emitBlock(sessionId, b)),
      assembling: new Map(),
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private emitBlock(sessionId: string, block: FeedBlock): void {
    for (const l of this.blockListeners) {
      try {
        l(sessionId, block);
      } catch (err) {
        // a broken subscriber must never take the feed down (P6)
        this.log?.error('block listener threw', { sessionId, error: String(err) });
      }
    }
  }

  /** Backlog for a panel that is mounting, or re-mounting. */
  blocks(sessionId: string): FeedBlock[] {
    return this.sessions.get(sessionId)?.buffer.list() ?? [];
  }

  /** Is any block still claiming to take tokens? (#140's "never open for ever".) */
  hasOpenBlocks(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    for (const b of s.assembling.values()) if (b.streaming === true) return true;
    return false;
  }

  onBlock(l: (sessionId: string, b: FeedBlock) => void): () => void {
    this.blockListeners.add(l);
    return () => this.blockListeners.delete(l);
  }

  onReset(l: (sessionId: string, cause?: 'clear') => void): () => void {
    this.resetListeners.add(l);
    return () => this.resetListeners.delete(l);
  }

  /** The session is gone; so are its blocks. */
  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
