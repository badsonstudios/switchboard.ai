// Which permission mode is this session in RIGHT NOW? (#1072)
//
// ── WHY THIS STORE HAS TO EXIST ─────────────────────────────────────────────
//
// Because a session's mode is not only something we set. `SessionRecord.autonomy`
// is the mode a session was STARTED at, and the manual has always said a changed
// mode applies at the next start — true of every change WE make. But the CLI
// changes mode by itself, mid-run: approve a plan and it leaves plan mode, and
// from then on asks about each change as an `ask` session does. Measured on
// 2.1.288 (`spike/findings/588-plan-mode-permission-bar.md`, trial C): Allow at
// 6,525 ms; a `system` message with `subtype: 'status'` and
// `permissionMode: 'default'` at 6,532 ms.
//
// Nothing read that message. The shield chip went on saying **plan** for a
// session that was about to start editing — and the chip is the only place
// anyone looks to find out which mode a session is in.
//
// So this is `stream-model.ts`'s shape for the same kind of fact: something only
// the CLI knows, announced unprompted on the stream, that nobody can ask for.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
//
// It does not touch `SessionRecord.autonomy`. That field drives the hold policy
// (E10-03) and is "the mode this session was spawned at" everywhere it is read;
// rewriting it from a status message would change what gets held, on the
// strength of a display bug. This store is what the session SAYS it is in, kept
// beside the record, and the surfaces that show a mode prefer it.
//
// And it holds nothing until the CLI has said something: `modeFor` answers
// `null` for a session that has announced no mode, and the caller falls back to
// the mode it was started at — which, until the CLI says otherwise, is the
// truth.
import { errorText } from '../../shared/error-text';
import { AUTONOMY_MODES, type AutonomyMode } from '../../shared/sessions';
import { Logger } from '../log/logger';
import { AUTONOMY_PERMISSION_MODE } from '../providers/claude';

/**
 * The CLI's `permissionMode` value → our profile, or `null` for one we have no
 * name for.
 *
 * Derived from `AUTONOMY_PERMISSION_MODE` rather than written out a second
 * time, so the two directions cannot disagree. The CLI has modes we do not
 * offer (`auto`, `dontAsk`); for those the honest answer is "unknown", and the
 * caller keeps showing what it had rather than a profile that is merely close.
 */
export function autonomyFromPermissionMode(value: unknown): AutonomyMode | null {
  if (typeof value !== 'string') return null;
  for (const mode of AUTONOMY_MODES) {
    if (AUTONOMY_PERMISSION_MODE[mode] === value) return mode;
  }
  return null;
}

export class StreamMode {
  private readonly bySession = new Map<string, AutonomyMode>();
  private readonly listeners = new Set<(sessionId: string, mode: AutonomyMode) => void>();

  /** Optional so a test can construct one bare; the app always passes it. */
  constructor(private readonly log?: Logger) {}

  /** Told when a session's announced mode CHANGES. Returns its own unsubscribe. */
  onChange(fn: (sessionId: string, mode: AutonomyMode) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /**
   * Feed one stream message. Ignores everything that is not a `system` /
   * `status` carrying a `permissionMode` we have a name for.
   *
   * `status` messages carry other things too (and may carry no mode at all), so
   * an absent field is the ordinary case and says nothing. An UNKNOWN value
   * keeps whatever we had — fail-open (P6): a stale chip beats a wrong one —
   * and is logged at `debug`, because a CLI that grows a mode would otherwise
   * shout on every announcement about something nobody here can act on.
   */
  offer(sessionId: string, msg: Record<string, unknown>): void {
    if (msg.type !== 'system' || msg.subtype !== 'status') return;
    if (msg.permissionMode === undefined) return;
    const mode = autonomyFromPermissionMode(msg.permissionMode);
    if (!mode) {
      this.log?.debug('stream status mode ignored', {
        sessionId,
        got: typeof msg.permissionMode === 'string' ? msg.permissionMode.slice(0, 40) : typeof msg.permissionMode,
      });
      return;
    }
    // only when it actually moved: one IPC message per real change, not per status
    if (this.bySession.get(sessionId) === mode) return;
    this.bySession.set(sessionId, mode);
    this.log?.info('session mode announced by the CLI', { sessionId, mode });
    for (const fn of this.listeners) {
      try {
        fn(sessionId, mode);
      } catch (err) {
        // a listener that throws must not cost the store its write
        this.log?.error('stream mode listener threw', { sessionId, error: errorText(err) });
      }
    }
  }

  /**
   * The mode this session last said it is in, or `null` for "it has not said".
   *
   * NULL IS A REAL ANSWER: fall back to the mode the session was started at.
   */
  modeFor(sessionId: string): AutonomyMode | null {
    return this.bySession.get(sessionId) ?? null;
  }

  /**
   * The session is gone; so is what it said. Silent, like `StreamModel`'s.
   *
   * This is also what makes "back to the configured mode at the next start"
   * true without any code saying so: a restart is a NEW live session with a new
   * id, which has announced nothing.
   */
  forgetSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
