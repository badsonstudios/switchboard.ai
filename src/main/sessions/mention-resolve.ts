// Turning a draft's `@Name` mentions into the prompt it actually sends
// (P2-E11-08, §5.2 Tier 2).
//
// THE COMPOSITION, AND ONLY THAT. Each part already exists and is tested where
// it lives:
//   - `findMentions` says WHERE a known session name is mentioned;
//   - `SessionQueries.resolve` says what the name IS — the same instance and
//     the same refusals the bus tools use, so `@TradingApp` in the composer and
//     an agent asking about "TradingApp" cannot mean different sessions;
//   - `sessionContext` + `sessionOutput` are what it has been doing, and
//     `renderMentionBrief` (#1092) arranges them: facts, what it was asked, the
//     recent conversation with tool calls as one-liners, and how to get more.
//     The data fence is the bus tools' own (`quoted`), injected by the caller;
//   - `renderOutput` — #764's wording — is the FALLBACK, for a session whose
//     handoff package could not be built;
//   - `buildMentionPrompt` puts the pieces in order.
//
// Here and not inline in `main/index.ts`, which has no tests (#763 review).
//
// HOW EACH NAME IS ANSWERED:
//   - resolves to ANOTHER session  → a brief on that session;
//   - resolves to the composer's OWN session → left literal;
//   - refused as AMBIGUOUS         → the whole send is refused with `resolve`'s
//     own reason, which names every candidate and its folder;
//   - refused for any other reason → left literal. The name came off the same
//     list a moment ago, so the one way here is a title `resolve` normalises
//     away (leading `@`, surrounding spaces) — and the negative half of #798
//     says an `@` that resolves to nothing reaches the model as typed.

import type { SessionQueries } from './queries';
import { BRIEF_LAST_N, renderMentionBrief, type BriefGitFacts } from './mention-brief';
import type { SessionSummary } from '../../shared/sessions';
import { findMentions } from '../../shared/mention-finder';
import {
  buildMentionPrompt,
  type MentionAnswer,
  type MentionPrompt,
  type MintContextRef,
} from '../../shared/mention-prompt';

/** The three query-core calls this needs — narrowed so a test can see which. */
export type MentionQueries = Pick<SessionQueries, 'listSessions' | 'resolve' | 'sessionOutput'> &
  // OPTIONAL, so a wiring without the package — the older unit hosts — sends
  // the plain recent output it always sent, through `render`.
  Partial<Pick<SessionQueries, 'sessionContext'>>;

/** What the caller can add that the transcript cannot say (#1092). */
export interface MentionExtras {
  /** mints the forgery ref each injected section is marked with (#830) */
  mint?: MintContextRef;
  /** the bus tools' data fence — drawn round the transcript's text, not the app's facts */
  fence?: (body: string) => string;
  /** a folder's checkout, when the caller found out in time; undefined = unknown */
  git?: (folder: string) => BriefGitFacts | undefined;
  /** a folder's working-tree root (#1098), on the same terms; asked of the READER's folder too */
  tree?: (folder: string) => string | undefined;
}

/**
 * The OTHER sessions a draft names, resolved — for a caller that wants to look
 * something up about each (its git state) BEFORE the prompt is built (#1092).
 *
 * The same finder and the same `resolve` `resolveMentions` uses, so the two
 * cannot disagree about who was mentioned. Ambiguous and unknown names are
 * simply absent: nothing is injected for them, so there is nothing to look up.
 */
export function mentionedSessions(
  queries: MentionQueries,
  text: string,
  ownSessionId: string
): SessionSummary[] {
  const listed = queries.listSessions();
  if (!listed.ok) return [];
  const found = findMentions(text, [
    ...listed.value.map((s) => s.name),
    ...listed.value.map((s) => s.id),
  ]);
  const out = new Map<string, SessionSummary>();
  for (const typed of new Set(found.map((m) => m.typed))) {
    const hit = queries.resolve(typed);
    if (hit.ok && hit.value.id !== ownSessionId) out.set(hit.value.id, hit.value);
  }
  return [...out.values()];
}

/**
 * @param extras  `mint` mints the forgery ref each injected section is marked
 *                with (#830) — OPTIONAL for the same reason `resolveMentions`
 *                itself is optional on the IPC deps: a wiring without it sends
 *                unmarked, which the Feed then declines to collapse, because
 *                the guard fails closed. A bare function is still accepted as
 *                `mint`, which is what this parameter was before #1092.
 */
export function resolveMentions(
  queries: MentionQueries,
  render: (output: unknown) => string,
  text: string,
  ownSessionId: string,
  extras: MentionExtras | MintContextRef = {}
): MentionPrompt {
  const x: MentionExtras = typeof extras === 'function' ? { mint: extras } : (extras ?? {});
  const mint = x.mint;
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
    answers.set(
      typed,
      answerFor(queries, render, typed, ownSessionId, x, listed.value.find((s) => s.id === ownSessionId))
    );
  }
  return buildMentionPrompt(text, found, answers, mint);
}

function answerFor(
  queries: MentionQueries,
  render: (output: unknown) => string,
  typed: string,
  ownSessionId: string,
  extras: MentionExtras,
  reader: SessionSummary | undefined
): MentionAnswer {
  const found = queries.resolve(typed);
  if (!found.ok) {
    return found.code === 'ambiguous' ? { kind: 'ambiguous', reason: found.reason } : { kind: 'missing' };
  }
  if (found.value.id === ownSessionId) return { kind: 'own' };
  // BY ID, not by the spelling again: it has been resolved once, and asking a
  // second time is a second chance for it to mean something else.
  //
  // A BRIEF when the handoff package can be built (#1092), and the plain recent
  // output when it cannot — a wiring without `sessionContext`, or a package
  // read that refused. Either way something true is injected; a mention is
  // never silently emptied because the richer form was unavailable.
  const pkg = queries.sessionContext?.(found.value.id);
  if (pkg?.ok) {
    const said = queries.sessionOutput(found.value.id, BRIEF_LAST_N, { compactTools: true });
    if (!said.ok) return { kind: 'missing' };
    // The FENCE goes round the transcript's text and nothing else: the facts
    // above it and the closing line below it are the app's own, and a reader
    // has to be able to tell which is which (see `mention-brief.ts`).
    const block = renderMentionBrief(
      pkg.value,
      said.value,
      {
        ...(reader ? { readerFolder: reader.folder } : {}),
        ...(extras.git ? { git: safeGit(extras.git, found.value.folder) } : {}),
        ...(extras.tree ? { tree: safeGit(extras.tree, found.value.folder) } : {}),
        ...(extras.tree && reader ? { readerTree: safeGit(extras.tree, reader.folder) } : {}),
      },
      extras.fence
    );
    return {
      kind: 'resolved',
      block,
      key: found.value.id,
      // The RESOLVED session's name, not the spelling that found it (#830) —
      // see `MentionAnswer`.
      name: found.value.name,
    };
  }
  const output = queries.sessionOutput(found.value.id);
  if (!output.ok) return { kind: 'missing' };
  return {
    kind: 'resolved',
    block: render(output.value),
    key: found.value.id,
    name: found.value.name,
  };
}

/** A git lookup that threw is a fact we do not have — never a refused send. */
function safeGit<T>(git: (folder: string) => T | undefined, folder: string): T | undefined {
  try {
    return git(folder);
  } catch {
    return undefined;
  }
}
