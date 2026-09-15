// `@session` mentions in the composer (P2-E11-07).
//
// NOT `slashToken` with a different character. A slash command is LINE-INITIAL
// (`shared/slash-commands.ts`): the draft must START with `/`. A mention lives
// mid-sentence — "take @TradingApp's last output and apply the same fix here" —
// so the rule is about the WORD the caret is in, not the draft's first character.
//
// The rule, in one place so the composer and its tests cannot disagree:
//   - the caret sits at the END of a word that begins with `@` (nothing but the
//     end of the draft or a name-ending character right after it), and
//   - that `@` is at a BOUNDARY: the start of the draft, whitespace, or an
//     opening bracket or quote.
//
// So `a@b.com`, `foo@bar` and any `@` mid-word never open the popup. `@media`
// at a word start DOES produce a token — the tokenizer cannot know that is not
// a session name — and the popup closes because nothing matches, which is the
// done-when's own answer for "no name matches the typed prefix".
//
// AT THE END, NOT ANYWHERE IN IT (review, #797). With the caret inside a mention
// already typed — `hey @Tr|adingApp please` — a token of "Tr" would open the
// popup, and Enter would replace `@Tr` with the first match, leaving
// `@Trackpad adingApp`. Clicking into a name to fix it and pressing Enter is
// ordinary; the popup only belongs where the user is still typing the name.
//
// Pure: no DOM, no I/O. The LIST RULES live here too (which sessions the popup
// offers, what Enter does) rather than inline in the composer, because a rule
// inlined in a component is a rule no unit test and no mutant can reach.
// Resolution of `@name` to a session's output is #798 — and #798 must NOT reuse
// `mentionToken` to find mentions at send: a session title can contain a space
// or an apostrophe, and this trigger stops at both.

import type { SessionSummary } from './sessions';

/** Characters a mention may follow. Anything else before `@` means "not a mention". */
const BOUNDARY = /[\s([{"'`]/;

/** Characters that end a mention's name while typing. */
const NAME_END = /[\s)\]}"'`,;:!?]/;

export interface MentionToken {
  /** index of the `@` in the draft */
  at: number;
  /** what has been typed after the `@`, up to the caret ('' right after `@`) */
  query: string;
}

/**
 * The mention the popup should complete, or null when no popup belongs on
 * screen.
 */
export function mentionToken(draft: string, caret: number): MentionToken | null {
  if (caret > draft.length) return null;
  const head = draft.slice(0, caret);
  // `lastIndexOf` also answers the caret-at-0 and no-`@` cases (-1), and it
  // guarantees there is no `@` between `at` and the caret.
  const at = head.lastIndexOf('@');
  if (at === -1) return null;
  // The `@` must start a word.
  if (at > 0 && !BOUNDARY.test(head[at - 1])) return null;
  const query = head.slice(at + 1);
  // The caret has left the word: a space or name-ending punctuation since the `@`.
  if (NAME_END.test(query)) return null;
  // The caret is INSIDE the word, not at its end (see the header).
  if (caret < draft.length && !NAME_END.test(draft[caret])) return null;
  return { at, query };
}

/**
 * Replace the mention being completed with `@name` and a trailing space,
 * keeping everything before the `@` and after the caret, without doubling a
 * separator the draft already has there (a space or a newline).
 */
export function insertMention(draft: string, token: MentionToken, caret: number, name: string): string {
  const before = draft.slice(0, token.at);
  const rest = draft.slice(caret);
  return `${before}@${name}${/^\s/.test(rest) ? '' : ' '}${rest}`;
}

/**
 * Where the caret belongs after `insertMention`: one past `@name`. That is just
 * after the space `insertMention` adds — or, when the draft already had a
 * separator there, just past that one. The same arithmetic the slash popup uses.
 */
export function caretAfterMention(token: MentionToken, name: string): number {
  return token.at + 1 + name.length + 1;
}

/**
 * The sessions the popup offers for `query`: case-insensitive substring on the
 * display name, prefix matches first, then alphabetical — the same ranking the
 * slash popup uses (`filterCommands`).
 *
 * - The composer's OWN session is never offered: `@` yourself would paste your
 *   own recent output back into your own prompt. Typed in full it is still just
 *   literal text (#798's negative table).
 * - EXITED sessions are kept, and the row marks them (#765: a session that has
 *   ended can still be READ, which is what `@` is for; only delivery needs it
 *   running).
 * - No match → `[]`, which is what closes the popup.
 *
 * Returns a new array; the list it was handed is not reordered.
 */
export function filterSummaries(list: readonly SessionSummary[], query: string, ownId: string): SessionSummary[] {
  const q = query.toLowerCase();
  return list
    .filter((s) => s.id !== ownId && s.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    });
}

/**
 * Has the user already typed this session's name in full? Case-insensitive,
 * exactly as `isCompleteCommand` is.
 */
export function isCompleteMention(query: string, name: string): boolean {
  return query.toLowerCase() === name.toLowerCase();
}

/**
 * What Enter does on a mention row: `'send'` the draft as typed, or
 * `'complete'` it to the highlighted session. Tab always completes; this is
 * Enter only.
 *
 * - **Typed in full → send.** #163's rule for slash commands (`isCompleteCommand`):
 *   "Enter confirms a completion" once ate every fully typed command, and would
 *   eat every fully typed `@Name` the same way.
 * - **The name STARTS with what was typed → complete.** `@Tra` + Enter is asking
 *   for TradingApp.
 * - **Only a SUBSTRING match, and the user did not move to it → send** (review,
 *   #797). `ping @app` with a session called TradingApp would otherwise become
 *   `@TradingApp` — a literal `@word` rewritten into a name nobody chose, which
 *   is exactly what #798's negative table forbids ("reaches the model as the
 *   literal characters the user typed").
 * - **The user moved the highlight (arrows or pointer) → complete**, whatever the
 *   match: they chose that row.
 */
export function mentionEnterAction(query: string, name: string, navigated: boolean): 'send' | 'complete' {
  if (isCompleteMention(query, name)) return 'send';
  if (navigated || name.toLowerCase().startsWith(query.toLowerCase())) return 'complete';
  return 'send';
}
