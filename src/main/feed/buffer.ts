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
import { BLOCK_CAP, FeedBlock } from './blocks';

export class FeedBuffer {
  private readonly items: FeedBlock[] = [];
  private seq = 0;
  /** tool_use id -> the block awaiting its result (bounded, see `remember`) */
  private readonly awaitingResult = new Map<string, FeedBlock>();

  constructor(
    private readonly emit: (b: FeedBlock) => void,
    private readonly cap = BLOCK_CAP
  ) {}

  /** Add a block, assign it a seq, and emit it. */
  push(b: Omit<FeedBlock, 'seq' | 'sidechain'>, sidechain: boolean): FeedBlock {
    // a thinking block's duration becomes known when the NEXT block lands
    const prev = this.items[this.items.length - 1];
    if (prev?.kind === 'thinking' && !prev.durationMs && prev.ts && b.ts) {
      const ms = Date.parse(b.ts) - Date.parse(prev.ts);
      if (Number.isFinite(ms) && ms > 0) {
        prev.durationMs = ms;
        this.update(prev);
      }
    }
    const block: FeedBlock = { ...b, seq: ++this.seq, sidechain };
    this.items.push(block);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
    this.emit(block);
    return block;
  }

  /** Re-emit a block that was mutated in place — same seq, new contents. */
  update(block: FeedBlock): void {
    this.emit(block);
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
  replace(block: FeedBlock, next: Omit<FeedBlock, 'seq' | 'sidechain'>): FeedBlock {
    const merged: FeedBlock = { ...next, seq: block.seq, sidechain: block.sidechain };
    const i = this.items.indexOf(block);
    if (i >= 0) this.items[i] = merged;
    // any tool_result still waiting on the old object would attach to a block
    // that is no longer in the list
    for (const [id, held] of this.awaitingResult) {
      if (held === block) this.awaitingResult.set(id, merged);
    }
    this.emit(merged);
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
