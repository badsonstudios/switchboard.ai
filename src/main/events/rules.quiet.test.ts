// Quiet hours as rule conditions, table-driven (P2-E14-05b).
//
// A separate file from `rules.test.ts` because it is a separate matrix: that
// one crosses event × scope × visibility, this one crosses **clock × action
// audience × per-rule override**, and stapling the two together would give a
// six-dimensional table nobody can read a failure out of.
//
// **Not one fake timer, not one `sleep`.** The clock is an argument
// (`RuleTrigger.now`) injected from one place (`RulesEngineDeps.now`), so
// "03:00 on a Tuesday" is a `new Date(...)` in the case row. That is the whole
// reason the clock was put on the trigger rather than read where it is needed.
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import {
  ACTION_OS_TOAST,
  ACTION_PUSH,
  ACTION_SOUND,
  ACTION_SPEAK,
  ACTION_WEBHOOK,
  ActionAudience,
  QuietHoursMode,
  QuietWindow,
  Rule,
  RuleTrigger,
  audienceOf,
  defaultRules,
  inQuietWindow,
  isQuietTime,
  isSaneRule,
  plannedActions,
  quietHolds,
  splitQuiet,
  triggerIsQuiet,
} from './rules';
import type { FeedKind } from './feed';

const CARD = 'card-a';
/** local wall-clock, which is what a quiet window is written in */
const at = (h: number, m = 0): Date => new Date(2026, 7, 14, h, m, 0);
const NIGHT: QuietWindow = { start: '22:00', end: '07:00' };

const trigger = (now: Date, quiet: QuietWindow | null = NIGHT): RuleTrigger => ({
  kind: 'done',
  cardId: CARD,
  visibility: 'hidden',
  now,
  quiet,
});

const rule = (actions: string[], quietHours?: QuietHoursMode): Rule => ({
  id: 'r',
  event: 'any',
  actions: actions.map((type) => ({ type })),
  ...(quietHours ? { quietHours } : {}),
});

