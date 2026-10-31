// The Feed, fed by the session's NEUTRAL events (P2-E18-10; neutral since E40
// item 03, #1286).
//
// IT READS NO PROVIDER'S FRAMES. Claude's stream-json is translated into
// `sessions/engine-events.ts` by `providers/claude-events.ts`, behind the
// adapter, and this class sees only the result: chunks opening, growing and
// closing at an index; a tool call opening by name; the authoritative message
// that supersedes them; the turn's end; the conversation's identity and its
// reset. The header below still describes the CLAUDE frames, because they are
// the measured case the assembly rule was built for — read "deltas" as
// `chunk` events and "the `assistant` message" as a `message` event.
//
// Same blocks, better source. In PTY mode the Feed is built by tailing the
// JSONL transcript — a file poll, so text arrives in bursts a poll apart and
// nothing renders until the CLI has flushed a whole message. In stream mode the
// CLI hands us the same content as it produces it, and `--include-partial-messages`
// turns that into `stream_event` token deltas.
//
// What this class does NOT do is decide what a block IS. That is the engine's:
// a `message` event and a replayed `ReplayEntry` both carry a `derive`, and
// for Claude both run the one derivation in `providers/claude-transcript.ts`,
// shared with the watcher, so the sources cannot drift apart. Nor does it read
// any engine's HISTORY format (#1303): `hydrate` and `absorbSidechain` take
// entries the provider has already read.
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
import { errorText } from '../../shared/error-text';
import { Logger } from '../log/logger';
import { toolCategory } from '../../shared/tool-taxonomy';
import {
  BlockIntent,
  DerivationContext,
  DerivedBlock,
  DISPLAY_CAPS,
  FeedBlock,
  HydrateOptions,
  ReplayEntry,
  TEXT_CAP,
} from './blocks';
import { compactionMark } from '../../shared/compaction';
import type {
  ChunkKind,
  CompactionEvent,
  ConversationEvent,
  ConversationResetEvent,
  EngineEvent,
  MessageEvent,
} from '../sessions/engine-events';
import type { ContextRefs } from './context-refs';
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
  /**
   * The conversation we have already thrown away, so we cannot throw it away
   * twice (#748).
   *
   * A SEPARATE FIELD from `conversationId`, and the review that asked for it
   * showed why the obvious alternative is wrong. Suppressing on "we know a
   * different id" fails in both directions, and in the case this item exists
   * for: on a turn-less session `conversationId` is `undefined`, so a duplicate
   * reset passes and wipes twice; and if an init ever arrived FIRST, the
   * following reset would name an id we no longer hold and be dropped —
   * zero wipes, which is #748 restored in the one ordering the guard was
   * written for. "Have I already discarded THIS conversation" is the question,
   * and it is a different question from "which conversation am I in".
   */
  discarded?: string;
  /**
   * When this session's history was replayed, in epoch ms (#1140). Set by
   * `hydrate` and only when its caller replayed the subagent transcripts too.
   *
   * A subagent line stamped at or before this instant is BACKLOG: the replay
   * either placed it where it happened or left it out on purpose (older than
   * the window, over the read budget). `absorbSidechain` refuses it, because
   * the watcher reads those same files from byte 0 and would otherwise append
   * every one of them after the newest message of the conversation.
   */
  sidechainBacklogBefore?: number;
  /** the one log line about the above has been written */
  backlogDropLogged?: boolean;
  /** the one log line about a history entry whose `derive` threw (#1303) */
  deriveFailLogged?: boolean;
  /** a divider waiting for the first `conversation` event (#1294, `placeMarker`) */
  pendingMarker?: DerivedBlock;
  /**
   * The delivery ids this buffer has already drawn (#680): every
   * `ReplayEntry.echoId` `hydrate` replayed and every
   * `MessageEvent.echoId` `onMessage` derived. A live echo naming one of
   * them is the same delivery again and draws nothing. Emptied with the buffer
   * (`wipe`), so it never outlives the blocks it speaks for.
   */
  deliveries: Set<string>;
  /** the one log line about a repeated delivery (#680) */
  repeatLogged?: boolean;
}

export class StreamFeed {
  private readonly sessions = new Map<string, StreamedSession>();
  private readonly blockListeners = new Set<(sessionId: string, b: FeedBlock) => void>();
  private readonly resetListeners = new Set<(sessionId: string, cause?: 'clear') => void>();

  /**
   * Both optional so a test can construct one bare; the app always passes them.
   *
   * `refs` is #830's forgery guard (`feed/context-refs.ts`). Without it, a user
   * turn carrying injected context derives exactly as it did before — one block,
   * full text, nothing folded — which is the fail-closed direction and the
   * reason it can be absent at all.
   */
  constructor(
    private readonly log?: Logger,
    private readonly refs?: ContextRefs
  ) {}

  /** What a derivation needs to know about this session, or nothing. */
  private ctx(sessionId: string): DerivationContext {
    return this.refs === undefined ? {} : { isMintedRef: this.refs.guardFor(sessionId) };
  }

