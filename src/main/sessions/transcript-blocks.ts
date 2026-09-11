// Transcript entries → renderable blocks → text, for the readers that are not
// the Feed (#761, #766).
//
// WHY THIS IS A MODULE AND NOT TWO FUNCTIONS INSIDE `queries.ts`. It was two
// functions inside `queries.ts` until #766 needed the same two, and importing
// them back out of that file would have made `queries.ts` and
// `context-package.ts` import each other — a runtime cycle, in main-process
// bootstrap code, to share a pure fold and a `switch`. The pair moved down a
// layer instead, which is where they always belonged: neither one asks a
// QUESTION about a session, they turn a file's lines into text.
//
// ONE FOLD, ONE RENDERING, AND THAT IS THE WHOLE POINT. `get_session_output`
// (#764) and the context package's recent-activity section (#766) show the same
// sibling's turn to the same kind of reader. Two implementations would differ
// in exactly the places a model notices — whether a subagent's line is marked,
// whether a tool's output is attached to the call that produced it — and would
// differ silently, because each would have its own passing tests.
import {
  BlockIntent,
  DerivationCaps,
  FeedBlock,
  deriveIntents,
} from '../feed/blocks';

/**
 * Keep the NEWEST `limit` characters, without splitting an astral character.
 *
 * Two callers cut a rendered tail from the front — `get_session_output` (#764)
 * and the context package's recent-activity section (#766) — for the same
 * reason: the front of a recent window is the least recent thing in it, and
 * "what is happening now" is the point of both.
 *
 * ⚠️ **A `slice` counts UTF-16 code units.** Cutting from the front can land
 * between the halves of an astral character (an emoji, most CJK extension
 * blocks) and leave a lone LOW surrogate at index 0, which reaches the reading
 * model as U+FFFD. `cap()` in `context-package.ts` guards the mirror case — a
 * lone HIGH surrogate at the END of a cut — and review found the two front
 * slices had been left without the matching guard, in both files, because the
 * fix was applied to the function that had been asked about rather than to the
 * shape of the bug.
 *
 * Deterministic either way, so byte-stability is untouched; this is about not
 * opening the handoff with a replacement character.
 */
export function sliceTail(text: string, limit: number): string {
  if (limit <= 0) return '';
  const kept = text.slice(-limit);
  const first = kept.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? kept.slice(1) : kept;
}

/** Prose blocks read as themselves; a tool row reads as one labelled line. */
export function renderBlock(block: FeedBlock): string {
  // A subagent's turn is NOT the main conversation, and handing it to another
  // agent unmarked is a misattribution it cannot detect. Labelled rather than
  // dropped: a sibling's subagent work is often the most interesting thing in
  // the window, and silently removing it would leave an unexplained gap.
  const tag = block.sidechain ? '[subagent] ' : '';
  if (block.kind === 'tool' && block.tool) {
    const head = `${tag}[${block.tool.name}] ${block.tool.summary}`;
    return block.tool.out ? `${head}\n  -> ${block.tool.out}` : head;
  }
  if (block.kind === 'todos' && block.todos) {
    return tag + block.todos.map((t) => `- [${t.status}] ${t.content}`).join('\n');
  }
  const text = block.text ?? '';
  if (!text) return '';
  const label = block.kind === 'user' ? 'User' : block.kind === 'thinking' ? 'Thinking' : 'Claude';
  return `${tag}${label}: ${text}`;
}

/**
 * Fold derivation intents into blocks, attaching tool results to their calls.
 *
 * A miniature of what `FeedBuffer` does. Not reusing `FeedBuffer` itself
 * because it is a live view — it emits through a callback, evicts at
 * `BLOCK_CAP`, and owns `seq` numbering shared with the renderer. None of that
 * belongs in a synchronous read of a file, and constructing one per query to
 * throw it away would couple this to the Feed's eviction policy for nothing.
 *
 * TWO DELIBERATE DIVERGENCES FROM `FeedBuffer`, both toward being more correct
 * for one call rather than for a live view:
 *  - `awaiting` is unbounded where `FeedBuffer.remember` caps at 200, so past
 *    200 unresolved calls the Feed forgets a result and this still attaches it.
 *    The map dies with the call and `readTranscriptWindow` bounds entries at
 *    5,000, so there is nothing to leak.
 *  - `seq` here is a local ordinal starting at 0; `FeedBuffer`'s starts at 1
 *    and is shared with the renderer. **Never surface this one** — it is not
 *    the Feed's `seq` and cannot be used to address a block on screen.
 */
export function blocksFrom(
  entries: readonly Record<string, unknown>[],
  caps: DerivationCaps
): FeedBlock[] {
  const blocks: FeedBlock[] = [];
  const awaiting = new Map<string, FeedBlock>();
  let seq = 0;
  for (const entry of entries) {
    // The watcher's other half of this (`full !== boundFile`) is N/A — we read
    // exactly one file — but a sidechain line lands IN that file and must not
    // be presented as the main conversation. `renderBlock` marks it.
    const sidechain = entry.isSidechain === true;
    let intents: BlockIntent[];
    try {
      // Belt-and-braces, not a known path: `deriveIntents` is tolerant by
      // construction and nothing `JSON.parse` produces can make it throw. Kept
      // so one malformed entry could never cost the whole tail, and flagged as
      // untested because it is untestable from outside.
      intents = deriveIntents(entry, caps);
    } catch {
      continue;
    }
    for (const intent of intents) {
      if (intent.t === 'tool-result') {
        const target = awaiting.get(intent.toolUseId);
        if (target?.tool) target.tool.out = intent.out;
        awaiting.delete(intent.toolUseId);
        continue;
      }
      const block: FeedBlock = { ...intent.block, seq: seq++, sidechain };
      if (intent.toolUseId) awaiting.set(intent.toolUseId, block);
      blocks.push(block);
    }
  }
  return blocks;
}
