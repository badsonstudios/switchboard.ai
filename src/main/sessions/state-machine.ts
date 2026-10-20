// Session status state machine (P1-E2-03), semantics from the S-06 findings:
//   - hooks are the transition authority (Stop ~30ms; transcript has no
//     done-marker)
//   - permission Notification is a debounced backup signal; our own
//     PreToolUse hold is authoritative when present (E2-05/Phase 2)
//   - no event fires on prompt acceptance: any working-ish event clears
//     needs-* states
//   - unknown events: log, don't transition (§5.26 posture)
import { INTERACTIVE_TOOLS } from '../../shared/tool-taxonomy';
import type { SessionStatus } from '../../shared/sessions';

// The status VOCABULARY moved to `shared/sessions.ts` in #590 — the renderer
// paints these values, so they cross IPC and belong with the rest of the wire
// shape. This module still owns the TRANSITIONS, which is the part that is
// main's alone. Re-exported so every main-side importer is unchanged.
export type { SessionStatus };

export type SessionEvent =
  | {
      kind: 'hook';
      /** hook_event_name — unknown values are tolerated, never transition */
      event: string;
      notificationType?: string;
      message?: string;
      tool?: string;
      /** SessionStart source: startup | resume | clear | compact */
      source?: string;
    }
  | { kind: 'permission-held' } // our PreToolUse round-trip is pending (E2-05+)
  /**
   * A held request was ANSWERED (#1359): what the router sent, `allow` or
   * `deny`. A deadline that ran out, a window nobody could see and every other
   * refusal the router makes on the user's behalf are a `deny`, because that is
   * what went to the engine. Absent = `allow`, the rule before #1359: the card
   * goes to `working`.
   *
   * A `deny` with NO main turn running (`TransitionContext.turn`) routes where
   * `permission-withdrawn` routes: nothing will run because of it, and no
   * `result` is owed. An `allow` goes to `working` either way — the helper that
   * asked is running and its tool is about to — and `background-work` below is
   * what moves it on when the helper is done.
   */
  | { kind: 'permission-resolved'; answer?: 'allow' | 'deny' }
  /**
   * The ENGINE took its own request back (#1340) — the CLI's
   * `control_cancel_request`, or ACP settling its requests on a cancel. Not an
   * answer: nobody said yes or no, so nothing new will run because of it. The
   * card goes to `working` only if a main turn is still running (see the
   * `permission-withdrawn` arm and `TransitionContext.turn`).
   */
  | { kind: 'permission-withdrawn' }
  /**
   * How many BACKGROUND tasks the engine says are running (#1359) — Claude's
   * `system:background_tasks_changed`, which re-sends the whole list whenever
   * it changes. Only `running: 0` can move the status: with no main turn
   * running, a card left at `working` by a helper (its output, or an Allow on
   * its request) has nothing else to end it, and an empty list is the engine
   * saying the helper is gone. With a main turn running it is ignored; the
   * turn's own end is the signal there.
   */
  | { kind: 'background-work'; running: number }
  | { kind: 'user-input' } // user typed into the terminal
  /**
   * What the session's own traffic says about the turn (P2-E18-05) — stream
   * mode's equivalent of a hook, and deliberately a SEPARATE kind rather than a
   * synthesised `hook`: these are not hooks, and `describeCause` must not claim
   * they are when someone is reading a transition log to work out where a
   * status came from.
   *
   * NEUTRAL SINCE E40 item 03 (#1286): `signal` is all the state machine may
   * branch on — `output` (the turn is producing something) or `turn-end` (it is
   * over, failed or not). It used to be the CLI's own frame name. `label` is
   * the frame the engine actually sent, kept for the transition log ONLY
   * (`stream:<label>`), which is why the log reads exactly as it did.
   */
  | {
      kind: 'stream';
      signal: 'output' | 'turn-end';
      label: string;
      /**
       * The output is a SUBAGENT's, not the main conversation's (#1340). It
       * moves the status exactly as main output does; it does not open a turn
       * (`TransitionContext.turn`), because no `result` is owed for it.
       */
      sidechain?: true;
    }
  /** We wrote a prompt to the session's transport (P2-E18-05). */
  | { kind: 'prompt-sent' }
  /**
   * The transport is up and the CLI is ready to take a prompt (P2-E18-05).
   *
   * Stream mode has no startup event of its own — MEASURED: S-11's log shows
   * nothing at all between spawn and the first message we provoke, and
   * `system:init` arrives ~10-20ms AFTER our own send, never before. So
   * readiness is the spawn succeeding. That is honest here and would not be for
   * the PTY, where a TUI still has to boot and can stop on a trust dialog;
   * S-10 confirmed stream mode draws none.
   */
  | { kind: 'transport-ready' }
  | { kind: 'exit'; code: number };