  /**
   * Seed a RESUMED session's Feed with the conversation that already happened
   * (#395) — the backlog, before a single byte of the live stream arrives.
   *
   * WHY THIS EXISTS. `--resume <id>` restores the model's context and re-sends
   * none of it: the CLI's stream starts at the next turn. A Terminal session
   * gets its history back twice over (the PTY repaint, and the transcript
   * watcher adopting the pre-existing JSONL), and a Direct session got it
   * neither way — the watcher does not derive a stream session's main
   * transcript, precisely so the two sources cannot interleave. The result was a resumed card that looked wiped,
   * which is how Dan read it after 0.3.0.
   *
   * WHY IT IS THE STREAM FEED'S JOB and not the watcher's. The interleaving
   * hazard is about the LIVE TAIL, not the backlog — but two buffers feeding one
   * renderer is more than a rendering-order problem: both number their blocks
   * from seq 1, and the renderer upserts on seq (`lib/feed.ts`), so the first
   * streamed block would OVERWRITE the first replayed one. Hydrating THIS
   * buffer keeps one seq space, one backlog for `transcripts:blocks` to serve,
   * and one reset to route — nothing downstream has to learn that a session's
   * Feed can have two sources at once.
   *
   * THE SEAM is the file's contents at this instant. The caller runs it inside
   * `sessions:create`, in the same synchronous stretch as the spawn, so no
   * stream message has been offered yet and nothing else can be appended in
   * between (the CLI writes nothing until its first turn — the S-07
   * measurement). Everything on disk lands below seq N; everything the stream
   * says lands above it.
   *
   * AND THE TWO CANNOT DRAW THE SAME PROMPT (#680). A Direct prompt reaches the
   * Feed only as Claude's `--replay-user-messages` echo, so the question is
   * whether a resumed CLI echoes the history this method just drew. It does
   * not: every site in the PATH binary (2.1.312) that builds an `isReplay`
   * frame is about a message the running process RECEIVED, and none replays a
   * `--resume`d transcript to stdout (the list is on `echoIdOf`,
   * `providers/claude-events.ts`). So the seam above is the whole of the
   * ordering argument: history first, then only what this process is sent.
   * Each replayed line's delivery id is remembered all the same, so if that
   * ever changes, an echo of a message already on screen still draws nothing
   * (`onMessage`). Pinned in `stream-feed.test.ts`.
   *
   * IT DOES NOT TOUCH `conversationId`. That field means "the conversation the
   * CLI last claimed", and it is how `/clear` is detected. Seeding it with the
   * resumed id would make a CLI that answers `--resume` with a forked id look
   * like a `/clear` on the very first turn — and the reset would wipe the
   * history this method just replayed.
   *
   * Returns the number of blocks replayed. Refuses a buffer that already holds
   * blocks: hydration is a start-of-session act, and a second one would append
   * the past onto the present.
   */
  hydrate(
    sessionId: string,
    entries: readonly ReplayEntry[],
    opts: HydrateOptions = {}
  ): number {
    const s = this.ensure(sessionId);
    if (s.buffer.size > 0) {
      this.log?.warn('refusing to replay history into a Feed that already has blocks', {
        sessionId,
      });
      return 0;
    }
    // Only once the replay is going ahead: a refused one replayed nothing, so
    // it has no backlog to speak for.
    if (opts.sidechainBacklogBefore !== undefined) {
      s.sidechainBacklogBefore = opts.sidechainBacklogBefore;
    }
    let n = 0;
    // Markers (#1294) in time order, each placed before the first entry stamped
    // after it. An entry with no readable stamp places nothing: it cannot be
    // after anything.
    const markers = [...(opts.markers ?? [])].sort((a, b) => a.at - b.at);
    let nextMarker = 0;
    const placeMarkersBefore = (at: number): void => {
      while (nextMarker < markers.length && markers[nextMarker].at < at) {
        s.buffer.push(markers[nextMarker++].block, { sidechain: false });
        n++;
      }
    };
    // SILENTLY: the caller runs inside `sessions:create`, whose own response is
    // what tells the renderer this session's live id — so every push here would
    // be sent to a panel that cannot yet be subscribed to it, and dropped on
    // arrival. The panel reads the backlog when it mounts. See `FeedBuffer`.
    s.buffer.silently(() => {
      for (const e of entries) {
        // A compaction's summary is no block (#1026) but is kept beside the
        // divider the line before it drew, so a resumed card can still open it
        // (#1374). FIRST, before any marker is placed: a marker pushed between
        // the two would break the pairing.
        if (e.compactionSummary !== undefined) {
          s.buffer.attachCompactionSummary(e.compactionSummary, e.origin);
          continue;
        }
        // Remembered whatever it derives to, as `onMessage` does: the same
        // message again derives to the same thing. (A superset of what the live
        // side keeps: see `readClaudeTranscriptEntry`.)
        if (e.echoId !== undefined) s.deliveries.add(e.echoId);
        if (e.at !== undefined) placeMarkersBefore(e.at);
        // The SAME derivation the live stream's messages run (for Claude,
        // `providers/claude-transcript.ts`), so a replayed turn cannot look
        // different from the one that streamed live.
        //
        // The entries are the main conversation AND its subagent transcripts,
        // already merged into the order they happened (#1140, `history.ts`).
        // Between #977 and #1140 the subagent half was left to the watcher,
        // which adopts those files on a resumed card and drained them in AFTER
        // this replay — under the newest message. See `absorbSidechain`.
        //
        // The ORIGIN is the entry's: a subagent FILE's line arrives with it
        // already worked out (#1140) — `history.ts` reads those files and is
        // the only one that knows which entry came out of which — and a main
        // line with what its provider read off it.
        const intents = this.deriveOrSkip(s, sessionId, e);
        for (const intent of intents) {
          if (intent.t === 'tool-result') {
            s.buffer.attachResult(intent.toolUseId, intent.out, intent.failed === true, intent.pictures);
            continue;
          }
          const block = s.buffer.push(intent.block, e.origin, intent.pictures);
          if (intent.toolUseId) s.buffer.remember(intent.toolUseId, block);
          n++;
        }
      }
      // whatever happened after the last entry — a switch back with no turn
      // since lands at the bottom, which is where it happened
      placeMarkersBefore(Infinity);
    });
    return n;
  }

