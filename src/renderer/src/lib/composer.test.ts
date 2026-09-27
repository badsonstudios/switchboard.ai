// @vitest-environment jsdom
//
// Which wire the renderer's three write paths end up on (#381).
//
// The file they test has one rule — ASK MAIN FIRST, fall back to the PTY only
// when main says this session has no typed-message transport — and it had no
// test at all until Direct mode became the default. That is the moment the rule
// stops being a nicety: a path that skips it is a control that silently does
// nothing for every user, which is what `/clear` and `/compact` were.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  sendSessionCommand,
  submitPrompt,
  interruptSession,
  resolveDraftMentions,
} from './composer';
import { sessionStore } from '../store/session-store';
import { ipcRefusal } from '../../../shared/ipc/refusal';

/** everything written to the PTY, in order, as the bridge would have seen it */
let ptyWrites: Array<{ id: string; data: string }>;
/** the prompts main accepted over a typed-message transport */
let submitted: Array<{ id: string; text: string; attachments?: unknown }>;
/** what `sessions.submitPrompt` answers — false = "no typed transport here" */
let mainTakesPrompts = true;
let mainTakesInterrupts = true;
/** when set, that IPC REJECTS instead of answering at all (P2-E18-17) */
let promptFailure: Error | null = null;
let interruptFailure: Error | null = null;

beforeEach(() => {
  ptyWrites = [];
  submitted = [];
  mainTakesPrompts = true;
  mainTakesInterrupts = true;
  promptFailure = null;
  interruptFailure = null;
  // Installing is all this file has to do: `writePromptToPty` schedules its CR
  // 75ms out, and a case that ends before flushing would otherwise write into
  // the NEXT case's `ptyWrites` (#439 — re-installing fake timers does NOT drop
  // what the previous test armed). The net in `src/test-setup.ts` empties the
  // queue and hands the clock back after every test in the run (#441).
  vi.useFakeTimers();
  (window as unknown as { switchboard: unknown }).switchboard = {
    pty: { input: (id: string, data: string) => ptyWrites.push({ id, data }) },
    sessions: {
      submitPrompt: (id: string, text: string, attachments?: unknown) => {
        if (promptFailure) return Promise.reject(promptFailure);
        if (mainTakesPrompts) submitted.push({ id, text, attachments });
        return Promise.resolve(mainTakesPrompts);
      },
      interrupt: () =>
        interruptFailure ? Promise.reject(interruptFailure) : Promise.resolve(mainTakesInterrupts),
    },
  };
});


