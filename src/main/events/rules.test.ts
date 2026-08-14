// The rules core, table-driven (P2-E14-03 done-when: event × scope × visibility).
//
// The matrix IS the specification: three questions, and a rule fires only when
// all three answer yes. Written as a cross-product rather than as prose cases
// so that adding a fourth condition later means adding a column, not hunting
// for the `it()` that happened to cover the combination it breaks.
import { describe, it, expect } from 'vitest';
import {
  ACTION_OS_TOAST,
  ACTION_PUSH,
  ACTION_WEBHOOK,
  ALL_VISIBILITIES,
  NOTIFY_WHEN_DONE,
  Rule,
  RuleTrigger,
  WHEN_AWAY,
  WindowVisibility,
  defaultRules,
  isSaneRule,
  notifyWhenDoneFor,
  notifyWhenDoneRule,
  plannedActions,
  ruleMatches,
  visibilityAcross,
  visibilityOf,
} from './rules';
import type { FeedKind } from './feed';

const KINDS: FeedKind[] = ['done', 'ready', 'needs-input', 'needs-permission', 'crashed'];
const CARD = 'card-a';
const OTHER = 'card-b';

const trigger = (
  kind: FeedKind,
  cardId: string | null,
  visibility: WindowVisibility
): RuleTrigger => ({ kind, cardId, visibility });

describe('ruleMatches — the three questions', () => {
  // ── event ────────────────────────────────────────────────────────────────
  it.each(KINDS)('a rule for `done` fires for %s only when it IS done', (kind) => {
    const rule: Rule = { id: 'r', event: 'done', actions: [{ type: ACTION_OS_TOAST }] };
    expect(ruleMatches(rule, trigger(kind, CARD, 'hidden'))).toBe(kind === 'done');
  });

  it.each(KINDS)('a rule for `any` fires for %s', (kind) => {
    const rule: Rule = { id: 'r', event: 'any', actions: [{ type: ACTION_OS_TOAST }] };
    expect(ruleMatches(rule, trigger(kind, CARD, 'hidden'))).toBe(true);
  });

  // ── scope ────────────────────────────────────────────────────────────────
  const scopeCases: Array<[string, string | undefined, string | null, boolean]> = [
    ['unscoped rule, any card', undefined, CARD, true],
    ['unscoped rule, unresolved card', undefined, null, true],
    ['scoped rule, its own card', CARD, CARD, true],
    ['scoped rule, another card', CARD, OTHER, false],
    // The one that matters most: an event whose card could not be resolved is
    // NOT a wildcard. Treating it as one turns one session's checkbox into
    // everyone's at exactly the moment we know least about what happened.
    ['scoped rule, unresolved card', CARD, null, false],
  ];
  it.each(scopeCases)('%s', (_name, session, cardId, expected) => {
    const rule: Rule = { id: 'r', event: 'done', session, actions: [{ type: ACTION_OS_TOAST }] };
    expect(ruleMatches(rule, trigger('done', cardId, 'hidden'))).toBe(expected);
  });

  // ── visibility ───────────────────────────────────────────────────────────
  const visCases: Array<[WindowVisibility[] | undefined, WindowVisibility, boolean]> = [
    [undefined, 'focused', true], // absent = any
    [undefined, 'hidden', true],
    [[], 'focused', true], // empty = any
    [[...WHEN_AWAY], 'focused', false], // the calm default
    [[...WHEN_AWAY], 'visible', true],
    [[...WHEN_AWAY], 'hidden', true],
    [['hidden'], 'visible', false],
    [['hidden'], 'hidden', true],
    [[...ALL_VISIBILITIES], 'focused', true], // crashes are excepted this way
  ];
  it.each(visCases)('visibility %s vs %s -> %s', (visibility, seen, expected) => {
    const rule: Rule = {
      id: 'r',
      event: 'done',
      visibility,
      actions: [{ type: ACTION_OS_TOAST }],
    };
    expect(ruleMatches(rule, trigger('done', CARD, seen))).toBe(expected);
  });

  // ── the full cross-product for the checkbox's own rule ────────────────────
  it('the notify-when-done rule fires for exactly one cell of the matrix', () => {
    const rule = notifyWhenDoneRule(CARD);
    const fired: string[] = [];
    for (const kind of KINDS) {
      for (const cardId of [CARD, OTHER, null]) {
        for (const visibility of ALL_VISIBILITIES) {
          if (ruleMatches(rule, trigger(kind, cardId, visibility)))
            fired.push(`${kind}/${cardId ?? 'unbound'}/${visibility}`);
        }
      }
    }
    expect(fired.sort()).toEqual([`done/${CARD}/hidden`, `done/${CARD}/visible`]);
  });

  it('an explicitly disabled rule never fires, whatever else holds', () => {
    const rule: Rule = {
      id: 'r',
      event: 'any',
      enabled: false,
      actions: [{ type: ACTION_OS_TOAST }],
    };
    for (const v of ALL_VISIBILITIES) expect(ruleMatches(rule, trigger('done', CARD, v))).toBe(false);
  });

  it('a rule with no actions is not a match — there is nothing to do', () => {
    expect(ruleMatches({ id: 'r', event: 'any', actions: [] }, trigger('done', CARD, 'hidden'))).toBe(
      false
    );
  });
});

