// What a dispatched session is actually handed (P2-E13-02, §5.15).
//
// ── ONE SWITCH, AND IT IS #946's RECORD ─────────────────────────────────────
//
// `shared/dispatch.ts` declares `CONTEXT_SOURCE` as THE ONE PLACE a context
// policy becomes a context source, and says in as many words that this item
// reads it and nothing else decides. This module is the reader. It does not
// branch on `ContextPolicy`; it branches on the source that record maps to, so a
// fourth policy cannot reach here without having said where its context comes
// from — the record is `Record<ContextPolicy, …>` and does not compile until it
// does.
//
// ── THE THREE SOURCES ARE THREE DIFFERENT KINDS OF THING ────────────────────
//
//   `artifact-bundle`  — assembled here, from a diff and a task statement.
//   `context-package`  — #766's generator, DELEGATED TO, not re-implemented.
//   `fork-adoption`    — not a document at all: an instruction to spawn with
//                        `forkFrom`, so the CLI carries the conversation.
//
// That last one is why the return type is a union rather than a string. A fork
// hands over the whole conversation by starting the new session inside a copy of
// it; there is no text to show and no size to estimate, and inventing either
// would be this module describing something it did not build.
//
// ── WHAT THIS MODULE DOES NOT DO ────────────────────────────────────────────
//
// It does not spawn, does not touch IPC and does not know what a role template
// is. It answers one question — "what does policy P hand over from session A" —
// and #948 asks it. Keeping the answer separate from the gesture is what stopped
// #946's enum growing three code paths, and it is the same reason here.
import {
  CONTEXT_SOURCE,
  isContextPolicy,
  type ContextPolicy,
  type ContextSource,
} from '../../shared/dispatch';
import { isConversationId } from '../transcripts/paths';
// The LITERAL below is typed, not stringly: `'package'` is a member of
// `CONTEXT_FIDELITIES`, and importing the type makes a rename of that vocabulary
// a compile error here rather than a refusal at run time.
import type { ContextFidelity } from '../../shared/context-drop';
import { buildCleanRoomBundle, type CleanRoomDiff } from './clean-room';
import type {
  QueryResult,
  SessionContextAnswer,
  SessionDiff,
  SessionSummary,
  SessionTaskStatement,
} from './queries';

/**
 * A briefing, as text the dispatched session is opened with.
 *
 * Both text sources produce this same shape on purpose: the caller renders one
 * thing, and the difference between a clean-room artifact and a Level-2 package
 * is in the document, where the reader that acts on it can see it.
 *
 * Neither variant carries a `truncated` flag, and that is deliberate rather than
 * an omission. Both documents state their own completeness IN BAND — the bundle
 * prints a warning line under a cut diff, the package prints `Covers:` — and the
 * reader that has to act on it is the model reading the text, not the caller
 * holding the object. A second copy of the claim on the outside would be a
 * second thing to keep true.
 */
export interface DispatchBriefing {
  source: Exclude<ContextSource, 'fork-adoption'>;
  text: string;
  /** An order-of-magnitude size, never a count. #766's estimate, copied. */
  tokens: number;
  /** There was nothing to hand over — stated, not inferred from length. */
  empty: boolean;
}

/**
 * An instruction to ADOPT the author's conversation by forking it (§5.5 L3).
 *
 * The fields are exactly `sessions:create`'s `forkFrom` operand, because that
 * path already exists and already re-validates them (#801). Nothing here is a
 * second fork implementation.
 *
 * ⚠️ **`ok` IS NOT A PROMISE THAT THE FORK WILL SUCCEED**, and the boundary is
 * worth stating because the obvious reading is the other one. This module
 * answers the questions a DISPATCH can answer — is the feature switched on, is
 * the target the same provider, is there a conversation at all — and each of
 * those gets one of the three sentences it mints. Whether this provider's
 * adapter can actually fork is `ProviderCapabilities.fork.canFork`, and that is
 * deliberately NOT re-asked here: it is not a static property of a provider but
 * a question about a specific transcript in a specific folder, `planSessionStart`
 * is the one place that asks the adapter anything, and an answer cached here
 * would be a second, weaker copy of it that can go stale between this call and
 * the spawn. A fork that gets past this and fails there surfaces as
 * `StartPlan.forkUnavailable`, which #948 should render rather than swallow.
 */
export interface DispatchFork {
  source: 'fork-adoption';
  fork: {
    /** The author's NATIVE conversation id — not its switchboard session id. */
    sourceSessionId: string;
    /** The folder whose transcript directory holds it. */
    sourceFolder: string;
  };
}

export type DispatchContext = DispatchBriefing | DispatchFork;

