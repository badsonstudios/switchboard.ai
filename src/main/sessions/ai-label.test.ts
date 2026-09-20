// #758 — the AI task label's two decisions: when to spend a model call, and
// what to do with the answer.
//
// Every test here is about a RULE, which is the same reason `auto-label.test.ts`
// exists beside `auto-label.ts`. The expensive half of this feature (a 14-second
// model call) is unreachable from a test, so the part that decides whether to
// make that call has to be provable without one.
import { describe, expect, it } from 'vitest';
import {
  acceptAiLabel,
  cleanAiLabel,
  shouldRelabel,
  DEFAULT_MIN_GAP_MS,
  DEFAULT_MIN_NEW_LINES,
  MIN_TRANSCRIPT_LINES,
  type AiLabelState,
  type RelabelInput,
} from './ai-label';

const NOW = 1_700_000_000_000;

/** A card nobody has typed a label on — the only kind this feature may touch. */
const autoCard = { taskLabel: 'an older label', labelSource: 'auto' as const };

function input(over: Partial<RelabelInput> = {}): RelabelInput {
  return {
    enabled: true,
    card: autoCard,
    lines: 500,
    state: { lastRunAt: NOW - DEFAULT_MIN_GAP_MS - 1, lastLines: 400 },
    now: NOW,
    ...over,
  };
}

describe('when to spend a model call (shouldRelabel)', () => {
  it('runs when the setting is on, the card is auto, and the work has moved on', () => {
    expect(shouldRelabel(input())).toEqual({ run: true });
  });

  it('never runs while the feature is switched off', () => {
    // Its OWN switch, not the auto-labels one: this spends usage, so the owner
    // turns it on (#758).
    expect(shouldRelabel(input({ enabled: false }))).toEqual({
      run: false,
      reason: 'disabled',
    });
  });

  it('never runs for a label the user typed', () => {
    // Checked here AND at the landing. This one saves the tokens; `acceptAiLabel`
    // saves the label. A pinned card must never cause a call whose result can
    // only be discarded.
    expect(shouldRelabel(input({ card: { taskLabel: 'mine', labelSource: 'user' } }))).toEqual({
      run: false,
      reason: 'user-owns-it',
    });
  });

  it('treats a pre-feature card with text in it as the user\'s', () => {
    // `labelSourceOf`'s fallback, inherited deliberately: guessing 'auto' for a
    // card that predates the source field would spend tokens to overwrite
    // something the user typed weeks ago.
    expect(shouldRelabel(input({ card: { taskLabel: 'typed long ago' } }))).toEqual({
      run: false,
      reason: 'user-owns-it',
    });
  });

  it('runs for a blank pre-feature card, which is nobody\'s', () => {
    expect(shouldRelabel(input({ card: {} }))).toEqual({ run: true });
  });

  it('refuses a second run while one is already out', () => {
    // At ~14 s a run (measured), a chatty session can end two turns inside one.
    // Without this the loser would overwrite the winner with older material.
    const state: AiLabelState = { inFlight: true, lastLines: 0 };
    expect(shouldRelabel(input({ state }))).toEqual({ run: false, reason: 'in-flight' });
  });

  it('says nothing about a conversation that has barely started', () => {
    expect(shouldRelabel(input({ lines: MIN_TRANSCRIPT_LINES - 1, state: {} }))).toEqual({
      run: false,
      reason: 'too-thin',
    });
  });

  describe('the cheap staleness signal — a transcript that has not grown', () => {
    it('refuses when too few new lines have landed', () => {
      // THE GATE THAT MAKES IDLE SESSIONS FREE. A transcript that has not grown
      // cannot have drifted, so there is no new label to be had.
      const state: AiLabelState = { lastRunAt: NOW - DEFAULT_MIN_GAP_MS - 1, lastLines: 495 };
      expect(shouldRelabel(input({ lines: 500, state }))).toEqual({
        run: false,
        reason: 'no-growth',
      });
    });

    it('runs on exactly the threshold of new lines', () => {
      const state: AiLabelState = {
        lastRunAt: NOW - DEFAULT_MIN_GAP_MS - 1,
        lastLines: 500 - DEFAULT_MIN_NEW_LINES,
      };
      expect(shouldRelabel(input({ lines: 500, state }))).toEqual({ run: true });
    });

    it('runs for a session it has never labelled, however long it is', () => {
      // No `lastLines` is not zero growth — it is no evidence either way, and
      // the first label for a session is the one most worth having.
      expect(shouldRelabel(input({ state: {} }))).toEqual({ run: true });
    });
  });

  describe('the floor under everything else — the minimum gap', () => {
    it('refuses a run inside the gap even when the session is busy', () => {
      // Growth alone is not enough: a session running flat out produces plenty
      // of lines per turn, and relabeling every turn is the failure mode the
      // whole module exists to prevent.
      const state: AiLabelState = { lastRunAt: NOW - 1_000, lastLines: 0 };
      expect(shouldRelabel(input({ lines: 5_000, state }))).toEqual({
        run: false,
        reason: 'too-soon',
      });
    });

    it('runs once the gap has elapsed', () => {
      const state: AiLabelState = { lastRunAt: NOW - DEFAULT_MIN_GAP_MS, lastLines: 0 };
      expect(shouldRelabel(input({ state }))).toEqual({ run: true });
    });
  });

  it('checks the free things before the ones that need the transcript', () => {
    // Ordering is a property here, not an implementation detail: this is called
    // for every open session on every turn that ends. A disabled feature must
    // cost one comparison, so `disabled` has to win over every other reason.
    const verdict = shouldRelabel(
      input({
        enabled: false,
        card: { taskLabel: 'mine', labelSource: 'user' },
        lines: 0,
        state: { inFlight: true },
      })
    );
    expect(verdict).toEqual({ run: false, reason: 'disabled' });
  });
});

