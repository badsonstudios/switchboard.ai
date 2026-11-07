// The window's side of a card's sticky note (#1544).
//
// A stand-in store, like `delivery-ipc.test.ts`: the claim under test is what
// each handler DECIDES. A refusal is `null` plus one log line, never a throw,
// and the note's words never reach the log.
import { describe, it, expect } from 'vitest';
import { NOTE_REQUEST_PROMPT, WAITING_NOTE_CONTEXT, busNotes, clearWaitingNote, registerNoteIpc } from './note-ipc';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import type { SessionNote, SessionNoteChange } from '../../shared/session-note';

type Handler = (e: unknown, ...args: unknown[]) => unknown;

const CARD = 'card-a';
const NOW = new Date('2026-11-06T14:18:00.000Z');

function harness(opts: { known?: string[]; failWrite?: boolean } = {}) {
  const known = opts.known ?? [CARD];
  const handlers = new Map<string, Handler>();
  const logs: { level: string; msg: string; fields?: LogFields }[] = [];
  const notes = new Map<string, SessionNote>();
  const pushes: SessionNoteChange[] = [];
  const broker = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) } as unknown as IpcBroker;
  const record =
    (level: string) =>
    (msg: string, fields?: LogFields): void =>
      void logs.push({ level, msg, fields });
  const log: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => log,
  };
  registerNoteIpc({
    broker,
    log,
    store: {
      cardNote: (id) => notes.get(id),
      setCardNote: (id, n) => {
        if (opts.failWrite) throw new Error('disk full');
        if (n) notes.set(id, n);
        else notes.delete(id);
        return notes.get(id);
      },
    },
    knownCard: (id) => known.includes(id),
    push: (c) => void pushes.push(c),
    now: () => NOW,
  });
  const call = (channel: string, ...args: unknown[]): unknown => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h(null, ...args);
  };
  return { call, logs, notes, pushes };
}

describe('sessions:setNote', () => {
  it('stores the cleaned text as the user, stamps the time, and tells the window', () => {
    const h = harness();
    const stored = h.call('sessions:setNote', CARD, '  Waiting on\nTanner  ');
    expect(stored).toEqual({ text: 'Waiting on Tanner', by: 'user', at: NOW.toISOString() });
    expect(h.notes.get(CARD)).toEqual(stored);
    expect(h.pushes).toEqual([{ cardId: CARD, note: stored }]);
  });

  it('replaces the note: one per card, last writer wins', () => {
    const h = harness();
    h.call('sessions:setNote', CARD, 'first');
    h.call('sessions:setNote', CARD, 'second');
    expect(h.notes.get(CARD)?.text).toBe('second');
  });

  it('deletes the note when the text is empty or only spaces', () => {
    const h = harness();
    h.call('sessions:setNote', CARD, 'something');
    expect(h.call('sessions:setNote', CARD, '   ')).toBeNull();
    expect(h.notes.has(CARD)).toBe(false);
    expect(h.pushes.at(-1)).toEqual({ cardId: CARD });
  });

  it('caps the text at 200 characters', () => {
    const h = harness();
    const stored = h.call('sessions:setNote', CARD, 'x'.repeat(500)) as SessionNote;
    expect(stored.text).toHaveLength(200);
  });

  it('refuses a non-string text rather than reading it as "delete"', () => {
    const h = harness();
    h.call('sessions:setNote', CARD, 'keep me');
    expect(h.call('sessions:setNote', CARD, 42)).toBeNull();
    expect(h.notes.get(CARD)?.text).toBe('keep me');
    expect(h.logs.some((l) => l.level === 'warn' && /refused/.test(l.msg))).toBe(true);
  });

  it('refuses an unknown card and a non-string card id', () => {
    const h = harness();
    expect(h.call('sessions:setNote', 'nope', 'hi')).toBeNull();
    expect(h.call('sessions:setNote', 7, 'hi')).toBeNull();
    expect(h.notes.size).toBe(0);
    expect(h.pushes).toEqual([]);
  });

  it('never writes the note text to the log', () => {
    const h = harness();
    h.call('sessions:setNote', CARD, 'my secret plan');
    expect(JSON.stringify(h.logs)).not.toContain('secret');
  });

  it('fails open: a store that throws leaves a log line and an answer, not a throw', () => {
    const h = harness({ failWrite: true });
    expect(() => h.call('sessions:setNote', CARD, 'hi')).not.toThrow();
    expect(h.logs.some((l) => l.level === 'error')).toBe(true);
  });
});