describe('plannedActions', () => {
  const t = trigger('done', CARD, 'hidden');

  it('collects the actions of every matching rule, in rule order', () => {
    const rules: Rule[] = [
      { id: 'a', event: 'done', actions: [{ type: 'sound', file: 'x' }] },
      { id: 'b', event: 'needs-input', actions: [{ type: 'push' }] },
      { id: 'c', event: 'any', actions: [{ type: ACTION_OS_TOAST }] },
    ];
    expect(plannedActions(rules, t).map((m) => `${m.rule.id}:${m.action.type}`)).toEqual([
      'a:sound',
      'c:os-toast',
    ]);
  });

  it('deduplicates identical actions — two rules, one toast', () => {
    const rules: Rule[] = [
      { id: 'a', event: 'done', actions: [{ type: ACTION_OS_TOAST }] },
      { id: 'b', event: 'any', actions: [{ type: ACTION_OS_TOAST }] },
    ];
    expect(plannedActions(rules, t)).toHaveLength(1);
  });

  it('keeps actions of the same type with different payloads — two phones, two pushes', () => {
    const rules: Rule[] = [
      { id: 'a', event: 'done', actions: [{ type: 'push', topic: 'phone' }] },
      { id: 'b', event: 'done', actions: [{ type: 'push', topic: 'tablet' }] },
    ];
    expect(plannedActions(rules, t)).toHaveLength(2);
  });

  it('ignores key ORDER when deduplicating', () => {
    const rules: Rule[] = [
      { id: 'a', event: 'done', actions: [{ type: 'push', topic: 'phone', urgent: true }] },
      { id: 'b', event: 'done', actions: [{ type: 'push', urgent: true, topic: 'phone' }] },
    ];
    expect(plannedActions(rules, t)).toHaveLength(1);
  });

  it('skips a malformed action rather than dispatching it', () => {
    const rules = [
      { id: 'a', event: 'done', actions: [{ type: '' }, null, { type: ACTION_OS_TOAST }] },
    ] as unknown as Rule[];
    expect(plannedActions(rules, t).map((m) => m.action.type)).toEqual([ACTION_OS_TOAST]);
  });
});

