// Which model is this session running? (#721)
//
// One string per session, and the interesting behaviour is entirely about the
// TWO KINDS OF ABSENCE the CLI produces:
//
//   • a session that has run no turn has emitted no `system:init` at all, so
//     its model is genuinely unknown — and that is the picker's PRIMARY case,
//     a fresh card someone opens the picker on before typing;
//   • an init that arrives without a usable `model` must not blank what we had.
import { describe, it, expect } from 'vitest';
import { StreamModel } from './stream-model';

const init = (model?: unknown): Record<string, unknown> => ({
  type: 'system',
  subtype: 'init',
  ...(model === undefined ? {} : { model }),
});

describe('reading the model off system:init', () => {
  it('takes it, and answers it back', () => {
    const s = new StreamModel();
    s.offer('L1', init('claude-opus-5'));
    expect(s.modelFor('L1')).toBe('claude-opus-5');
  });

  it('REPLACES on every init — init is once per TURN, not per session', () => {
    const s = new StreamModel();
    s.offer('L1', init('claude-opus-5'));
    s.offer('L1', init('claude-haiku-4-5-20251001'));
    expect(s.modelFor('L1')).toBe('claude-haiku-4-5-20251001');
  });

  it('keeps sessions apart', () => {
    const s = new StreamModel();
    s.offer('L1', init('claude-opus-5'));
    s.offer('L2', init('claude-sonnet-5'));
    expect(s.modelFor('L1')).toBe('claude-opus-5');
    expect(s.modelFor('L2')).toBe('claude-sonnet-5');
  });
});

describe('the two absences', () => {
  it('answers null for a session that has never said anything', () => {
    // The fresh-card case. NOT collapsible to "default": the user may well be
    // on something else from their settings, and a picker that ticked a model
    // it had not been told about would be inventing the one fact it exists to
    // report.
    expect(new StreamModel().modelFor('never-spoke')).toBeNull();
  });

  it('keeps the last known model when an init arrives without a usable one', () => {
    const s = new StreamModel();
    s.offer('L1', init('claude-opus-5'));
    for (const bad of [undefined, null, '', '   ', 42, {}, []]) {
      s.offer('L1', init(bad));
      expect(s.modelFor('L1'), JSON.stringify(bad)).toBe('claude-opus-5');
    }
  });

  it('stays null rather than storing junk when the FIRST init is unusable', () => {
    const s = new StreamModel();
    s.offer('L1', init(42));
    expect(s.modelFor('L1')).toBeNull();
  });
});

describe('everything else on the wire is ignored', () => {
  it('takes nothing from other message types', () => {
    const s = new StreamModel();
    s.offer('L1', { type: 'assistant', message: { model: 'claude-opus-5' } });
    s.offer('L1', { type: 'system', subtype: 'commands_changed', model: 'claude-opus-5' });
    s.offer('L1', { type: 'result', modelUsage: { 'claude-opus-5': {} } });
    s.offer('L1', {});
    expect(s.modelFor('L1')).toBeNull();
  });
});

describe('the optimistic write', () => {
  it('records a model we just set, so the tick moves before the next turn', () => {
    // Without it the picker's tick would only catch up on the user's NEXT
    // prompt, which reads as a control that did not work.
    const s = new StreamModel();
    s.noteSet('L1', 'haiku');
    expect(s.modelFor('L1')).toBe('haiku');
  });

  it('is a bridge, not an authority — the CLI’s next init wins', () => {
    const s = new StreamModel();
    s.noteSet('L1', 'haiku');
    s.offer('L1', init('claude-haiku-4-5-20251001'));
    // the CLI's resolved id, not the alias we sent
    expect(s.modelFor('L1')).toBe('claude-haiku-4-5-20251001');
  });

  it('refuses an empty value rather than blanking what is known', () => {
    const s = new StreamModel();
    s.offer('L1', init('claude-opus-5'));
    s.noteSet('L1', '   ');
    expect(s.modelFor('L1')).toBe('claude-opus-5');
  });
});

describe('forgetSession', () => {
  it('drops the session’s model and nobody else’s', () => {
    const s = new StreamModel();
    s.offer('L1', init('claude-opus-5'));
    s.offer('L2', init('claude-sonnet-5'));
    s.forgetSession('L1');
    expect(s.modelFor('L1')).toBeNull();
    expect(s.modelFor('L2')).toBe('claude-sonnet-5');
  });
});
