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
import { sendSessionCommand, submitPrompt, interruptSession, SUBMIT_DELAY_MS } from './composer';
import { sessionStore } from '../store/session-store';
import { ipcRefusal } from '../../../shared/ipc/refusal';

/** everything written to the PTY, in order, as the bridge would have seen it */
let ptyWrites: Array<{ id: string; data: string }>;
/** the prompts main accepted over a typed-message transport */
let submitted: Array<{ id: string; text: string }>;
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
  vi.useFakeTimers();
  // Re-installing fake timers does NOT drop what the previous test scheduled,
  // and `writePromptToPty` schedules its CR 75ms out — so a test that ends
  // before flushing leaves a live timer whose callback resolves
  // `window.switchboard.pty.input` at FIRE time, i.e. writes into the NEXT
  // test's `ptyWrites`. Found while mutation-testing P2-E18-17: a mutant that
  // failed early leaked a stray CR into an unrelated test three cases later.
  vi.clearAllTimers();
  (window as unknown as { switchboard: unknown }).switchboard = {
    pty: { input: (id: string, data: string) => ptyWrites.push({ id, data }) },
    sessions: {
      submitPrompt: (id: string, text: string) => {
        if (promptFailure) return Promise.reject(promptFailure);
        if (mainTakesPrompts) submitted.push({ id, text });
        return Promise.resolve(mainTakesPrompts);
      },
      interrupt: () =>
        interruptFailure ? Promise.reject(interruptFailure) : Promise.resolve(mainTakesInterrupts),
    },
  };
});

// ...and hand the clock back, so nothing that runs after this file's last test
// inherits a frozen one.
afterEach(() => vi.useRealTimers());

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

