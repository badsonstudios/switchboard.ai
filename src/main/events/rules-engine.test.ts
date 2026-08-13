// The runner half of the rules engine (P2-E14-03): the action registry's two
// fail-open promises, and the engine's job of turning a LIVE session event
// into a CARD-scoped decision.
import { describe, it, expect, vi } from 'vitest';
import { RuleActionRegistry, RulesEngine, RuleActionContext } from './rules-engine';
import { ACTION_OS_TOAST, Rule, defaultRules, notifyWhenDoneRule } from './rules';
import type { FeedEvent } from './feed';
import type { Logger } from '../log/logger';

const LIVE = 'live-1';
const CARD = 'card-a';
const event = (kind: FeedEvent['kind'] = 'done', sessionId = LIVE): FeedEvent => ({
  id: 1,
  sessionId,
  kind,
  at: '2026-08-11T00:00:00.000Z',
});

function fakeLog(): Logger & { lines: Array<[string, string]> } {
  const lines: Array<[string, string]> = [];
  const push = (level: string) => (msg: string) => void lines.push([level, msg]);
  return {
    lines,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
  } as unknown as Logger & { lines: Array<[string, string]> };
}

const ctx = (rule: Rule): RuleActionContext => ({
  event: event(),
  cardId: CARD,
  visibility: 'hidden',
  rule,
  title: 'TradingApp',
  body: 'done',
});

describe('RuleActionRegistry', () => {
  it('runs the handler registered for the action type', () => {
    const reg = new RuleActionRegistry();
    const seen: string[] = [];
    reg.register('sound', (a) => void seen.push(String(a.file)));
    const rule: Rule = { id: 'r', event: 'done', actions: [{ type: 'sound', file: 'bell.wav' }] };
    expect(reg.run({ type: 'sound', file: 'bell.wav' }, ctx(rule))).toBe(true);
    expect(seen).toEqual(['bell.wav']);
  });

  it('logs and skips an action type nothing registered (a rule from a newer build)', () => {
    const log = fakeLog();
    const reg = new RuleActionRegistry(log);
    const rule: Rule = { id: 'r', event: 'done', actions: [{ type: 'hologram' }] };
    expect(reg.run({ type: 'hologram' }, ctx(rule))).toBe(false);
    expect(log.lines[0][0]).toBe('warn');
    expect(log.lines[0][1]).toContain('no handler');
  });

  // The seam #424 (push / webhook) lands on: those handlers are HTTP round
  // trips, so the registry has to take an async one without the main process
  // collecting an unhandled rejection the first time a phone is unreachable.
  it('an async handler that REJECTS is logged, not left unhandled (P6)', async () => {
    const log = fakeLog();
    const reg = new RuleActionRegistry(log);
    let reject: (e: Error) => void = () => {};
    reg.register('push', () => new Promise<void>((_res, rej) => (reject = rej)));
    const rule: Rule = { id: 'r', event: 'done', actions: [{ type: 'push' }] };
    // dispatched, and NOT awaited — the engine sits on the event path
    expect(reg.run({ type: 'push' }, ctx(rule))).toBe(true);
    expect(log.lines).toHaveLength(0);
    reject(new Error('the phone is off'));
    await new Promise((r) => setTimeout(r, 0));
    expect(log.lines[0][0]).toBe('warn');
    expect(log.lines[0][1]).toContain('failed');
  });

  it('an async handler that resolves logs nothing', async () => {
    const log = fakeLog();
    const reg = new RuleActionRegistry(log);
    reg.register('push', () => Promise.resolve());
    const rule: Rule = { id: 'r', event: 'done', actions: [{ type: 'push' }] };
    expect(reg.run({ type: 'push' }, ctx(rule))).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(log.lines).toHaveLength(0);
  });

  it('a handler that THROWS costs its own action and nothing else (P6)', () => {
    const log = fakeLog();
    const reg = new RuleActionRegistry(log);
    reg.register('sound', () => {
      throw new Error('no audio device');
    });
    const toasted: string[] = [];
    reg.register(ACTION_OS_TOAST, (_a, c) => void toasted.push(c.title));
    const rule: Rule = {
      id: 'r',
      event: 'done',
      actions: [{ type: 'sound' }, { type: ACTION_OS_TOAST }],
    };
    expect(reg.run({ type: 'sound' }, ctx(rule))).toBe(false);
    expect(reg.run({ type: ACTION_OS_TOAST }, ctx(rule))).toBe(true);
    expect(toasted).toEqual(['TradingApp']);
    expect(log.lines.some(([lvl, msg]) => lvl === 'warn' && msg.includes('failed'))).toBe(true);
  });
});

interface Harness {
  engine: RulesEngine;
  toasts: RuleActionContext[];
  rules: Rule[];
  visibility: { current: 'focused' | 'visible' | 'hidden' };
  cards: Map<string, string>;
  log: ReturnType<typeof fakeLog>;
}

