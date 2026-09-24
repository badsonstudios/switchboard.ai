// @vitest-environment jsdom
//
// The session controls are ONE implementation with two entry points (#903): the
// card's ⋯ menu and the buttons on the composer's options row. This file tests
// the implementation; `FeedView.session-controls.test.tsx` tests that the row
// actually reaches it, and `SessionGrid`'s menu is the other caller.
//
// The lock rule is the part worth pinning. It used to be an expression inlined
// in the card, and the second surface could only have copied it — at which
// point "the same enabled/disabled rules as the menu" is a promise nothing
// enforces.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearConversation,
  compactConversation,
  lockReasonKey,
  sessionControlLock,
} from './session-controls';

/** the prompts main accepted over a typed-message transport */
let submitted: Array<{ id: string; text: string }>;

beforeEach(() => {
  submitted = [];
  vi.useFakeTimers();
  (window as unknown as { switchboard: unknown }).switchboard = {
    pty: { input: () => {} },
    sessions: {
      submitPrompt: (id: string, text: string) => {
        submitted.push({ id, text });
        return Promise.resolve(true);
      },
    },
  };
});

describe('sessionControlLock', () => {
  it('locks while the session is starting — the CLI may be in a start-up dialog', () => {
    expect(sessionControlLock('starting', null)).toBe('starting');
  });

  it('locks a crashed session', () => {
    expect(sessionControlLock('crashed', null)).toBe('dead');
  });

  // The case a surface holding only `status` cannot compute, and the whole
  // reason the value is handed down from the card rather than re-derived: a
  // session that exits CLEANLY is just as gone, and its status word is not
  // `crashed`. Re-deriving from the status would have put a live Clear button
  // on a session there is nothing left to clear.
  it('locks a session that ENDED even when the status word looks harmless', () => {
    expect(sessionControlLock('done', { kind: 'exited', code: 0 })).toBe('dead');
    expect(sessionControlLock('idle', { kind: 'never-started' })).toBe('dead');
  });

  it('leaves an idle, working or done session unlocked — done is idle, not gone', () => {
    expect(sessionControlLock('idle', null)).toBeNull();
    expect(sessionControlLock('working', null)).toBeNull();
    expect(sessionControlLock('done', null)).toBeNull();
    expect(sessionControlLock('needs-input', null)).toBeNull();
  });

  // `ended` defaults to "not ended", so a caller that genuinely has no such
  // record (a panel) gets the status-only answer instead of a permanent lock.
  it('treats a missing ended record as not-ended, not as ended', () => {
    expect(sessionControlLock('idle')).toBeNull();
    expect(sessionControlLock('idle', undefined)).toBeNull();
  });

  it('an unknown status is not a lock — a word we do not recognise is not a death', () => {
    expect(sessionControlLock('suspended', null)).toBeNull();
    expect(sessionControlLock(undefined, null)).toBeNull();
  });
});

describe('lockReasonKey', () => {
  // The menu's own keys, so both surfaces say the same sentence. A surface that
  // invented its own copy is the failure this function exists to prevent.
  it('names the reason with the keys the menu already uses', () => {
    expect(lockReasonKey('starting')).toBe('grid.menuStarting');
    expect(lockReasonKey('dead')).toBe('grid.menuDead');
  });

  it('has no reason to give when nothing is locked', () => {
    expect(lockReasonKey(null)).toBeNull();
  });
});

describe('the two commands', () => {
  // Host-don't-reimplement: these type the REAL slash commands into the real
  // CLI and let it decide what clearing and compacting mean. If this ever
  // asserts something other than the literal `/clear` and `/compact`, the
  // feature has stopped being a route to the CLI and started being a guess.
  it('clear types /clear into the session', async () => {
    await clearConversation('live-1');
    expect(submitted).toEqual([{ id: 'live-1', text: '/clear' }]);
  });

  it('compact types /compact into the session', async () => {
    await compactConversation('live-7');
    expect(submitted).toEqual([{ id: 'live-7', text: '/compact' }]);
  });

  // Both go through `sendSessionCommand`, which asks main first and only falls
  // back to the PTY when the session has no typed-message transport (#381).
  // That is what makes the buttons work on BOTH transports, which #903 asks
  // about explicitly — so a rewrite that reached for the PTY directly has to
  // fail here.
  it('falls back to the PTY when main has no typed transport for the session', async () => {
    const writes: Array<{ id: string; data: string }> = [];
    (window as unknown as { switchboard: unknown }).switchboard = {
      pty: { input: (id: string, data: string) => writes.push({ id, data }) },
      sessions: { submitPrompt: () => Promise.resolve(false) },
    };
    await compactConversation('live-2');
    await vi.advanceTimersByTimeAsync(200);
    expect(writes.map((w) => w.data)).toContain('/compact');
  });
});
