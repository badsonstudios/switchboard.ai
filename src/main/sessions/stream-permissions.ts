// can_use_tool -> the approval bar (P2-E18-07).
//
// THE REASON THIS EPIC EXISTS.
//
// Measured 2026-08-01: editing a file in a project's own `.claude/` folder
// prompted the owner TWICE — our bar, then the CLI's own terminal prompt six
// seconds after he allowed it. The CLI honours a hook's
// `permissionDecision:"allow"` for the ordinary permission layer and then
// applies its `.claude/` safety check ON TOP, which a hook verdict does not
// satisfy. His answer was discarded.
//
// The identical write arrives here as a `can_use_tool` control request, and
// answering it allow WRITES THE FILE with no second prompt (S-10 probe B). The
// same verdict is worth more from this channel than from a hook.
//
// Deliberately shaped like `HookListener`'s permission half — same
// `PermissionRequest`, same `onPermissionRequest` / `onPermissionResolved` /
// `pendingRequests` / `decide` — so `sessions/ipc.ts` wires it identically and
// the renderer's approval bar cannot tell the two apart. A second request type
// would mean a second bar to keep in step with the first.
import { PermissionRequest } from '../hooks/hook-listener';
import { Logger } from '../log/logger';
import { asDisplayString } from '../../shared/display-string';
import { controlResponse } from '../../shared/stream-protocol';
import { ASK_USER_QUESTION_TOOL } from '../../shared/ask-user-question';
import { SessionEvent } from './state-machine';

/**
 * How big a renderer-supplied `updatedInput` may be (#563).
 *
 * This is the first payload that travels RENDERER -> main -> the CLI's stdin
 * rather than the other way, so it is the first one where "it came from our own
 * window" is the only thing vouching for it. The cap is not about malice — it is
 * that a paste into the Other field is unbounded, stdin is a shared pipe, and a
 * megabyte of text wedged into a control_response would take the session's
 * transport down with it. 128 KB is ~40x the largest question payload the probe
 * produced and still small enough to be irrelevant to the pipe.
 */
const MAX_UPDATED_INPUT_BYTES = 128 * 1024;

/**
 * A QUESTION HAS NO DEADLINE while a window is open (#570).
 *
 * It had thirty minutes (#563), and the owner lost an answer to it: he was
 * asked something, stepped away for longer than that, came back and answered —
 * and the answer went nowhere, because switchboard had already told the CLI
 * "nobody answered this in time" and moved on. Stepping away mid-question is
 * ordinary behaviour, not misuse, and a deadline that punishes it is a deadline
 * measuring the wrong thing.
 *
 * NOTHING IS AT RISK WITHOUT IT, and that is why the number is gone rather than
 * merely bigger. Every way this could wedge a session is already answered
 * elsewhere, by paths that fire on an EVENT instead of on a clock:
 *
 *   * no window to ask at all      -> `offer` denies before it ever holds;
 *   * the renderer dies or the window closes with a question parked
 *                                  -> `releaseHeld`, from `onRendererLost`;
 *   * the card is closed or the session exits
 *                                  -> `forgetSession`, from the teardowns.
 *
 * What the timer governed, once those are subtracted, is only "how long may a
 * person take to answer" — and the CLI itself waits for ever (measured: 180s
 * with no TUI fallback and no timeout of its own). So the honest answer is: as
 * long as they like, until something real says they cannot.
 *
 * A PERMISSION still has its deadline. It is a glance and a click, the CLI is
 * blocked on it, and five minutes of no answer there is a different signal.
 */
const NO_DEADLINE = null;

/**
 * Is this the CLI asking a QUESTION rather than asking for permission?
 *
 * The difference decides one thing here and it is not cosmetic: an allow-all
 * session must not answer it (see `offer`). Everything else about the request —
 * the hold, the deadline, the fail-open deny — is identical, because the CLI is
 * blocked on us in exactly the same way.
 */
function isQuestion(tool: string): boolean {
  return tool === ASK_USER_QUESTION_TOOL;
}

/**
 * Is this the `answers` map the CLI actually accepts? (#563)
 *
 * The measured shape and only that: a non-empty plain object whose every value
 * is a non-empty string. Not a stylistic check — an array value and an empty map
 * are shapes the probe never sent, so what the CLI would do with them is
 * unknown, and "unknown" is not something to find out on a live session.
 *
 * UNCHANGED BY #567, deliberately, and this is the distinction that matters: a
 * SHORT map is now a first-class answer — the probe measured a partial one and
 * the CLI reads the omitted question as skipped (findings §3a) — and this
 * function has always allowed one, because what it counts is entries, not
 * questions. What it refuses is the EMPTY map, which is the one shape still
 * unmeasured, and an empty-string VALUE, which is the shape the UI has a
 * measured alternative to (omit the key). The renderer holds the same line one
 * step earlier (`anyAnswered` + `buildAnswers`); this is that rule enforced on
 * the side that is allowed to enforce it.
 */