describe('what the model said is untrusted text (cleanAiLabel)', () => {
  it('takes a plain label as-is', () => {
    expect(cleanAiLabel('Plan session history feature')).toBe('Plan session history feature');
  });

  it('takes only the first real line', () => {
    // A model asked for six words sometimes returns the six words and then
    // explains itself.
    expect(cleanAiLabel('\n\nFix the login redirect\n\nThis is because...')).toBe(
      'Fix the login redirect'
    );
  });

  it('unwraps a quoted answer', () => {
    expect(cleanAiLabel('"Fix the login redirect"')).toBe('Fix the login redirect');
    expect(cleanAiLabel('`Fix the login redirect`')).toBe('Fix the login redirect');
  });

  it('collapses whitespace and strips control characters', () => {
    expect(cleanAiLabel('Fix   the\tlogin redirect')).toBe('Fix the login redirect');
  });

  it('REFUSES anything that opens like markup or a tool call', () => {
    // ⚠️ THE SECURITY CASE, and it is not hypothetical. A contained turn asked
    // to go snooping replied with `<function_calls>` blocks as plain text and
    // narrated results it never received (probe 758, Q4). A labeler writes that
    // stdout onto a card. The input is a transcript excerpt that may contain
    // anything the agent was asked to read, so the model can be steered — #832
    // is the same shape one surface over.
    //
    // Refused outright rather than sanitized into something plausible: a label
    // we cannot explain is worse than the folder name, which is what stands.
    expect(cleanAiLabel('<function_calls>')).toBeNull();
    expect(cleanAiLabel('<script>alert(1)</script>')).toBeNull();
    expect(cleanAiLabel('{"tool":"bash"}')).toBeNull();
    expect(cleanAiLabel('[{"type":"tool_call"}]')).toBeNull();
    expect(cleanAiLabel('/etc/passwd')).toBeNull();
    expect(cleanAiLabel('#!/bin/sh')).toBeNull();
  });

  it('caps at the same length as a typed label', () => {
    // One row of a card header is one row whichever field is in it.
    expect(cleanAiLabel('x'.repeat(500))).toHaveLength(120);
  });

  it('answers null for nothing at all', () => {
    expect(cleanAiLabel(undefined)).toBeNull();
    expect(cleanAiLabel('')).toBeNull();
    expect(cleanAiLabel('   \n\t  ')).toBeNull();
    expect(cleanAiLabel('""')).toBeNull();
  });
});

describe('the last-writer rule (acceptAiLabel)', () => {
  it('lands a good label on a card that is still auto', () => {
    expect(acceptAiLabel(autoCard, 'Wire up the session bus', 'auto')).toBe(
      'Wire up the session bus'
    );
  });

  it('DISCARDS the result if the user typed while it was in flight', () => {
    // The guardrail most likely to fire in real use: a run takes ~14 seconds,
    // which is plenty of time to type. Their words win.
    const typedSince = { taskLabel: 'mine, thanks', labelSource: 'user' as const };
    expect(acceptAiLabel(typedSince, 'Wire up the session bus', 'auto')).toBeNull();
  });

  it('discards when the card was already the user\'s when the run began', () => {
    expect(acceptAiLabel(autoCard, 'Wire up the session bus', 'user')).toBeNull();
  });

  it('discards a label that did not survive cleaning', () => {
    expect(acceptAiLabel(autoCard, '<function_calls>', 'auto')).toBeNull();
  });

  it('de-dupes: an unchanged label is not a write', () => {
    // Same reason `nextAutoLabel` de-dupes — no persist, no render, no push.
    expect(acceptAiLabel({ taskLabel: 'Same label', labelSource: 'auto' }, 'Same label', 'auto'))
      .toBeNull();
  });

  it('lands a label that differs only after cleaning', () => {
    expect(acceptAiLabel({ taskLabel: 'Same label', labelSource: 'auto' }, '"Different label"\n', 'auto'))
      .toBe('Different label');
  });
});