  /**
   * Put one block in this session's Feed that no transcript or stream will
   * send — the AI-switch divider (#1294).
   *
   * `now`: at once, SILENTLY, for the reason `hydrate` is silent — the caller is
   * inside `sessions:create` and no panel can be subscribed to this session yet;
   * it reads the backlog when it mounts. A fresh conversation's divider goes at
   * the top, which is where it is placed this way.
   *
   * `after-conversation`: when the engine first names its conversation. An ACP
   * agent replays a loaded conversation as `session/update`s BEFORE it answers
   * `session/load`, and the answer is the `conversation` event — so this lands
   * below the replayed history, where a switch BACK happened. Not silent: by
   * then the panel is listening. Dropped if the session ends first.
   */
  placeMarker(sessionId: string, block: DerivedBlock, when: 'now' | 'after-conversation'): void {
    const s = this.ensure(sessionId);
    if (when === 'after-conversation' && s.conversationId === undefined) {
      s.pendingMarker = block;
      return;
    }
    if (when === 'now') s.buffer.silently(() => s.buffer.push(block, { sidechain: false }));
    else s.buffer.push(block, { sidechain: false });
  }

  /**
   * Re-draw a divider `placeMarker` (or `hydrate`) already placed, from a newer
   * copy of its mark (#1295): the first start after a switch decides what the
   * arrival WAS — briefed, resumed, started without context — only after the
   * divider is down. Found by the mark's id; replaced in place, so it keeps its
   * seq and its position, and emitted so a listening panel updates. A divider
   * still waiting for its conversation is updated where it waits. One that is
   * nowhere (the session ended, a reset wiped it) is left alone.
   */
  updateMarker(sessionId: string, block: DerivedBlock): void {
    const id = block.aiSwitch?.id;
    const s = this.sessions.get(sessionId);
    if (!id || !s) return;
    if (s.pendingMarker?.aiSwitch?.id === id) {
      s.pendingMarker = block;
      return;
    }
    const placed = s.buffer.list().find((b) => b.kind === 'ai-switch' && b.aiSwitch?.id === id);
    if (placed) s.buffer.replace(placed, block);
  }

  /**
   * Take ONE subagent line from the transcript watcher (#977), already read by
   * the session's provider into a `ReplayEntry` whose origin names the agent
   * file it came out of (#1303).
   *
   * ⚠️ THIS EXISTS SO THERE IS STILL ONE BUFFER PER SESSION, which is the whole
   * of `hydrate`'s argument one method up: two buffers feeding one renderer both
   * number from seq 1 and the renderer upserts on seq, so a second source does
   * not interleave — it OVERWRITES. #977's first draft had the watcher push into
   * its own buffer and re-learned that the hard way (the first subagent block
   * replaced the session's first block, survivors sorted to the top, and none of
   * them reached `transcripts:blocks`, so they vanished on remount).
   *
   * Pushing HERE gets three things for free, and they are the same three
   * `hydrate` lists: one seq space, one backlog for `transcripts:blocks` to
   * serve — which is what makes a subagent run survive a remount and a resumed
   * card see one at all — and one reset to route.
   *
   * WHY THE WATCHER AND NOT THE STREAM. The CLI does not send this content on
   * the stream: `--forward-subagent-text` gates it and we do not pass it.
   * Measured on 2.1.280 — without the flag exactly ONE sidechain frame arrives,
   * the subagent's seeding prompt, and nothing it says. The files carry all of
   * it, with `agentId` and `attributionAgent`, and the watcher was already
   * tailing them (`spike/findings/e18-977-stream-sidechains.md`).
   *
   * NOT `silently`: these are live blocks for a session the renderer is
   * subscribed to, which is the opposite of `hydrate`'s case.
   *
   * Returns false when this session has no stream Feed, so the caller can drop
   * the line rather than misfile it.
   */
  absorbSidechain(sessionId: string, entry: ReplayEntry): boolean {
    const s = this.sessions.get(sessionId);
    // NOT `ensure`: a session this Feed has never heard of is not one whose
    // subagent output anybody is waiting for, and creating state for it here
    // would leak an entry per stray line.
    if (!s) return false;
    // ⚠️ BACKLOG IS NOT LIVE (#1140). On a resumed card the watcher binds the
    // conversation and drains every subagent file it ever wrote from byte 0 —
    // rightly, the usage totals are in there. Pushed here, all of it lands
    // ABOVE the replayed history in seq, i.e. BELOW the newest message on
    // screen: the conversation ends on a subagent's old work and the last
    // reply is somewhere up the page. That is how a session came back from an
    // update looking as if it had "gone back".
    //
    // The replay has already put those lines where they happened, so anything
    // written before it ran is taken and dropped. TRUE, not false: the line was
    // accounted for, and the caller must not treat it as homeless.
    //
    // A line with no readable timestamp is let through, which is what happened
    // to every line before this check existed.
    if (s.sidechainBacklogBefore !== undefined && entry.at !== undefined) {
      if (entry.at <= s.sidechainBacklogBefore) {
        // Said ONCE per session, so a report that subagent history went
        // missing after a restart has a line to find.
        if (!s.backlogDropLogged) {
          s.backlogDropLogged = true;
          this.log?.info('subagent backlog left to the replay, not appended', { sessionId });
        }
        return true;
      }
    }
    // a subagent's own compaction summary, beside ITS divider (#1374), as
    // `hydrate` does for the same line after a restart
    if (entry.compactionSummary !== undefined) {
      s.buffer.attachCompactionSummary(entry.compactionSummary, entry.origin);
      return true;
    }
    for (const intent of this.deriveOrSkip(s, sessionId, entry)) {
      if (intent.t === 'tool-result') {
        s.buffer.attachResult(intent.toolUseId, intent.out, intent.failed === true, intent.pictures);
        continue;
      }
      const block = s.buffer.push(intent.block, entry.origin, intent.pictures);
      if (intent.toolUseId) s.buffer.remember(intent.toolUseId, block);
    }
    return true;
  }