describe('sendSessionCommand — the ⋯ menu route (#381)', () => {
  it('goes over the typed transport when the session has one', async () => {
    await sendSessionCommand('live-1', '/compact');

    expect(submitted).toEqual([{ id: 'live-1', text: '/compact' }]);
    expect(ptyWrites).toEqual([]);
  });

  // The whole bug: a stream session has no PTY, so a direct `pty.input` was
  // dropped and the menu item did nothing at all.
  it('falls back to the PTY only when main declines', async () => {
    mainTakesPrompts = false;

    await sendSessionCommand('live-1', '/clear');

    expect(submitted).toEqual([]);
    expect(ptyWrites[0]).toEqual({ id: 'live-1', data: '/clear' });
    // ...and the separate, delayed CR that a TUI needs to treat it as submitted
    vi.advanceTimersByTime(SUBMIT_DELAY_MS);
    expect(ptyWrites[1]).toEqual({ id: 'live-1', data: String.fromCharCode(13) });
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

  it('writes Esc to the PTY when main declines', async () => {
    mainTakesInterrupts = false;
    await interruptSession('live-1');
    expect(ptyWrites).toEqual([{ id: 'live-1', data: String.fromCharCode(27) }]);
  });
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

  it('sendSessionCommand falls back to the PTY instead of rejecting', async () => {
    promptFailure = new Error('ipc exploded');

    await expect(sendSessionCommand('live-1', '/compact')).resolves.toBeUndefined();

    expect(ptyWrites[0]).toEqual({ id: 'live-1', data: '/compact' });
    vi.advanceTimersByTime(SUBMIT_DELAY_MS);
    expect(ptyWrites[1]).toEqual({ id: 'live-1', data: CR });
  });

  it('...and says so, because a silent recovery is how #154 hid for weeks', async () => {
    promptFailure = new Error('ipc exploded');

    await sendSessionCommand('live-1', '/compact');

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('submitPrompt');
    expect(warn.mock.calls[0][1]).toBe(promptFailure); // the cause, not just a shrug
  });

  it('interruptSession falls back to Esc instead of rejecting', async () => {
    interruptFailure = new Error('ipc exploded');

    await expect(interruptSession('live-1')).resolves.toBeUndefined();

    expect(ptyWrites).toEqual([{ id: 'live-1', data: ESC }]);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('interrupt');
  });

  it('submitPrompt survives it too, and still counts as a submit', async () => {
    const notify = vi.spyOn(sessionStore, 'notifyPromptSubmitted');
    promptFailure = new Error('ipc exploded');

    await expect(submitPrompt('live-1', 'hello')).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledWith('live-1');
    expect(ptyWrites[0]).toEqual({ id: 'live-1', data: 'hello' });
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

    expect(ptyWrites[0]).toEqual({ id: 'live-1', data: '/clear' });
  });
});

// The bracketed paste had zero coverage repo-wide, which is startling for a
// line whose shape is a measured CLI finding (S-03, refound live 2026-07-22):
// a multiline prompt written raw is read by the TUI as many submitted prompts,
// and text+CR in one chunk registers as a paste that never submits at all.
describe('writePromptToPty: multiline is ONE bracketed paste (P2-E18-17)', () => {
  beforeEach(() => {
    mainTakesPrompts = false; // the PTY route is the only one that pastes
  });

  it('wraps a multiline prompt in the paste brackets, as a single write', async () => {
    await sendSessionCommand('live-1', 'first\nsecond');

    expect(ptyWrites).toEqual([
      { id: 'live-1', data: ESC + '[200~' + 'first\nsecond' + ESC + '[201~' },
    ]);
  });

  it('does not wrap a single-line prompt — brackets are for the newline', async () => {
    await sendSessionCommand('live-1', 'just one line');

    expect(ptyWrites[0].data).toBe('just one line');
  });

  it('a trailing newline alone is enough to make it a paste', async () => {
    await sendSessionCommand('live-1', 'one\n');

    expect(ptyWrites[0].data).toBe(ESC + '[200~' + 'one\n' + ESC + '[201~');
  });

  // THE S-03 finding, and the reason SUBMIT_DELAY_MS exists: the CR is a
  // SEPARATE, LATER write. Bundling it into the paste is the one-character
  // change that makes every multiline prompt sit in the composer unsent.
  it('the CR is a separate, delayed write — never part of the paste', async () => {
    await sendSessionCommand('live-1', 'first\nsecond');

    expect(ptyWrites).toHaveLength(1); // nothing has submitted it yet
    expect(ptyWrites[0].data.endsWith(CR)).toBe(false);
    vi.advanceTimersByTime(SUBMIT_DELAY_MS);
    expect(ptyWrites[1]).toEqual({ id: 'live-1', data: CR });
  });

  it('the CR does not arrive early either', async () => {
    await sendSessionCommand('live-1', 'hello');

    vi.advanceTimersByTime(SUBMIT_DELAY_MS - 1);
    expect(ptyWrites).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ptyWrites).toHaveLength(2);
  });
});

// `submitPrompt`'s fallback was asserted only through `sendSessionCommand`
// before this item — i.e. the user-facing route was never watched taking the
// PTY path at all, which is the route EVERY Terminal-mode session uses.
describe('submitPrompt on the PTY route writes the same bytes (P2-E18-17)', () => {
  it('pastes the prompt and submits it with the delayed CR', async () => {
    mainTakesPrompts = false;

    await submitPrompt('live-1', 'write me a haiku\nabout ptys');

    expect(submitted).toEqual([]);
    expect(ptyWrites).toEqual([
      { id: 'live-1', data: ESC + '[200~' + 'write me a haiku\nabout ptys' + ESC + '[201~' },
    ]);
    vi.advanceTimersByTime(SUBMIT_DELAY_MS);
    expect(ptyWrites[1]).toEqual({ id: 'live-1', data: CR });
  });

  it('writes NOTHING to the PTY when main took the prompt', async () => {
    await submitPrompt('live-1', 'hello');

    vi.advanceTimersByTime(SUBMIT_DELAY_MS);
    expect(ptyWrites).toEqual([]);
    expect(submitted).toEqual([{ id: 'live-1', text: 'hello' }]);
  });
});
