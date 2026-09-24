// The session controls — "clear this conversation", "compact this
// conversation" — as ONE implementation with two entry points: the card's ⋯
// menu (SessionGrid) and the buttons on the composer's options row (#903).
//
// Both of those are §5.10 INPUT ROUTES to the real CLI: they type `/clear` and
// `/compact` into the session and let the CLI decide what that means
// (host-don't-reimplement). Nothing here reimplements either command; what
// lives here is the pair of commands, and the rule for when they are allowed —
// which is the part that was previously inlined in the card and would have been
// copied to the second surface.
import { sendSessionCommand } from './composer';

/**
 * Why the session controls are unavailable, or `null` when they work.
 *
 * `'starting'` — the CLI may still be in a startup TUI dialog the composer
 * cannot see (§5.10 startup-dialog rule), so a write now lands in the wrong
 * place.
 * `'dead'` — the live session is gone; the write would be a silent no-op.
 *
 * `'done'` is deliberately NOT a lock: the session is idle, not gone.
 */
export type SessionControlLock = 'starting' | 'dead' | null;

/**
 * The lock rule, for every surface that offers these controls.
 *
 * `ended` is the card's own "this session exited, or never started" record — a
 * session can die WITHOUT its status reaching `crashed` (a clean exit leaves
 * `done`), so a surface that only has the status word cannot compute this by
 * itself. That is exactly why the value is computed once in the card and handed
 * down rather than recomputed in the composer.
 */
export function sessionControlLock(
  status: string | undefined,
  // `object | null`, not `unknown`: the card's record is an object or nothing,
  // and a looser type would let a future caller pass `false` or `0` and get a
  // permanent lock out of a value that meant "not ended".
  ended: object | null | undefined = null
): SessionControlLock {
  if (status === 'starting') return 'starting';
  if (status === 'crashed' || (ended !== null && ended !== undefined)) return 'dead';
  return null;
}

/**
 * What to tell the user when a control is locked — the SAME words on both
 * surfaces (#903 done-when 3). The keys are the ⋯ menu's originals: they are
 * not menu-specific copy, and renaming them would be churn for its own sake.
 */
export function lockReasonKey(lock: SessionControlLock): string | null {
  if (lock === 'starting') return 'grid.menuStarting';
  if (lock === 'dead') return 'grid.menuDead';
  return null;
}

/**
 * Clear the conversation. ALWAYS confirm before calling this — every caller
 * does, and the reason is in the copy: the session's context starts over and
 * there is no undo on the CLI side.
 */
export async function clearConversation(liveId: string): Promise<void> {
  await sendSessionCommand(liveId, '/clear');
}

/** Compact the conversation — the CLI summarizes to free context. */
export async function compactConversation(liveId: string): Promise<void> {
  await sendSessionCommand(liveId, '/compact');
}
