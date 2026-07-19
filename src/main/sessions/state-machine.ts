// Session status state machine (P1-E2-03), semantics from the S-06 findings:
//   - hooks are the transition authority (Stop ~30ms; transcript has no
//     done-marker)
//   - permission Notification is a debounced backup signal; our own
//     PreToolUse hold is authoritative when present (E2-05/Phase 2)
//   - no event fires on prompt acceptance: any working-ish event clears
//     needs-* states
//   - unknown events: log, don't transition (§5.26 posture)
export type SessionStatus =
  | 'starting'
  | 'working'
  | 'needs-input'
  | 'needs-permission'
  | 'idle'
  | 'done'
  | 'crashed';

export type SessionEvent =
  | { kind: 'hook'; event: 'SessionStart' }
  | { kind: 'hook'; event: 'UserPromptSubmit' }
  | { kind: 'hook'; event: 'PreToolUse'; tool?: string }
  | { kind: 'hook'; event: 'PostToolUse'; tool?: string }
  | { kind: 'hook'; event: 'Notification'; notificationType?: string; message?: string }
  | { kind: 'hook'; event: 'Stop' }
  | { kind: 'hook'; event: 'SubagentStop' }
  | { kind: 'hook'; event: string } // forward-compat: unknown hook events
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

  // terminal-ish: crashed only leaves via restart (manager re-creates)
  if (current === 'crashed' && ev.kind !== 'hook') {
    if (ev.kind === 'exit') return stay();
  }

  switch (ev.kind) {
    case 'exit':
      // done -> exit(0) is a normal wind-down, not a crash
      return ev.code === 0 || current === 'done' ? to('done') : to('crashed');
    case 'permission-held':
      return to('needs-permission');
    case 'permission-resolved':
      return to('working');
    case 'user-input':
      // typing answers whatever was being waited on
      return current === 'needs-input' || current === 'needs-permission' || current === 'idle'
        ? to('working')
        : stay();
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
          const n = ev as { notificationType?: string; message?: string };
          const blob = `${n.notificationType ?? ''} ${n.message ?? ''}`;
          if (/permission/i.test(blob)) return to('needs-permission');
          if (/waiting|input|idle/i.test(blob)) return to('needs-input');
          return stay(`notification:${n.notificationType ?? 'unknown'}`);
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
