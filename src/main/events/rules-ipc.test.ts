// The rule IPC seam (P2-E14-03): the only write surface v1 gives the renderer.
//
// The store is a stand-in rather than a real `WorkspaceStore` — the claim under
// test is what the handler decides to hand it, so what it is handed is what
// gets asserted (the shape `group-ipc.test.ts` and `sessions/ipc.test.ts`
// settled on). Refusals follow the house contract: a VALUE back, a warning in
// the log, and nothing written.
import { describe, it, expect, beforeEach } from 'vitest';
import { registerRulesIpc } from './rules-ipc';
import { NOTIFY_WHEN_DONE, Rule, notifyWhenDoneRule } from './rules';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import { WorkspaceStore } from '../workspace/store';

type Handler = (e: unknown, ...args: unknown[]) => unknown;
interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  fields?: LogFields;
}

const CARD = 'card-a';

function harness(prior: Rule[] = [], knownCards: string[] = [CARD]) {
  const handlers = new Map<string, Handler>();
  const rules = [...prior];
  const logs: LogLine[] = [];
  const broker = {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
  } as unknown as IpcBroker;
  const store = {
    listRules: () => rules.map((r) => ({ ...r })),
    upsertRule: (r: Rule) => {
      const i = rules.findIndex((x) => x.id === r.id);
      if (i >= 0) rules[i] = { ...r };
      else rules.push({ ...r });
      return true;
    },
    removeRule: (id: string) => {
      const before = rules.length;
      const kept = rules.filter((r) => r.id !== id);
      rules.length = 0;
      rules.push(...kept);
      return kept.length !== before;
    },
  } as unknown as WorkspaceStore;
  const record =
    (level: LogLine['level']) =>
    (msg: string, fields?: LogFields): void => void logs.push({ level, msg, fields });
  const log: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => log,
  } as unknown as Logger;

  registerRulesIpc({
    broker,
    log,
    store,
    knownCard: (id) => knownCards.includes(id),
  });
  return {
    rules,
    logs,
    get warnings() {
      return logs.filter((l) => l.level === 'warn').map((l) => l.msg);
    },
    call: (channel: string, ...args: unknown[]) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`nothing registered on ${channel}`);
      return fn({}, ...args);
    },
  };
}

describe('rules:setNotifyWhenDone', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('ticking writes one rule scoped to that card', () => {
    expect(h.call('rules:setNotifyWhenDone', CARD, true)).toBe(true);
    expect(h.rules).toHaveLength(1);
    expect(h.rules[0]).toMatchObject({
      event: 'done',
      session: CARD,
      source: NOTIFY_WHEN_DONE,
      visibility: ['visible', 'hidden'],
    });
  });

  it('ticking twice leaves ONE rule, not two', () => {
    h.call('rules:setNotifyWhenDone', CARD, true);
    h.call('rules:setNotifyWhenDone', CARD, true);
    expect(h.rules).toHaveLength(1);
  });

  it('unticking removes it and leaves other cards alone', () => {
    h.call('rules:setNotifyWhenDone', CARD, true);
    h.rules.push(notifyWhenDoneRule('card-b'));
    expect(h.call('rules:setNotifyWhenDone', CARD, false)).toBe(false);
    expect(h.rules.map((r) => r.session)).toEqual(['card-b']);
  });

  it('answers the state the STORE holds, so a refusal reverts the tick', () => {
    const unknown = harness([], []); // no cards at all
    expect(unknown.call('rules:setNotifyWhenDone', 'ghost', true)).toBe(false);
    expect(unknown.rules).toEqual([]);
    expect(unknown.warnings.join(' ')).toContain('unknown card');
  });

  it.each([
    ['a non-string cardId', [7, true], 'cardId must be a string'],
    ['a non-boolean value', [CARD, 'yes'], 'must be true or false'],
    ['no value at all', [CARD, undefined], 'must be true or false'],
  ])('refuses %s with a value and a warning, writing nothing', (_name, args, reason) => {
    expect(h.call('rules:setNotifyWhenDone', ...(args as unknown[]))).toBe(false);
    expect(h.rules).toEqual([]);
    expect(h.warnings.join(' ')).toContain(reason);
  });
});

describe('rules:notifyWhenDone / rules:list', () => {
  it('reads the checkbox back for the right card only', () => {
    const h = harness([notifyWhenDoneRule(CARD)]);
    expect(h.call('rules:notifyWhenDone', CARD)).toBe(true);
    expect(h.call('rules:notifyWhenDone', 'card-b')).toBe(false);
  });

  it('refuses a non-string cardId rather than answering about nothing', () => {
    const h = harness([notifyWhenDoneRule(CARD)]);
    expect(h.call('rules:notifyWhenDone', 42)).toBe(false);
    expect(h.warnings.join(' ')).toContain('cardId must be a string');
  });

  it('lists what is stored — the read half a rules editor will grow into', () => {
    const h = harness([notifyWhenDoneRule(CARD)]);
    expect(h.call('rules:list')).toEqual([notifyWhenDoneRule(CARD)]);
  });
});
