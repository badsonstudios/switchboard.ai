// Building the prompt a draft with `@Name` mentions actually SENDS (P2-E11-08).
//
// Pure. The finder (`mention-finder.ts`) says WHERE known names are mentioned;
// `SessionQueries.resolve` + `renderOutput` say what each name resolves to. This
// turns those answers into one prompt, or into a refusal that stops the send.
//
// WHAT REACHES THE MODEL, AND WHY:
//   - Each RESOLVED session's context block goes AHEAD of the prose, once per
//     SESSION however often it is mentioned, in first-mention order.
//   - A RESOLVED mention is rewritten in the prose from `@TradingApp` to
//     `"TradingApp" (session)`. MEASURED (#798 probe, CLI 2.1.272): the CLI
//     expands any `@word` as a file mention itself — a same-named file in the
//     session's folder is attached, and even a miss cost the model a Read. The
//     rewrite changes only the `@` shape; every word the user typed is still
//     sent, so the user's line is NOT quoted again inside the block (that would
//     send it twice).
//   - A mention of no session, or of the composer's OWN session, is left
//     byte-for-byte as typed — the done-when's negative table.
//   - A draft with no resolved mention comes back EXACTLY as it went in.
//
// KEYED ON WHAT THE USER TYPED, not on what the session list calls it (review
// blocker, #798) — see `FoundMention.typed`. Two answers can therefore point at
// ONE session (`@api` and `@API` where only `api` exists), which is why
// injection is deduplicated on `MentionAnswer.key`, the resolved session's id,
// rather than on the spelling.
//
// AN AMBIGUOUS NAME REFUSES THE WHOLE SEND. Two sessions sharing a title is the
// ordinary result of two checkouts of one repo, and `resolve` refuses it rather
// than picking. Sending the rest of the prompt without that context would be the
// same wrong answer delivered with less warning, so nothing is sent and the
// caller keeps the draft and shows the reason.

import type { FoundMention } from './mention-finder';

export type MentionAnswer =
  | {
      kind: 'resolved';
      /** the rendered context block */
      block: string;
      /** the resolved session's ID — what "the same session twice" is decided on */
      key: string;
    }
  | { kind: 'missing' }
  | { kind: 'own' }
  | { kind: 'ambiguous'; reason: string };

export type MentionPrompt = { ok: true; prompt: string } | { ok: false; refusals: string[] };

/**
 * How much injected context ONE prompt may carry, across every session
 * mentioned in it (review should-fix, #798).
 *
 * `queries.ts` caps each session's output at 20k characters, and nothing bounded
 * the total: `@A @B @C @D` could put 80 KB in front of a one-line question. That
 * matters most where it is least visible — a Terminal-mode session has no typed
 * transport, so the composer falls back to a bracketed paste into the PTY and
 * fires the Enter 75 ms later whether or not the write has drained.
 *
 * Whole blocks, never a cut one: half of a fenced quotation of another session's
 * transcript is worse than an honest note saying it was left out. The note names
 * the sessions, so the model is told rather than left to infer.
 */
export const TOTAL_CONTEXT_CHAR_CAP = 40_000;

/** The prose form of a resolved mention: no `@`, so the CLI does not treat it as a path. */
export function mentionLabel(name: string): string {
  return `"${name}" (session)`;
}

/** Said in-band when the budget stopped a block going in. */
export function leftOutNote(names: readonly string[]): string {
  return (
    `Context from ${names.length === 1 ? 'one more mentioned session' : `${names.length} more mentioned sessions`}` +
    ` (${names.join(', ')}) was left out: the prompt would have been too long.` +
    ' Ask that session directly for it.'
  );
}

/**
 * @param text     the draft as the user wrote it
 * @param found    `findMentions(text, names)`, in order
 * @param answers  one answer per mention AS TYPED (`FoundMention.typed`)
 */
export function buildMentionPrompt(
  text: string,
  found: readonly FoundMention[],
  answers: ReadonlyMap<string, MentionAnswer>
): MentionPrompt {
  const refusals: string[] = [];
  for (const m of found) {
    const a = answers.get(m.typed);
    if (a?.kind === 'ambiguous' && !refusals.includes(a.reason)) refusals.push(a.reason);
  }
  if (refusals.length > 0) return { ok: false, refusals };

  const blocks: string[] = [];
  const leftOut: string[] = [];
  const seen = new Set<string>();
  let budget = TOTAL_CONTEXT_CHAR_CAP;
  for (const m of found) {
    const a = answers.get(m.typed);
    if (a?.kind !== 'resolved' || seen.has(a.key)) continue;
    seen.add(a.key);
    // The FIRST mentions win the budget, which is the order the user wrote them
    // in. A block that does not fit is named rather than trimmed.
    if (a.block.length > budget) {
      leftOut.push(m.typed);
      continue;
    }
    budget -= a.block.length;
    blocks.push(a.block);
  }
  if (leftOut.length > 0) blocks.push(leftOutNote(leftOut));
  if (blocks.length === 0) return { ok: true, prompt: text };

  // EVERY resolved mention is rewritten, including one whose context was left
  // out: the `@` shape is what makes the CLI go looking for a file, and that is
  // true whether or not we had room for the session's output.
  //
  // From the END, so earlier offsets stay valid.
  let prose = text;
  for (const m of [...found].reverse()) {
    if (answers.get(m.typed)?.kind !== 'resolved') continue;
    prose = prose.slice(0, m.start) + mentionLabel(m.typed) + prose.slice(m.end);
  }
  return { ok: true, prompt: `${blocks.join('\n\n')}\n\n${prose}` };
}