/**
 * The fidelity a `briefed` dispatch asks `sessionContextFor` for.
 *
 * The WHOLE document, which is what "briefed" means in §5.15's table — the
 * Level-2 package, not one section of it. Named and typed rather than written as
 * a bare string at the call site, so renaming the fidelity vocabulary is a
 * compile error here instead of a refusal nobody sees until someone dispatches.
 */
const BRIEFED_FIDELITY: ContextFidelity = 'package';

/**
 * A refusal carries TWO channels, and they are for different readers.
 *
 * `reason` is English for a log and for a developer — the same register the rest
 * of the query core answers in. `reasonKey` is an i18n catalogue key and is
 * present exactly when there is a sentence worth SHOWING the user; #946
 * established that shape (`dispatch.refusal.*`) precisely so main-side code can
 * choose which sentence without hardcoding one (§5.21).
 *
 * A refusal with no `reasonKey` is one the user cannot act on and should not see
 * as a dispatch-specific message — an unresolvable session reference from a
 * gesture that started on a real card is a bug, not a state.
 */
export type DispatchContextResult =
  | { ok: true; value: DispatchContext }
  | { ok: false; reason: string; reasonKey?: string };

/**
 * The slice of `SessionQueries` this needs.
 *
 * A structural interface rather than the class, for the reason the class's own
 * deps are injected: this module's tests should be able to say "the diff refused"
 * without standing up a git service. `SessionQueries` satisfies it as written.
 */
export interface DispatchContextQueries {
  resolve(ref: string): QueryResult<SessionSummary>;
  sessionDiff(ref: string): Promise<QueryResult<SessionDiff>>;
  taskStatement(ref: string): QueryResult<SessionTaskStatement>;
  sessionContextFor(ref: string, level?: ContextFidelity): QueryResult<SessionContextAnswer>;
}

export interface DispatchContextDeps {
  queries: DispatchContextQueries;
  /**
   * §5.5 Level 3 is switched on (Settings → Advanced, off by default).
   *
   * A THUNK, and read at the moment of dispatch rather than captured, for the
   * reason `sessions:create` re-checks it: a layout or a template saved while
   * the flag was on must be refused now that it is off, not honoured because it
   * was once legitimate.
   */
  experimentalFork(): boolean;
  /**
   * The author session's native conversation id, or `null` if it has none yet.
   *
   * `SessionSummary` deliberately does not carry this — it is the app's own
   * session id space that a sibling addresses, and the CLI's conversation id is
   * a different space that only the record knows. A session that has not had a
   * turn yet has no conversation to adopt, which is a refusal rather than an
   * empty fork.
   */
  conversationIdFor(sessionId: string): string | null;
}

export interface DispatchContextRequest {
  /** The AUTHOR session — `@name` or id, resolved like every other reference. */
  from: string;
  policy: ContextPolicy;
  /**
   * The provider the dispatched session will run on.
   *
   * Only `fork-adoption` reads it, and it reads it to REFUSE: §5.5 records that
   * transcript formats are not interchangeable, so a conversation cannot be
   * adopted across providers. The two text sources are provider-neutral markdown
   * by construction and do not care.
   */
  targetProviderId: string;
  /**
   * What "done" looks like, for a clean-room bundle. See `CleanRoomSource`.
   *
   * Ignored by the other two sources rather than refused: a briefed dispatch
   * that was given criteria has not asked for anything impossible, and the
   * package it gets is the package #766 builds.
   */
  acceptanceCriteria?: string;
  /**
   * The task, as the DISPATCHING USER stated it (#948).
   *
   * ⚠️ THIS FIELD EXISTS BECAUSE OF A MEASUREMENT, and #947 deliberately did not
   * add it. Run against this repo's own 7.7 MB transcript fixture,
   * `SessionQueries.taskStatement` answers **`"do it."`** — correct and honest,
   * because that really is the first prose the user typed; what precedes it is a
   * slash command (`isCommandPlumbing` skips it, #846) and an `isMeta` line
   * carrying the skill body. So a session started from a slash command — most of
   * the ones this project runs — hands a clean-room reviewer a task statement
   * with no task in it, and clean-room is defined by withholding everything
   * else, which makes this the one field that has to carry the job and the field
   * most likely to be useless.
   *
   * That was not fixable in #947: changing what counts as the opening prompt
   * would make `taskStatement` disagree with #766's package about the same fact,
   * which is exactly the drift both are shared to prevent. It was left as a
   * design input for the gesture, and #948's dialog is the caller — one line,
   * prefilled from what the transcript says, editable before dispatch. A second
   * field with no caller would have been speculative surface; this one has one.
   *
   * ABSENT MEANS READ THE TRANSCRIPT, which is the byte-identical pre-#948
   * behaviour for every existing caller — and a live branch rather than a
   * theoretical one: only `artifact-bundle` reads this field, so #948's dialog
   * offers it only for `clean-room` and omits it entirely for the other two. (The
   * package generator derives its own Goal section, and a second source for one
   * fact is exactly the drift both are shared to prevent.)
   */
  taskStatement?: string;
}

