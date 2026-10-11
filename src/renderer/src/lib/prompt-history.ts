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
  /** what the list shows: the prompt, or a slash command as a short label */
  text: string;
  /**
   * What "use again" puts in the prompt box. The same as `text` for a prompt.
   * For a slash command it is the WHOLE command: `text` is a label, flattened
   * and cut to a line, and a command run with a pasted briefing would
   * otherwise come back as its first eighty characters and an ellipsis.
   */
  recall: string;
  /** when it was sent, if the block says */
  ts?: string;
  /** it was a slash command, shown as you would type it ("/clear") */
  command: boolean;
}

/**
 * YOUR words in a prompt: its text with the stretches the app injected taken
 * out (#830).
 *
 * A prompt that mentioned another session is sent with that session's output
 * ahead of the prose, and `context` marks where. The conversation shows those
 * stretches as rows of their own; a list of "what I asked" must not show two
 * lines of somebody else's transcript, match a filter inside it, or paste it
 * back into the prompt box. The offsets are main's; nothing here re-reads the
 * markers.
 */
export function ownWords(
  text: string,
  context: ReadonlyArray<{ start: number; end: number }> | undefined
): string {
  if (!context || context.length === 0) return text.trim();
  const parts: string[] = [];
  let at = 0;
  for (const c of context) {
    parts.push(text.slice(at, c.start));
    at = c.end;
  }
  parts.push(text.slice(at));
  return parts.join('').trim();
}

/** A slash command in full, as typed: the name and ALL of its arguments. */
function wholeCommand(raw: string): string | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(raw);
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw);
  const whole = `${name[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  return whole || null;
}

/**
 * The prompts in a conversation, NEWEST FIRST.
 *
 * A prompt is a `user` block of the main conversation with something in it. A
 * subagent's instructions are not yours and are left out. The CLI's own
 * plumbing around a slash command (its stdout, a caveat line) is not a prompt;
 * the command itself is, and is listed as you typed it.
 *
 * WHAT COUNTS AS A COMMAND is asked the way the conversation asks it: the
 * markup has to OPEN the text. A prompt that quotes `<command-name>` partway
 * through (someone asking about this very format) is prose, and is listed and
 * recalled as the prose it is.
 *
 * `blocks` is the view's buffer, which holds the most recent thousand blocks:
 * a prompt older than that is not in it and is not listed. The list says so
 * rather than passing itself off as the whole history.
 */
export function promptsOf(blocks: readonly FeedBlockDto[]): PromptEntry[] {
  const out: PromptEntry[] = [];
  for (const b of blocks) {
    if (b.kind !== 'user' || b.sidechain) continue;
    const raw = ownWords(b.text ?? '', b.context);
    if (!raw) continue;
    const plumbing = isCommandPlumbing(raw);
    const label = plumbing ? commandInvocation(raw) : null;
    if (plumbing && label === null) continue;
    out.push({
      seq: b.seq,
      text: label ?? raw,
      recall: label === null ? raw : (wholeCommand(raw) ?? label),
      ...(b.ts ? { ts: b.ts } : {}),
      command: label !== null,
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