describe('sessions:note', () => {
  it('reads the note back, or null when there is none', () => {
    const h = harness();
    expect(h.call('sessions:note', CARD)).toBeNull();
    h.call('sessions:setNote', CARD, 'hello');
    expect((h.call('sessions:note', CARD) as SessionNote).text).toBe('hello');
    expect(h.call('sessions:note', 5)).toBeNull();
  });
});

describe('set_session_note, the host side (#1544)', () => {
  function bus(cardFor: (id: string) => string | null = (id) => (id === 'live-1' ? CARD : null)) {
    const notes = new Map<string, SessionNote>();
    const pushes: SessionNoteChange[] = [];
    const logs: string[] = [];
    const log: Logger = {
      debug: () => {},
      info: (m) => void logs.push(m),
      warn: (m) => void logs.push(m),
      error: (m) => void logs.push(m),
      child: () => log,
    };
    const b = busNotes({
      store: {
        cardNote: (id) => notes.get(id),
        setCardNote: (id, n) => {
          if (n) notes.set(id, n);
          else notes.delete(id);
          return notes.get(id);
        },
      },
      push: (c) => void pushes.push(c),
      now: () => NOW,
      log,
      cardFor,
    });
    return { b, notes, pushes, logs };
  }

  it("writes the CALLER's card note as the AI, and tells the window", () => {
    const h = bus();
    const r = h.b.set('live-1', 'Blocked: need your call on the retry limit');
    expect(r).toEqual({ ok: true, value: { cleared: false, text: 'Blocked: need your call on the retry limit' } });
    expect(h.notes.get(CARD)).toEqual({ text: 'Blocked: need your call on the retry limit', by: 'ai', at: NOW.toISOString() });
    expect(h.pushes).toHaveLength(1);
  });

  it('says when it replaced a note the user wrote, and when the text was cut', () => {
    const h = bus();
    h.notes.set(CARD, { text: 'mine', by: 'user', at: NOW.toISOString() });
    const r = h.b.set('live-1', 'y'.repeat(300));
    expect(r).toMatchObject({ ok: true, value: { replaced: 'user', truncated: true } });
    expect(h.notes.get(CARD)?.text).toHaveLength(200);
  });

  it('clears with empty text', () => {
    const h = bus();
    h.b.set('live-1', 'x');
    expect(h.b.set('live-1', '')).toEqual({ ok: true, value: { cleared: true, replaced: 'ai' } });
    expect(h.notes.has(CARD)).toBe(false);
  });

  it('refuses a caller with no card, and a non-string text, touching nothing', () => {
    const h = bus();
    expect(h.b.set('stranger', 'x')).toMatchObject({ ok: false });
    expect(h.b.set('live-1', 42)).toMatchObject({ ok: false });
    expect(h.notes.size).toBe(0);
  });

  it('never logs the text', () => {
    const h = bus();
    h.b.set('live-1', 'secret plan');
    expect(JSON.stringify(h.logs)).not.toContain('secret');
  });
});

describe('sessions:askForNote, "Let Claude write it" (#1544)', () => {
  function asker(over: { hasBus?: boolean; sent?: boolean | 'throw'; card?: string | null } = {}) {
    const handlers = new Map<string, Handler>();
    const submitted: [string, string][] = [];
    const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log };
    registerNoteIpc({
      broker: { handle: (c: string, fn: Handler) => handlers.set(c, fn) } as unknown as IpcBroker,
      log,
      store: { cardNote: () => undefined, setCardNote: () => undefined },
      knownCard: () => true,
      push: () => {},
      ask: {
        cardFor: () => (over.card === undefined ? CARD : over.card),
        hasBus: () => over.hasBus ?? true,
        submit: async (id, text) => {
          if (over.sent === 'throw') throw new Error('pipe gone');
          submitted.push([id, text]);
          return over.sent ?? true;
        },
      },
    });
    const call = (...args: unknown[]): Promise<unknown> => Promise.resolve(handlers.get('sessions:askForNote')!(null, ...args));
    return { call, submitted };
  }

  it('sends the session the note request prompt', async () => {
    const h = asker();
    expect(await h.call('live-1')).toEqual({ ok: true });
    expect(h.submitted).toEqual([['live-1', NOTE_REQUEST_PROMPT]]);
    expect(NOTE_REQUEST_PROMPT).toMatch(/set_session_note/);
  });

  it('refuses a session whose AI cannot reach the switchboard tools, sending nothing', async () => {
    const h = asker({ hasBus: false });
    expect(await h.call('live-1')).toEqual({ ok: false, reason: 'no-tools' });
    expect(h.submitted).toEqual([]);
  });

  it('refuses an unknown session and a bad id', async () => {
    expect(await asker({ card: null }).call('live-1')).toEqual({ ok: false, reason: 'no-session' });
    expect(await asker().call(7)).toEqual({ ok: false, reason: 'no-session' });
  });

  it('fails open: a send that fails or throws is an answer, not a throw', async () => {
    expect(await asker({ sent: false }).call('live-1')).toEqual({ ok: false, reason: 'not-sent' });
    expect(await asker({ sent: 'throw' }).call('live-1')).toEqual({ ok: false, reason: 'not-sent' });
  });
});