export interface TransitionResult {
  status: SessionStatus;
  changed: boolean;
  /** transient markers that aren't status changes (subagent-done etc.) */
  note?: string;
}

/**
 * Does this hook event read as "the CLI is asking permission"? (#313.)
 *
 * The `Notification` arm's classifier, lifted out because it now has a SECOND
 * caller: `HookListener.ingest` has to make the same judgement one layer
 * earlier, to decide whether a stream session's Notification should reach the
 * state machine at all. Two copies of this regex would be two answers to one
 * question, and the day they drifted a Notification would be suppressed as a
 * permission by one and transitioned as an idle nag by the other.
 *
 * The blob, not the type alone, and that is measured rather than defensive:
 * the CLI's debounced nudge labels every on-screen dialog `permission_prompt`
 * (probed), and the message is where the specifics live.
 *
 * False for anything that is not a `Notification` — the caller should not have
 * to check first, and no other hook event carries this signal.
 */
export function isPermissionNotification(ev: SessionEvent): boolean {
  if (ev.kind !== 'hook' || ev.event !== 'Notification') return false;
  return /permission/i.test(`${ev.notificationType ?? ''} ${ev.message ?? ''}`);
}

/**
 * What `transition` cannot work out from the status and the event alone.
 *
 * `held` (#1258): is a request from this session still waiting on a person —
 * an approval or a question that main is holding and nobody has answered?
 * Passed in rather than looked up, so this stays a pure function; the manager
 * asks whoever holds them (`SessionManager.setHeldRequestProbe`).
 */
export interface TransitionContext {
  held?: boolean;
  /**
   * Is the session's MAIN turn running? (#1340) Read by `permission-withdrawn`,
   * a denied `permission-resolved` and `background-work` (#1359), and kept by
   * the manager (`SessionManager.trackTurn`):
   *
   *  - `open`: a prompt was sent, or the main conversation produced output,
   *    and no turn end has arrived since;
   *  - `closed`: the last turn ended and nothing has opened another;
   *  - `none`: no turn has run in this session at all.
   *
   * Absent means "nobody can say", and reads as `open` — what every release
   * before this one assumed.
   *
   * ⚠️ A SUBAGENT'S OUTPUT DOES NOT OPEN A TURN, and the measurement is why.
   * In the #1268 capture the parent turn's `result` came first; the background
   * subagent's own `assistant` frame followed (which walks the card to
   * `working` — a subagent working is the session working), then its request.
   * "What was the card doing before it was asked" would have answered
   * `working` there, and stranded it exactly as before.
   */
  turn?: 'open' | 'closed' | 'none';
}

/**
 * The only events that end a wait on a held request (#1258). Everything else
 * that arrives while one is held is the session doing something BESIDE the
 * wait, and none of it is an answer.
 *
 *  - `permission-held`: another request. Still waiting (and `needs-input`
 *    becomes `needs-permission`, as it always has).
 *  - a stream `turn-end`: the turn is OVER. Whatever was asked in it is moot,
 *    and pinning here would strand the card: the answer or the deadline that
 *    finally clears the request would walk a finished session to `working`,
 *    with nothing left to end it.
 *  - `exit` is handled before this is consulted, as it always was.
 */
function endsHeldWait(ev: SessionEvent): boolean {
  return ev.kind === 'permission-held' || (ev.kind === 'stream' && ev.signal === 'turn-end');
}

/** Is this status waiting on a person — the only statuses a request's end can release? */
function isWaiting(status: SessionStatus): boolean {
  return status === 'needs-permission' || status === 'needs-input';
}

/**
 * Where a card goes when the wait it was in ends and NO main turn is running
 * (#1340, #1359): the turn that last ran is over, so `done`; none ever ran, so
 * `idle`. Undefined while a main turn is running (or nobody can say, which
 * reads as running): the caller's own answer applies there.
 */
