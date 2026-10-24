// The CLI's compaction summaries, held in main (#1374).
//
// When Claude Code compacts a conversation it writes a summary of everything
// above that point, and that summary is all the model now remembers of it. It
// is NOT part of the Feed (#1026: the CLI's own live view hides it, and drawn
// as a block it read as a prompt the user typed). The divider that marks the
// compaction (#1259) can offer it on request instead, and this is where the
// text waits until somebody asks.
//
// THE TEXT NEVER RIDES ON A BLOCK. Measured over every transcript on this
// machine, a summary is 3k to 21k characters; on the block it would be cloned
// over IPC on every re-emit and every backlog read, for a thing almost nobody
// opens. So the block carries a HANDLE (`CompactionMark.summaryId`) and the
// page asks for the text by it, through `feed:compactionSummary`, only when the
// user presses "Show summary". The same shape as the conversation's pictures
// (`pictures.ts`, #1240), for the same reason.
//
// A HANDLE NAMES ONE SUMMARY FOR EVER: minted at random, never reused, so a
// stale divider can be answered with its own summary or with nothing, never
// with another compaction's.
//
// IN MEMORY, UNDER A BUDGET, NEWEST KEPT. Nothing is written to disk; the CLI's
// transcript keeps every summary, and a resumed session reads it back from
// there. Past the budget the oldest are let go and their dividers answer "no
// longer available".
import { randomUUID } from 'crypto';
import type { CompactionSummaryResult } from '../../shared/compaction';

/**
 * The most summary text held at once, across every session, in CHARACTERS
 * (UTF-16 code units: about 8 MB). About 200 summaries at the largest
 * measured size.
 */
export const COMPACTION_SUMMARY_BUDGET = 4 * 1024 * 1024;

interface Held {
  owner: object;
  text: string;
}

export class CompactionSummaryStore {
  /** insertion order is age: the first key is the oldest summary held */
  private readonly held = new Map<string, Held>();
  private chars = 0;

  constructor(
    private readonly budget = COMPACTION_SUMMARY_BUDGET,
    private readonly mint: () => string = randomUUID
  ) {}

  /**
   * Keep this text for `owner` and answer its handle, or `undefined` when it is
   * too large to keep at all: then there is no handle, and no button offering a
   * summary that was never held.
   */
  keep(owner: object, text: string): string | undefined {
    if (text.length > this.budget) return undefined;
    const id = this.mint();
    this.held.set(id, { owner, text });
    this.chars += text.length;
    for (const [old, h] of this.held) {
      if (this.chars <= this.budget) break;
      this.held.delete(old);
      this.chars -= h.text.length;
    }
    return id;
  }

  /** The text this handle names, or undefined: never minted, or gone. */
  get(id: string): string | undefined {
    return this.held.get(id)?.text;
  }

  /** Forget one handle: the block that carried it is gone. */
  drop(id: string): void {
    const h = this.held.get(id);
    if (!h) return;
    this.held.delete(id);
    this.chars -= h.text.length;
  }

  /** Forget everything kept for `owner`: its conversation was reset or closed. */
  dropOwner(owner: object): void {
    for (const [id, h] of this.held) {
      if (h.owner !== owner) continue;
      this.held.delete(id);
      this.chars -= h.text.length;
    }
  }

  /** how many summaries are held, and how much text: for tests */
  get size(): number {
    return this.held.size;
  }
  get heldChars(): number {
    return this.chars;
  }
}

/** The app's one store. Every Feed buffer keeps into it unless told otherwise. */
export const compactionSummaries = new CompactionSummaryStore();

/**
 * `feed:compactionSummary`'s answer. Anything that is not a string handle the
 * store holds is `{ok: false}`: the page cannot ask for a thing by any other
 * name, and a refusal costs it nothing but the words "no longer available".
 */
export function compactionSummaryAnswer(
  store: CompactionSummaryStore,
  id: unknown
): CompactionSummaryResult {
  if (typeof id !== 'string' || id === '') return { ok: false };
  const text = store.get(id);
  return text === undefined ? { ok: false } : { ok: true, text };
}
