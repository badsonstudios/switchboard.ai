// The per-session Feed block buffer (P2-E18-10).
//
// Extracted from `TranscriptWatcher` alongside `blocks.ts`, and for the same
// reason: the transcript watcher and `StreamFeed` must not each grow their own
// answer to "what seq is this", "when does a thinking block learn its
// duration", "how many blocks do we keep". Those are properties of the FEED,
// not of a transport.
//
// Emission is a callback rather than a listener set: a buffer belongs to
// exactly one session and its owner already has the fan-out. Both new blocks
// and UPDATES to an existing block go out the same way, carrying the same
// `seq` — the renderer's `upsertBlock` is keyed on it (see `lib/feed.ts`), so
// re-emitting a block with a new field is how OUT sections, thinking durations
// and streamed text all reach the view.
import { BLOCK_CAP, BlockOrigin, DerivedBlock, FeedBlock, originOf, stamp } from './blocks';

/**
 * The longest gap between two blocks that can still be read as "how long it
 * thought for" (#395).
 *
 * A thinking block learns its duration from the NEXT block's timestamp, which
 * is only a measurement while the two belong to the same turn. Across a SEAM
 * they do not: history replayed off a transcript carries yesterday's timestamps
 * and the first live block carries now, so a conversation that happened to end
 * mid-thought renders "Thought for 50400s" the morning after — a number the
 * user is being shown as fact. The same arithmetic sits behind the transcript
 * watcher's own resume replay, which is why the bound lives here rather than in
 * either source.
 *
 * Ten minutes is chosen to be far longer than any extended-thinking block the
 * CLI produces and far shorter than the gaps a seam invents. Past it the block
 * simply keeps no duration and renders as plain "Thinking" — no claim beats a
 * wrong one.
 */
export const MAX_THINKING_GAP_MS = 10 * 60_000;

export class FeedBuffer {
  private readonly items: FeedBlock[] = [];
  private seq = 0;
  /** tool_use id -> the block awaiting its result (bounded, see `remember`) */
  private readonly awaitingResult = new Map<string, FeedBlock>();
  /** see `silently` */
  private muted = false;

  constructor(
    private readonly emit: (b: FeedBlock) => void,
    private readonly cap = BLOCK_CAP
  ) {}

  /**
   * Fill the buffer with `fn`'s blocks WITHOUT telling anybody (#395).
   *
   * For the one caller that provably has no audience: replaying a resumed
   * conversation happens inside `sessions:create`, before its own response has
   * told the renderer which live id this session even is — so every push would
   * cross the IPC boundary keyed to a session no panel is subscribed to, and be
   * dropped on arrival. A long conversation makes thousands of those, on the
   * boot path. The panel reads the backlog when it mounts (`transcripts:blocks`)
   * and misses nothing.
   *
   * Suppresses UPDATES too, not just pushes: a replayed tool result attaching to
   * a replayed call is the same wasted round trip.
   */
  silently<T>(fn: () => T): T {
    this.muted = true;
    try {
      return fn();
    } finally {
      this.muted = false;
    }
  }

  private fire(b: FeedBlock): void {
    if (!this.muted) this.emit(b);
  }

