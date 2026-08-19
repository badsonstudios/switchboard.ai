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
  | { kind: 'permission-resolved' }
  | { kind: 'user-input' } // user typed into the terminal
  /**
   * A stream-json message (P2-E18-05) — stream mode's equivalent of a hook,
   * and deliberately a SEPARATE kind rather than a synthesised `hook`: these
   * are not hooks, and `describeCause` must not claim they are when someone is
   * reading a transition log to work out where a status came from.
   */
  | { kind: 'stream'; event: string; subtype?: string }
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

export function transition(current: SessionStatus, ev: SessionEvent): TransitionResult {
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
    if (ev.kind === 'stream' && (ev.event === 'assistant' || ev.event === 'stream_event')) {
      return to('working');
    }
    return stay('idle-after-done');
  }

  switch (ev.kind) {
    case 'permission-held':
      return to('needs-permission');
    case 'permission-resolved':
      return to('working');
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
      switch (ev.event) {
        case 'assistant':
        case 'stream_event':
          // Output is arriving. Normally a no-op after `prompt-sent`; it
          // matters when nobody told us a turn began.
          return to('working');
        case 'result':
          // Stream mode's `Stop`. `subtype` distinguishes success from an
          // error, but both END the turn — a failed turn is finished, not
          // running, and the error surfaces in the feed rather than the badge.
          return to('done');
        default:
          // Same posture as an unknown hook (§5.26): log, never transition.
          return stay(`unknown-stream:${ev.event}`);
      }
    case 'hook':
      switch (ev.event) {
        case 'SessionStart':
          // Auto-compaction fires SessionStart(source:'compact') MID-TURN —
          // the turn resumes seconds later, so the status must not move
          // (review P1 #11: the working banner vanished during compacts).
          if (ev.source === 'compact') return stay('compacting');
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
