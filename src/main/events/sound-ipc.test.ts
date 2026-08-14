// The per-session sound IPC (P2-E14-05a).
//
// Same shape and same house contract as `rules-ipc.test.ts`: a stand-in store,
// because the claim under test is what the handler DECIDES to hand it, and a
// refusal is a value back plus one line in the log — never a throw.
import { describe, it, expect } from 'vitest';
import { registerSoundIpc } from './sound-ipc';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import { WorkspaceStore } from '../workspace/store';
import { CardSound } from '../../shared/sounds';

type Handler = (e: unknown, ...args: unknown[]) => unknown;
interface LogLine {
  level: string;
  msg: string;
  fields?: LogFields;
}

const CARD = 'card-a';

function harness(knownCards: string[] = [CARD]) {
  const handlers = new Map<string, Handler>();
  const logs: LogLine[] = [];
  const pinned = new Map<string, string>();
  const writes: Array<[string, string | null]> = [];
  const broker = {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
  } as unknown as IpcBroker;
  const store = {
    cardSound: (cardId: string): CardSound =>
      pinned.has(cardId)
        ? { id: pinned.get(cardId)!, pinned: true }
        : { id: 'chime', pinned: false },
    setCardSound: (cardId: string, sound: string | null) => {
      writes.push([cardId, sound]);
      if (sound === null) pinned.delete(cardId);
      else pinned.set(cardId, sound);
    },
  } as unknown as WorkspaceStore;
  const record =
    (level: string) =>
    (msg: string, fields?: LogFields): void => void logs.push({ level, msg, fields });
  const log: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => log,
  } as unknown as Logger;

  const unplayable: string[] = [];
  registerSoundIpc({
    broker,
    log,
    store,
    knownCard: (id) => knownCards.includes(id),
    onUnplayable: (c) => unplayable.push(c),
  });
  const call = (channel: string, ...args: unknown[]): unknown =>
    handlers.get(channel)!(null, ...args);
  return { call, logs, writes, handlers, pinned, unplayable };
}

describe('reading a card sound', () => {
  it('answers the auto cue and says it is not pinned', () => {
    const h = harness();
    expect(h.call('sounds:get', CARD)).toEqual({ id: 'chime', pinned: false });
  });

  it('answers the pinned cue once one is set', () => {
    const h = harness();
    h.call('sounds:set', CARD, 'bell');
    expect(h.call('sounds:get', CARD)).toEqual({ id: 'bell', pinned: true });
  });

  it('answers NULL for a card main has never heard of', () => {
    // A card mounts before `sessions:create` has persisted it. Answering the
    // store's fallback cue there would tell the menu this card rings "chime"
    // when it will really ring the cue its position hands it — and offer a
    // write `sounds:set` is about to refuse. The renderer draws no entry for
    // `null` and re-reads each time the menu opens.
    const h = harness([]);
    expect(h.call('sounds:get', CARD)).toBeNull();
  });

  it('refuses a non-string card without throwing', () => {
    const h = harness();
    expect(h.call('sounds:get', 42)).toBeNull();
    expect(h.logs.filter((l) => l.level === 'warn')).toHaveLength(1);
  });
});

describe('writing a card sound', () => {
  it('stores it and answers with what the store now holds', () => {
    const h = harness();
    expect(h.call('sounds:set', CARD, 'knock')).toEqual({ id: 'knock', pinned: true });
    expect(h.writes).toEqual([[CARD, 'knock']]);
  });

  it('null is a real value: it hands the card back to auto', () => {
    // the ONLY way out of a pinned cue, so it must not be lumped in with a bad
    // argument
    const h = harness();
    h.call('sounds:set', CARD, 'knock');
    expect(h.call('sounds:set', CARD, null)).toEqual({ id: 'chime', pinned: false });
    expect(h.writes[1]).toEqual([CARD, null]);
  });

  it('refuses a cue this build cannot play, and writes nothing', () => {
    // a hand-edited workspace file or a newer renderer: the store must never
    // end up holding a name that resolves to nothing
    const h = harness();
    expect(h.call('sounds:set', CARD, 'airhorn')).toBeNull();
    expect(h.writes).toEqual([]);
    expect(h.logs.some((l) => l.level === 'warn')).toBe(true);
  });

  it('refuses an unknown card', () => {
    const h = harness([]);
    expect(h.call('sounds:set', CARD, 'bell')).toBeNull();
    expect(h.writes).toEqual([]);
  });

  it('checks the cue BEFORE the card, so a bad cue is named as a bad cue', () => {
    // both are refusals, but the log line is the thing a support question is
    // answered from — "unknown card" for a card that exists would send the
    // reader hunting in the wrong place
    const h = harness([]);
    h.call('sounds:set', CARD, 'airhorn');
    expect(h.logs.at(-1)!.msg).toContain('not a sound this build can play');
  });

  it('refuses a non-string card id', () => {
    const h = harness();
    expect(h.call('sounds:set', null, 'bell')).toBeNull();
    expect(h.writes).toEqual([]);
  });

  it('logs the change once it takes', () => {
    const h = harness();
    h.call('sounds:set', CARD, 'bell');
    const info = h.logs.filter((l) => l.level === 'info');
    expect(info).toHaveLength(1);
    expect(info[0].fields).toMatchObject({ cardId: CARD, sound: 'bell', pinned: true });
  });

  it('registers exactly the channels the capability map tags', () => {
    const h = harness();
    expect([...h.handlers.keys()].sort()).toEqual(['audio:failed', 'sounds:get', 'sounds:set']);
  });
});

describe('the window could not play what it was sent', () => {
  it('passes the channel through, so main can beep instead', () => {
    const h = harness();
    expect(h.call('audio:failed', 'sound')).toBe(true);
    expect(h.call('audio:failed', 'speak')).toBe(true);
    expect(h.unplayable).toEqual(['sound', 'speak']);
  });

  it('refuses anything that is not one of the two channels', () => {
    const h = harness();
    expect(h.call('audio:failed', 'trumpet')).toBe(false);
    expect(h.call('audio:failed', null)).toBe(false);
    expect(h.unplayable).toEqual([]);
    expect(h.logs.filter((l) => l.level === 'warn')).toHaveLength(2);
  });
});