  /**
   * One history entry's intents, or none. `derive` is the provider's code, as
   * `MessageEvent.derive` is on the live path, and a throw costs that entry —
   * never the replay, never the session's Feed (P6). Claude's derivation is
   * tolerant by construction and does not throw.
   *
   * Logged ONCE per session: a reader broken for one line is usually broken
   * for all of them, and a replay is up to `HISTORY_MAX_LINES` lines.
   */
  private deriveOrSkip(s: StreamedSession, sessionId: string, entry: ReplayEntry): BlockIntent[] {
    try {
      return entry.derive(DISPLAY_CAPS, this.ctx(sessionId));
    } catch (err) {
      if (!s.deriveFailLogged) {
        s.deriveFailLogged = true;
        this.log?.error('history entry derivation threw: entry skipped', {
          sessionId,
          error: errorText(err),
        });
      }
      return [];
    }
  }

  /**
   * Feed one NEUTRAL event from one stream session (#1286). What each Claude
   * frame becomes is `providers/claude-events.ts`'s decision; the cases below
   * are what each event means for the Feed.
   */
  ingest(sessionId: string, ev: EngineEvent): void {
    switch (ev.type) {
      case 'message-start':
        // A new message supersedes whatever the last one left behind — it may
        // have ended without its authoritative message, or without a turn end.
        this.endMessage(this.ensure(sessionId));
        return;
      case 'chunk-open':
        this.open(this.ensure(sessionId), ev.index, ev.kind);
        return;
      case 'tool-call-start':
        this.openTool(this.ensure(sessionId), ev.index, ev.name, ev.toolCallId);
        return;
      case 'chunk':
        this.onChunk(this.ensure(sessionId), ev.index, ev.kind, ev.text);
        return;
      case 'chunk-close': {
        const s = this.ensure(sessionId);
        this.stopStreaming(s, s.assembling.get(ev.index));
        return;
      }
      case 'message-end':
        // Tokens have stopped. The assembly map has NOT expired: the
        // authoritative message still has to find these blocks. See the header.
        this.closeStreaming(this.ensure(sessionId));
        return;
      case 'message':
        return this.onMessage(sessionId, ev);
      case 'turn-end':
        // The turn is over — nothing more will arrive for whatever it left
        // open. This is the ordinary way a turn ends; `finalize` is also called
        // when the session exits, which is the way it is not.
        return this.finalize(sessionId);
      case 'conversation':
        return this.onConversation(sessionId, ev);
      case 'conversation-reset':
        // The engine saying, in as many words, that it threw the conversation
        // away. #748: Claude's frame for this used to fall through the
        // `default` of this switch and be dropped — in a switch whose stated
        // purpose is that a new message type is a DECISION rather than a
        // silent no-op. It was a silent no-op, and it cost a user-visible bug.
        return this.onConversationReset(sessionId, ev);
      case 'compaction':
        return this.onCompaction(sessionId, ev);
      // Not content: status, the control-path notices (#1287) and usage are
      // other consumers'. Listed rather than defaulted so a NEW event type is
      // somebody's decision rather than a silent no-op.
      case 'activity':
      case 'permission-request':
      case 'permission-withdrawn':
      case 'background-work':
      case 'commands':
      case 'model':
      case 'mode':
      case 'settings':
      case 'usage':
        return;
      default: {
        // COMPILE-TIME: a new `EngineEvent` type fails `tsc` here until
        // somebody decides what it means for the Feed. At run time it is
        // ignored, which is the fail-open direction.
        const unhandled: never = ev;
        return unhandled;
      }
    }
  }