// ── the window itself ──────────────────────────────────────────────────────
describe('inQuietWindow — local wall clock, end exclusive', () => {
  // hour → inside an overnight 22:00–07:00 window?
  const overnight: Array<[number, boolean]> = [
    [21, false],
    [22, true], // start is INCLUSIVE
    [23, true],
    [0, true], // …across midnight
    [3, true],
    [6, true],
    [7, false], // end is EXCLUSIVE — 07:00 is morning
    [12, false],
  ];
  it.each(overnight)('%i:00 -> %s', (h, inside) => {
    expect(inQuietWindow(NIGHT, at(h))).toBe(inside);
  });

  // The same window written the other way round: a same-day range must not
  // secretly behave like an overnight one.
  const daytime: Array<[number, boolean]> = [
    [11, false],
    [12, true],
    [13, true],
    [14, false],
    [23, false],
  ];
  it.each(daytime)('a daytime window 12:00–14:00 at %i:00 -> %s', (h, inside) => {
    expect(inQuietWindow({ start: '12:00', end: '14:00' }, at(h))).toBe(inside);
  });

  it('minutes count, not just hours', () => {
    expect(inQuietWindow({ start: '22:30', end: '23:00' }, at(22, 29))).toBe(false);
    expect(inQuietWindow({ start: '22:30', end: '23:00' }, at(22, 30))).toBe(true);
    expect(inQuietWindow({ start: '22:30', end: '23:00' }, at(22, 59))).toBe(true);
    expect(inQuietWindow({ start: '22:30', end: '23:00' }, at(23, 0))).toBe(false);
  });

  it('no window at all is never quiet', () => {
    expect(inQuietWindow(null, at(3))).toBe(false);
    expect(inQuietWindow(undefined, at(3))).toBe(false);
  });

  it('equal ends is an EMPTY window, not a 24-hour one', () => {
    // The two are indistinguishable by looking, so the ambiguous pair is
    // refused rather than guessed at. A user who wants silence all day turns
    // notifications off — there is a switch for exactly that.
    for (const h of [0, 6, 12, 22]) {
      expect(inQuietWindow({ start: '09:00', end: '09:00' }, at(h))).toBe(false);
    }
  });

  it.each([
    ['10pm', false],
    ['', false],
    ['24:00', false],
    ['22:60', false],
    ['7:00', true], // a single-digit hour is a legitimate way to write it
    ['07:00', true],
    ['00:00', true],
    ['23:59', true],
  ])('isQuietTime(%s) -> %s', (s, ok) => {
    expect(isQuietTime(s)).toBe(ok);
  });

  it('an unparseable end disables the window rather than half-applying it', () => {
    expect(inQuietWindow({ start: '22:00', end: 'sunrise' }, at(3))).toBe(false);
  });

  /**
   * DST, pinned rather than left to a comment nobody can fail.
   *
   * Windows are wall-clock, so the rule is "what does the clock on the wall
   * say" — the reading a person uses, and the only one that needs no
   * explanation in the manual. The consequences are asserted below in a FORCED
   * timezone, because CI runs in UTC where there is no DST to observe and the
   * bug this guards against (reading `getUTCHours`) would go unnoticed.
   */
  describe('across a DST boundary, in a timezone that has one', () => {
    const realTZ = process.env.TZ;
    // Node re-reads `process.env.TZ` for Dates created after it changes (v16+),
    // which is what makes a deterministic DST test possible at all.
    //
    // CAVEAT for whoever changes the vitest pool: the timezone cache is
    // PROCESS-wide, and this restores it in `afterAll` — safe while files run
    // one at a time per worker (the default), a cross-file flake vector the day
    // two files share a process concurrently.
    beforeAll(() => {
      process.env.TZ = 'America/Chicago';
    });
    afterAll(() => {
      if (realTZ === undefined) delete process.env.TZ;
      else process.env.TZ = realTZ;
    });

    it('is the LOCAL hour that decides, not the UTC one', () => {
      // 22:00 CST is 04:00 UTC the next day. An implementation reading
      // `getUTCHours` would call this "not quiet" — this is the whole
      // wall-clock claim, and the assertion that would catch losing it.
      expect(new Date(2026, 0, 15, 22, 30).getUTCHours()).toBe(4);
      expect(inQuietWindow(NIGHT, new Date(2026, 0, 15, 22, 30))).toBe(true);
    });

    it('the hour that happens TWICE in autumn is quiet both times', () => {
      // 2026-11-01: 02:00 CDT falls back to 01:00 CST, so 01:30 occurs twice —
      // once at 06:30 UTC and once at 07:30 UTC. Both read 01:30 on the wall,
      // so both are inside a 01:00–03:00 window. Nothing extra is needed to
      // make that true; it falls out of only ever asking the wall clock.
      const win: QuietWindow = { start: '01:00', end: '03:00' };
      const first = new Date(Date.UTC(2026, 10, 1, 6, 30)); // 01:30 CDT
      const second = new Date(Date.UTC(2026, 10, 1, 7, 30)); // 01:30 CST
      expect([first.getHours(), second.getHours()]).toEqual([1, 1]);
      expect(inQuietWindow(win, first)).toBe(true);
      expect(inQuietWindow(win, second)).toBe(true);
    });

    it('the hour that never happens in spring is simply never inside it', () => {
      // 2026-03-08: the clock jumps 02:00 → 03:00, so no instant reads 02:15 on
      // the wall. Asking for one lands on 03:15, which is outside a window that
      // ends at 03:00 — the honest answer, and the one a person reading their
      // own clock would give.
      const win: QuietWindow = { start: '01:30', end: '03:00' };
      const nonexistent = new Date(2026, 2, 8, 2, 15);
      expect(nonexistent.getHours()).toBe(3);
      expect(inQuietWindow(win, nonexistent)).toBe(false);
    });
  });
});

// ── who each action is aimed at ────────────────────────────────────────────
describe('the action audience table — the decision quiet hours turns on', () => {
  const cases: Array<[string, ActionAudience]> = [
    [ACTION_OS_TOAST, 'person'],
    [ACTION_SOUND, 'person'],
    [ACTION_SPEAK, 'person'],
    // A phone buzzing on a nightstand is the MOST person-facing channel here,
    // not the least. If this row ever flips, quiet hours stop being quiet.
    [ACTION_PUSH, 'person'],
    // …and the one that does not have ears. This is the item's decision.
    [ACTION_WEBHOOK, 'machine'],
  ];
  it.each(cases)('%s is aimed at a %s', (type, audience) => {
    expect(audienceOf(type)).toBe(audience);
  });

  it('an action type this build does not know counts as person-facing', () => {
    // Deliberately the cautious side: wrongly holding an unknown channel costs
    // one digest line, wrongly firing it wakes someone up. (And an unknown type
    // has no handler anyway, so in practice this decides the digest entry.)
    expect(audienceOf('smoke-signal')).toBe('person');
  });
});