function harness(opts: { osToasts?: boolean } = {}): Harness {
  const toasts: RuleActionContext[] = [];
  const rules: Rule[] = [];
  const visibility = { current: 'hidden' as 'focused' | 'visible' | 'hidden' };
  const cards = new Map<string, string>([[LIVE, CARD]]);
  const log = fakeLog();
  const registry = new RuleActionRegistry(log);
  registry.register(ACTION_OS_TOAST, (_a, c) => void toasts.push(c));
  const engine = new RulesEngine({
    getRules: () => rules,
    getDefaultRules: () => defaultRules({ osToasts: opts.osToasts === true }),
    cardIdFor: (id) => cards.get(id) ?? null,
    getVisibility: () => visibility.current,
    titleFor: () => 'TradingApp',
    bodyFor: (e) => e.kind,
    registry,
    log,
  });
  return { engine, toasts, rules, visibility, cards, log };
}

describe('RulesEngine', () => {
  it('resolves the LIVE session id to the CARD a rule is scoped to', () => {
    const h = harness();
    h.rules.push(notifyWhenDoneRule(CARD));
    expect(h.engine.handle(event('done', LIVE))).toBe(1);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].cardId).toBe(CARD);
  });

  it('a live session with no card binding fires no session-scoped rule', () => {
    const h = harness();
    h.rules.push(notifyWhenDoneRule(CARD));
    expect(h.engine.handle(event('done', 'a-session-nobody-bound'))).toBe(0);
    expect(h.toasts).toEqual([]);
  });

  it('the checkbox is per SESSION: the other card stays quiet on done', () => {
    const h = harness();
    h.cards.set('live-2', 'card-b');
    h.rules.push(notifyWhenDoneRule(CARD));
    h.engine.handle(event('done', 'live-2'));
    expect(h.toasts).toEqual([]);
  });

  it('no toast while the window is focused, even with the box ticked', () => {
    const h = harness();
    h.rules.push(notifyWhenDoneRule(CARD));
    h.visibility.current = 'focused';
    expect(h.engine.handle(event('done'))).toBe(0);
    h.visibility.current = 'visible';
    expect(h.engine.handle(event('done'))).toBe(1);
  });

  it('done stays quiet with no rule, while the built-ins still cover permission asks', () => {
    const h = harness({ osToasts: true });
    expect(h.engine.handle(event('done'))).toBe(0);
    expect(h.engine.handle(event('needs-permission'))).toBe(1);
  });

  it('the per-session rule is its own opt-in: it fires with the global toast pref OFF', () => {
    // The checkbox IS the consent for that session — a control that silently
    // did nothing because of a global switch elsewhere would be a lie.
    const h = harness({ osToasts: false });
    h.rules.push(notifyWhenDoneRule(CARD));
    expect(h.engine.handle(event('done'))).toBe(1);
  });

  it('`plan` says what WOULD run without running it', () => {
    const h = harness();
    h.rules.push(notifyWhenDoneRule(CARD));
    const { trigger, actions } = h.engine.plan(event('done'));
    expect(trigger).toEqual({ kind: 'done', cardId: CARD, visibility: 'hidden' });
    expect(actions.map((a) => a.action.type)).toEqual([ACTION_OS_TOAST]);
    expect(h.toasts).toEqual([]);
  });

  it('a rules source that throws never reaches the caller (P6)', () => {
    const h = harness();
    const engine = new RulesEngine({
      getRules: () => {
        throw new Error('the store fell over');
      },
      getDefaultRules: () => [],
      cardIdFor: () => CARD,
      getVisibility: () => 'hidden',
      titleFor: () => '',
      bodyFor: () => '',
      registry: new RuleActionRegistry(h.log),
      log: h.log,
    });
    expect(() => engine.handle(event('done'))).not.toThrow();
    expect(engine.handle(event('done'))).toBe(0);
    expect(h.log.lines.some(([lvl]) => lvl === 'warn')).toBe(true);
  });

  it('logs one line naming the rules that fired', () => {
    const h = harness();
    h.rules.push(notifyWhenDoneRule(CARD));
    h.engine.handle(event('done'));
    expect(h.log.lines.some(([lvl, msg]) => lvl === 'info' && msg.includes('rules fired'))).toBe(
      true
    );
  });

  it('says nothing at all when nothing matched — silence is not an event', () => {
    const h = harness();
    h.engine.handle(event('done'));
    expect(h.log.lines).toEqual([]);
  });

  it('resolves the title and body ONCE per event, not once per action', () => {
    const h = harness();
    const titleFor = vi.fn(() => 'TradingApp');
    const registry = new RuleActionRegistry(h.log);
    registry.register(ACTION_OS_TOAST, () => {});
    registry.register('sound', () => {});
    const engine = new RulesEngine({
      getRules: () => [
        { id: 'r', event: 'any', actions: [{ type: ACTION_OS_TOAST }, { type: 'sound' }] },
      ],
      getDefaultRules: () => [],
      cardIdFor: () => CARD,
      getVisibility: () => 'hidden',
      titleFor,
      bodyFor: () => 'done',
      registry,
      log: h.log,
    });
    expect(engine.handle(event('done'))).toBe(2);
    expect(titleFor).toHaveBeenCalledTimes(1);
  });
});