  /**
   * The engine compacted the conversation (#1259): a divider at this point, the
   * way a `/clear` gets one. Everything above it is, to the model, now only a
   * summary — which a reader scrolling back could not otherwise tell.
   *
   * FROM THE ENGINE'S FRAME ONLY (Claude's `system:compact_boundary`), never
   * inferred: the CLI decides when to compact, and this draws what it said.
   * NOTHING IS WIPED — unlike a reset, the history above stays on screen, and
   * the summary that follows on the wire is dropped by the derivation (#1026),
   * so it never becomes a prompt. Counts the engine did not send are left off
   * the mark, and the divider still draws (fail-open).
   *
   * After a restart the same divider comes from the transcript's
   * `compact_boundary` line, through `hydrate` and the same derivation every
   * transcript reader runs; this is the live half only.
   */
  private onCompaction(sessionId: string, ev: CompactionEvent): void {
    const s = this.ensure(sessionId);
    s.buffer.push(
      {
        kind: 'compaction',
        compaction: compactionMark(ev.trigger, ev.preTokens, ev.postTokens),
        ts: new Date().toISOString(),
      },
      { sidechain: false }
    );
  }

  /**
   * `conversation_reset` — the CLI saying the conversation was thrown away
   * (#748). **This is the primary trigger**; the init comparison below is the
   * belt-and-braces.
   *
   * ── WHY THIS EXISTS, AND WHY THE INIT COMPARISON COULD NOT DO THE JOB ──────
   *
   * The comparison infers a clear from an id CHANGING, and it cannot fire until
   * it has an id to change FROM. Measured (#748 probe 2): **nothing announces a
   * conversation id at spawn — zero inits until the first TURN.** So on a
   * session that has not replied yet, `/clear` lands on
   * `conversationId === undefined`, which sets the id and returns. Nothing is
   * wiped. The user's SECOND `/clear` finally has something to differ from, and
   * that is the whole of the reported "the second time I do it, it clears".
   *
   * Resumed cards fail EVERY time for the same reason from the other end:
   * `hydrate()` deliberately never sets `conversationId` (its comment has the
   * good reason — seeding it would make a forked `--resume` id look like a
   * clear and wipe the history it just replayed), so a card showing a screenful
   * of replayed history is guaranteed to swallow its first `/clear`.
   *
   * This message needs none of that. It is unconditional, it is what the CLI
   * MEANS rather than something inferred, and it arrives first — measured at
   * 12-16 ms BEFORE the init, including on a session that has never run a turn
   * (probe 4, which is the case that matters).
   *
   * ── WHAT ELSE EMITS THIS, because it is NOT `/clear`-only ─────────────────
   *
   * The CLI's own zod schema, read out of the PATH binary (2.1.245) per the
   * standing rule, describes the frame as:
   *
   *     "Emitted by /clear, plan-mode exit, and fresh-session flows. The
   *      surface should mount a fresh transcript under new_conversation_id and
   *      reset any cached session title."
   *
   * Wiping the Feed IS mounting a fresh transcript, so following that contract
   * is right for every emitter. But we draw "Conversation cleared" when we do
   * it, so the other two clauses were measured rather than assumed (probe 5):
   *
   * * **A `--resume` spawn, saying nothing for 12 s: ZERO frames.** This was
   *   the dangerous one — `hydrate()` has just replayed a screenful of history
   *   that its own comment explains must never be wiped, and a reset at spawn
   *   would delete exactly that. It does not happen.
   * * **Plan-mode exit (`ExitPlanMode` approved over the control channel):
   *   ZERO frames, and the `session_id` does not rotate.** So no mid-work wipe,
   *   and nothing for the init backstop to fire on either.
   *
   * Caveat worth keeping: one build, one machine, and "fresh-session flows" is
   * the CLI's phrase for something we have not identified — plausibly an SDK
   * entry point this app never drives. If a wipe ever appears out of nowhere,
   * this is the first place to look.
   *
   * DRIVEN END TO END SINCE #752, which taught the fake `/clear` so its
   * conversation id actually rotates: `e2e/stream-feed.spec.ts` → "Clear
   * conversation on a Direct session". Worth knowing which test covers which
   * branch, because they are not interchangeable — on a stream session the
   * transcript watcher's own reset is gated off (`sessions/ipc.ts`, `isStream`),
   * so this file is the ONLY source of the cleared marker there:
   *
   * * the RESUMED-card test can only be satisfied by `onConversationReset` —
   *   no turn has run, so the backstop has no id to compare against. It is
   *   verified RED against the pre-#748 code;
   * * the ordinary test runs a turn first, so it goes through the backstop
   *   below and passed before #748 as well. It guards the ⋯ → send route and
   *   that the session keeps working in the new conversation.
   *
   * ── `new_conversation_id`: NOT ADOPTED, and correct either way ─────────────
   *
   * The frame carries `session_id` (the conversation being discarded) and
   * `new_conversation_id`. Adopting the latter is the obvious way to stop the
   * init 14 ms later from wiping a second time.
   *
   * TWO READINGS DISAGREE, so this does not depend on either. The CLI's own
   * description says to mount under `new_conversation_id` — but one measured
   * exchange (probe 4) had it match neither side:
   *
   *     reset.session_id          4d6adc68…   the old conversation
   *     reset.new_conversation_id a78738c8…
   *     init.session_id           b21fb84e…   what actually followed
   *
   * That is a single observation against a documented contract, which is the
   * shape of a measurement with a confound in it — so it is recorded, not
   * relied on. Blanking is chosen because it is right under BOTH readings: if
   * the ids agree, the init matches `undefined` and sets it; if they do not,
   * the init still matches `undefined` and sets it. Adopting would be right
   * under only one of them.
   *
   * ── THE SECOND CONSUMER ────────────────────────────────────────────────────
   *
   * `sessions/session-manager.ts`'s stream pump applies the SAME RULING —
   * trust the frame, keep the id comparison as a backstop — to a different
   * question: not "wipe the view" but "tag the watcher's rebind `'clear'`"
   * (#753). Its bookkeeping differs because the questions do: a repeat frame
   * must not wipe twice, hence `discarded` here, whereas setting a boolean
   * latch twice needs no guard. A third consumer should re-use this ruling
   * rather than re-derive it a third time.
   */
  private onConversationReset(sessionId: string, ev: ConversationResetEvent): void {
    const gone = ev.discarded;
    const s = this.ensure(sessionId);
    // ALREADY THROWN THIS ONE AWAY. The question is about the conversation the
    // frame NAMES, not about which one we think we are in — see `discarded`,
    // which is the whole reason that is a separate field.
    if (gone !== undefined && s.discarded === gone) return;
    s.discarded = gone;
    // BLANKED, not adopted — see the header. The next init sets it.
    s.conversationId = undefined;
    this.wipe(sessionId, s, 'the CLI reset the conversation');
  }