function afterTurn(ctx: TransitionContext): SessionStatus | undefined {
  if (ctx.turn === 'closed') return 'done';
  if (ctx.turn === 'none') return 'idle';
  return undefined;
}

export function transition(
  current: SessionStatus,
  ev: SessionEvent,
  ctx: TransitionContext = {}
): TransitionResult {
  const to = (status: SessionStatus, note?: string): TransitionResult => ({
    status,
    changed: status !== current,
    note,
  });
  const stay = (note?: string): TransitionResult => ({ status: current, changed: false, note });

  // crashed is terminal: ONLY restart leaves it (the manager creates a fresh
  // record). Late hook POSTs racing in after a crash must not resurrect it.
  if (current === 'crashed') return stay('ignored-after-crash');

  // exit is always meaningful, even from a terminal state.
  if (ev.kind === 'exit') {
    // done -> exit(0) is a normal wind-down, not a crash
    return ev.code === 0 || current === 'done' ? to('done') : to('crashed');
  }

  // A HELD REQUEST PINS THE WAIT (#1258).
  //
  // The header's rule, "any working-ish event clears needs-* states", was
  // written for the PTY, where nothing told us a prompt had been answered. On
  // the control channel we KNOW: a request is held until it is answered, runs
  // out of time, or is cancelled by the CLI, and the router that held it says
  // so each time (`permission-resolved` for an answer or a deadline,
  // `permission-withdrawn` for the CLI's cancel — #1340 — applied after it has
  // let go).
  //
  // AN INTERRUPT IS ONE OF THOSE "CANCELLED BY THE CLI" CASES, measured (#1268,
  // 2.1.288): the CLI sends `control_cancel_request` for every request still
  // held, ahead of its `result`, so the router lets go and says so before the
  // turn ends. The router deliberately does NOT let go at `result` itself: the
  // same probe watched a background subagent ask 137 ms AFTER its parent turn's
  // `result`, and that request was genuinely waiting. `result` ends the WAIT
  // here (see `endsHeldWait`); only an answer, a deadline, a lost window, a
  // teardown or the CLI's cancel ends the REQUEST.
  //
  // Without this the session's status was right for one frame. MEASURED, in
  // the owner's log: 51 of 305 held requests were walked back to `working`
  // while still held, 16 of them questions, some within a millisecond:
  //
  //     stream:stream_event   38     the rest of the message that asked
  //     stream:assistant      11
  //     hook:PostToolUse       2     a tool running BESIDE the held one
  //
  // The real CLI keeps streaming after it asks (a message can carry several
  // tool calls), and every "N need you" readout hangs off this status by way
  // of the Events list. So the approval sat there for up to five minutes under
  // a card that said "working", counted nowhere.
  //
  // Which is why this is not a rule about stream frames. A hook, a prompt typed
  // into the composer, the CLI's idle nag: none of them answers a request, so
  // none of them may end the wait. `permission-resolved` is pinned too while
  // something is STILL held (two calls asked at once, one answered). The
  // router's `decide` and deadline already decline to send it then; two of
  // `offer`'s immediate refusals do not, and this covers them.
  if (
    ctx.held &&
    (current === 'needs-permission' || current === 'needs-input') &&
    !endsHeldWait(ev)
  ) {
    return stay('request-still-held');
  }

  // A completed turn is TURN-TERMINAL: only a genuinely new turn leaves it.
  // Real observed bug (ClaudeMon): after Stop->done, an idle Notification and
  // then a stray keystroke walked done -> needs-input -> working, so a session
  // that had finished showed "working" forever. A new turn always opens with
  // UserPromptSubmit (or a tool starting); idle notifications, subagent stops,
  // and keystrokes are not new turns.
  if (current === 'done') {
    if (ev.kind === 'hook' && (ev.event === 'UserPromptSubmit' || ev.event === 'PreToolUse')) {
      return to('working');
    }
    if (ev.kind === 'permission-held') return to('needs-permission');
    // Stream mode's new turn. `prompt-sent` is the exact analogue of
    // UserPromptSubmit above — it is us writing to stdin — and assistant output
    // arriving is a turn running whether or not we saw the send (a resumed
    // conversation, or a message the CLI had queued: S-11 watched one written
    // during a 150s stall get picked up 144s after we resumed reading).
    if (ev.kind === 'prompt-sent') return to('working');
    if (ev.kind === 'stream' && ev.signal === 'output') return to('working');
    return stay('idle-after-done');
  }

  switch (ev.kind) {
    case 'permission-held':
      return to('needs-permission');
    case 'permission-resolved': {
      // A DENY WITH NO MAIN TURN RUNNING (#1359): the same place a withdrawal
      // goes, below, and for the same reason. The request was a background
      // helper's, asked after its parent turn's `result` (#1268's capture);
      // refusing it runs nothing, and no `result` is coming. `working` here was
      // the #1340 strand by another door: a Deny, or a deadline nobody saw.
      // If the helper carries on after the refusal, its next frame walks `done`
      // back to `working`, and `background-work` ends that.
      //
      // Only from a WAIT, like a withdrawal: a deny that lands on a card that
      // was not waiting on it has nothing to go back to.
      //
      // An ALLOW goes to `working` with or without a turn: the helper is running
      // (the engine listed it when it asked) and the tool it was allowed is
      // about to. Mid-turn, every answer goes to `working`, as it always has.
      const settled = ev.answer === 'deny' ? afterTurn(ctx) : undefined;
      if (settled === undefined) return to('working');
      if (!isWaiting(current)) return stay('denied-not-waiting');
      return to(settled, 'denied-no-turn');
    }
    case 'background-work': {
      // THE HELPER IS GONE (#1359). The engine's list of running background
      // tasks is empty, no main turn is running, and the card still says
      // `working`: nothing else will ever end that. Only from `working` —
      // a wait is a request's to end (`held` above, the router's answers), and
      // a calm card has nothing to be moved off.
      const settled = ev.running === 0 ? afterTurn(ctx) : undefined;
      if (settled === undefined || current !== 'working') return stay('background-work');
      return to(settled, 'helpers-done');
    }
    case 'permission-withdrawn':
      // Only a WAIT is ended by a withdrawal; any other status was not
      // waiting on this request and has nothing to go back to. (`done` and
      // `crashed` never get here: their own arms above keep them.)
      if (!isWaiting(current)) {
        return stay('withdrawn-not-waiting');
      }
      // Mid-turn (the ordinary Stop with a bar up): the CLI's `result` follows
      // within ~20 ms (measured) and ends the turn, so `working` is right for
      // that instant.
      //
      // With NO main turn running, nothing will follow, measured (#1268,
      // 2.1.288): a background subagent asked 137 ms after its parent turn's
      // `result`; on an interrupt the CLI killed the subagent, took the
      // request back, and sent no `result` — there was no turn left to end.
      // `working` there was for good. The turn that last ran is over, so the
      // card says so. If something DID carry on (a cancel for another reason,
      // unmeasured), its output walks `done` back to `working` on the next
      // frame; a stranded `working` had no such way out.
      {
        const settled = afterTurn(ctx);
        return settled === undefined ? to('working') : to(settled, 'withdrawn-no-turn');
      }
    case 'user-input':
      // A keystroke is NOT a submitted prompt — it must not change status.
      // The UserPromptSubmit hook marks 'working' on actual submit; answering
      // a permission/input prompt is reflected by the subsequent tool hooks.
      return stay('keystroke');
    case 'transport-ready':
      // Only ever a promotion out of 'starting'. A late or duplicated ready
      // must not drag a working session backwards.
      return current === 'starting' ? to('idle') : stay('already-started');
    case 'prompt-sent':
      // Stream mode's UserPromptSubmit, except we do not have to wait for a
      // round trip to learn it: WE did the writing.
      return to('working');
    case 'stream':
      switch (ev.signal) {
        case 'output':
          // Output is arriving. Normally a no-op after `prompt-sent`; it
          // matters when nobody told us a turn began.
          return to('working');
        case 'turn-end':
          // Stream mode's `Stop`. Success and error both END the turn — a
          // failed turn is finished, not running, and the error surfaces in
          // the feed rather than the badge. (An unknown frame never reaches
          // here at all: the engine's translator reports and drops it.)
          return to('done');
      }
      // unreachable while `signal` is a closed union; kept so a widened one
      // stays inert (§5.26's posture for an unknown hook) rather than falling
      // through to the hook arm
      return stay('unknown-stream');
    case 'hook':
      switch (ev.event) {
        case 'SessionStart':
          // Auto-compaction fires SessionStart(source:'compact') MID-TURN —
          // the turn resumes seconds later, so the status must not move
          // (review P1 #11: the working banner vanished during compacts).
          if (ev.source === 'compact') return stay('compacting');
          // A prompt sent BEFORE the CLI finished starting is still owed an
          // answer (#1003). `transport-ready` promotes a stream session to
          // idle at the spawn, so the composer and the Clear button are live
          // while the CLI is still loading the conversation it was asked to
          // resume — measured at 5–30 s on the reporter's machine. Anything
          // written in that window is QUEUED, not dropped: the CLI runs it
          // the moment start-up ends (`spike/findings/1003-clear-during-
          // startup.md`). This hook is that start-up reporting in, and it
          // used to answer `working` with `idle` — a card that said "ready"
          // with a `/clear` outstanding, which the user read as "it did
          // nothing", pressed again, and got two.
          //
          // Narrow on purpose. `working` this early can ONLY be our own
          // `prompt-sent`: the CLI cannot have run a turn before it started.
          // And `clear` is not in the list — after a `/clear` this hook IS the
          // end of the work, and `idle` is right.
          if (current === 'working' && (ev.source === 'startup' || ev.source === 'resume')) {
            return stay('prompt-queued-during-startup');
          }
          // Otherwise (startup/resume/clear) the session is up and its TUI
          // is (about to be) ready — that's IDLE, not "working" (Dan
          // 2026-07-22: three resumed sessions all claimed to be working at
          // boot). A real turn opens with UserPromptSubmit.
          return to('idle');
        case 'UserPromptSubmit':
          return to('working');
        case 'PreToolUse':
          // The ONE tool family where "a tool started" does not mean working:
          // an interactive question BLOCKS mid-turn on a human answering the
          // CLI's own dialog (#92). No Stop fires — the turn never ends — so
          // without this a session sits on 'working' while it waits for you,
          // which is exactly what Dan hit: "nothing seemed to have happened".
          if (ev.tool && INTERACTIVE_TOOLS.includes(ev.tool)) return to('needs-input');
          return to('working');
        case 'PostToolUse':
          return to('working');
        case 'Notification': {
          const blob = `${ev.notificationType ?? ''} ${ev.message ?? ''}`;
          // A pending question already told us precisely what is happening,
          // from the tool itself and ~6s sooner. The CLI's debounced nudge
          // calls every on-screen dialog a permission_prompt (probed), and
          // demoting to needs-permission here would relabel a QUESTION as a
          // permission request — a card asking to approve something, with no
          // approval bar, because nothing was ever held.
          if (current === 'needs-input' && isPermissionNotification(ev)) {
            return stay('interactive-prompt-already-known');
          }
          // CONSIDERED AND DECLINED for #313: requiring a HELD request here, or
          // refusing to override a just-resolved one. Both would need state this
          // pure function does not have, and — the real objection — this arm is
          // the ONLY permission signal a PTY session has when our hold policy
          // deliberately passed the call to the CLI (plan mode never holds;
          // full-auto gates nothing; anything outside `PRETOOL_MATCHER`). Gating
          // it on evidence we by definition do not have would trade a nuisance
          // badge for a session sitting blocked on a terminal prompt with the
          // card claiming it is working — silent, and strictly worse. The false
          // alarms are a STREAM problem, and they are answered on the stream, at
          // the producer (`HookListener.ingest`).
          if (isPermissionNotification(ev)) return to('needs-permission');
          // "Claude is waiting for your input" is the CLI's 60s IDLE nag —
          // nothing actionable is on screen (Dan's phantom needs-input,
          // 2026-07-22). Idle is calm: no event, no toast.
          if (/waiting for your input|idle/i.test(blob)) return to('idle');
          if (/waiting|input/i.test(blob)) return to('needs-input');
          return stay(`notification:${ev.notificationType ?? 'unknown'}`);
        }
        case 'Stop':
          return to('done');
        case 'SubagentStop':
          return stay('subagent-done');
        default:
          return stay(`unknown-hook:${ev.event}`);
      }
  }
}
