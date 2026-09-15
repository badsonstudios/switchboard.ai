// Building the prompt a draft with `@Name` mentions actually SENDS (P2-E11-08).
//
// Pure. The finder (`mention-finder.ts`) says WHERE known names are mentioned;
// `SessionQueries.resolve` + `renderOutput` say what each name resolves to. This
// turns those answers into one prompt, or into a refusal that stops the send.
//
// WHAT REACHES THE MODEL, AND WHY:
//   - Each RESOLVED session's context block goes AHEAD of the prose, once per
//     session however often it is mentioned, in first-mention order.
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
// AN AMBIGUOUS NAME REFUSES THE WHOLE SEND. Two sessions sharing a title is the
// ordinary result of two checkouts of one repo, and `resolve` refuses it rather
// than picking. Sending the rest of the prompt without that context would be the
// same wrong answer delivered with less warning, so nothing is sent and the
// caller keeps the draft and shows the reason.

import type { FoundMention } from './mention-finder';

export type MentionAnswer =
  | { kind: 'resolved'; block: string }
  | { kind: 'missing' }
  | { kind: 'own' }
  | { kind: 'ambiguous'; reason: string };

export type MentionPrompt = { ok: true; prompt: string } | { ok: false; refusals: string[] };

/** The prose form of a resolved mention: no `@`, so the CLI does not treat it as a path. */
export function mentionLabel(name: string): string {
  return `"${name}" (session)`;
}

/**
 * @param text     the draft as the user wrote it
 * @param found    `findMentions(text, names)`, in order
 * @param answers  one answer per mentioned NAME (the finder's spelling)
 */
export function buildMentionPrompt(
  text: string,
  found: readonly FoundMention[],
  answers: ReadonlyMap<string, MentionAnswer>
): MentionPrompt {
  const refusals: string[] = [];
  for (const m of found) {
    const a = answers.get(m.name);
    if (a?.kind === 'ambiguous' && !refusals.includes(a.reason)) refusals.push(a.reason);
  }
  if (refusals.length > 0) return { ok: false, refusals };

  const blocks: string[] = [];
  const injected = new Set<string>();
  for (const m of found) {
    const a = answers.get(m.name);
    if (a?.kind !== 'resolved' || injected.has(m.name)) continue;
    injected.add(m.name);
    blocks.push(a.block);
  }
  if (blocks.length === 0) return { ok: true, prompt: text };

  // Rewrite from the END so earlier offsets stay valid.
  let prose = text;
  for (const m of [...found].reverse()) {
    if (answers.get(m.name)?.kind !== 'resolved') continue;
    prose = prose.slice(0, m.start) + mentionLabel(m.name) + prose.slice(m.end);
  }
  return { ok: true, prompt: `${blocks.join('\n\n')}\n\n${prose}` };
}
