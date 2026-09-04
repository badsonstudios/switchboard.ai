// The model list's shared rules (#747), which used to live in the picker's test.
//
// They moved here with the code, and the move is the point: TWO surfaces now
// render `list_models` — the picker dialog and the footer chip's quick menu —
// and these are the rules that decide what both of them SAY. A copy per surface
// is how two menus start disagreeing about which model a session is on.
//
// The two rules that are easy to get wrong and invisible when you do:
//
//   • WHICH ROW IS TICKED. `system:init.model` reports a RESOLVED id
//     (`claude-haiku-4-5-20251001`) while the list's `value` is the alias
//     (`haiku`), so matching only `value` leaves a real session with nothing
//     ticked — always, since the CLI always resolves.
//   • NOTHING IS TICKED WHEN THE MODEL IS UNKNOWN, and that is a real state
//     rather than a missing one: the CLI reports the running model only on
//     `system:init`, once per TURN, so a session that has not replied yet has
//     genuinely never said. Ticking `default` there would be inventing the one
//     fact these surfaces exist to report.
import { describe, it, expect } from 'vitest';
import { currentIndex, failureText, modelLabel, rowSubtitle } from './model-choices';
import { CLI_MODELS as MODELS, modelAt as at } from './fixtures/cli-models';

describe('currentIndex — exactly one row, and which', () => {
  it('matches the resolved id the session actually reports', () => {
    // THE CASE THAT MATTERS. `set_model` takes `haiku`; `system:init.model`
    // comes back `claude-haiku-4-5-20251001`. Matching `value` alone would tick
    // nothing on every real session.
    expect(currentIndex(MODELS, 'claude-haiku-4-5-20251001')).toBe(at('haiku'));
  });

  it('matches the alias too, for the optimistic tick right after a switch', () => {
    expect(currentIndex(MODELS, 'haiku')).toBe(at('haiku'));
  });

  it('picks ONE row when two share a resolvedModel — the captured collision', () => {
    // `default` and `opus[1m]` both resolve to `claude-opus-5[1m]`. A per-row
    // predicate ticked both, for anyone on the default model, which is the
    // default setup.
    expect(currentIndex(MODELS, 'claude-opus-5[1m]')).toBe(at('default'));
  });

  it('prefers an EXACT alias over a row that merely resolves the same way', () => {
    // A session switched to `opus[1m]` must tick `opus[1m]`, not the `default`
    // row above it that happens to resolve identically.
    expect(currentIndex(MODELS, 'opus[1m]')).toBe(at('opus[1m]'));
  });

  it('ticks NOTHING when the model is unknown', () => {
    expect(currentIndex(MODELS, null)).toBe(-1);
  });

  it('ticks nothing for a model that is not in the list at all', () => {
    expect(currentIndex(MODELS, 'claude-sonnet-4-5-20250929')).toBe(-1);
    expect(currentIndex(MODELS, 'opus')).toBe(-1);
  });
});

describe('rowSubtitle — never empty', () => {
  it('prefers the description, falls back to the resolved id, then the value', () => {
    expect(rowSubtitle(MODELS[0])).toContain('Opus 5');
    expect(rowSubtitle(MODELS[3])).toBe('claude-sonnet-5');
    expect(rowSubtitle({ value: 'bare' })).toBe('bare');
  });
});

describe('modelLabel — the CLI names its own models', () => {
  it('prefers the display name and falls back to the alias', () => {
    expect(modelLabel(MODELS[4])).toBe('Haiku');
    // Every entry has a `value`; nothing else is guaranteed. A row with no
    // label at all would be an unclickable blank in both surfaces.
    expect(modelLabel({ value: 'bare' })).toBe('bare');
  });
});

describe('failureText — the CLI speaks for itself', () => {
  const t = (k: string): string => k;

  it('passes a refusal through verbatim rather than rewording it', () => {
    const sentence =
      'Model "x" is not a recognized model id. Run /model to see available models.';
    expect(failureText({ ok: false, reason: 'refused', message: sentence }, t)).toBe(sentence);
  });

  it('has our own words for the failures the CLI never explains', () => {
    expect(failureText({ ok: false, reason: 'not-stream', message: '' }, t)).toBe('model.notStream');
    expect(failureText({ ok: false, reason: 'session-gone', message: '' }, t)).toBe(
      'model.sessionGone'
    );
    expect(failureText({ ok: false, reason: 'timed-out', message: '' }, t)).toBe('model.timedOut');
    expect(failureText({ ok: false, reason: 'invalid', message: '' }, t)).toBe('model.failed');
  });

  it('falls back rather than showing an empty refusal', () => {
    expect(failureText({ ok: false, reason: 'refused', message: '' }, t)).toBe('model.failed');
  });
});