describe('defaultRules — the built-ins, and what they encode', () => {
  it('are empty while OS toasts are off (the default posture, §5.9)', () => {
    expect(defaultRules({})).toEqual([]);
    expect(defaultRules({ osToasts: false })).toEqual([]);
  });

  const on = { osToasts: true };

  it('never toast `done` — that is the per-session checkbox now', () => {
    const fired = defaultRules(on).filter((r) =>
      ruleMatches(r, trigger('done', CARD, 'hidden'))
    );
    expect(fired).toEqual([]);
  });

  it.each(['needs-input', 'needs-permission'] as FeedKind[])(
    '%s toasts while away and stays quiet while focused',
    (kind) => {
      const away = plannedActions(defaultRules(on), trigger(kind, CARD, 'hidden'));
      const focused = plannedActions(defaultRules(on), trigger(kind, CARD, 'focused'));
      expect(away.map((a) => a.action.type)).toEqual([ACTION_OS_TOAST]);
      expect(focused).toEqual([]);
    }
  );

  it('a crash toasts even while the window is focused', () => {
    for (const v of ALL_VISIBILITIES) {
      expect(plannedActions(defaultRules(on), trigger('crashed', CARD, v))).toHaveLength(1);
    }
  });

  it('`ready` is not an attention event and toasts nothing', () => {
    for (const v of ALL_VISIBILITIES) {
      expect(plannedActions(defaultRules(on), trigger('ready', CARD, v))).toEqual([]);
    }
  });

  // ── the two channels that leave the machine (P2-E14-06) ──────────────────
  describe('push and webhook', () => {
    const types = (prefs: Parameters<typeof defaultRules>[0], kind: FeedKind, v: WindowVisibility) =>
      plannedActions(defaultRules(prefs), trigger(kind, CARD, v)).map((a) => a.action.type);

    it('contribute nothing until their own switch is on', () => {
      expect(defaultRules({ osToasts: true }).some((r) => r.actions[0].type !== ACTION_OS_TOAST)).toBe(
        false
      );
      expect(defaultRules({})).toEqual([]);
    });

    // The decision the per-session checkbox already established (§5.9): a
    // switch does what it says, whatever the switch beside it is doing.
    it('fire with desktop pop-ups OFF — each channel is its own opt-in', () => {
      expect(types({ push: true }, 'needs-permission', 'hidden')).toEqual([ACTION_PUSH]);
      expect(types({ webhook: true }, 'done', 'focused')).toEqual([ACTION_WEBHOOK]);
    });

    it.each(['needs-input', 'needs-permission', 'crashed'] as FeedKind[])(
      'pushes %s while away, and never while you are looking at the app',
      (kind) => {
        expect(types({ push: true }, kind, 'hidden')).toEqual([ACTION_PUSH]);
        expect(types({ push: true }, kind, 'visible')).toEqual([ACTION_PUSH]);
        expect(types({ push: true }, kind, 'focused')).toEqual([]);
      }
    );

    it('does not push a finished turn — that is the per-session checkbox', () => {
      expect(types({ push: true }, 'done', 'hidden')).toEqual([]);
    });

    // A webhook goes to a program, and a program is not distracted by being
    // looked at. Different conditions from the phone, on purpose.
    it.each(['needs-input', 'needs-permission', 'crashed', 'done'] as FeedKind[])(
      'POSTs %s whatever the window is doing',
      (kind) => {
        for (const v of ALL_VISIBILITIES)
          expect(types({ webhook: true }, kind, v)).toEqual([ACTION_WEBHOOK]);
      }
    );

    it('carries NO destination in the action payload — that would be a secret in the file', () => {
      for (const r of defaultRules({ push: true, webhook: true }))
        for (const a of r.actions) expect(Object.keys(a)).toEqual(['type']);
    });

    it('stacks with the toasts rather than replacing them', () => {
      expect(types({ osToasts: true, push: true, webhook: true }, 'needs-permission', 'hidden')).toEqual(
        [ACTION_OS_TOAST, ACTION_PUSH, ACTION_WEBHOOK]
      );
    });

    it('leaves the shipped toast rule ids untouched', () => {
      expect(defaultRules({ osToasts: true }).map((r) => r.id)).toEqual([
        'default:needs-input',
        'default:needs-permission',
        'default:crashed',
      ]);
    });

    it('`ready` reaches neither channel', () => {
      for (const v of ALL_VISIBILITIES)
        expect(types({ push: true, webhook: true }, 'ready', v)).toEqual([]);
    });
  });
});

describe('notifyWhenDone helpers', () => {
  it('reads a card`s checkbox off the rule list', () => {
    const rules = [notifyWhenDoneRule(CARD)];
    expect(notifyWhenDoneFor(rules, CARD)).toBe(true);
    expect(notifyWhenDoneFor(rules, OTHER)).toBe(false);
    expect(notifyWhenDoneFor([], CARD)).toBe(false);
  });

  it('derives the id from the card, so ticking twice cannot leave two rules', () => {
    expect(notifyWhenDoneRule(CARD).id).toBe(notifyWhenDoneRule(CARD).id);
    expect(notifyWhenDoneRule(CARD).id).not.toBe(notifyWhenDoneRule(OTHER).id);
    expect(notifyWhenDoneRule(CARD).source).toBe(NOTIFY_WHEN_DONE);
  });

  it('a disabled notify-when-done rule reads as unticked', () => {
    expect(notifyWhenDoneFor([{ ...notifyWhenDoneRule(CARD), enabled: false }], CARD)).toBe(false);
  });
});

