// Prompt History (#1203): the prompts YOU sent in this conversation, so you can
// go back to one.
//
// The owner, of the History button: "nothing in there tells me: when I put in a
// new prompt, if I want to go back to a previous prompt, how do I do that?"
// That button lists previous CONVERSATIONS. It stays as it is. This is the
// second kind of history he asked for: previous PROMPTS, in the conversation
// that is on screen.
//
// "GO BACK" MEANS TWO THINGS, and both are offered from one list:
//
//   - go to where it is: the view jumps to that prompt in the conversation;
//   - use it again: its text is put back in the prompt box, to edit or resend.
//
// It does NOT mean rewinding the conversation's state. That is a different
// feature with a different cost, and is not here.
//
// This is the pure half: which blocks are prompts, what each one is called in
// the list, and how recalled text meets whatever is already typed.
import { commandInvocation, isCommandPlumbing } from '../../../shared/command-invocation';
import type { FeedBlockDto } from './feed';

export interface PromptEntry {
  /** the block to jump to */
  seq: number;
  /** what the list shows, and what "use again" puts in the prompt box */
  text: string;
  /** when it was sent, if the block says */
  ts?: string;
  /** it was a slash command, shown as you would type it ("/clear") */
  command: boolean;
}

/**
 * The prompts in a conversation, NEWEST FIRST.
 *
 * A prompt is a `user` block of the main conversation with something in it. A
 * subagent's instructions are not yours and are left out. The CLI's own
 * plumbing around a slash command (its stdout, a caveat line) is not a prompt;
 * the command itself is, and is listed as you typed it.
 *
 * `blocks` is the view's buffer, which holds the most recent thousand blocks:
 * a prompt older than that is not in it and is not listed. The list says so
 * rather than passing itself off as the whole history.
 */
export function promptsOf(blocks: readonly FeedBlockDto[]): PromptEntry[] {
  const out: PromptEntry[] = [];
  for (const b of blocks) {
    if (b.kind !== 'user' || b.sidechain) continue;
    const raw = (b.text ?? '').trim();
    if (!raw) continue;
    const command = commandInvocation(raw);
    if (command === null && isCommandPlumbing(raw)) continue;
    out.push({
      seq: b.seq,
      text: command ?? raw,
      ...(b.ts ? { ts: b.ts } : {}),
      command: command !== null,
    });
  }
  return out.reverse();
}

/** The prompts whose text contains every word typed, in any order. */
export function filterPrompts(prompts: readonly PromptEntry[], query: string): PromptEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...prompts];
  return prompts.filter((p) => {
    const hay = p.text.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * What the prompt box holds after "use again".
 *
 * NEVER AT THE COST OF WHAT WAS TYPED. An empty box takes the prompt. A box
 * with words in it keeps them, and the recalled prompt is added after a blank
 * line: someone half-way through a sentence who reaches for an old prompt
 * wanted both.
 */
export function recallInto(draft: string, recalled: string): string {
  if (draft.trim() === '') return recalled;
  if (draft.trim() === recalled.trim()) return draft;
  const nl = String.fromCharCode(10);
  return `${draft.replace(/\s+$/, '')}${nl}${nl}${recalled}`;
}

/** How long ago, in the coarse steps a list of prompts needs. */
export function promptAge(
  ts: string | undefined,
  now: number
): { unit: 'now' | 'minutes' | 'hours' | 'days'; count: number } | null {
  if (!ts) return null;
  const at = Date.parse(ts);
  if (!Number.isFinite(at)) return null;
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return { unit: 'now', count: 0 };
  if (mins < 60) return { unit: 'minutes', count: mins };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { unit: 'hours', count: hours };
  return { unit: 'days', count: Math.floor(hours / 24) };
}
