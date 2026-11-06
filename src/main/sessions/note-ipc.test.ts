// The window's side of a card's sticky note (#1544).
//
// A stand-in store, like `delivery-ipc.test.ts`: the claim under test is what
// each handler DECIDES. A refusal is `null` plus one log line, never a throw,
// and the note's words never reach the log.
import { describe, it, expect } from 'vitest';
import { registerNoteIpc } from './note-ipc';
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
