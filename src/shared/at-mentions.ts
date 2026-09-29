// Stopping another session's words from attaching THIS session's files (#832).
//
// ── THE DEFECT, IN ONE SENTENCE ─────────────────────────────────────────────
//
// The CLI extracts `@word` file mentions from the WHOLE prompt and resolves
// them against the receiving session's own folder — so when we place text from
// session A into session B's prompt, an `@word` inside A's text attaches (or
// lists, up to 1,000 entries) a file in B. `@`-shaped words are ordinary in a
// transcript: npm scopes (`@types/node`), decorators (`@Injectable`), an email
// address, or another agent quoting a mention back.
//
// ── MEASURED, NOT ASSUMED (`spike/findings/832-fenced-at-mention.md`) ───────
//
// #832 asked whether the content fence protects anything in practice. It does
// not. On CLI 2.1.280, with the prompt shaped exactly as `renderOutput` builds
// it — header, `===== BEGIN CONTENT FROM ANOTHER SESSION =====`, the quoted
// text — a file named inside the fenced block was attached before the model saw
// the turn, and the transcript carries the `attachment` line to prove it. The
// same probe's second turn escaped the mention and NOTHING was attached.
//
// ── WHY AN ESCAPE, AND WHY A VISIBLE ONE ───────────────────────────────────
//
// The issue offered three answers. Two of them do not actually fix it:
//
//  * *Say it in the fence.* The attach step runs BEFORE the model reads a word
//    of our header, so a sentence addressed to the model cannot stop a file
//    being read or a directory being listed. It is worth saying — and this
//    module carries the sentence — but on its own it would be advice, not a fix.
//  * *Accept and document.* The mitigation on offer is "the user pressed
//    Enter", and what the user cannot reasonably do is notice an
//    `@types/node` in the middle of a quoted transcript and predict that it
//    will list a folder.
//
// So: neutralise on the way in. The cost is that we edit another session's
// words, which is exactly what the fence promises we do not do — and that is
// why the edit is A BACKSLASH THE READER CAN SEE, never an invisible character.
// `sibling-message.ts` refuses zero-width and bidi characters for a reason
// stated in as many words there: *the block the user reviews must be the prompt
// the agent reads*. Neutralising with a zero-width joiner would have broken
// that rule in the very module that exists to keep it.
//
// It is also not a new principle. #798 already rewrites the `@Name` the USER
// typed (`mentionLabel`, `"Name" (session)`) for this exact reason; this is the
// same rule applied to the half of the prompt the user did not write.

/** What goes in front of a neutralised `@` — visible, and a conventional escape. */
export const AT_ESCAPE = '\\';

/**
 * Where the CLI will look for a file mention, verbatim from the 2.1.272 binary
 * and re-confirmed on 2.1.280: `/(^|[\s。、？！])@([^\s]+)\b/g` for the bare form
 * and the same boundary for the quoted `@"…"` form.
 *
 * ONLY THE BOUNDARY IS COPIED, not the tail. We are not deciding what a valid
 * path looks like — the CLI does that, and its answer will drift. All we have to
 * do is make sure the character before an `@` is not start-of-string or
 * whitespace, which is what the extractor requires and what no tail rule can
 * restore. Escaping an `@` that would not have matched anyway costs a backslash;
 * missing one costs a file read.
 */
const AT_AFTER_BOUNDARY = /(^|[\s。、？！])@/gu;

/** Text with its file mentions defused, and how many there were. */
export interface Neutralised {
  text: string;
  /** 0 means nothing was changed — the caller says nothing in that case */
  count: number;
}

/**
 * Break every `@word` the CLI would treat as a path, leaving the word readable.
 *
 * IDEMPOTENT by construction: after one pass every `@` is preceded by a
 * backslash, which is not a boundary character, so a second pass matches
 * nothing. That matters because a block can pass through more than one of these
 * doors — a sibling forwards text it was itself handed.
 */
export function neutraliseAtMentions(text: string): Neutralised {
  let count = 0;
  const out = text.replace(AT_AFTER_BOUNDARY, (_m, before: string) => {
    count++;
    return `${before}${AT_ESCAPE}@`;
  });
  return { text: out, count };
}

/**
 * The one sentence the reading model is owed when we have edited the text.
 *
 * Said ONLY when something was escaped (`count > 0`), so an ordinary block
 * carrying no `@` pays nothing for this. It has two jobs: the model is told why
 * the text differs from what the other session wrote, and it is told that a path
 * in here is the OTHER session's, which is the half of #832 the fence was always
 * the right place to answer.
 */
export const AT_ESCAPE_NOTE =
  'File mentions in the text below are escaped as \\@ — they name paths in the OTHER ' +
  "session's folder, not this one's, and were not attached here.";

/** The note on its own line, or nothing at all. */
export function atEscapeNote(count: number): string {
  return count > 0 ? AT_ESCAPE_NOTE : '';
}