  /**
   * The engine naming the conversation this turn runs in — for Claude, the
   * `system:init` frame, which is what the rest of this note is about.
   *
   * `system:init` arrives ONCE PER TURN (S-11 measured 26 for 25 turns), so it
   * must never be read as "the session started" — the fact every item in this
   * epic has to respect. What it CAN tell us is that the conversation was
   * REPLACED: `/clear` mints a fresh id, and the extension bundle keys its own
   * "wipe the view" on exactly this comparison. Guarded on having seen a
   * previous id, so a session's first init never resets anything.
   *
   * **Since #748 this is the BACKSTOP, not the primary trigger.** It is kept
   * rather than replaced so a CLI that stops emitting `conversation_reset` —
   * an older build, a future one — degrades to the behaviour we had, which is
   * wrong only for the first clear, instead of to no wipe at all.
   *
   * In the normal case it now fires against `conversationId === undefined`,
   * because the reset 12 ms earlier blanked it: this sets the id and returns,
   * and the wipe happens exactly once. `/compact` also lands here, and is
   * inert for the reason it always was — measured (#748 probe 3), it emits an
   * init carrying the SAME session_id, and no `conversation_reset` at all.
   */
  private onConversation(sessionId: string, ev: ConversationEvent): void {
    // never empty: the translator drops an init that names no conversation
    const id = ev.id;
    const s = this.ensure(sessionId);
    if (s.conversationId === undefined || s.conversationId === id) {
      s.conversationId = id;
      // the divider that waited for the loaded history to land (#1294)
      const pending = s.pendingMarker;
      if (pending) {
        s.pendingMarker = undefined;
        s.buffer.push(pending, { sidechain: false });
      }
      return;
    }
    // Recorded for the same reason the reset path records it: if a
    // `conversation_reset` naming this conversation arrives afterwards — the
    // ordering we have never measured — it must not wipe the fresh one on top.
    s.discarded = s.conversationId;
    s.conversationId = id;
    this.wipe(sessionId, s, 'the CLI started a new conversation');
  }

  /**
   * Throw the view away and tell everyone once.
   *
   * ONE PATH FOR BOTH TRIGGERS, which is what makes the ticket's idempotency
   * requirement structural: the "conversation cleared" divider (E10-07) is
   * drawn by these listeners, so two routes to the wipe must not become two
   * routes to two dividers. Callers own the `conversationId` bookkeeping that
   * decides whether a wipe happens at all; this only performs it.
   */
  private wipe(sessionId: string, s: StreamedSession, why: string): void {
    s.buffer.reset();
    s.assembling.clear();
    s.deliveries.clear();
    this.log?.info('stream feed reset', { sessionId, why });
    for (const l of this.resetListeners) {
      try {
        l(sessionId, 'clear');
      } catch (err) {
        this.log?.error('feed reset listener threw', { sessionId, error: errorText(err) });
      }
    }
  }

  /**
   * One chunk of prose for the block at `index`.
   *
   * Opened lazily when needed: an opening event is the engine's to send and we
   * do not get to require it. A chunk with no block is still text the user
   * should see. (A subagent's chunks never arrive: the translator drops them,
   * #977 — see `providers/claude-events.ts`.)
   */
  private onChunk(s: StreamedSession, index: number, kind: ChunkKind, piece: string): void {
    if (piece === '') return;
    const block = this.streamingAt(s, index) ?? this.open(s, index, kind);
    block.text = ((block.text ?? '') + piece).slice(0, TEXT_CAP);
    // NOT `update`: this runs once per token, and an immediate re-emit of
    // the whole block per token is what #1013 measured. See
    // `STREAM_COALESCE_MS`.
    s.buffer.updateSoon(block);
  }