  /** Add a block, assign it a seq, and emit it. */
  push(b: DerivedBlock, origin: BlockOrigin): FeedBlock {
    // a thinking block's duration becomes known when the NEXT block lands —
    // unless the two are separated by a seam rather than by thought
    // (MAX_THINKING_GAP_MS)
    //
    // ⚠️ **AND UNLESS THE NEXT BLOCK IS SOMEBODY ELSE'S** (#788 review). `prev`
    // is the previous block in the MERGED buffer, and the premise of this whole
    // item is that the buffer interleaves N subagent files with no ordering
    // relation between them. So agent A thinks at `T`, the next poll drains
    // agent B's file and pushes a line stamped `T+42s`, and A's block renders
    // "Thought for 42s" — a number about A produced entirely by B's clock. The
    // same thing happens at every subagent→main-conversation boundary.
    //
    // This predates #788; `BlockOrigin` is what makes it FIXABLE, because until
    // now the buffer had no way to ask whether two adjacent blocks came from
    // the same place. Both sides are `undefined` on the main conversation, so
    // the ordinary path is untouched. #395's rule in this file is "no claim
    // beats a wrong one", and a duration measured across two agents is a wrong
    // one presented as a fact.
    const prev = this.items[this.items.length - 1];
    if (prev?.agentId === origin.agentId && prev?.kind === 'thinking' && !prev.durationMs && prev.ts && b.ts) {
      const ms = Date.parse(b.ts) - Date.parse(prev.ts);
      if (Number.isFinite(ms) && ms > 0 && ms <= MAX_THINKING_GAP_MS) {
        prev.durationMs = ms;
        this.update(prev);
      }
    }
    const block = stamp(b, ++this.seq, origin);
    this.items.push(block);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
    this.fire(block);
    return block;
  }

  /** Re-emit a block that was mutated in place — same seq, new contents. */
  update(block: FeedBlock): void {
    this.fire(block);
  }

  /**
   * Swap a block's whole contents, keeping its `seq` and its place in the list.
   *
   * This is how a block that was assembled from token deltas is superseded by
   * the authoritative message (P2-E18-10): the renderer upserts on seq, so the
   * bubble the user has been watching fill in is the one that finalises.
   *
   * A wholesale swap rather than a field-by-field merge, deliberately. The
   * message is authoritative about EVERYTHING, including the block's kind — a
   * streamed `tool_use` placeholder becomes a `todos` checklist, and a merge
   * would leave the tool fields behind on it. Same defect shape as the
   * field-by-field persisted-session copy that silently dropped `transport`
   * (#153): what you forget to overwrite survives, invisibly.
   */
  replace(block: FeedBlock, next: DerivedBlock): FeedBlock {
    // The ORIGIN survives the swap, and it is spread as one group rather than
    // field-by-field (#788). The message is authoritative about everything the
    // line says; it is authoritative about nothing the line CANNOT say — which
    // file this came out of, and therefore which subagent. Listing the fields
    // individually here is how the next one gets forgotten: `DerivedBlock`
    // makes `next` structurally incapable of carrying them, so there is exactly
    // one place they can come from and it is the block being replaced.
    const merged = stamp(next, block.seq, originOf(block));
    const i = this.items.indexOf(block);
    if (i >= 0) this.items[i] = merged;
    // any tool_result still waiting on the old object would attach to a block
    // that is no longer in the list
    for (const [id, held] of this.awaitingResult) {
      if (held === block) this.awaitingResult.set(id, merged);
    }
    this.fire(merged);
    return merged;
  }

  /**
   * Remember that `toolUseId`'s result should attach to `block`.
   *
   * Bounded: past 200 calls in flight the oldest mapping is forgotten. A tool
   * whose result never arrives would otherwise pin its block for the life of
   * the session, and a long session makes many of them.
   */
  remember(toolUseId: string, block: FeedBlock): void {
    this.awaitingResult.set(toolUseId, block);
    if (this.awaitingResult.size > 200) {
      const first = this.awaitingResult.keys().next().value;
      if (first !== undefined) this.awaitingResult.delete(first);
    }
  }

  /** Attach tool output to the block that asked for it. Returns true if it landed. */
  attachResult(toolUseId: string, out: string): boolean {
    const target = this.awaitingResult.get(toolUseId);
    if (!target?.tool || target.tool.out !== undefined) return false;
    target.tool.out = out;
    this.awaitingResult.delete(toolUseId);
    this.update(target);
    return true;
  }

  /** Everything currently held, for a panel that is mounting (backlog replay). */
  list(): FeedBlock[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }

  /**
   * Start again from seq 1 — a corrected mis-bind, or a `/clear` that minted a
   * fresh conversation. The renderer drops its blocks on the matching reset
   * push, so the two stay in step.
   */
  reset(): void {
    this.items.length = 0;
    this.seq = 0;
    this.awaitingResult.clear();
  }
}