/**
 * `SessionDiff` → what the bundle should SAY about the change.
 *
 * Three facts, kept apart (see `CleanRoomDiff`). The refusal branch is safe to
 * treat as "git would not answer" only because the caller resolved the session
 * first — otherwise an unknown session name would arrive here and be rendered to
 * a reviewer as a git problem.
 */
function asCleanRoomDiff(result: QueryResult<SessionDiff>): CleanRoomDiff {
  if (!result.ok) return { state: 'unavailable', why: result.reason };
  const { isRepo, diff, truncated } = result.value;
  if (!isRepo) return { state: 'not-a-repo' };
  if (diff.trim() === '') return { state: 'clean' };
  return { state: 'diff', text: diff, truncated };
}

/**
 * What policy `P` hands over from session `A`.
 *
 * `async` because the diff is — `GitService` shells out. The other two sources
 * are synchronous reads and are awaited for nothing, which is the right trade
 * against two entry points for one question.
 */
export async function buildDispatchContext(
  deps: DispatchContextDeps,
  req: DispatchContextRequest
): Promise<DispatchContextResult> {
  // RESOLVED ONCE, UP FRONT, and everything below addresses the session by id.
  // Two reasons, and the second is the load-bearing one: a name resolves against
  // a list that can change between calls, so three lookups could answer about
  // three different sessions; and `sessionDiff`'s refusal is indistinguishable
  // from a resolve failure, so without this the bundle would tell a reviewer
  // that git had failed when the truth was that nobody knew which session was
  // meant.
  const found = deps.queries.resolve(req.from);
  if (!found.ok) return { ok: false, reason: found.reason };
  const session = found.value;

  // ⚠️ A RUNTIME FLOOR UNDER AN EXHAUSTIVE SWITCH, and it is not ceremony.
  // `CONTEXT_SOURCE` is total over `ContextPolicy`, so `tsc` is satisfied — but
  // `req.policy` is only a `ContextPolicy` by declaration. A `workspace.json`
  // written by a newer build, or an IPC payload if #948 ever sends a policy
  // rather than a template id, produces a value that is in neither the union nor
  // the record: the lookup is `undefined`, no case matches, and the function
  // resolves `undefined`. Every caller does `got.ok` and gets a `TypeError` —
  // which is the worst available version of "a refusal reported as something
  // else". `isContextPolicy` is the shared predicate that guards the same door
  // for the workspace store.
  const source: ContextSource | undefined = isContextPolicy(req.policy)
    ? CONTEXT_SOURCE[req.policy]
    : undefined;
  if (source === undefined) {
    return { ok: false, reason: `unknown context policy ${JSON.stringify(req.policy)}` };
  }

  switch (source) {
    case 'artifact-bundle': {
      // THE DIFF COMES FROM `get_session_diff`'s OWN ANSWER (#764), not from a
      // second git call. The issue is explicit about it and the reason is the
      // one this codebase keeps rediscovering: one question, two
      // implementations, and the day either grows a cap or a cut the other does
      // not, two surfaces describe the same change differently.
      const diff = await deps.queries.sessionDiff(session.id);
      // ── WHAT THE BUNDLE IS TOLD THE TASK WAS ─────────────────────────────
      //
      // THE CALLER'S OVERRIDE WINS, AND THE TRANSCRIPT IS NOT READ WHEN IT IS
      // GIVEN. Not "read both and prefer one": a `taskStatement` query opens the
      // transcript's head window, and doing that to throw the answer away is
      // work for nothing on the path that spends a subscription turn. The
      // override is what the user typed into the dispatch dialog, which was
      // prefilled from this same query — so the read already happened, once,
      // when the dialog opened.
      //
      // A BLANK OVERRIDE IS A CHOICE AND IS HONOURED AS ONE. `''` after trimming
      // means the user cleared the line, and the bundle then prints `TASK_UNKNOWN`
      // — "not known" — rather than quietly substituting the `"do it."` the user
      // had just deleted. `??` and not `||` for exactly that reason.
      //
      // FAIL-OPEN ON THE TASK STATEMENT, not on the diff's refusal either: both
      // are rendered as sentences inside the document. A reviewer told "the
      // diff could not be read" can say so in its findings; a dispatch that
      // refused outright would leave the user with a toast and no session.
      const stated =
        req.taskStatement ??
        (() => {
          const task = deps.queries.taskStatement(session.id);
          return task.ok ? task.value.text : undefined;
        })();
      const bundle = buildCleanRoomBundle({
        session,
        diff: asCleanRoomDiff(diff),
        ...(stated === undefined ? {} : { taskStatement: stated }),
        ...(req.acceptanceCriteria === undefined
          ? {}
          : { acceptanceCriteria: req.acceptanceCriteria }),
      });
      return {
        ok: true,
        value: {
          source: 'artifact-bundle',
          text: bundle.text,
          tokens: bundle.tokens,
          empty: bundle.empty,
        },
      };
    }

    case 'context-package': {
      // ⚠️ A CALLER, NOT A SECOND GENERATOR — the item's second done-when, and
      // this branch is the whole of it. `sessionContextFor(id, 'package')` is
      // the existing agent-pulled path: it builds #766's package, renders it
      // through `buildContextOffer`'s `package` fidelity, and reports that
      // option's own estimate. Every field below is copied. Nothing is
      // recomputed, no heading is added, and the text a briefed dispatch
      // receives is byte-identical to the text `get_session_context` returns for
      // the same session — which is the property that makes one honesty rule
      // (§5.5's "a briefed continuation, never a resumption") cover both.
      const answer = deps.queries.sessionContextFor(session.id, BRIEFED_FIDELITY);
      if (!answer.ok) return { ok: false, reason: answer.reason };
      return {
        ok: true,
        value: {
          source: 'context-package',
          text: answer.value.text,
          tokens: answer.value.tokens,
          empty: answer.value.empty,
        },
      };
    }

    case 'fork-adoption': {
      // ── THREE GATES, AND THE ORDER IS CHEAPEST-AND-MOST-GENERAL FIRST ──────
      //
      // Each refuses for a different reason and each names a different fix, so
      // they are three sentences rather than one. `contextPolicyRefusalKey` in
      // `shared/` answers the first of them for a UI that wants to grey a menu
      // row out before anyone clicks; the other two need facts — a provider, a
      // record — that a shared module has no access to, which is why they live
      // here and not there.
      if (!deps.experimentalFork()) {
        return {
          ok: false,
          reason: 'fork adoption is off (experimental)',
          reasonKey: 'dispatch.refusal.fullContext',
        };
      }
      // §5.5: TRANSCRIPT FORMATS ARE NOT INTERCHANGEABLE. Adopting a Claude
      // conversation into another vendor's CLI is not a degraded handoff, it is
      // a file that adapter cannot read — and #801's own done-when says this
      // path must not be reachable from a cross-provider dispatch at all.
      if (req.targetProviderId !== session.providerId) {
        return {
          ok: false,
          reason:
            `cannot adopt a ${session.providerId} conversation into a ` +
            `${req.targetProviderId} session`,
          reasonKey: 'dispatch.refusal.crossProviderFork',
        };
      }
      const conversation = deps.conversationIdFor(session.id);
      if (!conversation) {
        // A REFUSAL RATHER THAN A FRESH SESSION, which is the same call
        // `start-plan.ts` makes for an unresolvable fork: somebody asked for
        // this conversation specifically, and quietly opening an empty one
        // instead looks exactly like the app lost it.
        return {
          ok: false,
          reason: 'that session has no conversation to adopt yet',
          reasonKey: 'dispatch.refusal.noConversation',
        };
      }
      // ⚠️ A SEPARATE BRANCH, AND A KEYLESS ONE. `isConversationId` is the same
      // guard `sessions:create` applies to this field (#838) — the value is
      // interpolated into a path and handed to the CLI as `--resume`'s operand,
      // where a leading dash reaches argv as a flag — but it is checking OUR OWN
      // RECORD, so a failure here is a bug and not a state.
      //
      // Folding it into the branch above was the first version and it was wrong:
      // `dispatch.refusal.noConversation` says "this session has not had a turn;
      // give it something to do first", which for a present-but-malformed id is
      // both false and a remedy that cannot work. This module's own rule is that
      // a `reasonKey` is for something the user can act on.
      if (!isConversationId(conversation)) {
        // ECHOED BACK BOUNDED, for `describeLevel`'s reason one module over: a
        // corrupt record can hold anything, and this goes to a log. Enough to
        // see the shape of what went wrong, not enough to be the log entry.
        const shown = conversation.length > 40 ? conversation.slice(0, 40) + '…' : conversation;
        return {
          ok: false,
          reason: `that session's conversation id is not usable: ${JSON.stringify(shown)}`,
        };
      }
      return {
        ok: true,
        value: {
          source: 'fork-adoption',
          // The AUTHOR's folder, which is not necessarily where the dispatched
          // session will run — `StartPlan.requestedFork` spends a paragraph on
          // exactly this, because collapsing the two looks right for the
          // same-folder case and silently answers "no such conversation" for
          // the cross-folder one the feature exists for.
          fork: { sourceSessionId: conversation, sourceFolder: session.folder },
        },
      };
    }
  }
}
