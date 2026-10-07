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
import { errorText } from '../../shared/error-text';
import { Logger } from '../log/logger';
import { toolCategory } from '../../shared/tool-taxonomy';
import {
  BlockOrigin,
  DerivationContext,
  DerivedBlock,
  DISPLAY_CAPS,
  FeedBlock,
  HydrateOptions,
  TEXT_CAP,
  deriveIntents,
} from './blocks';
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

/**
 * Could this `assistant` message have been built by `stream_event` deltas?
 *
 * `true` means it could not, and therefore that it must not claim a block the
 * deltas opened.
 *
 * ── THE BUG (#978) ────────────────────────────────────────────────────────
 *
 * A local slash command (`/usage`, `/cost`, `/context`) arrives as a bare
 * `system:init -> assistant -> result`: no `message_start`, no deltas, no
 * `message_stop`. So it never reaches `endMessage`, which is the only thing
 * that CLEARS the assembly map — `finalize` deliberately does not (#154: an
 * interrupted turn's `assistant` can arrive after its own `result`).
 *
 * If anything is still sitting in that map, `claim()`'s index-miss fallback
 * hands it over: the fallback takes ANY open block of a superseding kind,
 * because the real CLI reports content index 0 on every `assistant` message of
 * a multi-block turn. The local command's text then REPLACES that block's text,
 * in place, at the same seq — text the user has already read, silently
 * overwritten. It is the failure `supersedes()` refuses a kind disagreement to
 * avoid, arriving through the one door that check does not cover.
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
 * callers. If one ever re-sent streamed content, this would APPEND a block
 * rather than replace one — an extra block, never lost text, which is the same
 * direction `supersedes()` already chose on purpose.
 *
 * DELIBERATELY NOT a check for "were there any deltas this turn?". That is the
 * same fact one inference further away, and it would need turn-scoped state
 * this class keeps for a different purpose — the assembly map outliving the
 * tokens is load-bearing (see its declaration) and reading it as "a stream
 * happened" is how the two facts get collapsed again.
 */
