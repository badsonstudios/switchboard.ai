// A draft's `@Name` mentions resolved WITH the handoffs the named sessions wrote
// themselves (#1126) — the composition, and only that.
//
// Each part is tested where it lives: `handoff-request.ts` asks a session and
// ends the wait; `mention-resolve.ts` turns mentions into a prompt;
// `mention-brief.ts` arranges a brief. This puts them in ORDER, and the order
// is where the mistakes were (three of them found in review while it still
// lived inline in `main/index.ts`, which has no tests):
//
//   1. If the send is going to be REFUSED, ask nobody.
//   2. Read what each session had said BEFORE asking it.
//   3. Ask, and wait.
//   4. Look up git state — after the wait, so it is current.
//   5. Build the prompt, each asked session described as it was at step 2.
//
// Without the switch (`selfWritten` false) steps 1–3 do nothing and this is
// exactly the call it replaced.
import type { MentionHandoff, MentionPrompt, MintContextRef } from '../../shared/mention-prompt';
import type { SessionSummary } from '../../shared/sessions';
import { BRIEF_LAST_N, type BriefGitFacts } from './mention-brief';
import type { HandoffOutcome } from './handoff-request';
import { mentionedSessions, resolveMentions, type MentionQueries } from './mention-resolve';

export interface MentionHandoffDeps {
  queries: MentionQueries;
  /** `renderOutput` — the fallback wording for a session with no package */
  render: (output: unknown) => string;
  /** `HandoffRequests.request`, bound */
  request: (sourceId: string, readerId: string, askedBy: string) => Promise<HandoffOutcome>;
  /** the git lookups for the named folders, and the working tree of each plus the reader's */
  lookup: (
    folders: string[],
    readerFolder: string | undefined
  ) => Promise<{ git: (folder: string) => BriefGitFacts | undefined; tree: (folder: string) => string | undefined }>;
  mint: MintContextRef;
  fence: (body: string) => string;
}

export async function resolveMentionsWithHandoffs(
  deps: MentionHandoffDeps,
  text: string,
  ownSessionId: string,
  opts: { selfWritten?: boolean } = {}
): Promise<MentionPrompt> {
  const { queries } = deps;
  const named = mentionedSessions(queries, text, ownSessionId);
  const listed = named.length > 0 ? queries.listSessions() : undefined;
  const me = listed?.ok ? listed.value.find((s) => s.id === ownSessionId) : undefined;

  // ── 1. ask nobody if nothing is going to be sent ───────────────────────────
  // An ambiguous name refuses the whole draft, and finding that out AFTER three
  // sessions had each spent a turn writing would be the app wasting the user's
  // subscription to tell them to retype a name. A dry run — no `mint`, so it
  // marks nothing and costs a lookup.
  const asking = opts.selfWritten === true && named.length > 0;
  if (asking) {
    const dry = resolveMentions(queries, deps.render, text, ownSessionId, {});
    if (!dry.ok) return dry;
  }
  // one request per SESSION, however often it is named: `mentionedSessions` is
  // already one entry per session
  const asked: SessionSummary[] = asking ? named : [];

  // ── 2. what each had said, before it is asked ──────────────────────────────
  // The request and its answer become the newest turn of that session's
  // conversation. A brief read afterwards would quote the handoff a second time
  // under "Recent conversation" and list the app's own request under what the
  // session "was asked". Read first, the brief describes the session as it was
  // when the user pressed Send — which is also when they decided to ask.
  const before = new Map(
    asked.map((s) => [
      s.id,
      {
        context: queries.sessionContext?.(s.id),
        output: queries.sessionOutput(s.id, BRIEF_LAST_N, { compactTools: true }),
      },
    ])
  );

  // ── 3. ask, side by side, and wait for all of them ─────────────────────────
  const outcomes = await Promise.all(
    asked.map((s) =>
      // `request` never rejects by contract; a host that breaks that contract
      // still must not lose the user's send (P6)
      deps.request(s.id, ownSessionId, me?.name ?? '').catch(
        (): HandoffOutcome => ({ kind: 'fallback', reason: 'unreachable', asked: false })
      )
    )
  );
  const written = new Map<string, { text: string; truncated: boolean }>();
  /** sessions whose conversation now ends with the app's own request */
  const touched = new Set<string>();
  const report: MentionHandoff[] = [];
  asked.forEach((s, i) => {
    const outcome = outcomes[i];
    if (outcome.kind === 'written') {
      written.set(s.id, { text: outcome.text, truncated: outcome.truncated });
      touched.add(s.id);
    } else if (outcome.asked) {
      touched.add(s.id);
    }
    report.push({ name: s.name, outcome: outcome.kind === 'written' ? 'written' : outcome.reason });
  });

  // ── 4. git, now ────────────────────────────────────────────────────────────
  const { git, tree } = await deps.lookup(
    named.map((s) => s.folder),
    me?.folder
  );

  // ── 5. the prompt ──────────────────────────────────────────────────────────
  // For a session that was ASKED — whether or not it delivered — the snapshot
  // from step 2. A wait that timed out, or ended on a question, has put the
  // request into that conversation just the same, and its brief must not read
  // "Reply with ONE message, WITHOUT using any tools…" as that session's latest
  // instruction. For a session that was never touched (busy, waiting, not
  // running) there is nothing to hide: it is read now, as if the switch were off.
  //
  // Only a snapshot that SUCCEEDED is used. A read that refused then may well
  // succeed now, and a refusal carried forward would silently drop the mention.
  const asOf = (id: string) => (touched.has(id) ? before.get(id) : undefined);
  const snapshotted: MentionQueries =
    touched.size === 0
      ? queries
      : {
          listSessions: () => queries.listSessions(),
          resolve: (ref) => queries.resolve(ref),
          ...(queries.sessionContext
            ? {
                sessionContext: (ref: string) => {
                  const was = asOf(ref)?.context;
                  return was?.ok ? was : queries.sessionContext!(ref);
                },
              }
            : {}),
          sessionOutput: (ref, lastN, o) => {
            const was = lastN === BRIEF_LAST_N && o?.compactTools ? asOf(ref)?.output : undefined;
            return was?.ok ? was : queries.sessionOutput(ref, lastN, o);
          },
        };
  const prompt = resolveMentions(snapshotted, deps.render, text, ownSessionId, {
    mint: deps.mint,
    fence: deps.fence,
    git,
    tree,
    handoff: (sessionId) => written.get(sessionId),
  });
  return prompt.ok && report.length > 0 ? { ...prompt, handoffs: report } : prompt;
}
