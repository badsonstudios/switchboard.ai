// What the compaction divider SAYS (#1259), decided with no component in it so
// every branch can be pinned.
//
// ONLY WHAT THE FRAME RECORDS IS SAID. Who asked comes from the CLI's
// `trigger`; the counts come from its `pre_tokens` / `post_tokens`, and are
// shown only when BOTH arrived — "32.5k → ?" reads as a fault. A mark with
// neither still draws "Conversation compacted" (fail-open). AI-neutral words on
// purpose (#1316): the event is the engine's, and naming Claude would be wrong
// the day another engine reports one.
import type { CompactionMark } from '../../../shared/compaction';
import { formatTokens } from './usage';

export function compactionCopy(mark: CompactionMark | undefined): {
  key: string;
  vars: Record<string, string>;
} {
  const who = mark?.trigger === 'manual' ? 'manual' : mark?.trigger === 'auto' ? 'auto' : 'plain';
  const pre = mark?.preTokens;
  const post = mark?.postTokens;
  if (pre !== undefined && post !== undefined) {
    return {
      key: `feedView.compaction.${who}Tokens`,
      vars: { pre: formatTokens(pre), post: formatTokens(post) },
    };
  }
  return { key: `feedView.compaction.${who}`, vars: {} };
}