  /**
   * The authoritative version of a message.
   *
   * A sidechain (subagent) message never arrives: its content comes from the
   * subagent's transcript since #977 (`absorbSidechain`), and the translator
   * drops it on the stream so one `FeedBuffer` cannot receive the same text
   * from two sources.
   */
  private onMessage(sessionId: string, ev: MessageEvent): void {
    const s = this.ensure(sessionId);
    // ONE BLOCK PER DELIVERY (#680). A Direct prompt reaches the Feed only as
    // the engine's echo of it, and the engine can echo one delivery more than
    // once: Claude acknowledges a message it dropped as a duplicate with the
    // identical envelope. `echoId` is set only on a message the engine marked
    // as a replay; for a prompt it is the id the host minted for that one
    // send, so a match is the same send and never the same words sent again.
    // FIRST, ahead of the summary and the derive: a repeat contributes nothing
    // at all. (The summary can never be the frame dropped here: Claude sends
    // it `isReplay: false`, so it carries no id.) Why a resumed history and
    // its live echoes cannot meet here in the first place: `hydrate`.
    if (ev.echoId !== undefined) {
      if (s.deliveries.has(ev.echoId)) {
        if (!s.repeatLogged) {
          s.repeatLogged = true;
          this.log?.info('a delivery the Feed already drew was echoed again: not drawn twice', {
            sessionId,
            echoId: ev.echoId,
          });
        }
        return;
      }
      s.deliveries.add(ev.echoId);
    }
    const isAssistant = ev.role === 'assistant';
    // ⚠️ A MESSAGE NOTHING STREAMED MUST NOT CLAIM A STREAMED BLOCK (#978).
    // The full argument, and the two Claude markers it turns on, are on
    // `wasNeverStreamed` in `providers/claude-events.ts`. In one line:
    // `claim()`'s index-miss fallback takes ANY open block of a superseding
    // kind, which is right for a model's reply and wrong for a message no model
    // produced — it would replace text the user has already read.
    const unstreamed = isAssistant && ev.unstreamed;
    // The CLI's summary of what it just compacted (#1374): beside the divider
    // that came just before it, never a block of its own. Before the derive, as
    // `hydrate` and the watcher do it, so a block this message made could never
    // come between the two.
    if (ev.compactionSummary !== undefined) s.buffer.attachCompactionSummary(ev.compactionSummary);
    let intents: BlockIntent[];
    try {
      intents = ev.derive(DISPLAY_CAPS, this.ctx(sessionId));
    } catch (err) {
      // `derive` is the engine's code; a throw costs this message, never the
      // session's Feed (P6)
      this.log?.error('message derivation threw: message skipped', {
        sessionId,
        error: errorText(err),
      });
      return;
    }
    for (const intent of intents) {
      if (intent.t === 'tool-result') {
        s.buffer.attachResult(intent.toolUseId, intent.out, intent.failed === true, intent.pictures);
        continue;
      }
      // Only an assistant message can complete streamed deltas; a replayed
      // `user` message shares the index space with nothing, and an unstreamed
      // one completes nothing by construction (see above).
      const streamed =
        isAssistant && !unstreamed ? this.claim(s, intent.index, intent.block.kind) : undefined;
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
        : // `sidechain: false` — the translator never sends a sidechain
          // message, so nothing that reaches here is one (E18-13)
          s.buffer.push({ ...intent.block, streaming: false }, { sidechain: false }, intent.pictures);
      if (intent.toolUseId) s.buffer.remember(intent.toolUseId, block);
    }
    // Tokens are done for whatever this message named; anything still open is
    // either a block a LATER message in the same turn will claim (the real
    // CLI sends one message per content block — see `claim`) or an orphan.
    // Either way it is no longer filling in, and either way it must stay in
    // the map so a later message can still find it.
    //
    // `!unstreamed` for the same reason it guards the claim: this message is not
    // part of whatever turn it lands in, so it has no standing to say that
    // turn's tokens have stopped.
    //
    // ⚠️ AND IT IS NOT A GUARANTEE THAT NOTHING CLOSES — a claim an earlier
    // draft of this comment made and which is false. The measured local-command
    // turn ENDS IN ITS OWN `result` (`system:init -> assistant -> result`), and
    // that result reaches `finalize` milliseconds later and closes every open
    // block anyway. What this line buys is narrow and worth having on its own:
    // the close is not attributed to a message that had nothing to do with it,
    // so if the shape ever changes — a local command that does not end its own
    // turn — the behaviour follows from the frames rather than from this
    // function guessing.
    if (isAssistant && !unstreamed) this.closeStreaming(s);
  }