describe('visibilityOf', () => {
  const win = (o: Partial<Record<'destroyed' | 'minimized' | 'visible' | 'focused', boolean>>) => ({
    isDestroyed: () => o.destroyed === true,
    isMinimized: () => o.minimized === true,
    isVisible: () => o.visible !== false,
    isFocused: () => o.focused === true,
  });

  it.each([
    ['focused window', win({ focused: true }), 'focused'],
    ['on screen, focused elsewhere', win({}), 'visible'],
    ['minimized', win({ minimized: true }), 'hidden'],
    ['not visible', win({ visible: false }), 'hidden'],
    ['destroyed', win({ destroyed: true, focused: true }), 'hidden'],
  ])('%s -> %s', (_name, w, expected) => {
    expect(visibilityOf(w)).toBe(expected);
  });

  it('has no window at all: hidden, not a crash', () => {
    expect(visibilityOf(null)).toBe('hidden');
    expect(visibilityOf(undefined)).toBe('hidden');
  });

  it('a window that THROWS reads as hidden — fail open, tell the user twice', () => {
    const angry = {
      isDestroyed: () => false,
      isMinimized: () => {
        throw new Error('the window went away mid-question');
      },
      isVisible: () => true,
      isFocused: () => true,
    };
    expect(visibilityOf(angry)).toBe('hidden');
  });
});

describe('visibilityAcross — the APP, not one window', () => {
  const w = (o: Partial<Record<'minimized' | 'visible' | 'focused', boolean>>) => ({
    isDestroyed: () => false,
    isMinimized: () => o.minimized === true,
    isVisible: () => o.visible !== false,
    isFocused: () => o.focused === true,
  });
  const MAIN_MIN = w({ minimized: true });
  const POPOUT_FOCUSED = w({ focused: true });

  it('no windows at all is hidden', () => {
    expect(visibilityAcross([])).toBe('hidden');
    expect(visibilityAcross([null, undefined])).toBe('hidden');
  });

  // The bug this function exists for: a card popped into its own window (E8)
  // while the main window is minimized. Asking only the main window says
  // `hidden`, and the rule then toasts a session the user is reading.
  it('a focused POPOUT beats a minimized main window', () => {
    expect(visibilityAcross([MAIN_MIN, POPOUT_FOCUSED])).toBe('focused');
    expect(visibilityOf(MAIN_MIN)).toBe('hidden'); // …which alone would say otherwise
  });

  it('the inverse too: a focused main window with a hidden popout is focused', () => {
    expect(visibilityAcross([POPOUT_FOCUSED, MAIN_MIN])).toBe('focused');
  });

  it('on screen but focused elsewhere is `visible`, and one hidden peer cannot lower it', () => {
    expect(visibilityAcross([w({}), MAIN_MIN])).toBe('visible');
  });

  it('every window minimized is hidden', () => {
    expect(visibilityAcross([MAIN_MIN, w({ visible: false })])).toBe('hidden');
  });

  it('the notify-when-done rule is therefore SILENT while a popout has focus', () => {
    const seen = visibilityAcross([MAIN_MIN, POPOUT_FOCUSED]);
    expect(ruleMatches(notifyWhenDoneRule(CARD), trigger('done', CARD, seen))).toBe(false);
  });
});

describe('isSaneRule — what survives a hand-edited workspace file', () => {
  const good = notifyWhenDoneRule(CARD);

  it('keeps a well-formed rule', () => {
    expect(isSaneRule(good)).toBe(true);
    expect(isSaneRule({ id: 'r', event: 'any', actions: [{ type: 'push', topic: 'x' }] })).toBe(true);
  });

  it.each([
    ['not an object', 42],
    ['null', null],
    ['an array', []],
    ['no id', { event: 'done', actions: [] }],
    ['a blank id', { id: '', event: 'done', actions: [] }],
    ['a non-string event', { id: 'r', event: 7, actions: [] }],
    ['a non-string session', { id: 'r', event: 'done', session: 7, actions: [] }],
    ['a visibility that is not a list', { id: 'r', event: 'done', visibility: 'hidden', actions: [] }],
    ['an unknown visibility', { id: 'r', event: 'done', visibility: ['squinting'], actions: [] }],
    ['no actions list', { id: 'r', event: 'done' }],
    ['an action with no type', { id: 'r', event: 'done', actions: [{ file: 'x' }] }],
  ])('drops one with %s', (_name, value) => {
    expect(isSaneRule(value)).toBe(false);
  });

  it('keeps a rule whose ACTION TYPE this build does not know — a newer file is not a broken one', () => {
    // The registry logs and skips an unknown action at dispatch time; dropping
    // the rule on the way IN would silently delete it the next time this older
    // build saved the file.
    expect(isSaneRule({ id: 'r', event: 'done', actions: [{ type: 'hologram' }] })).toBe(true);
  });
});
