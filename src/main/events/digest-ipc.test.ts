// The missed-events digest's IPC seam (P2-E14-05c): the read half of #482's record.
//
// Same harness shape as `rules-ipc.test.ts` — a stand-in store, because the
// claim under test is what the HANDLER decides to hand it, and the real
// `WorkspaceStore`'s own suppression behaviour (FIFO, cap, clear-by-id,
// persistence) is already pinned in `workspace/store.test.ts`.
import { describe, it, expect } from 'vitest';
import { registerDigestIpc } from './digest-ipc';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import { WorkspaceStore } from '../workspace/store';
import { SuppressedEvent } from '../../shared/suppressed';

type Handler = (e: unknown, ...args: unknown[]) => unknown;
interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  fields?: LogFields;
}

const rec = (id: string, over: Partial<SuppressedEvent> = {}): SuppressedEvent => ({
  id,
  at: 1_700_000_000_000,
  kind: 'needs-permission',
  cardId: 'card-a',
  title: 'TradingApp',
  body: 'needs permission',
  actions: ['os-toast', 'sound'],
  ruleIds: ['built-in:toast'],
  reason: 'quiet-hours',
  ...over,
});

function harness(prior: SuppressedEvent[] = []) {
  const handlers = new Map<string, Handler>();
  let held = [...prior];
  const logs: LogLine[] = [];
  const broker = {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
  } as unknown as IpcBroker;
  const store = {
    listSuppressed: () => held.map((e) => ({ ...e })),
    clearSuppressed: (ids?: readonly string[]) => {
      const before = held.length;
      if (ids === undefined) held = [];
      else {
        const drop = new Set(ids);
        held = held.filter((e) => !drop.has(e.id));
      }
      return before - held.length;
    },
  } as unknown as WorkspaceStore;
  const log = {
    debug: (msg: string, fields?: LogFields) => logs.push({ level: 'debug', msg, fields }),
    info: (msg: string, fields?: LogFields) => logs.push({ level: 'info', msg, fields }),
    warn: (msg: string, fields?: LogFields) => logs.push({ level: 'warn', msg, fields }),
    error: (msg: string, fields?: LogFields) => logs.push({ level: 'error', msg, fields }),
  } as unknown as Logger;
  registerDigestIpc({ broker, log, store });
  const call = (channel: string, ...args: unknown[]): unknown =>
    handlers.get(channel)?.(null, ...args);
  return { call, logs, remaining: () => held, handlers };
}

describe('notifications:listSuppressed', () => {
  it('answers the held list in the store’s order', () => {
    const h = harness([rec('a'), rec('b')]);
    expect((h.call('notifications:listSuppressed') as SuppressedEvent[]).map((e) => e.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('answers an EMPTY list rather than nothing when nothing was held', () => {
    // the ordinary case, and the one the digest renders as absent — it must be
    // a list the renderer can map over, not a null it has to guard
    expect(harness().call('notifications:listSuppressed')).toEqual([]);
  });
});

describe('notifications:clearSuppressed', () => {
  it('clears exactly the named ids and answers what survived', () => {
    const h = harness([rec('a'), rec('b'), rec('c')]);
    const res = h.call('notifications:clearSuppressed', ['a', 'c']) as {
      cleared: number;
      remaining: SuppressedEvent[];
    };
    expect(res.cleared).toBe(2);
    expect(res.remaining.map((e) => e.id)).toEqual(['b']);
    expect(h.remaining().map((e) => e.id)).toEqual(['b']);
  });

  it('leaves an event held AFTER the digest was drawn', () => {
    // the reason the channel takes ids at all: clearing is pressed against a
    // list the user has read, and one held behind it is not part of that review
    const h = harness([rec('a')]);
    h.remaining().push(rec('late'));
    h.call('notifications:clearSuppressed', ['a']);
    expect(h.remaining().map((e) => e.id)).toEqual(['late']);
  });

  it('REFUSES a missing argument rather than reading it as "clear everything"', () => {
    // The store's own signature treats `undefined` as all, which is right for
    // the store. Across IPC it would mean one dropped parameter erases a digest
    // nobody read, so the channel demands the list.
    const h = harness([rec('a'), rec('b')]);
    const res = h.call('notifications:clearSuppressed') as { cleared: number };
    expect(res.cleared).toBe(0);
    expect(h.remaining()).toHaveLength(2);
    expect(h.logs.some((l) => l.level === 'warn' && /must be an array/.test(l.msg))).toBe(true);
  });

  it('refuses a non-array and a list holding a non-string, as a VALUE plus a log line', () => {
    for (const bad of ['a', 42, null, {}] as unknown[]) {
      const h = harness([rec('a')]);
      expect((h.call('notifications:clearSuppressed', bad) as { cleared: number }).cleared).toBe(0);
      expect(h.remaining()).toHaveLength(1);
      expect(h.logs.some((l) => l.level === 'warn')).toBe(true);
    }
    const h = harness([rec('a')]);
    expect((h.call('notifications:clearSuppressed', ['a', 7]) as { cleared: number }).cleared).toBe(0);
    expect(h.remaining()).toHaveLength(1);
  });

  it('refuses an EMPTY-STRING id — it can never match, and hides a caller bug', () => {
    const h = harness([rec('a')]);
    expect((h.call('notifications:clearSuppressed', ['']) as { cleared: number }).cleared).toBe(0);
    expect(h.logs.some((l) => l.level === 'warn')).toBe(true);
  });

  it('still answers the LIST on a refusal, so the digest can put itself back', () => {
    // `cleared: 0` alone is indistinguishable from "there was nothing", and the
    // renderer reconciles against `remaining` — an empty one would blank a
    // digest the store never agreed to drop
    const h = harness([rec('a'), rec('b')]);
    const res = h.call('notifications:clearSuppressed', 'nope') as {
      cleared: number;
      remaining: SuppressedEvent[];
    };
    expect(res.remaining.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('an id that is not held is 0 cleared, not an error', () => {
    const h = harness([rec('a')]);
    const res = h.call('notifications:clearSuppressed', ['gone']) as { cleared: number };
    expect(res.cleared).toBe(0);
    expect(h.remaining()).toHaveLength(1);
    // and it is not a refusal either — the ask was well-formed
    expect(h.logs.some((l) => l.level === 'warn')).toBe(false);
  });

  it('logs the clear at info — the count is the only trace a digest leaves', () => {
    const h = harness([rec('a')]);
    h.call('notifications:clearSuppressed', ['a']);
    const line = h.logs.find((l) => l.level === 'info');
    expect(line?.fields).toMatchObject({ asked: 1, cleared: 1 });
  });

  it('registers both channels and nothing else', () => {
    expect([...harness().handlers.keys()].sort()).toEqual([
      'notifications:clearSuppressed',
      'notifications:listSuppressed',
    ]);
  });
});