describe('resolveDraftMentions — what a draft with @-mentions becomes (P2-E11-08)', () => {
  const answer = (value: unknown) => {
    (window.switchboard.sessions as unknown as { resolveMentions: unknown }).resolveMentions = (
      id: string,
      text: string
    ) => {
      asked.push([id, text]);
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    };
  };
  let asked: Array<[string, string]>;
  beforeEach(() => {
    asked = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('asks main about THIS session and sends the prompt main built', async () => {
    answer({ ok: true, prompt: 'BLOCK\n\ntake "A" (session)' });
    await expect(resolveDraftMentions('live-1', 'take @A')).resolves.toEqual({
      kind: 'send',
      prompt: 'BLOCK\n\ntake "A" (session)',
    });
    expect(asked).toEqual([['live-1', 'take @A']]);
  });

  it('passes an ambiguous-name refusal through — the send must not happen', async () => {
    answer({ ok: false, refusals: ['"A" is ambiguous'] });
    await expect(resolveDraftMentions('live-1', 'take @A')).resolves.toEqual({
      kind: 'refused',
      refusals: ['"A" is ambiguous'],
    });
  });

  // Fail open (P6): every way the LOOKUP can fail sends the draft as typed and
  // is marked so the composer can say the context did not go.
  const failures: Array<[string, unknown]> = [
    ['main answers null (it refused the call)', null],
    ['the channel is refused by capability', ipcRefusal('sessions:resolveMentions', 'capability' as Parameters<typeof ipcRefusal>[1])],
    ['the invoke rejects', new Error('gone')],
    ['a shape nobody sends', { ok: 'maybe' }],
    ['a refusal with no reasons', { ok: false, refusals: [] }],
  ];
  for (const [what, value] of failures) {
    it(`${what} → unresolved, the draft exactly as typed`, async () => {
      answer(value);
      await expect(resolveDraftMentions('live-1', 'take @A')).resolves.toEqual({
        kind: 'unresolved',
        prompt: 'take @A',
      });
    });
  }
});

describe('sendSessionCommand — the ⋯ menu route (#381)', () => {
  it('goes over the typed transport when the session has one', async () => {
    await sendSessionCommand('live-1', '/compact');

    expect(submitted).toEqual([{ id: 'live-1', text: '/compact' }]);
    expect(ptyWrites).toEqual([]);
  });

  // THE WHOLE BUG #381 FIXED, and what is left of it (#952). A stream session had
  // no PTY, so a direct `pty.input` was dropped and the menu item did nothing at
  // all — which is why this route learned to try main FIRST and only then fall
  // back. There is nothing to fall back TO now, so what has to survive is the
  // other half: main declining must not look like success.
  it('does not claim success when main declines', async () => {
    mainTakesPrompts = false;

    await sendSessionCommand('live-1', '/clear');

    expect(submitted).toEqual([]);
    expect(ptyWrites).toEqual([]); // and nothing is written anywhere else either
  });

  // §5.8: the workspace folding itself away because you clicked a menu item
  // would be baffling. This is the ONLY difference from `submitPrompt`, so it
  // is the only thing that could be lost by routing them through one function.
  it('does not count as the user submitting a prompt', async () => {
    const notify = vi.spyOn(sessionStore, 'notifyPromptSubmitted');

    await sendSessionCommand('live-1', '/compact');

    expect(notify).not.toHaveBeenCalled();
    notify.mockRestore();
  });
});

describe('submitPrompt', () => {
  it('sends the prompt AND announces it', async () => {
    const notify = vi.spyOn(sessionStore, 'notifyPromptSubmitted');

    await submitPrompt('live-1', 'hello');

    expect(notify).toHaveBeenCalledWith('live-1');
    expect(submitted).toEqual([{ id: 'live-1', text: 'hello' }]);
    notify.mockRestore();
  });

  it('announces before the round trip, not after it', async () => {
    const order: string[] = [];
    const notify = vi
      .spyOn(sessionStore, 'notifyPromptSubmitted')
      .mockImplementation(() => void order.push('notified'));
    mainTakesPrompts = false;

    const done = submitPrompt('live-1', 'hello');
    // the IPC promise has not resolved yet, and the collapse has already run
    expect(order).toEqual(['notified']);
    await done;

    notify.mockRestore();
  });
});

describe('interruptSession (#154)', () => {
  it('asks main first', async () => {
    await interruptSession('live-1');
    expect(ptyWrites).toEqual([]);
  });

  // "Writes Esc to the PTY when main declines" went with the fallback (#952).
  // The stop button used to write Esc unconditionally and a stream session had no
  // PTY, so it was a silent no-op and the button did nothing at all — Dan
  // reproduced it every time (#154). `interrupt` is a real control request now.
});

// ---------------------------------------------------------------------------
// P2-E18-17 — the pins the #404 audit found missing.
// ---------------------------------------------------------------------------

// A rejecting IPC used to be the #154 defect on a different trigger: every
// caller of these functions is a `void`-ed click handler, so the rejection
// became an unhandled renderer rejection AND the fallback never ran — the
// control did nothing and said nothing. All three tests below fail (unhandled
// rejection, no PTY write) if `mainTook`'s try/catch is deleted.
describe('a rejecting IPC is read as "main did not take it" (P2-E18-17)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  // Two fallback tests went with the PTY route (#952). What they were REALLY
  // about survives in `mainTook`, asserted below: a REJECTING ipc must be read as
  // "main did not take it" and said out loud, because every caller is a `void`-ed
  // click handler — so a rejection used to become an unhandled renderer rejection
  // AND skip the fallback, leaving the control doing nothing and saying nothing.

  it('...and says so, because a silent recovery is how #154 hid for weeks', async () => {
    promptFailure = new Error('ipc exploded');

    await sendSessionCommand('live-1', '/compact');

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('submitPrompt');
    expect(warn.mock.calls[0][1]).toBe(promptFailure); // the cause, not just a shrug
  });


  it('submitPrompt survives it too, and still counts as a submit', async () => {
    const notify = vi.spyOn(sessionStore, 'notifyPromptSubmitted');
    promptFailure = new Error('ipc exploded');

    // FALSE now, and the change is the point (#952). A text prompt used to always
    // go somewhere — main took it, or the PTY route did — so only the image path
    // (P2-E10-09) could answer false. With no second route a rejected send really
    // did not happen, and the caller MUST be told, or the composer clears a draft
    // whose words went nowhere.
    await expect(submitPrompt('live-1', 'hello')).resolves.toBe(false);

    // §5.8's auto-minimize still fires: it is a response to the user's GESTURE,
    // deliberately taken before the IPC round trip, and it must not depend on
    // whether the send succeeded.
    expect(notify).toHaveBeenCalledWith('live-1');
    expect(ptyWrites).toEqual([]);
    notify.mockRestore();
  });

  // The nothing-happened case stays untouched: a plain `false` is a routine
  // answer ("this session is a PTY"), not a failure, and must not put a line in
  // anybody's console.
  it('a plain false is not warned about — it is the normal PTY answer', async () => {
    mainTakesPrompts = false;

    await sendSessionCommand('live-1', '/clear');

    expect(warn).not.toHaveBeenCalled();
  });

  // The OTHER door: `broker.handle` resolves an `IpcRefusal` OBJECT for a
  // refused channel instead of throwing (#346), and an object is truthy — so a
  // truthiness check reads a refusal as "main took it" and drops the command on
  // the floor, which is #154 all over again. Unreachable today (first-party
  // holds every capability), and green either way unless `mainTook` compares
  // `=== true`.
  it('a refusal OBJECT is not mistaken for a yes', async () => {
    // the broker's real payload, built by the real factory — a hand-rolled
    // stand-in would stop matching the day the brand changes
    (
      window as unknown as { switchboard: { sessions: Record<string, unknown> } }
    ).switchboard.sessions.submitPrompt = () =>
      Promise.resolve(ipcRefusal('sessions:submitPrompt', 'capability-not-held'));

    await sendSessionCommand('live-1', '/clear');

    // A refusal is a NO, and with no fallback route the only thing left to assert
    // is that it was not mistaken for a yes: nothing was written anywhere.
    expect(ptyWrites).toEqual([]);
    expect(submitted).toEqual([]);
  });
});

// The bracketed paste had zero coverage repo-wide, which is startling for a
// line whose shape is a measured CLI finding (S-03, refound live 2026-07-22):
// a multiline prompt written raw is read by the TUI as many submitted prompts,
// and text+CR in one chunk registers as a paste that never submits at all.
// ── TWO PTY-ROUTE SUITES WENT WITH THE FALLBACK (#952) ──────────────────────
//
// `writePromptToPty: multiline is ONE bracketed paste` and `submitPrompt on the
// PTY route writes the same bytes` pinned the byte-level shape of a keystroke
// submit: a multiline prompt wrapped in ESC[200~ … ESC[201~ as a SINGLE write,
// then the carriage return SEPARATELY, 75ms later.
//
// ⚠️ THE SEPARATION WAS A MEASURED FINDING, NOT A STYLE CHOICE: text and a CR
// written together register as a PASTE in the CLI's TUI and never submit (S-03,
// refound live 2026-07-22). It is recorded here because it is the kind of thing
// that gets rediscovered the expensive way, and because `main/mcp/ipc.ts`
// carried a duplicate of the same constants for the same reason.

describe('submitPrompt WITH IMAGES (P2-E10-09)', () => {
  const png = { kind: 'image' as const, mediaType: 'image/png' as const, data: 'AQIDBA==' };

  it('hands the attachments to main alongside the text', async () => {
    await expect(submitPrompt('live-1', 'what is this?', [png])).resolves.toBe(true);

    expect(submitted).toEqual([{ id: 'live-1', text: 'what is this?', attachments: [png] }]);
    expect(ptyWrites).toEqual([]);
  });

  // THE DEFECT THIS PREVENTS: a silent half-send. Nothing may reach the PTY,
  // and the caller must be told it failed so the draft and the attachments stay
  // on screen instead of being cleared into nowhere.
  it('reports failure instead of sending the words without the picture', async () => {
    mainTakesPrompts = false;

    await expect(submitPrompt('live-1', 'what is this?', [png])).resolves.toBe(false);

    expect(ptyWrites).toEqual([]);
    expect(submitted).toEqual([]);
  });

  it('reports failure on a REJECTING ipc too, still without a PTY write', async () => {
    promptFailure = new Error('ipc exploded');

    await expect(submitPrompt('live-1', 'what is this?', [png])).resolves.toBe(false);

    expect(ptyWrites).toEqual([]);
  });

  // §5.8's auto-minimize is about the USER submitting, not about which
  // transport took it — an image prompt is still a prompt.
  it('still counts as the user submitting a prompt', async () => {
    const notify = vi.spyOn(sessionStore, 'notifyPromptSubmitted');
    mainTakesPrompts = false;

    await submitPrompt('live-1', 'look', [png]);

    expect(notify).toHaveBeenCalledWith('live-1');
    notify.mockRestore();
  });
});