describe('the automatic waiting note (#1544 part 4)', () => {
  function rig(on = true) {
    let enabled = on;
    const waitingStore = new Map<string, SessionNote>();
    const pushes: SessionNoteChange[] = [];
    const waiting = {
      on: () => enabled,
      setOn: (v: boolean) => {
        enabled = v;
      },
      store: {
        cardWaitingNote: (id: string) => waitingStore.get(id),
        setCardWaitingNote: (id: string, n: SessionNote | undefined) => {
          if (n) waitingStore.set(id, n);
          else waitingStore.delete(id);
          return waitingStore.get(id);
        },
      },
      push: (c: SessionNoteChange) => void pushes.push(c),
    };
    const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log };
    const b = busNotes({
      store: { cardNote: () => undefined, setCardNote: () => undefined },
      push: () => {},
      now: () => NOW,
      log,
      cardFor: (id) => (id === 'live-1' ? CARD : null),
      waiting,
    });
    const handlers = new Map<string, Handler>();
    registerNoteIpc({
      broker: { handle: (c: string, fn: Handler) => handlers.set(c, fn) } as unknown as IpcBroker,
      log,
      store: { cardNote: () => undefined, setCardNote: () => undefined },
      knownCard: (id) => id === CARD,
      push: () => {},
      waiting,
    });
    const call = (ch: string, ...args: unknown[]): unknown => handlers.get(ch)!(null, ...args);
    return { b, waitingStore, pushes, waiting, call, isOn: () => enabled };
  }

  it('the AI leaves a waiting note on its own card, separate from the sticky note', () => {
    const r = rig();
    expect(r.b.setWaiting('live-1', 'Need your call: keep v1?')).toEqual({ ok: true, value: { text: 'Need your call: keep v1?' } });
    expect(r.waitingStore.get(CARD)).toEqual({ text: 'Need your call: keep v1?', by: 'ai', at: NOW.toISOString() });
    expect(r.pushes).toEqual([{ cardId: CARD, note: r.waitingStore.get(CARD) }]);
  });

  it('is refused while the switch is off, saying the agent need not try', () => {
    const r = rig(false);
    const out = r.b.setWaiting('live-1', 'x');
    expect(out).toMatchObject({ ok: false });
    expect(JSON.stringify(out)).toMatch(/turned off/);
    expect(r.waitingStore.size).toBe(0);
  });

  it('refuses empty text, a stranger, and a non-string', () => {
    const r = rig();
    expect(r.b.setWaiting('live-1', '  ')).toMatchObject({ ok: false });
    expect(r.b.setWaiting('stranger', 'x')).toMatchObject({ ok: false });
    expect(r.b.setWaiting('live-1', 3)).toMatchObject({ ok: false });
    expect(r.waitingStore.size).toBe(0);
  });

  it('clearWaitingNote removes it and tells the window, and is quiet when there is none', () => {
    const r = rig();
    r.b.setWaiting('live-1', 'x');
    r.pushes.length = 0;
    clearWaitingNote(r.waiting, CARD);
    expect(r.waitingStore.has(CARD)).toBe(false);
    expect(r.pushes).toEqual([{ cardId: CARD }]);
    clearWaitingNote(r.waiting, CARD);
    expect(r.pushes).toHaveLength(1);
  });

  it('the window can read it, dismiss it, and flip the switch (a real boolean only)', () => {
    const r = rig(false);
    expect(r.call('settings:getWaitingNotes')).toBe(false);
    expect(r.call('settings:setWaitingNotes', 'yes')).toBe(false);
    expect(r.call('settings:setWaitingNotes', true)).toBe(true);
    r.b.setWaiting('live-1', 'x');
    expect((r.call('sessions:waitingNote', CARD) as SessionNote).text).toBe('x');
    expect(r.call('sessions:dismissWaitingNote', CARD)).toBe(true);
    expect(r.call('sessions:waitingNote', CARD)).toBeNull();
    expect(r.call('sessions:dismissWaitingNote', 'other')).toBe(false);
  });

  it('the instruction names the tool and asks for nothing when nothing is needed', () => {
    expect(WAITING_NOTE_CONTEXT).toMatch(/set_waiting_note/);
    expect(WAITING_NOTE_CONTEXT).toMatch(/If you need nothing, do not call it/);
  });
});