function answersLookRight(answers: unknown): boolean {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
  const entries = Object.entries(answers as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(([q, a]) => q.length > 0 && typeof a === 'string' && a.trim().length > 0);
}

/** How we answer: the manager knows which transport a session is on. */
export type SendToSession = (sessionId: string, msg: unknown) => boolean;

/**
 * How a decision reaches the STATUS machine — `SessionManager.apply` (#310).
 *
 * REQUIRED, and that is the point. The hook path has had this since E2-05
 * (`HookListener` takes the manager in its options); the stream path shipped
 * without it, and nothing complained, because there was nothing to complain
 * with. A card sat in `needs-permission` from the moment `can_use_tool`
 * arrived until the CLI's NEXT `assistant`/`stream_event` — one whole tool
 * round trip, ~5s in Dan's dogfooding — with nothing held and nothing to
 * answer. Optional, it would go missing again the first time a call site
 * forgot, exactly as silently; required, forgetting is a compile error, which
 * is how the five existing call sites were found rather than hunted for.
 *
 * A narrow function rather than the manager itself, matching `send` beside it:
 * this router answers the CLI and moves a badge, and handing it the object that
 * can also spawn, kill and remove sessions would be handing it the ability to
 * do something it has no business doing.
 */
export type ApplyStatus = (sessionId: string, ev: SessionEvent) => void;

/**
 * Is there a surface in the app that could SHOW this session's question? (#333)
 *
 * Not the same question as `hasLiveWindow`, and the difference is the whole of
 * this issue. A window can be wide open and a particular session still be
 * unreachable: a stream request is pushed as `sessions:permissionRequest`
 * stamped with the card that owns the live session (`registerSessionIpc`'s
 * `cardOfLive`), and every mounted card drops what is not its own
 * (`intakePermission` returns early on `r.cardId !== cardId`). A request whose
 * session has NO card is therefore stamped `cardId: undefined`, matches no card,
 * and is shown to nobody — while the router happily holds it, the badge says
 * `needs-permission`, and the CLI blocks. Before #319 that was for ever; after
 * it, it was five minutes of silence followed by a decline the user never saw
 * offered. Neither is an answer.
 *
 * There are exactly two ways to be unbound, and neither is a user asking a
 * question that deserves a home. `sessions:create` binds the card in the same
 * synchronous stretch that spawns the session — no `await` between them, which
 * is why nothing can arrive in the gap (see `bindLive`) — and `tearDownLive`
 * unbinds only AFTER `manager.remove` has retired the session. So it is either
 * a straggler from a teardown, or a binding this process lost. Both get
 * declined; `offer` tells them apart by whether the deny could still be
 * delivered.
 *
 * WHY DECLINE RATHER THAN SURFACE IT SOMEWHERE GLOBAL. Not because nothing
 * could carry it — the shell's ledger is not card-filtered, so an unbound
 * request already reaches it (`App.tsx`), and `chooseBatch` drops it only for
 * want of a second session with an identical key. That is an accident of
 * arity, not a design, and it argues the other way: a global **Allow** on a row
 * the user cannot NAME, LOCATE or REVEAL is the hazard `permission-toast.ts`
 * refuses in so many words — "a toast with an Allow button that says only
 * 'needs permission' asks the user to grant a tool call they cannot see — which
 * is worse than no toast at all". §5.12 says the same of attention surfaces in
 * general: "Each item shows the **session name** with the **task label**
 * beneath it (never raw session ids)". An unbound session has no card, so it
 * has no name (§5.11's identity kit is keyed by card), no rail row and nothing
 * `reveal` could focus. The honest answer is a fast, distinctly-worded decline.
 *
 * Wired by `registerSessionIpc` (see `setAnswerSurfaceProbe`), which owns the
 * binding this reads — as `cardOfLive.has(id)`, which answers "is there a card
 * id to stamp", not the broader "will anyone actually look". A card that is
 * merely hidden or popped out is not mounted either, and those still HOLD. That
 * is the conservative direction on purpose: a hold is recoverable by the user
 * coming back, a deny is not. Absent, this router behaves exactly as it did
 * before #333.
 */
export type AnswerSurfaceProbe = (sessionId: string) => boolean;

/**
 * The fail-open half (#319). Optional, and both default to the hook path's
 * behaviour, so a call site that knows nothing about either is no worse off
 * than it was — but the app wires both, and there is only one app.
 */
export interface StreamPermissionsOptions {
  /**
   * Is there a renderer that could answer a hold? Same provider the hook path
   * takes (`HookListener.hasLiveWindow`), and it must be the same expression:
   * two liveness checks that could disagree would mean one channel failing open
   * while the other parks.
   */
  hasLiveWindow?: () => boolean;
  /** How long a question may go unanswered. Defaults to the hook path's 300s. */
  holdTimeoutMs?: number;
}

interface Pending {
  sessionId: string;
  /** the CLI's own request id — what the control_response must echo back */
  nativeRequestId: string;
  request: PermissionRequest;
  /** the fail-open deadline (#319), or null for a question (#570) — cleared by
   *  every exit from `pending` */
  timer: NodeJS.Timeout | null;
}

export class StreamPermissions {
  private readonly pending = new Map<string, Pending>();
  private readonly requestListeners = new Set<(r: PermissionRequest) => void>();
  private readonly resolvedListeners = new Set<(requestId: string) => void>();
  /**
   * LIVE sessions where the user chose "Allow all (this session)" (#319).
   *
   * The stream twin of `HookListener.allowAllSessions`, and it exists for the
   * same reason that one does: an allow-all session must not hold, beep, or
   * round-trip the renderer for every gated call — the verdict is answered
   * right here. Until this existed, stream allow-all was RENDERER-ONLY (a Set
   * in `sessionStore`), so `sessions:allowAllSession` told main nothing, and an
   * allow-all Direct session still needed a live window to run a gated tool.
   *
   * Keyed by LIVE id so a respawn asks again — `HookListener`'s semantics, and
   * the renderer's (`sessionStore.allowAllByLive`). Cleared in `forgetSession`,
   * which is where a live id stops existing.
   */
  private readonly allowAllSessions = new Set<string>();
  /**
   * Sessions already warned about having no window to ask — see `offer`.
   * Membership means "warned about the outage we are IN", not "warned once,
   * ever": `offer` re-arms it the moment a live window is seen again (#334).
   */
  private readonly noWindowWarned = new Set<string>();
  /**
   * Sessions already reported as having no surface to ask on (#333).
   *
   * `noWindowWarned`'s twin, re-armed the same way and for the same reason:
   * membership means "reported about the state we are IN". A session that
   * regains a binding re-arms, so a second unbinding is loud again.
   */
  private readonly unroutableWarned = new Set<string>();
  /** see `setAnswerSurfaceProbe` — absent until `registerSessionIpc` wires it */
  private answerSurface: AnswerSurfaceProbe | null = null;

  constructor(
    private readonly send: SendToSession,
    private readonly applyStatus: ApplyStatus,
    private readonly log: Logger,
    private readonly opts: StreamPermissionsOptions = {}
  ) {}

  /**
   * Is there a renderer that could answer a hold? A provider that THROWS counts
   * as "no" — "I can't tell" must never resolve to "park the CLI". Absent
   * provider = assume yes (unit tests, and any call site that predates #319).
   *
   * Copied in shape from `HookListener.windowLive` deliberately: the two are
   * the same question asked by the two channels, and a reader who has
   * understood one has understood both.
   */
  private windowLive(): boolean {
    try {
      return this.opts.hasLiveWindow?.() !== false;
    } catch (err) {
      this.log.warn('window liveness check threw — treating as no window', {
        error: String(err),
      });
      return false;
    }
  }

  /**
   * Teach this router which live sessions have a surface that can show a
   * question (#333). See `AnswerSurfaceProbe` for what the question means.
   *
   * A SETTER rather than a fourth constructor option, unlike #319's two, and
   * the ownership is why: the binding this reads is `registerSessionIpc`'s own
   * `cardOfLive` map, which does not exist until that function runs — and this
   * router is constructed several hundred lines before it, in `main/index.ts`.
   * The alternative was a late-bound `let` in `index.ts` (the shape
   * `cardIdForLive` and `sessionIpcRef` use for the rules engine and the toast),
   * whose unwired default is `() => null` — i.e. "no card", i.e. DENY
   * EVERYTHING, for the window between construction and wiring. Nothing can
   * offer in that window today, but a default that is one refactor away from
   * denying every gated call in the app is not a default to write down. Unset,
   * this probe means "hold", which is the pre-#333 behaviour and the safe half.
   *
   * `manager.setPermissionHoldSuppressor` is the same shape for the same
   * reason: a predicate that only its owner can answer, handed over when the
   * owner exists.
   */
  setAnswerSurfaceProbe(probe: AnswerSurfaceProbe): void {
    this.answerSurface = probe;
  }

  /**
   * Could a request for this session be SHOWN to someone? (#333)
   *
   * Fails toward HOLDING — no probe, or a probe that throws, means yes — and
   * that is the opposite of `windowLive` above, deliberately. The asymmetry is
   * in what each mistake costs. Holding when no window exists parks the CLI with
   * nothing that can ever answer, so "I can't tell" must resolve to deny.
   * Holding when we cannot tell whether a card owns the session costs at most
   * a bounded park: the request is pushed, a card that owns it shows it, and
   * the 300s deadline is underneath either way. Denying instead takes a
   * question the user COULD have answered off their screen, permanently. A
   * bounded wrong wait beats an unbounded wrong verdict.
   *
   * The reviewer's correction, kept because it is the honest version: if the
   * probe throws then `cardOfLive` is broken, and the push listener's very next
   * act is `cardOfLive.get(...)` — which throws too, and `offer`'s per-listener
   * catch swallows it, so in THAT world nothing is shown and the park runs its
   * full course. The choice is still right; the claim that "a card that does own
   * it still shows it" was not. The probe as wired is `Map.has`, which cannot
   * throw, so this branch is a guard against a future one that can.
   */
  private answerable(sessionId: string): boolean {
    if (!this.answerSurface) return true;
    try {
      return this.answerSurface(sessionId) !== false;
    } catch (err) {
      this.log.warn('answer-surface probe threw — holding the request anyway', {
        sessionId,
        error: String(err),
      });
      return true;
    }
  }

  /**
   * Offer one `control_request` to the user. Ignores anything that is not
   * `can_use_tool` — `hook_callback` and `mcp_message` ride the same channel
   * and are plumbing, not questions.
   *
   * Four ways out — the first three in the hook path's order (#319), the fourth
   * added by #333:
   *
   * 1. **allow-all** — answered here, no hold, no push, no beep;
   * 2. **no live window** — answered here as a DENY, because nobody can;
   * 3. **no card owns this session** — answered here as a DENY too, with a
   *    DIFFERENT reason, because the window is fine and this one session's
   *    question has nowhere to appear;
   * 4. otherwise it is held, on a deadline.
   *
   * Order matters. 1 before 2 is the same order `HookListener.maybeHold` uses:
   * an allow-all verdict never needed a renderer, so checking liveness first
   * would turn allows into denies the moment the user closed the window. 2
   * before 3 is #333's own choice: they answer the same way, so the only thing
   * the order decides is WHICH reason the model is told, and "there was no
   * window open" is the true and useful one when both are so — the missing card
   * is a consequence of the app going away, not a separate fault to report.
   */
  offer(sessionId: string, msg: Record<string, unknown>): void {
    if (msg.type !== 'control_request') return;
    const req = msg.request as Record<string, unknown> | undefined;
    if (req?.subtype !== 'can_use_tool') return;

    const nativeRequestId = asDisplayString(msg.request_id);
    if (!nativeRequestId) {
      // Unanswerable: with no id there is nothing to echo back, so offering it
      // would park the card on a question whose answer goes nowhere.
      this.log.warn('can_use_tool with no request_id — ignored', { sessionId });
      return;
    }
    // Namespaced so a stream request can never collide with a hook request id
    // in the single `decidePermission` channel they share.
    const requestId = `stream:${sessionId}:${nativeRequestId}`;
    if (this.pending.has(requestId)) return; // duplicate delivery

    const request: PermissionRequest = {
      requestId,
      sessionId,
      tool: asDisplayString(req.tool_name, 'unknown'),
      input: (req.input as Record<string, unknown>) ?? {},
      source: 'stream',
      reason: typeof req.decision_reason === 'string' ? req.decision_reason : undefined,
      reasonType: typeof req.decision_reason_type === 'string' ? req.decision_reason_type : undefined,
      displayName: typeof req.display_name === 'string' ? req.display_name : undefined,
      suggestions: Array.isArray(req.permission_suggestions)
        ? (req.permission_suggestions as Array<Record<string, unknown>>)
        : undefined,
    };

    // 1. Allow-all: the user already answered every question this session will
    //    ask. Answer at the server — no pending entry, no listener push, and
    //    therefore no `sessions:permissionRequest`, no review bar, and no
    //    Events entry (the last one comes from the STATUS, suppressed at
    //    `SessionManager.onMessage`; see `setPermissionHoldSuppressor`).
    //    A QUESTION IS EXEMPT, and this is #563's sharpest edge. "Allow all
    //    tools in this session" is not "answer all questions in this session",
    //    and the CLI is unambiguous about what a bare allow means: probe mode
    //    `empty` sent `updatedInput` with no `answers` and got back **"The user
    //    did not answer the questions."** So auto-allowing here would not be a
    //    generous default — it would silently skip every question the session
    //    ever asks, from the ONE path that never pushes anything to the
    //    renderer, so the user would not even see what they missed. A question
    //    holds like any other request and waits for a person.
    if (this.allowAllSessions.has(sessionId) && !isQuestion(request.tool)) {
      const sent = this.send(sessionId, controlResponse(nativeRequestId, { behavior: 'allow', updatedInput: request.input }));
      // NO `applyStatus`, deliberately, and this is the exact mirror of the
      // hook path: `maybeHold` returns 'answered' for an allow-all session and
      // the caller applies nothing, because a question that was never asked has
      // no answer to record. The hold is suppressed BEFORE it is applied
      // (`SessionManager.setPermissionHoldSuppressor`), so there is nothing here
      // to undo.
      //
      // Resolving anyway would look like free insurance and is not: this
      // session can be in `needs-permission` for a reason that has nothing to do
      // with this call — a request offered before the grant and still sitting in
      // the card's queue, or a `Notification` hook on a mixed session — and
      // walking it to `working` would put the status back to lying, which is
      // the whole of #310 pointed the other way.
      this.log.debug('gated call auto-allowed (allow-all session)', {
        sessionId,
        requestId,
        tool: request.tool,
        delivered: sent,
      });
      return;
    }

    // 2. Nobody to ask — the window is closed, destroyed, or its renderer
    //    crashed while sessions kept running. Holding here parks the CLI FOR
    //    EVER: nothing else answers a `control_request`, and unlike a held
    //    PreToolUse there is no TUI prompt waiting behind it to take over.
    //
    //    So this channel's fail-open is a DENY, for the reason `forgetSession`
    //    gives below: a `can_use_tool` has no "no opinion" answer — the
    //    transport IS the decision — and a refused tool call is recoverable
    //    where a wedged session is not. The user can always ask again.
    if (!this.windowLive()) {
      // Loud the first time per session, quiet after: a closed window with a
      // busy session produces one of these per gated call, and a log that
      // repeats one line for ever is a log nobody reads (the hook path's rule).
      const first = !this.noWindowWarned.has(sessionId);
      this.noWindowWarned.add(sessionId);
      const where = { sessionId, requestId, tool: request.tool };
      const message = this.unavailable('No switchboard window was open to review this request');
      this.send(sessionId, controlResponse(nativeRequestId, { behavior: 'deny', message }));
      // Unlike `forgetSession`, this session is ALIVE and carries on: the
      // `permission-held` that `streamStatusEvent` already applied one message
      // ago has to end, or the card the user eventually reopens shows a
      // question that was answered while they were away.
      this.applyStatus(sessionId, { kind: 'permission-resolved' });
      if (first) this.log.warn('no live window to ask — denying to keep the session moving', where);
      else this.log.debug('no live window to ask — denying to keep the session moving', where);
      return;
    }
    // A window is back. Re-arm the warning so the NEXT outage is loud again
    // (#334) — same fix, same reason, same place as `HookListener.maybeHold`,
    // because these two blocks are the same question asked by the two channels
    // and must not drift. `forgetSession` clears it too, but only when the
    // session itself ends; a session outlives many windows.
    this.noWindowWarned.delete(sessionId);

    // 3. There is a window, and this session is not in it (#333).
    //
    //    The push below is stamped with the card that owns the live session,
    //    and every mounted card drops what is not its own. With no card there
    //    is no stamp, so the request is offered to a room with nobody in it:
    //    held here, `needs-permission` on a badge nothing renders, and the CLI
    //    blocked. #319 stopped that being FOR EVER by putting a 300s deadline
    //    under it — a backstop, and the reason this issue exists. Five minutes
    //    of silence followed by a decline is not better than a decline; it is
    //    the same decline with the session wedged first.
    //
    //    So: decline it now, and say something DIFFERENT from every other way
    //    this router can decline, because the user-visible symptom is different
    //    and the fix is ours, not theirs. See `AnswerSurfaceProbe` for why the
    //    answer is not "show it somewhere global instead": an unbound live
    //    session has no card, no rail row and no name, so any surface offering
    //    Allow for it would be asking the user to grant a tool call they cannot
    //    see or locate.
    if (!this.answerable(sessionId)) {
      const where = { sessionId, requestId, tool: request.tool };
      const message = this.unavailable(
        'Switchboard lost track of which of its cards this session belongs to and had nowhere ' +
          'on screen to show this request'
      );
      const delivered = this.send(
        sessionId,
        controlResponse(nativeRequestId, { behavior: 'deny', message })
      );
      // Same reason as the no-window branch: an unbound session that is still
      // ALIVE carries on, so the `permission-held` applied one message ago has
      // to end. A no-op for the straggler below — `SessionManager.apply` drops
      // events for sessions it no longer knows — which is exactly why this is
      // safe to call unconditionally.
      //
      // NOT suppressed at the pump the way allow-all is, and that was weighed
      // (#333 review). `setPermissionHoldSuppressor` could be widened to cover
      // this case, which would stop the `needs-permission` -> `working` flap and
      // the beep it rings. Two reasons not to. The flap cannot happen for the
      // straggler at all — `apply` has already dropped both halves — so the only
      // session it could reach is the alive-and-unbound one, which is the bug;
      // and there the beep is the ONE thing in the app that says out loud that
      // something is wrong, in a case whose whole history is that it was silent
      // for five minutes. Suppressing it would make the invariant violation
      // quieter, not the app calmer.
      this.applyStatus(sessionId, { kind: 'permission-resolved' });
      // HOW LOUD depends on whether anybody was still listening, and `send` is
      // the only thing that knows (#333 review).
      //
      // `sendToTransport` returns false when the manager has no handle for this
      // session — which happens exactly once: `manager.remove` deletes the
      // handle, and `tearDownLive` calls it a step BEFORE `unbindLive`. So a
      // request arriving here undelivered is a STRAGGLER: bytes that were
      // already in the CLI's stdout buffer when the user hit Restart or closed
      // the card, ingested a tick later against a session that has been retired
      // (`StreamService.remove` drops the session from its map without
      // detaching the listener). Nothing is wrong, nobody is blocked, and the
      // deny went to a closed pipe. That is a `debug` line, not a fault.
      //
      // A DELIVERED one is the real thing this gate is for: a session that is
      // alive, is being spoken to, and has no card. That is a binding this
      // process lost — `error`, once per unbinding and quiet after, because a
      // busy unbound session produces one per gated call.
      const line = 'no card owns this session — denying at once rather than parking it';
      if (!delivered) {
        this.log.debug(`${line} (session already torn down)`, where);
        return;
      }
      const first = !this.unroutableWarned.has(sessionId);
      this.unroutableWarned.add(sessionId);
      if (first) this.log.error(line, where);
      else this.log.debug(line, where);
      return;
    }
    // Bound again — re-arm, exactly as the window gate above does.
    this.unroutableWarned.delete(sessionId);

    // 4. Held, on a deadline.
    //
    // A QUESTION GETS A LONGER ONE (#563), and the asymmetry is the point. The
    // 300s deadline exists to stop a session wedging when nobody CAN answer —
    // and both of those cases are already handled above, where a dead window
    // (#319) and an unbound session (#333) are denied outright. What is left is
    // a live window with a person in front of it who can see THIS session, and
    // the two request classes ask very different things of that person:
    // a permission is a glance and a click, a question is "which of these three
    // approaches should I take?" — read the options, think, quite possibly type
    // a paragraph into Other. Five minutes is a plausible amount of time to
    // spend answering one properly, and a deadline that fires mid-sentence
    // deletes the panel, throws away what was typed, and tells the model nobody
    // answered in time. The cost of the longer deadline is a session that waits
    // — which is what it was doing anyway, since the CLI itself waits for ever
    // (measured: 180s with no fallback and no timeout of its own).
    // A QUESTION waits for a person (#570) — see `NO_DEADLINE`. An explicit
    // `holdTimeoutMs` still applies to everything, because that is how tests
    // drive this path in seconds rather than minutes.
    const timeout =
      this.opts.holdTimeoutMs ?? (isQuestion(request.tool) ? NO_DEADLINE : 300_000);
    const timer =
      timeout === null
        ? null
        : setTimeout(() => {
            this.failOpen(requestId, 'permission hold timed out');
          }, timeout);
    timer?.unref?.();
    this.pending.set(requestId, { sessionId, nativeRequestId, request, timer });
    this.log.info('stream permission requested', {
      sessionId,
      requestId,
      tool: request.tool,
      reasonType: request.reasonType,
    });
    for (const l of this.requestListeners) {
      try {
        l({ ...request });
      } catch (err) {
        // a broken subscriber must never strand the CLI (P6)
        this.log.error('permission request listener threw', { requestId, error: String(err) });
      }
    }
  }

  /**
   * Answer one.
   *
   * `updatedInput` echoes the input back unchanged: the CLI expects the tool
   * input with an allow, and it is the CLI's own input — we neither invent nor
   * edit it, which would be reimplementing a decision (P7).
   *
   * It also APPLIES `permission-resolved`, exactly as `HookListener.decide`
   * does (#310). `offer` is what put the session into `needs-permission` —
   * `streamStatusEvent` maps `can_use_tool` to `permission-held` — so answering
   * is the moment that state ends, and it is the only moment we can KNOW it has
   * ended. Leaving it to the stream meant waiting for the CLI to speak again,
   * which it does not do until the tool it just asked about has RUN: Dan
   * watched a Direct session sit on `needs-permission` for ~5s per gated call
   * with nothing held, which is precisely the render condition the terminal
   * handoff bar exists for (#125/#153).
   *
   * `updatedInput` is the ONE exception to "we neither invent nor edit it"
   * (#563), and it is the exception the CLI itself designed: `AskUserQuestion`
   * asks a question and reads the answer back off its own tool input, so
   * answering it IS writing to the input. It is still not us editing a decision
   * — it is us carrying one. `answeredInput` in `shared/ask-user-question` is
   * the only thing that builds one, and `sanitizeUpdatedInput` below is what
   * stops a renderer sending anything else.
   */
  decide(
    requestId: string,
    decision: 'allow' | 'deny',
    reason?: string,
    updatedInput?: unknown
  ): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    if (p.timer) clearTimeout(p.timer);

    const answered = decision === 'allow' ? this.sanitizeUpdatedInput(p, updatedInput) : undefined;
    // A REJECTED ANSWER IS NOT A BARE ALLOW.
    //
    // For every other tool, falling back to the request's own input is exactly
    // what this function did before `updatedInput` existed, and it is right. For
    // a question it is the one outcome this whole item exists to prevent: the
    // CLI reads an allow with no `answers` as "The user did not answer the
    // questions" (measured), so a user who clicked Send, watched the panel
    // close and saw the queue drain would have been told nothing while the model
    // was told they declined. Allow-all, the toast and the batch card were all
    // closed off for precisely this reason; a validator that failed open here
    // would reopen the hole from the inside.
    //
    // So: an answer was OFFERED and could not be carried => say so, honestly, in
    // the words `unavailable` uses for every other undeliverable verdict.
    const undeliverable =
      decision === 'allow' && isQuestion(p.request.tool) && updatedInput !== undefined && !answered;
    const payload = undeliverable
      ? {
          behavior: 'deny',
          message: this.unavailable('Your answer to this question could not be delivered'),
        }
      : decision === 'allow'
        ? { behavior: 'allow', updatedInput: answered ?? p.request.input }
        : { behavior: 'deny', message: reason || 'Denied in switchboard' };
    if (undeliverable) {
      this.log.error('an answered question could not be delivered — denied instead of skipped', {
        requestId,
        sessionId: p.sessionId,
      });
    }

    const sent = this.send(p.sessionId, controlResponse(p.nativeRequestId, payload));
    // Before `notifyResolved`, and unguarded, so this half stays a mirror image
    // of `HookListener.decide` — a divergence between the two would be a trap
    // for whoever reads one to understand the other, which is the shape of the
    // whole class (see the header).
    this.applyStatus(p.sessionId, { kind: 'permission-resolved' });
    this.log.info('stream permission decided', {
      requestId,
      decision,
      sessionId: p.sessionId,
      delivered: sent,
    });
    this.notifyResolved(requestId);
    return sent;
  }

  /**
   * Vet a renderer-supplied `updatedInput`, or return undefined (#563).
   *
   * THE TRUST DIRECTION IS BACKWARDS HERE and that is the whole reason this
   * function exists. Every other payload in this file came FROM the CLI and is
   * echoed back to it; this one comes from a window and is written to the CLI's
   * stdin. Rejecting rather than repairing: anything that fails a check falls
   * back to the request's own input, which is exactly what `decide` did before
   * this parameter existed — so the worst case is the CLI being told the
   * questions were not answered, never a malformed control_response.
   *
   * Four checks, each earning its place:
   *
   * 1. **Only for the tool that asked.** `AskUserQuestion` is the one tool whose
   *    input is the answer channel. Letting a renderer rewrite a `Bash` input on
   *    the way to allow would turn our approval bar into a place where the
   *    command the user READ and the command that RUNS are different strings.
   * 2. **A plain JSON object**, so `controlResponse` cannot be handed a class
   *    instance, an array or a prototype-polluted shape.
   * 3. **Round-trips through JSON**, which is what the transport will do to it
   *    anyway — a value that cannot survive that (a cycle, a BigInt) must fail
   *    here, where there is a fallback, and not at `JSON.stringify` time in the
   *    writer, where there is not.
   * 4. **Bounded** — see `MAX_UPDATED_INPUT_BYTES`.
   * 5. **Carries the MEASURED answer shape** — see `answersLookRight`. The first
   *    four vet the envelope; without the fifth, main would forward
   *    `answers: {q: ['a','b']}` or `answers: {}` verbatim to the CLI's stdin,
   *    which are exactly the shapes the UI refuses to produce (`anyAnswered` +
   *    `buildAnswers`).
   *    The trusted side enforces the rule rather than trusting the untrusted
   *    side to have followed it.
   */
  private sanitizeUpdatedInput(p: Pending, updatedInput: unknown): Record<string, unknown> | undefined {
    if (updatedInput === undefined) return undefined;
    const where = { requestId: p.request.requestId, sessionId: p.sessionId, tool: p.request.tool };
    if (!isQuestion(p.request.tool)) {
      this.log.warn('ignoring updatedInput for a tool that does not answer questions', where);
      return undefined;
    }
    if (!updatedInput || typeof updatedInput !== 'object' || Array.isArray(updatedInput)) {
      this.log.warn('ignoring updatedInput that is not a plain object', where);
      return undefined;
    }
    let json: string;
    try {
      json = JSON.stringify(updatedInput);
    } catch (err) {
      this.log.warn('ignoring updatedInput that will not serialise', { ...where, error: String(err) });
      return undefined;
    }
    if (typeof json !== 'string') return undefined;
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > MAX_UPDATED_INPUT_BYTES) {
      // the value we TESTED, not `json.length` — that counts UTF-16 code units
      // and would understate a rejection caused by non-ASCII text
      this.log.warn('ignoring updatedInput over the size cap', { ...where, bytes });
      return undefined;
    }
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!answersLookRight(parsed.answers)) {
      this.log.warn('ignoring updatedInput whose answers are not the measured shape', where);
      return undefined;
    }
    return parsed;
  }

  /**
   * Deny everything outstanding for a session, e.g. its card was closed.
   *
   * DENY rather than drop: an unanswered control request leaves the CLI waiting
   * for ever, and a wedged session is worse than a refused tool call — the user
   * can always ask again. Same fail-safe posture as the hook path's release.
   *
   * Deliberately does NOT apply `permission-resolved`, and that is the same
   * deliberate choice `HookListener.release` makes — it is the reason #310's
   * fix lands in `decide` alone. Both callers of this are teardowns
   * (`ipc.ts` → `releaseHeldPermissions`, on a closed card and on a session's
   * own exit), and its comment there names the hazard: "a status transition
   * here would walk a `needs-permission` session to `working` a beat before its
   * exit lands." There is nobody to show `working` to and nothing left to do
   * it. Answering the CLI is the whole job here; moving the badge is not.
   */
  forgetSession(sessionId: string, why: string): void {
    // "this session" ends here — the grant is keyed by LIVE id, so the session
    // that replaces this one asks again (#319). Mirrors
    // `HookListener.unregisterSession`.
    this.allowAllSessions.delete(sessionId);
    this.noWindowWarned.delete(sessionId);
    this.unroutableWarned.delete(sessionId);
    for (const [id, p] of [...this.pending]) {
      if (p.sessionId !== sessionId) continue;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      this.send(p.sessionId, controlResponse(p.nativeRequestId, { behavior: 'deny', message: why }));
      this.log.info('stream permission auto-denied', { requestId: id, sessionId, why });
      this.notifyResolved(id);
    }
  }

  /**
   * Fail every parked request open at once, across every session (#319).
   *
   * The renderer is gone — window closed, or its process died — and the
   * sessions are still running in main. The `hasLiveWindow` gate in `offer`
   * only helps the calls that arrive AFTER that; anything already held would
   * otherwise sit out the full timeout with nothing able to decide it, and this
   * channel's timeout is the only thing between it and for ever.
   *
   * `HookListener.releaseHeld`'s twin, called from the same `onRendererLost` —
   * and one behaviour apart from it, deliberately. The hook path releases by
   * ANSWERING NOTHING, which lets the CLI's own TUI prompt take the question.
   * A `control_request` has no such fallback: the CLI is blocked on us and on
   * nothing else, so "no opinion" is not one of the things we can say. See
   * `forgetSession` for the full argument; this takes the same posture for the
   * same reason.
   *
   * Unlike `forgetSession` it DOES apply `permission-resolved`. That function's
   * two callers are teardowns and its comment names the hazard — a status
   * transition a beat before the session's own exit lands. Here the sessions
   * are alive and will keep working; leaving them on `needs-permission` would
   * mean the user reopens the window to a card claiming to hold a question that
   * was answered while they were away.
   */
  releaseHeld(reason: string): void {
    const ids = [...this.pending.keys()];
    if (ids.length === 0) return;
    this.log.warn('releasing held stream permissions — denying to keep the sessions moving', {
      reason,
      count: ids.length,
    });
    for (const id of ids) this.failOpen(id, reason);
  }

  /**
   * What the MODEL is told when nobody could answer (#319).
   *
   * Not a log line. The CLI feeds a deny message straight to Claude, and
   * `HookListener.verdict` records what happens when one reads wrong: a denial
   * that sounds like infrastructure gets ROUTED AROUND — Claude announced it
   * was "getting blocked by something called switchboard" and reached for a
   * second tool, then a third, until it got what the user had refused.
   *
   * These denials are the failure mode that reads most like a sandbox, so they
   * have to say three things: nobody was available, it is not a restriction,
   * and asking again is the way through. And one thing `verdict`'s denial says
   * that this must NOT: that the user decided. The user decided nothing — that
   * is the entire problem being reported.
   *
   * `what` is the DISTINCT half, and it is a requirement rather than a flourish
   * (#333). FOUR different things reach here — no window was open (#319),
   * nobody answered in time (#319), an answer could not be delivered (#563),
   * and no card owned the session (#333) — and they are four different faults
   * with four different fixes. A shared sentence would leave the model, the log
   * and anyone reading a transcript unable to tell "you had the app closed"
   * from "switchboard lost track of this session", which is the difference
   * between something the user did and a bug worth reporting. Every caller
   * passes a clause nothing else passes, and none of them blames the same thing
   * twice: only the #319 window case says "window".
   */
  private unavailable(what: string): string {
    return (
      `${what}, so switchboard declined it rather than leave you blocked for ever. ` +
      'This is NOT a sandbox restriction, a misconfiguration, or a decision anyone made ' +
      'about this request — there was simply nobody available to review it. Do not work ' +
      'around it with another tool. Say so and ask again; it will be reviewed then.'
    );
  }

  /**
   * Answer one held request the user never got to — deadline or lost renderer.
   *
   * Deny, apply, notify: the same three steps `decide` takes, minus the user.
   */
  private failOpen(requestId: string, why: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    if (p.timer) clearTimeout(p.timer);
    const message = this.unavailable('Nobody in switchboard answered this request in time');
    this.send(p.sessionId, controlResponse(p.nativeRequestId, { behavior: 'deny', message }));
    this.applyStatus(p.sessionId, { kind: 'permission-resolved' });
    this.log.warn('stream permission failed open (denied)', {
      requestId,
      sessionId: p.sessionId,
      why,
    });
    this.notifyResolved(requestId);
  }

  /**
   * Mark a LIVE session as allow-all: gated calls are answered `allow` at the
   * server, with no hold, no `needs-permission` event, and no beep (#319).
   *
   * Verbatim the contract `HookListener.setAllowAll`'s docblock has stated
   * since P2 — and which Direct mode did not honour, because stream allow-all
   * lived only in the renderer. `sessions:allowAllSession` now tells both.
   */
  setAllowAll(sessionId: string): void {
    this.allowAllSessions.add(sessionId);
    this.log.info('allow-all enabled for stream session', { sessionId });
  }

  /** Does this live session answer its own gated calls? (`SessionManager`'s
   *  `permission-held` suppressor asks this — see `offer` step 1.) */
  isAllowAll(sessionId: string): boolean {
    return this.allowAllSessions.has(sessionId);
  }

  pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => ({ ...p.request }));
  }

  onPermissionRequest(l: (r: PermissionRequest) => void): () => void {
    this.requestListeners.add(l);
    return () => this.requestListeners.delete(l);
  }

  onPermissionResolved(l: (requestId: string) => void): () => void {
    this.resolvedListeners.add(l);
    return () => this.resolvedListeners.delete(l);
  }

  private notifyResolved(requestId: string): void {
    for (const l of this.resolvedListeners) {
      try {
        l(requestId);
      } catch (err) {
        this.log.error('permission resolved listener threw', { requestId, error: String(err) });
      }
    }
  }
}
