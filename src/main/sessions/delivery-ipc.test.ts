// The window's side of `send_to_session` (P2-E11-05).
//
// Same house contract as `sound-ipc.test.ts`: a stand-in store, because the
// claim under test is what each handler DECIDES, and a refusal is a value back
// plus one line in the log — never a throw.
import { describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { pushSiblingMessage, registerDeliveryIpc } from './delivery-ipc';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import type { SiblingMessage } from '../../shared/sibling-message';

type Handler = (e: unknown, ...args: unknown[]) => unknown;

const CARD = 'card-a';

function harness(knownCards: string[] = [CARD]) {
  const handlers = new Map<string, Handler>();
  const logs: { level: string; msg: string; fields?: LogFields }[] = [];
  const on = new Set<string>();
  const writes: [string, boolean][] = [];
  const acks: unknown[][] = [];
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
  registerDeliveryIpc({
    broker,
    log,
    store: {
      cardAcceptsSiblings: (id) => on.has(id),
      setCardAcceptsSiblings: (id, v) => {
        writes.push([id, v]);
        if (v) on.add(id);
        else on.delete(id);
        return on.has(id);
      },
    },
    knownCard: (id) => knownCards.includes(id),
    delivery: {
      ack: (deliveryId, ack) => {
        acks.push([deliveryId, ack]);
        return deliveryId === 'waiting';
      },
    },
  });
  const call = (channel: string, ...args: unknown[]): unknown => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h(null, ...args);
  };
  return { call, logs, writes, acks, handlers, on };
}

describe('the auto-accept flag', () => {
  it('reads OFF for a fresh card', () => {
    expect(harness().call('sessions:acceptFromSiblings', CARD)).toBe(false);
  });

  it('switches, answering what the store now holds', () => {
    const h = harness();
    expect(h.call('sessions:setAcceptFromSiblings', CARD, true)).toBe(true);
    expect(h.call('sessions:acceptFromSiblings', CARD)).toBe(true);
    expect(h.call('sessions:setAcceptFromSiblings', CARD, false)).toBe(false);
    expect(h.writes).toEqual([
      [CARD, true],
      [CARD, false],
    ]);
  });

  it.each([['true'], [1], ['yes'], [{}], [null], [undefined]])(
    'REFUSES %j — only a real boolean moves the flag that removes a human from the loop',
    (v) => {
      const h = harness();
      expect(h.call('sessions:setAcceptFromSiblings', CARD, v)).toBe(false);
      expect(h.writes).toEqual([]);
      expect(h.logs.some((l) => l.level === 'warn')).toBe(true);
    }
  );

  it('refuses an unknown card, and writes nothing', () => {
    const h = harness([]);
    expect(h.call('sessions:setAcceptFromSiblings', CARD, true)).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it('refuses a non-string card id on both channels without throwing', () => {
    const h = harness();
    expect(h.call('sessions:acceptFromSiblings', 42)).toBe(false);
    expect(h.call('sessions:setAcceptFromSiblings', 42, true)).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it('logs every change at INFO — the line that answers "why did it act on that?"', () => {
    const h = harness();
    h.call('sessions:setAcceptFromSiblings', CARD, true);
    const info = h.logs.filter((l) => l.level === 'info');
    expect(info).toHaveLength(1);
    expect(info[0].fields).toMatchObject({ cardId: CARD, on: true });
  });
});

describe('the window’s acknowledgement', () => {
  it('is handed to the delivery policy verbatim, and its answer returned', () => {
    const h = harness();
    expect(h.call('sessions:siblingMessageAck', 'waiting', { placed: true, shown: true })).toBe(true);
    expect(h.call('sessions:siblingMessageAck', 'late', { placed: true, shown: false })).toBe(false);
    expect(h.acks).toEqual([
      ['waiting', { placed: true, shown: true }],
      ['late', { placed: true, shown: false }],
    ]);
  });
});

it('registers exactly the three inbound channels the capability map tags', () => {
  expect([...harness().handlers.keys()].sort()).toEqual([
    'sessions:acceptFromSiblings',
    'sessions:setAcceptFromSiblings',
    'sessions:siblingMessageAck',
  ]);
});

describe('pushSiblingMessage', () => {
  const message: SiblingMessage = {
    deliveryId: 'd1',
    cardId: CARD,
    from: { id: 'live-a', name: 'Alpha' },
    text: 'hi',
    at: '2026-09-10T00:00:00.000Z',
  };
  const win = (over: { destroyed?: boolean; wcDestroyed?: boolean; crashed?: boolean; throws?: boolean } = {}) =>
    ({
      isDestroyed: () => over.destroyed === true,
      webContents: {
        isDestroyed: () => over.wcDestroyed === true,
        isCrashed: () => {
          if (over.throws) throw new Error('gone');
          return over.crashed === true;
        },
      },
    }) as unknown as BrowserWindow;

  it('sends on the declared channel and answers true', () => {
    const send = vi.fn();
    const w = win();
    expect(pushSiblingMessage({ send } as unknown as IpcBroker, w, message)).toBe(true);
    expect(send).toHaveBeenCalledWith(w, 'sessions:siblingMessage', message);
  });

  it.each([
    ['no window', null],
    ['a destroyed window', win({ destroyed: true })],
    ['destroyed web contents', win({ wcDestroyed: true })],
    ['a CRASHED renderer', win({ crashed: true })],
    ['a window that throws when asked', win({ throws: true })],
  ])('answers FALSE for %s, and sends nothing', (_label, w) => {
    // False is what turns into "no switchboard window is open" — an explicit
    // refusal — instead of a push into nothing that waits out its deadline.
    const send = vi.fn();
    expect(pushSiblingMessage({ send } as unknown as IpcBroker, w, message)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