// ── the cross-product: clock × audience × override ─────────────────────────
describe('quietHolds — the matrix', () => {
  const ACTIONS = [ACTION_OS_TOAST, ACTION_SOUND, ACTION_SPEAK, ACTION_PUSH, ACTION_WEBHOOK];

  it.each(ACTIONS)('outside the window, %s always fires', (type) => {
    expect(quietHolds(rule([type]), { type }, trigger(at(12)))).toBe(false);
  });

  it.each(ACTIONS)('with no window configured at all, %s always fires', (type) => {
    expect(quietHolds(rule([type]), { type }, trigger(at(3), null))).toBe(false);
  });

  it.each(ACTIONS)('inside the window, %s follows its audience', (type) => {
    expect(quietHolds(rule([type]), { type }, trigger(at(3)))).toBe(
      audienceOf(type) === 'person'
    );
  });

  // The two overrides, each proved to beat the default IN BOTH DIRECTIONS —
  // one row each would leave "the override is read at all" untested for
  // whichever direction agreed with the default by accident.
  it("`quietHours: 'ignore'` fires a person-facing action at 3am", () => {
    const r = rule([ACTION_OS_TOAST], 'ignore');
    expect(quietHolds(r, { type: ACTION_OS_TOAST }, trigger(at(3)))).toBe(false);
  });

  it("`quietHours: 'obey'` holds a webhook at 3am", () => {
    const r = rule([ACTION_WEBHOOK], 'obey');
    expect(quietHolds(r, { type: ACTION_WEBHOOK }, trigger(at(3)))).toBe(true);
  });

  it('an override still does nothing outside the window', () => {
    expect(quietHolds(rule([ACTION_WEBHOOK], 'obey'), { type: ACTION_WEBHOOK }, trigger(at(12)))).toBe(
      false
    );
  });

  it('a trigger with no clock holds nothing — an absent time is not 3am', () => {
    const noClock: RuleTrigger = { kind: 'done', cardId: CARD, visibility: 'hidden', quiet: NIGHT };
    expect(triggerIsQuiet(noClock)).toBe(false);
    expect(quietHolds(rule([ACTION_OS_TOAST]), { type: ACTION_OS_TOAST }, noClock)).toBe(false);
  });
});

// ── the split, which is what the engine actually calls ─────────────────────
describe('splitQuiet — matched actions, divided', () => {
  it('holds the person-facing half and lets the webhook through', () => {
    const rules: Rule[] = [rule([ACTION_OS_TOAST, ACTION_SOUND, ACTION_PUSH, ACTION_WEBHOOK])];
    const t = trigger(at(3));
    const { run, held } = splitQuiet(plannedActions(rules, t), t);
    expect(run.map((a) => a.action.type)).toEqual([ACTION_WEBHOOK]);
    expect(held.map((a) => a.action.type)).toEqual([ACTION_OS_TOAST, ACTION_SOUND, ACTION_PUSH]);
  });

  it('holds nothing at noon', () => {
    const rules: Rule[] = [rule([ACTION_OS_TOAST, ACTION_WEBHOOK])];
    const t = trigger(at(12));
    const { run, held } = splitQuiet(plannedActions(rules, t), t);
    expect(run).toHaveLength(2);
    expect(held).toEqual([]);
  });

  it('matching is untouched — a rule that never matched is in neither list', () => {
    // Suppression is NOT matching, and this is the pin on that: a rule the
    // visibility condition rejected must not turn up in the digest as
    // "held by quiet hours", because it was not.
    const focusedOnly: Rule = {
      id: 'r',
      event: 'any',
      visibility: ['focused'],
      actions: [{ type: ACTION_OS_TOAST }],
    };
    const t = trigger(at(3)); // visibility is 'hidden'
    const { run, held } = splitQuiet(plannedActions([focusedOnly], t), t);
    expect(run).toEqual([]);
    expect(held).toEqual([]);
  });

  it('the default rules behave the way the manual says at 3am', () => {
    // Every channel switched on, all four events, the whole built-in set.
    const prefs = { osToasts: true, sounds: true, speak: true, push: true, webhook: true };
    for (const kind of ['needs-input', 'needs-permission', 'crashed', 'done'] as FeedKind[]) {
      const t: RuleTrigger = { kind, cardId: CARD, visibility: 'hidden', now: at(3), quiet: NIGHT };
      const { run, held } = splitQuiet(plannedActions(defaultRules(prefs), t), t);
      // The one thing that leaves the machine for a program still leaves it…
      expect(run.map((a) => a.action.type)).toEqual([ACTION_WEBHOOK]);
      // …and nothing that reaches a person does.
      expect(held.every((a) => audienceOf(a.action.type) === 'person')).toBe(true);
    }
  });
});

