// The runner half of the rules engine (P2-E14-03): the action registry's two
// fail-open promises, and the engine's job of turning a LIVE session event
// into a CARD-scoped decision.
import { describe, it, expect, vi } from 'vitest';
import { RuleActionRegistry, RulesEngine, RuleActionContext } from './rules-engine';
import {
  ACTION_OS_TOAST,
  ACTION_PUSH,
  ACTION_SOUND,
  ACTION_SPEAK,
  ACTION_WEBHOOK,
  Rule,
  defaultRules,
  notifyWhenDoneRule,
} from './rules';
import type { SuppressedEvent } from '../../shared/suppressed';
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
    expect(trigger).toMatchObject({ kind: 'done', cardId: CARD, visibility: 'hidden' });
    // The clock is on the trigger since P2-E14-05b, and it is the ENGINE that
    // put it there — a trigger without one would mean quiet hours could never
    // be evaluated, so it is asserted rather than ignored.
    expect(trigger.now).toBeInstanceOf(Date);
    expect(trigger.quiet).toBeNull(); // no window configured in this harness
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

// ── quiet hours, at the ENGINE level (P2-E14-05b) ──────────────────────────
//
// The matrix lives in `rules.quiet.test.ts`; what only the engine can show is
// the two things it owns: that the clock reaches the pure evaluator from ONE
// injected place, and that a held event becomes a RECORD for #483's digest
// rather than vanishing.
describe('RulesEngine and quiet hours', () => {
  const NIGHT = { start: '22:00', end: '07:00' };
  const at = (h: number): Date => new Date(2026, 7, 14, h, 0, 0);

  function quietHarness(now: Date, quiet: { start: string; end: string } | null = NIGHT) {
    const ran: string[] = [];
    const held: SuppressedEvent[] = [];
    const log = fakeLog();
    const registry = new RuleActionRegistry(log);
    for (const type of [ACTION_OS_TOAST, ACTION_SOUND, ACTION_SPEAK, ACTION_PUSH, ACTION_WEBHOOK])
      registry.register(type, (a) => void ran.push(a.type));
    const rules: Rule[] = [];
    const engine = new RulesEngine({
      getRules: () => rules,
      getDefaultRules: () => [],
      cardIdFor: () => CARD,
      getVisibility: () => 'hidden',
      titleFor: () => 'TradingApp',
      bodyFor: (e) => e.kind,
      getQuietWindow: () => quiet,
      now: () => now,
      onSuppressed: (r) => void held.push(r),
      registry,
      log,
    });
    return { engine, ran, held, rules, log };
  }

  const everything: Rule = {
    id: 'r',
    event: 'any',
    actions: [
      { type: ACTION_OS_TOAST },
      { type: ACTION_SOUND },
      { type: ACTION_SPEAK },
      { type: ACTION_PUSH },
      { type: ACTION_WEBHOOK },
    ],
  };

  it('at 3am runs only the webhook, and no handler is even called for the rest', () => {
    // Not merely "the toast did nothing": the HANDLER must not run at all, or a
    // future handler with a side effect before its own guard would still fire.
    const h = quietHarness(at(3));
    h.rules.push(everything);
    expect(h.engine.handle(event('done'))).toBe(1);
    expect(h.ran).toEqual([ACTION_WEBHOOK]);
  });

  it('at noon runs all five', () => {
    const h = quietHarness(at(12));
    h.rules.push(everything);
    expect(h.engine.handle(event('done'))).toBe(5);
    expect(h.ran).toHaveLength(5);
  });

  it('with no window configured, 3am is an ordinary hour', () => {
    const h = quietHarness(at(3), null);
    h.rules.push(everything);
    expect(h.engine.handle(event('done'))).toBe(5);
  });

  it('writes ONE record per event, listing the channels it held', () => {
    const h = quietHarness(at(3));
    h.rules.push(everything);
    h.engine.handle(event('needs-input'));
    expect(h.held).toHaveLength(1);
    expect(h.held[0]).toMatchObject({
      kind: 'needs-input',
      cardId: CARD,
      title: 'TradingApp',
      body: 'needs-input',
      reason: 'quiet-hours',
      ruleIds: ['r'],
    });
    // the webhook is NOT in the held list — it went out
    expect(h.held[0].actions).toEqual([ACTION_OS_TOAST, ACTION_SOUND, ACTION_SPEAK, ACTION_PUSH]);
    // the record's timestamp is the injected clock's, not the wall clock's
    expect(h.held[0].at).toBe(at(3).getTime());
  });

  it('gives two events in the same millisecond different ids', () => {
    // The digest clears BY ID; two rows sharing one would clear each other.
    const h = quietHarness(at(3));
    h.rules.push(everything);
    h.engine.handle(event('done'));
    h.engine.handle(event('crashed'));
    expect(h.held).toHaveLength(2);
    expect(h.held[0].id).not.toBe(h.held[1].id);
  });

  it('records nothing when nothing was held', () => {
    const h = quietHarness(at(12));
    h.rules.push(everything);
    h.engine.handle(event('done'));
    expect(h.held).toEqual([]);
  });

  it('a rule that never MATCHED is not recorded as held', () => {
    // Suppression is not matching: a digest that listed rules the visibility
    // condition rejected would be reporting events that were never going to
    // fire in the first place.
    const h = quietHarness(at(3));
    h.rules.push({ ...everything, visibility: ['focused'] }); // we are 'hidden'
    expect(h.engine.handle(event('done'))).toBe(0);
    expect(h.held).toEqual([]);
  });

  it('a store that throws while recording costs the digest and nothing else', () => {
    const h = quietHarness(at(3));
    h.rules.push(everything);
    const engine = new RulesEngine({
      getRules: () => h.rules,
      getDefaultRules: () => [],
      cardIdFor: () => CARD,
      getVisibility: () => 'hidden',
      titleFor: () => 'TradingApp',
      bodyFor: (e) => e.kind,
      getQuietWindow: () => NIGHT,
      now: () => at(3),
      onSuppressed: () => {
        throw new Error('the workspace file is read-only');
      },
      registry: (() => {
        const reg = new RuleActionRegistry(h.log);
        reg.register(ACTION_WEBHOOK, () => void h.ran.push(ACTION_WEBHOOK));
        return reg;
      })(),
      log: h.log,
    });
    // the webhook still went out (P6) …
    expect(engine.handle(event('done'))).toBe(1);
    // … and the failure is written down rather than swallowed
    expect(h.log.lines.some(([lvl, m]) => lvl === 'warn' && m.includes('could not be recorded'))).toBe(
      true
    );
  });

  it('logs the quiet flag and the held channels — the line the e2e reads', () => {
    // The e2e asserts on `quiet` and `held` by name. Asserting only that SOME
    // info line exists would pass with both fields deleted — which is a test
    // whose failure mode is a red e2e ten minutes later.
    const fields: Array<Record<string, unknown>> = [];
    const log = {
      info: (_m: string, f?: Record<string, unknown>) => void fields.push(f ?? {}),
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as Logger;
    const registry = new RuleActionRegistry();
    registry.register(ACTION_WEBHOOK, () => {});
    registry.register(ACTION_OS_TOAST, () => {});
    new RulesEngine({
      getRules: () => [everything],
      getDefaultRules: () => [],
      cardIdFor: () => CARD,
      getVisibility: () => 'hidden',
      titleFor: () => 'TradingApp',
      bodyFor: (e) => e.kind,
      getQuietWindow: () => NIGHT,
      now: () => at(3),
      registry,
      log,
    }).handle(event('done'));
    expect(fields).toHaveLength(1);
    expect(fields[0].quiet).toBe(true);
    expect(String(fields[0].held).split(',')).toContain(ACTION_OS_TOAST);
    expect(String(fields[0].held).split(',')).not.toContain(ACTION_WEBHOOK);
    expect(fields[0].ran).toBe(1); // the webhook did go
  });

  it('an event whose every action is held still gets a record and a log line', () => {
    // The `actions.length === 0` early return used to mean "nothing matched".
    // With quiet hours it can also mean "everything was held", and returning
    // early there would lose the whole digest entry.
    const h = quietHarness(at(3));
    h.rules.push({ id: 'r', event: 'any', actions: [{ type: ACTION_OS_TOAST }] });
    expect(h.engine.handle(event('done'))).toBe(0);
    expect(h.held).toHaveLength(1);
    expect(h.log.lines).not.toEqual([]);
  });
});
