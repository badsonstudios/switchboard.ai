// @vitest-environment jsdom
//
// Which wire the renderer's three write paths end up on (#381).
//
// The file they test has one rule — ASK MAIN FIRST, fall back to the PTY only
// when main says this session has no typed-message transport — and it had no
// test at all until Direct mode became the default. That is the moment the rule
// stops being a nicety: a path that skips it is a control that silently does
// nothing for every user, which is what `/clear` and `/compact` were.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendSessionCommand, submitPrompt, interruptSession, SUBMIT_DELAY_MS } from './composer';
import { sessionStore } from '../store/session-store';

/** everything written to the PTY, in order, as the bridge would have seen it */
let ptyWrites: Array<{ id: string; data: string }>;
/** the prompts main accepted over a typed-message transport */
let submitted: Array<{ id: string; text: string }>;
/** what `sessions.submitPrompt` answers — false = "no typed transport here" */
let mainTakesPrompts = true;
let mainTakesInterrupts = true;

beforeEach(() => {
  ptyWrites = [];
  submitted = [];
  mainTakesPrompts = true;
  mainTakesInterrupts = true;
  vi.useFakeTimers();
  (window as unknown as { switchboard: unknown }).switchboard = {
    pty: { input: (id: string, data: string) => ptyWrites.push({ id, data }) },
    sessions: {
      submitPrompt: (id: string, text: string) => {
        if (mainTakesPrompts) submitted.push({ id, text });
        return Promise.resolve(mainTakesPrompts);
      },
      interrupt: () => Promise.resolve(mainTakesInterrupts),
    },
  };
});

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