// ── the field survives the round trip ──────────────────────────────────────
describe('isSaneRule and the quietHours override', () => {
  it.each([undefined, 'obey', 'ignore'])('accepts %s', (mode) => {
    expect(isSaneRule({ ...rule([ACTION_OS_TOAST]), quietHours: mode })).toBe(true);
  });

  it.each(['always', '', 1, null, {}])('drops a rule carrying %s', (mode) => {
    // Dropped, not defaulted: the difference between this field's two values is
    // "held all night" and "rang at 3am", and guessing is not allowed to be one
    // of the outcomes.
    expect(isSaneRule({ ...rule([ACTION_OS_TOAST]), quietHours: mode })).toBe(false);
  });
});

// ── the dedup must not swallow the override ────────────────────────────────
//
// Found in self-review, not by a failing test: `plannedActions` collapses
// identical actions and keeps the FIRST rule that asked, and the built-ins are
// evaluated first. So a hand-written `quietHours` on a rule whose action a
// built-in already claimed would have been silently discarded — and hand-writing
// that field is exactly what the manual tells a user to do.
describe('an explicit quietHours survives action dedup', () => {
  const builtinToast: Rule = { id: 'default:toast', event: 'any', actions: [{ type: ACTION_OS_TOAST }] };

  it("a user's 'ignore' beats the built-in that claimed the same toast", () => {
    const mine: Rule = {
      id: 'mine',
      event: 'any',
      session: CARD,
      quietHours: 'ignore',
      actions: [{ type: ACTION_OS_TOAST }],
    };
    const t = trigger(at(3));
    // Still ONE toast — the dedup's own promise is untouched…
    const planned = plannedActions([builtinToast, mine], t);
    expect(planned).toHaveLength(1);
    // …and it fires at 3am, which is what the user asked for.
    expect(splitQuiet(planned, t).run.map((a) => a.action.type)).toEqual([ACTION_OS_TOAST]);
  });

  it("a user's 'obey' beats a built-in webhook that would have gone out", () => {
    const builtinHook: Rule = { id: 'default:hook', event: 'any', actions: [{ type: ACTION_WEBHOOK }] };
    const mine: Rule = { id: 'mine', event: 'any', quietHours: 'obey', actions: [{ type: ACTION_WEBHOOK }] };
    const t = trigger(at(3));
    const { run, held } = splitQuiet(plannedActions([builtinHook, mine], t), t);
    expect(run).toEqual([]);
    expect(held.map((a) => a.action.type)).toEqual([ACTION_WEBHOOK]);
  });

  it('an override does NOT reorder anything or duplicate the action', () => {
    const t = trigger(at(12));
    const mine: Rule = { id: 'mine', event: 'any', quietHours: 'obey', actions: [{ type: ACTION_OS_TOAST }] };
    const other: Rule = { id: 'other', event: 'any', actions: [{ type: ACTION_SOUND }] };
    const planned = plannedActions([builtinToast, other, mine], t);
    expect(planned.map((a) => a.action.type)).toEqual([ACTION_OS_TOAST, ACTION_SOUND]);
    // the surviving entry carries the rule that had something to say
    expect(planned[0].rule.id).toBe('mine');
  });

  it('two conflicting overrides: the first still wins, no cleverness', () => {
    const a: Rule = { id: 'a', event: 'any', quietHours: 'ignore', actions: [{ type: ACTION_OS_TOAST }] };
    const b: Rule = { id: 'b', event: 'any', quietHours: 'obey', actions: [{ type: ACTION_OS_TOAST }] };
    const t = trigger(at(3));
    expect(splitQuiet(plannedActions([a, b], t), t).run).toHaveLength(1);
  });
});