  /**
   * Find the streamed block this message content belongs to, and take it.
   *
   * INDEX FIRST, THEN KIND — and the fallback is not defensive padding, it is
   * the case the real CLI actually produces. MEASURED 2026-08-02 against the
   * PATH CLI with our exact argument list (`spike/s11/probe-140-slash-flags.cjs`),
   * on three separate turns:
   *
   *   message_start
   *   content_block_start(0, thinking) -> delta -> ASSISTANT -> content_block_stop(0)
   *   content_block_start(1, text)     -> delta -> ASSISTANT -> content_block_stop(1)
   *   message_delta -> message_stop -> result
   *
   * **One `assistant` message per CONTENT BLOCK, arriving mid-stream — before
   * its own `content_block_stop`, not after `message_stop`.** And each carries a
   * single-element `content` array, so EVERY one of them reports content index
   * 0 while the stream events that built it were addressed 0, 1, 2…
   *
   * A purely index-based match therefore lines up only for the first block and
   * appends a duplicate for every one after it. The fake did not show this
   * because it sends all deltas and then one whole message — the same
   * fake-is-kinder-than-reality blind spot as #153/#154/#139. The fake now
   * reproduces the real shape.
   *
   * Taking the block OUT of the map is what makes the fallback safe: within one
   * message each entry can be claimed once, and blocks are claimed in the order
   * they were opened, which is the order the messages arrive in.
   */
  private claim(
    s: StreamedSession,
    index: number | undefined,
    kind: FeedBlock['kind']
  ): FeedBlock | undefined {
    const exact = index !== undefined ? s.assembling.get(index) : undefined;
    if (exact && supersedes(exact, kind)) {
      s.assembling.delete(index as number);
      return exact;
    }
    for (const [at, block] of s.assembling) {
      if (!supersedes(block, kind)) continue;
      s.assembling.delete(at);
      return block;
    }
    return undefined;
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
   * Start a prose block (text or thinking) for one content index.
   *
   * Never reuses a block that has stopped: a turn that ended without its
   * authoritative message leaves its entry in the map (see `finalize`), and
   * appending the next turn's tokens to it would grow one endless bubble.
   */
  private open(s: StreamedSession, index: number, kind: ChunkKind): FeedBlock {
    return (
      this.streamingAt(s, index) ??
      this.start(s, index, { kind: kind === 'thinking' ? 'thinking' : 'assistant', text: '' })
    );
  }

  /**
   * Start a tool row for one content index, from the tool's NAME alone.
   *
   * Opening it here is what keeps a message's blocks in the ORDER the model
   * produced them: a streamed block takes its seq when it opens, so a
   * `[tool_use, text]` message that opened only the text would render the two
   * the wrong way round. The row is a shell — name only — until the
   * authoritative message fills in its input.
   *
   * `toolCallId`, when the engine says it this early, makes the row
   * addressable by session find (#458) from the instant it opens rather than
   * only once the message supersedes it — which for a long Bash call is the
   * whole of it. The message's own derivation sets the identical value
   * (`providers/claude-transcript.ts`). Absent fails open: no `srcId` until
   * the message lands, and the alignment still has every other anchor in the
   * window. (For Claude the
   * id is INFERRED from the streaming shape, not measured — see the
   * translator.)
   */
  private openTool(s: StreamedSession, index: number, name: string, toolCallId?: string): void {
    if (this.streamingAt(s, index)) return;
    this.start(s, index, {
      kind: 'tool',
      tool: { name, category: toolCategory(name), summary: '' },
      ...(toolCallId !== undefined ? { srcId: `tool:${toolCallId}` } : {}),
    });
  }

  private start(s: StreamedSession, index: number, seed: DerivedBlock): FeedBlock {
    // `sidechain: false` unconditionally — live sidechain traffic never
    // reaches here at all (the translator drops it); rendering it is E18-13's.
    const block = s.buffer.push(
      { ...seed, ts: new Date().toISOString(), streaming: true },
      { sidechain: false }
    );
    s.assembling.set(index, block);
    return block;
  }

  private ensure(sessionId: string): StreamedSession {
    const found = this.sessions.get(sessionId);
    if (found) return found;
    const created: StreamedSession = {
      buffer: new FeedBuffer((b) => this.emitBlock(sessionId, b)),
      assembling: new Map(),
      deliveries: new Set(),
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
        this.log?.error('block listener threw', { sessionId, error: errorText(err) });
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

  /**
   * Deliberately NARROWER than `ResetCause` (#790). This source feeds the same
   * `sessions:feedReset` channel, but `'clear'` is the only cause it can
   * produce — `onConversationReset` is its one emitter. Widening the type to
   * the channel's full union would let it claim a value it cannot emit, which
   * is the opposite of what a type is for.
   */
  onReset(l: (sessionId: string, cause?: 'clear') => void): () => void {
    this.resetListeners.add(l);
    return () => this.resetListeners.delete(l);
  }

  /** The session is gone; so are its blocks. */
  forgetSession(sessionId: string): void {
    // …and the refs minted for it (#830). They are useless once the session is
    // gone — nothing will ever derive a block under this id again — and the
    // register is the one piece of per-session state that would otherwise sit
    // there for the life of the process.
    this.refs?.forget(sessionId);
    // pay what is owed first: the last tokens of a session that died mid-turn
    // are still text the user should see
    this.sessions.get(sessionId)?.buffer.flush();
    // ...and let go of the pictures main was keeping for it (#1240)
    this.sessions.get(sessionId)?.buffer.dispose();
    this.sessions.delete(sessionId);
  }
}
