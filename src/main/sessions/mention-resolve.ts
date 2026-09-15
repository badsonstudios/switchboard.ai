// Turning a draft's `@Name` mentions into the prompt it actually sends
// (P2-E11-08, §5.2 Tier 2).
//
// THE COMPOSITION, AND ONLY THAT. Each part already exists and is tested where
// it lives:
//   - `findMentions` says WHERE a known session name is mentioned;
//   - `SessionQueries.resolve` + `sessionOutput` say what the name IS — the
//     same instance, the same caps and the same refusals the bus tools use, so
//     `@TradingApp` in the composer and `get_session_output("TradingApp")` from
//     an agent cannot disagree;
//   - `renderOutput` is #764's wording, fence included (injected by the caller,
//     because it lives with the bus tools);
//   - `buildMentionPrompt` puts the pieces in order.
//
// Here and not inline in `main/index.ts`, which has no tests (#763 review).
//
// HOW EACH NAME IS ANSWERED:
//   - resolves to ANOTHER session  → that session's recent output, rendered;
//   - resolves to the composer's OWN session → left literal;
//   - refused as AMBIGUOUS         → the whole send is refused with `resolve`'s
//     own reason, which names every candidate and its folder;
//   - refused for any other reason → left literal. The name came off the same
//     list a moment ago, so the one way here is a title `resolve` normalises
//     away (leading `@`, surrounding spaces) — and the negative half of #798
//     says an `@` that resolves to nothing reaches the model as typed.

import type { SessionQueries } from './queries';
import { findMentions } from '../../shared/mention-finder';
import { buildMentionPrompt, type MentionAnswer, type MentionPrompt } from '../../shared/mention-prompt';

/** The three query-core calls this needs — narrowed so a test can see which. */
export type MentionQueries = Pick<SessionQueries, 'listSessions' | 'resolve' | 'sessionOutput'>;

export function resolveMentions(
  queries: MentionQueries,
  render: (output: unknown) => string,
  text: string,
  ownSessionId: string
): MentionPrompt {
  const listed = queries.listSessions();
  // No list, nothing to match against: the draft goes as typed, exactly as it
  // did before this feature existed.
  if (!listed.ok) return { ok: true, prompt: text };
  // IDS ARE CANDIDATES TOO (review should-fix, #798). `resolve` matches an id
  // before any name, and it is the escape hatch it offers when two sessions
  // share a title — "Use the session id." So the manual and the refusal both
  // tell the user something true only if `@<id>` is findable in the first place.
  const found = findMentions(text, [
    ...listed.value.map((s) => s.name),
    ...listed.value.map((s) => s.id),
  ]);
  if (found.length === 0) return { ok: true, prompt: text };

  // Keyed on what the USER TYPED, never on the list's spelling — see
  // `FoundMention.typed`. `@api` and `@API` are two keys, and if they resolve to
  // one session the builder injects it once, on `key`.
  const answers = new Map<string, MentionAnswer>();
  for (const typed of new Set(found.map((m) => m.typed))) {
    answers.set(typed, answerFor(queries, render, typed, ownSessionId));
  }
  return buildMentionPrompt(text, found, answers);
}

function answerFor(
  queries: MentionQueries,
  render: (output: unknown) => string,
  typed: string,
  ownSessionId: string
): MentionAnswer {
  const found = queries.resolve(typed);
  if (!found.ok) {
    return found.code === 'ambiguous' ? { kind: 'ambiguous', reason: found.reason } : { kind: 'missing' };
  }
  if (found.value.id === ownSessionId) return { kind: 'own' };
  // BY ID, not by the spelling again: it has been resolved once, and asking a
  // second time is a second chance for it to mean something else.
  const output = queries.sessionOutput(found.value.id);
  if (!output.ok) return { kind: 'missing' };
  return { kind: 'resolved', block: render(output.value), key: found.value.id };
}