function wasNeverStreamed(msg: Record<string, unknown>): boolean {
  if (msg.local_command_run != null || msg.local_command_source != null) return true;
  const message = msg.message;
  if (typeof message !== 'object' || message === null) return false;
  return (message as Record<string, unknown>).model === '<synthetic>';
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

  /** What `deriveIntents` needs to know about this session, or nothing. */
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
    entries: readonly Record<string, unknown>[],
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
    // SILENTLY: the caller runs inside `sessions:create`, whose own response is
    // what tells the renderer this session's live id — so every push here would
    // be sent to a panel that cannot yet be subscribed to it, and dropped on
    // arrival. The panel reads the backlog when it mounts. See `FeedBuffer`.
    s.buffer.silently(() => {
      for (const e of entries) {
        // The SAME derivation the transcript watcher runs (`blocks.ts`), so a
        // replayed turn cannot look different from the one that streamed live.
        //
        // The entries are the main conversation AND its subagent transcripts,
        // already merged into the order they happened (#1140, `history.ts`).
        // Between #977 and #1140 the subagent half was left to the watcher,
        // which adopts those files on a resumed card and drained them in AFTER
        // this replay — under the newest message. See `absorbSidechain`.
        for (const intent of deriveIntents(e, DISPLAY_CAPS, this.ctx(sessionId))) {
          if (intent.t === 'tool-result') {
            s.buffer.attachResult(intent.toolUseId, intent.out);
            continue;
          }
          // A MAIN-transcript line gets no `agentId`, and not because it was
          // overlooked: it was measured zero times there (#788, re-confirmed on
          // 2.1.280 by #977), so a sidechain in the main file can only be a
          // pre-2.1.226 line, which carries no id to group by either.
          //
          // A subagent FILE's line arrives with its origin already worked out
          // (#1140): `history.ts` reads those files and is the only one that
          // knows which entry came out of which.
          const origin = opts.origins?.get(e) ?? { sidechain: e.isSidechain === true };
          const block = s.buffer.push(intent.block, origin);
          if (intent.toolUseId) s.buffer.remember(intent.toolUseId, block);
          n++;
        }
      }
    });
    return n;
  }

  /**
   * Take ONE subagent line from the transcript watcher (#977).
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
  absorbSidechain(
    sessionId: string,
    entry: Record<string, unknown>,
    origin: BlockOrigin
  ): boolean {
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
    if (s.sidechainBacklogBefore !== undefined) {
      const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (at <= s.sidechainBacklogBefore) {
        // Said ONCE per session, so a report that subagent history went
        // missing after a restart has a line to find.
        if (!s.backlogDropLogged) {
          s.backlogDropLogged = true;
          this.log?.info('subagent backlog left to the replay, not appended', { sessionId });
        }
        return true;
      }
    }
    for (const intent of deriveIntents(entry, DISPLAY_CAPS, this.ctx(sessionId))) {
      if (intent.t === 'tool-result') {
        s.buffer.attachResult(intent.toolUseId, intent.out);
        continue;
      }
      const block = s.buffer.push(intent.block, origin);
      if (intent.toolUseId) s.buffer.remember(intent.toolUseId, block);
    }
    return true;
  }

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
      case 'conversation_reset':
        // The CLI saying, in as many words, that it threw the conversation
        // away. #748: this used to fall through the `default` below and be
        // dropped — in a switch whose stated purpose is that a new message
        // type is a DECISION rather than a silent no-op. It was a silent
        // no-op, and it cost a user-visible bug.
        return this.onConversationReset(sessionId, msg);
      default:
        // rate_limit_event, transcript_mirror, control_request, keep_alive,
        // and `system`'s own non-init subtypes (`status`, `compact_boundary` —
        // both measured, #748 probe 3): not content. Defaulted explicitly so a
        // NEW message type is somebody's decision rather than a silent no-op.
        return;
    }
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
  private onConversationReset(sessionId: string, msg: Record<string, unknown>): void {
    const gone = typeof msg.session_id === 'string' ? msg.session_id : undefined;
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
   * A `system` message. Only one of them concerns the Feed.
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
  private onSystem(sessionId: string, msg: Record<string, unknown>): void {
    if (msg.subtype !== 'init') return;
    const id = typeof msg.session_id === 'string' ? msg.session_id : undefined;
    if (!id) return;
    const s = this.ensure(sessionId);
    if (s.conversationId === undefined || s.conversationId === id) {
      s.conversationId = id;
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
    this.log?.info('stream feed reset', { sessionId, why });
    for (const l of this.resetListeners) {
      try {
        l(sessionId, 'clear');
      } catch (err) {
        this.log?.error('feed reset listener threw', { sessionId, error: errorText(err) });
      }
    }
  }

  private onStreamEvent(sessionId: string, msg: Record<string, unknown>): void {
    const ev = msg.event as Record<string, unknown> | undefined;
    if (!ev || typeof ev.type !== 'string') return;
    // ⚠️ THE GUARD STAYS, AND #977 IS WHY IT IS NOT A GAP ANY MORE. It used to
    // say "E18-13 owns it"; E18-13 landed and chose the other source.
    //
    // A subagent's words reach the Feed from its own transcript file, which the
    // watcher already tails and now derives (`deriveFeed: 'sidechains'`).
    // Dropping them here is what stops the same text arriving twice.
    //
    // Nothing is lost by dropping DELTAS in particular: measured on the PATH CLI
    // 2.1.280, **zero** `stream_event` frames carried a `parent_tool_use_id`,
    // with or without `--forward-subagent-text`. A subagent's reply is one
    // finished message, never a token stream, so there was no streaming half to
    // give up (`spike/findings/e18-977-stream-sidechains.md`).
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
        // NOT `update`: this runs once per token, and an immediate re-emit of
        // the whole block per token is what #1013 measured. See
        // `STREAM_COALESCE_MS`.
        s.buffer.updateSoon(block);
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
    // See `onStreamEvent`: sidechain content comes from the transcript since
    // #977, and dropping it here is what keeps one `FeedBuffer` from receiving
    // the same subagent text from two sources. Without
    // `--forward-subagent-text` — which we deliberately do not pass — the only
    // thing that would arrive here is the subagent's SEEDING prompt anyway.
    if (msg.parent_tool_use_id != null) return;
    const s = this.ensure(sessionId);
    // The stream carries no timestamp of its own, and the Feed shows one (and
    // times thinking blocks by it). Ours is honest to the millisecond for a
    // message we have just received — more than a transcript's is.
    const entry = { ...msg, timestamp: new Date().toISOString() };
    const isAssistant = msg.type === 'assistant';
    // ⚠️ A MESSAGE NOTHING STREAMED MUST NOT CLAIM A STREAMED BLOCK (#978).
    // The full argument, and the two markers it turns on, are on
    // `wasNeverStreamed`. In one line: `claim()`'s index-miss fallback takes ANY
    // open block of a superseding kind, which is right for a model's reply and
    // wrong for a message no model produced — it would replace text the user has
    // already read.
    const unstreamed = isAssistant && wasNeverStreamed(msg);
    for (const intent of deriveIntents(entry, DISPLAY_CAPS, this.ctx(sessionId))) {
      if (intent.t === 'tool-result') {
        s.buffer.attachResult(intent.toolUseId, intent.out);
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
        : // `sidechain: false` — `onMessage` returns early on
          // `parent_tool_use_id`, so nothing that reaches here is one (E18-13)
          s.buffer.push({ ...intent.block, streaming: false }, { sidechain: false });
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
    let seed: DerivedBlock;
    if (type === 'text' || type === 'thinking') {
      seed = { kind: type === 'thinking' ? 'thinking' : 'assistant', text: '' };
    } else if (type === 'tool_use' && typeof cb?.name === 'string') {
      seed = {
        kind: 'tool',
        tool: { name: cb.name, category: toolCategory(cb.name), summary: '' },
        // `content_block_start` carries the tool_use id alongside the name, so
        // the row is addressable by session find (#458) from the instant it
        // opens rather than only once the `assistant` message supersedes it —
        // which for a long Bash call is the whole of it. The message's own
        // derivation sets the identical value (`blocks.ts`).
        //
        // INFERRED from the Anthropic streaming shape (`content_block_start`
        // carries the whole `content_block`, and a `tool_use` block's `id` is
        // part of it), NOT measured: the S-11 probe recorded a thinking/text
        // turn only, so no real `tool_use` start is in our captured record. It
        // FAILS OPEN — no id means no `srcId` until the message lands, and the
        // alignment still has every other anchor in the window.
        ...(typeof cb.id === 'string' ? { srcId: `tool:${cb.id}` } : {}),
      };
    } else {
      return undefined;
    }
    // `sidechain: false` unconditionally — live sidechain traffic never reaches
    // here at all (`parent_tool_use_id != null` returns early in both
    // `onStreamEvent` and `onMessage`); rendering it is E18-13's.
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
    this.sessions.delete(sessionId);
  }
}
