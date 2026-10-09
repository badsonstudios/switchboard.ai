// The last thing a session was asked (#631): what the hover on a session's tab,
// row or pill shows.
//
// NO NEW SOURCE. Main already holds each live session's conversation as feed
// blocks (the transcript watcher's for a Terminal session, the stream feed's
// for a Direct one). This walks that list backwards for the last `user` block
// that is something a person would call a prompt.
//
// ⚠️ A `user` BLOCK IS NOT ALWAYS SOMETHING THE USER TYPED (found in review; the
// first cut of this file said it was). `blocks.ts` drops plumbing and turns a
// harness-injected turn into a `notice`, but these still arrive as `user`:
//
//   * a SLASH COMMAND, as `<command-name>` markup. Shown the way a person
//     writes it (`/next-item 818`), by the same helper the feed uses.
//   * the CLI's INTERRUPT MARKER (`[Request interrupted by user]`). Not a
//     prompt; passed over.
//   * the CLI's COMPACTION SUMMARY ("This session is being continued from a
//     previous conversation…"), written by the model. Passed over. Recognised
//     by its opening words, because the block carries no flag for it: if the
//     CLI rewords it, the summary will show until the next real prompt.
//   * a MESSAGE FROM ANOTHER SESSION (the session bus), wrapped in a header and
//     footer. It IS what the session was last asked, so it is shown, without
//     the wrapper, and marked as having come from that session.
//   * CONTEXT THIS APP ATTACHED to a prompt (another session's work, #830).
//     Cut out, by the block's own ranges when it has them and by the marker's
//     shape when it does not (after a restart the ranges are no longer made).
//
// LAZY: asked for when a hover has lasted long enough to mean it, never kept
// up to date per message. A busy session pays nothing for a tooltip nobody is
// looking at.
import { commandInvocation, isCommandPlumbing } from '../../shared/command-invocation';
import { BLOCK_CAP, type FeedBlock } from './blocks';

/** enough to recognise the task; the popup shows a few lines of it */
export const LAST_PROMPT_CAP = 600;

/** What `transcripts:lastPrompt` answers; `null` there means "cannot say". */
export interface LastPrompt {
  /** the prompt's own words, trimmed and capped; `null` when there is none yet */
  text: string | null;
  /** the prompt was longer than the cap and was cut */
  cut: boolean;
  /** it carried attachments (an image, say) and no words at all */
  attachmentOnly: boolean;
  /** the name of the session that sent it, when it was not typed here */
  from?: string;
}

/** a context section this app attached, by shape: `injected-context.ts` writes both lines */
const CONTEXT_SECTION =
  /\[Context (\S+) from another switchboard session,[^\n]*\]\n?[\s\S]*?\[End of context \1 from [^\n]*\]\n?/g;
/** a message another session sent: `sibling-message.ts`'s `formatSiblingPrompt` */
const SIBLING_MESSAGE =
  /^\[Message (\S+) from another switchboard session, "([^"\n]*)"[^\n]*\]\n([\s\S]*?)\n\[End of message \1 from [^\n]*\]\s*$/;
const INTERRUPT_MARKER = '[Request interrupted';
const COMPACT_SUMMARY = 'This session is being continued from a previous conversation';

/**
 * A `user` block's text with the context this app attached cut out.
 *
 * The block's own `context` ranges first: they are exact, and only made for
 * markers this app minted. Then anything left that has the marker's shape,
 * because after a restart (or when the text was cut to fit) the ranges are
 * absent and the hover would otherwise lead with another session's report. A
 * user who TYPES the marker loses those words from a 600-character hint, which
 * is a fair price; the feed itself still shows every byte.
 */
function withoutContext(block: FeedBlock): string {
  const text = block.text ?? '';
  const sections = [...(block.context ?? [])].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const s of sections) {
    if (s.start < at || s.end > text.length || s.end < s.start) continue; // not a range into this text
    out += text.slice(at, s.start);
    at = s.end;
  }
  return (out + text.slice(at)).replace(CONTEXT_SECTION, '');
}

/** trailing spaces off each line, the ends trimmed, the lines in between kept */
const tidy = (s: string): string => s.replace(/[ \t]+\n/g, '\n').trim();

/**
 * The last prompt in a session's blocks, or `null` when that cannot be said.
 *
 * `null` (the whole answer) is for a list that may have LOST the prompt: main
 * keeps at most `cap` blocks, and a long turn can push the prompt out of it.
 * "No prompts yet" would be false there, so the surface shows nothing.
 *
 * A subagent's own prompt (`sidechain`) is not the user's and is skipped. A
 * prompt that was only an attachment has no words to show, and says so rather
 * than falling back to an older prompt, which would describe a task the
 * session has since moved on from.
 */
export function lastPromptOf(blocks: readonly FeedBlock[], cap = BLOCK_CAP): LastPrompt | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind !== 'user' || b.sidechain) continue;
    const raw = (b.text ?? '').trim();
    if (raw.startsWith(INTERRUPT_MARKER) || raw.startsWith(COMPACT_SUMMARY)) continue;

    let words: string;
    let from: string | undefined;
    const sibling = SIBLING_MESSAGE.exec(raw);
    if (raw && isCommandPlumbing(raw)) {
      const command = commandInvocation(raw);
      if (!command) continue; // markup with no command in it: nothing a person asked
      words = command;
    } else if (sibling) {
      from = sibling[2];
      words = tidy(sibling[3]);
    } else {
      words = tidy(withoutContext(b));
    }

    if (!words) {
      if (b.attachments) return { text: null, cut: false, attachmentOnly: true };
      continue; // nothing of anyone's in it at all: look further back
    }
    const cut = words.length > LAST_PROMPT_CAP;
    return {
      text: cut ? words.slice(0, LAST_PROMPT_CAP).trimEnd() : words,
      cut,
      attachmentOnly: false,
      ...(from ? { from } : {}),
    };
  }
  // none found. In a full list that is "it may have scrolled out", not "none".
  if (blocks.length >= cap) return null;
  return { text: null, cut: false, attachmentOnly: false };
}
