// Where a conversation was compacted (#1259).
//
// When Claude Code compacts a conversation (the user's `/compact`, or on its
// own when the context window fills) everything above that point survives in
// the model's memory only as a summary. The CLI marks the spot with a frame
// built for exactly that, and the Feed draws it as a divider, the way a
// `/clear` gets one. The summary itself is NOT shown (#1026: it is the CLI's
// own working note, and its live view hides it too).
//
// HOST, DON'T REIMPLEMENT: the CLI decides when to compact. This mark is only
// ever made from its frame, never inferred.
//
// The frame, measured on CLI 2.1.288 (`spike/findings/1026-not-for-the-live-
// view.md`), in its two spellings:
//
//   stream:     {type:"system", subtype:"compact_boundary",
//                compact_metadata:{trigger:"manual", pre_tokens, post_tokens}}
//   transcript: {type:"system", subtype:"compact_boundary",
//                content:"Conversation compacted",
//                compactMetadata:{trigger:"auto", preTokens, postTokens, ...}}
//
// Shared because both sides read it: main builds the mark, the renderer draws
// the divider.

/**
 * One compaction, as the engine reported it. EVERY FIELD OPTIONAL, and that is
 * the fail-open rule: a frame with no counts or no trigger still draws a
 * divider, just without the words it cannot back.
 */
export interface CompactionMark {
  /** who asked: the user (`/compact`, the Compact button) or the CLI on its own */
  trigger?: 'manual' | 'auto';
  /** context tokens before the compaction */
  preTokens?: number;
  /** context tokens after it */
  postTokens?: number;
}

/** A token count from another process: a finite, non-negative number, or nothing. */
function count(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Build a mark from the pieces of a frame. A trigger we have no words for is
 * dropped rather than guessed at: the divider then says only "compacted",
 * which is true whatever it was. Absent fields are ABSENT, never
 * `undefined`-valued, so a mark with nothing to say is `{}`.
 */
export function compactionMark(trigger: unknown, preTokens: unknown, postTokens: unknown): CompactionMark {
  const mark: CompactionMark = {};
  if (trigger === 'manual' || trigger === 'auto') mark.trigger = trigger;
  const pre = count(preTokens);
  if (pre !== undefined) mark.preTokens = pre;
  const post = count(postTokens);
  if (post !== undefined) mark.postTokens = post;
  return mark;
}

/**
 * The mark carried by a TRANSCRIPT line, or null when the line is not a
 * compaction boundary. Reads the camelCase metadata the transcript writes and,
 * as a guard on the same contract, the stream's snake_case spelling.
 */
export function compactionMarkOfEntry(entry: Record<string, unknown>): CompactionMark | null {
  if (entry.type !== 'system' || entry.subtype !== 'compact_boundary') return null;
  const camel = entry.compactMetadata;
  const snake = entry.compact_metadata;
  if (camel && typeof camel === 'object') {
    const m = camel as Record<string, unknown>;
    return compactionMark(m.trigger, m.preTokens ?? m.pre_tokens, m.postTokens ?? m.post_tokens);
  }
  if (snake && typeof snake === 'object') {
    const m = snake as Record<string, unknown>;
    return compactionMark(m.trigger, m.pre_tokens ?? m.preTokens, m.post_tokens ?? m.postTokens);
  }
  return {};
}
