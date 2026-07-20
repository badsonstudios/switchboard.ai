// Session status state machine (P1-E2-03), semantics from the S-06 findings:
//   - hooks are the transition authority (Stop ~30ms; transcript has no
//     done-marker)
//   - permission Notification is a debounced backup signal; our own
//     PreToolUse hold is authoritative when present (E2-05/Phase 2)
//   - no event fires on prompt acceptance: any working-ish event clears
//     needs-* states
//   - unknown events: log, don't transition (§5.26 posture)
// 'idle' is currently only reachable via future idle-detection (E4 wiring —
// Notification "waiting" classifies to needs-input today); kept in the union
// because the spec names it and the UI ships a badge for it.
export type SessionStatus =
  | 'starting'
  | 'working'
  | 'needs-input'
  | 'needs-permission'
  | 'idle'
  | 'done'
  | 'crashed';

export type SessionEvent =
  | {
      kind: 'hook';
      /** hook_event_name — unknown values are tolerated, never transition */
      event: string;
      notificationType?: string;
      message?: string;
      tool?: string;
    }
  | { kind: 'permission-held' } // our PreToolUse round-trip is pending (E2-05+)
  | { kind: 'permission-resolved' }
  | { kind: 'user-input' } // user typed into the terminal
  | { kind: 'exit'; code: number };

export interface TransitionResult {
  status: SessionStatus;
  changed: boolean;
  /** transient markers that aren't status changes (subagent-done etc.) */
  note?: string;
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
    case 'hook':
      switch (ev.event) {
        case 'SessionStart':
          return to('starting');
        case 'UserPromptSubmit':
          return to('working');
        case 'PreToolUse':
        case 'PostToolUse':
          return to('working');
        case 'Notification': {
          const blob = `${ev.notificationType ?? ''} ${ev.message ?? ''}`;
          if (/permission/i.test(blob)) return to('needs-permission');
          if (/waiting|input|idle/i.test(blob)) return to('needs-input');
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
