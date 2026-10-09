// Reading and setting the effort level (#1115): the request builders and the
// two readers. The contract they encode was measured against the real CLI; see
// the header of effort.ts.
import { describe, it, expect } from 'vitest';
import {
  effortLevelsFor,
  getSettingsRequest,
  readApplied,
  setEffortRequest,
  withLevel,
} from './effort';

describe('the two requests', () => {
  it('asks for settings by the verb the CLI answers', () => {
    expect(getSettingsRequest('r1')).toEqual({
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'get_settings' },
    });
  });

  it('sets the level through the flag settings, not through the verb that is gone', () => {
    expect(setEffortRequest('r2', ' high ')).toEqual({
      type: 'control_request',
      request_id: 'r2',
      request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } },
    });
  });

  it('refuses to build one with no level: the CLI would say success and do nothing', () => {
    for (const bad of [undefined, null, '', '   ', 3, {}, ['high']]) {
      expect(setEffortRequest('r', bad)).toBeNull();
    }
  });
});

describe('what a get_settings answer says is applied', () => {
  it('reads the model and the level', () => {
    expect(
      readApplied({ effective: {}, applied: { model: 'claude-opus-5-5', effort: 'high' } })
    ).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
  });

  it('a model with no effort levels is a real answer: effort null', () => {
    expect(readApplied({ applied: { model: 'claude-haiku-4-5-20251001', effort: null } })).toEqual({
      model: 'claude-haiku-4-5-20251001',
      effort: null,
    });
  });

  it('says nothing at all when the CLI has no applied block, or no effort in it', () => {
    expect(readApplied({ effective: { effortLevel: 'high' } })).toBeNull();
    expect(readApplied({ applied: { model: 'x' } })).toBeNull();
    expect(readApplied({ applied: 'nope' })).toBeNull();
  });

  it('does not pass a non-string through as a level', () => {
    expect(readApplied({ applied: { model: 7, effort: 5 } })).toEqual({ model: null, effort: null });
  });
});

describe('the levels for the model a session is on', () => {
  // the real payload's shape (2.1.288), trimmed
  const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
  const FOUR = ['low', 'medium', 'high', 'max'];
  const list = {
    models: [
      { value: 'default', resolvedModel: 'claude-opus-5[1m]', supportsEffort: true, supportedEffortLevels: FIVE },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', supportsEffort: true, supportedEffortLevels: FIVE },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
      { value: 'claude-opus-4-6', supportsEffort: true, supportedEffortLevels: FOUR },
      { value: 'claude-sonnet-4-6', supportsEffort: true, supportedEffortLevels: FOUR },
    ],
  };

  it('finds a model by its own id', () => {
    expect(effortLevelsFor(list, 'claude-opus-4-6')).toEqual(FOUR);
  });

  it('finds a resolved id that stops short of the minor version', () => {
    // applied says `claude-sonnet-5-5`; the list says `claude-sonnet-5`
    expect(effortLevelsFor(list, 'claude-sonnet-5-5')).toEqual(FIVE);
  });

  it('ignores a context-window suffix on either side', () => {
    expect(effortLevelsFor(list, 'claude-opus-5[1m]')).toEqual(FIVE);
    expect(effortLevelsFor(list, 'claude-opus-5-5')).toEqual(FIVE);
  });

  it('prefers the longest match: 4-6 is not "sonnet 4" with something after it', () => {
    const tricky = {
      models: [
        { value: 'claude-sonnet-4', supportedEffortLevels: ['low'] },
        { value: 'claude-sonnet-4-6', supportedEffortLevels: FOUR },
      ],
    };
    expect(effortLevelsFor(tricky, 'claude-sonnet-4-6')).toEqual(FOUR);
  });

  it('does not match on a bare prefix: sonnet-5 is not sonnet-55', () => {
    const near = { models: [{ value: 'claude-sonnet-5', supportedEffortLevels: ['low'] }, { value: 'other', supportedEffortLevels: FIVE }] };
    // no real match, so the fallback: the longest list, not the nearest name
    expect(effortLevelsFor(near, 'claude-sonnet-55')).toEqual(FIVE);
  });

  it('falls back to the LONGEST list when nothing matches, wherever it sits', () => {
    expect(effortLevelsFor(list, 'something-new')).toEqual(FIVE);
    expect(effortLevelsFor(list, null)).toEqual(FIVE);
    // a short list first must not hide levels: an extra level is caught by
    // the read-back, a missing one is caught by nothing
    const shortFirst = { models: [{ value: 'a', supportedEffortLevels: ['low'] }, { value: 'b', supportedEffortLevels: FOUR }] };
    expect(effortLevelsFor(shortFirst, 'unknown')).toEqual(FOUR);
  });

  it('hands back a copy, never the payload’s own array', () => {
    const got = effortLevelsFor(list, 'claude-opus-4-6');
    got.push('made-up');
    expect(effortLevelsFor(list, 'claude-opus-4-6')).toEqual(FOUR);
  });

  it('is empty for a payload with no models, or none that has levels', () => {
    expect(effortLevelsFor({}, 'x')).toEqual([]);
    expect(effortLevelsFor({ models: 'nope' }, 'x')).toEqual([]);
    expect(effortLevelsFor({ models: [{ value: 'haiku' }, null, 4] }, 'haiku')).toEqual([]);
  });
});

describe('offering the level in force when the list left it out', () => {
  it('puts it where the CLI’s own order would', () => {
    expect(withLevel(['low', 'medium', 'high'], 'max')).toEqual(['low', 'medium', 'high', 'max']);
    expect(withLevel(['low', 'high', 'max'], 'medium')).toEqual(['low', 'medium', 'high', 'max']);
    expect(withLevel(['medium', 'high'], 'low')).toEqual(['low', 'medium', 'high']);
  });

  it('leaves a list that already has it alone', () => {
    expect(withLevel(['low', 'medium'], 'medium')).toEqual(['low', 'medium']);
  });

  it('puts a level it has never heard of last, rather than dropping it', () => {
    expect(withLevel(['low', 'max'], 'ludicrous')).toEqual(['low', 'max', 'ludicrous']);
  });
});
