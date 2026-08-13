// P2-E7-06: who owns a task label, and what the CLI's title may do to it.
//
// The four rules under test are Dan's, decided 2026-07-30 (§5.11). They are
// tested here rather than only through the IPC handler because they are
// DECISIONS — "typing pins it forever" is a claim about a rule, and a rule you
// can call is the only kind you can prove.
import { describe, it, expect } from 'vitest';
import { labelSourceOf, nextAutoLabel, typedLabel, visibleTaskLabel } from './auto-label';
import { REVISED, titlesOf } from '../transcripts/fixtures/ai-title';

/** The two real titles the CLI produced for one conversation, in order. */
const [FIRST, SETTLED] = titlesOf(REVISED);

describe('who owns the label (labelSourceOf)', () => {
  it('takes the stored answer when there is one', () => {
    expect(labelSourceOf({ taskLabel: 'x', labelSource: 'user' })).toBe('user');
    expect(labelSourceOf({ taskLabel: 'x', labelSource: 'auto' })).toBe('auto');
  });

  it('treats a pre-E7-06 card with a label as the USER’s', () => {
    // E7-03 shipped the typed label with no `labelSource` at all. Guessing
    // 'auto' here would let the first `ai-title` overwrite a label the user
    // typed weeks ago — a silent data loss on upgrade.
    expect(labelSourceOf({ taskLabel: 'refactor the parser' })).toBe('user');
  });

  it('treats a blank one as nobody’s, so auto may take it', () => {
    expect(labelSourceOf({})).toBe('auto');
    expect(labelSourceOf({ taskLabel: '' })).toBe('auto');
    expect(labelSourceOf({ taskLabel: '   ' })).toBe('auto');
  });

  it('falls back on the same rule for a junk value in a hand-edited file', () => {
    const junk = { taskLabel: 'mine', labelSource: 42 } as unknown as { taskLabel: string };
    expect(labelSourceOf(junk)).toBe('user');
    expect(labelSourceOf({ labelSource: 'whatever' } as unknown as { taskLabel?: string })).toBe('auto');
  });
});

describe('what a new title does (nextAutoLabel)', () => {
  it('fills a blank label', () => {
    expect(nextAutoLabel({}, SETTLED, true)).toBe(SETTLED);
  });

  it('keeps tracking while on auto — the CLI revises', () => {
    // Observed one line apart in a real transcript.
    expect(nextAutoLabel({ taskLabel: FIRST, labelSource: 'auto' }, SETTLED, true)).toBe(SETTLED);
  });

  it('never touches a label the user typed', () => {
    expect(nextAutoLabel({ taskLabel: 'mine', labelSource: 'user' }, SETTLED, true)).toBeNull();
    // ...including the pre-E7-06 card with no source recorded
    expect(nextAutoLabel({ taskLabel: 'mine' }, SETTLED, true)).toBeNull();
  });

  it('says nothing when the title has not moved — the de-dupe', () => {
    expect(nextAutoLabel({ taskLabel: SETTLED, labelSource: 'auto' }, SETTLED, true)).toBeNull();
  });

  it('no title means no label; the folder name stands', () => {
    expect(nextAutoLabel({}, undefined, true)).toBeNull();
    expect(nextAutoLabel({}, '', true)).toBeNull();
    expect(nextAutoLabel({}, '   ', true)).toBeNull();
  });

  it('does nothing at all while auto labels are switched off', () => {
    expect(nextAutoLabel({}, SETTLED, false)).toBeNull();
  });

  it('trims and caps what it stores', () => {
    expect(nextAutoLabel({}, `  ${SETTLED}  `, true)).toBe(SETTLED);
    expect(nextAutoLabel({}, 'x'.repeat(500), true)).toHaveLength(120);
  });
});

describe('typing pins it, clearing hands it back (typedLabel)', () => {
  it('makes a typed label the user’s', () => {
    expect(typedLabel('  wire up the parser ')).toEqual({
      taskLabel: 'wire up the parser',
      labelSource: 'user',
    });
  });

  it('CLEARS to auto, with the text explicitly gone', () => {
    // `taskLabel` must be PRESENT and undefined: callers spread this over the
    // card, and a missing key keeps the old text — leaving a visible label that
    // auto is now free to overwrite.
    const cleared = typedLabel('   ');
    expect(cleared.labelSource).toBe('auto');
    expect(cleared.taskLabel).toBeUndefined();
    expect('taskLabel' in cleared).toBe(true);
  });

  it('a cleared card is immediately auto-fillable again', () => {
    expect(nextAutoLabel(typedLabel(''), SETTLED, true)).toBe(SETTLED);
  });

  it('caps a typed label like a card title', () => {
    expect(typedLabel('y'.repeat(500)).taskLabel).toHaveLength(120);
  });
});

describe('the screen-share switch (visibleTaskLabel)', () => {
  it('hides an auto label when the switch is off', () => {
    expect(visibleTaskLabel({ taskLabel: SETTLED, labelSource: 'auto' }, false)).toBeUndefined();
  });

  it('never hides a label the user typed', () => {
    // The switch is about phrases derived from the prompt. What the user chose
    // to write is theirs, and hiding it would be the app editing their words.
    expect(visibleTaskLabel({ taskLabel: 'mine', labelSource: 'user' }, false)).toBe('mine');
  });

  it('shows everything while it is on', () => {
    expect(visibleTaskLabel({ taskLabel: SETTLED, labelSource: 'auto' }, true)).toBe(SETTLED);
  });

  it('keeps the stored value, so flipping it back is lossless', () => {
    const card = { taskLabel: SETTLED, labelSource: 'auto' as const };
    visibleTaskLabel(card, false);
    expect(card.taskLabel).toBe(SETTLED);
  });
});
