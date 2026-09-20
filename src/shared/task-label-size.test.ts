// #877 — the task-label size vocabulary. Small, but it is the thing that stops
// two surfaces disagreeing about what "full" means, so the mapping is pinned.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TASK_LABEL_SIZE,
  LABEL_LINES,
  TASK_LABEL_SIZES,
  isTaskLabelSize,
  labelLinesOf,
  taskLabelSizeOf,
} from './task-label-size';

describe('the sizes we offer', () => {
  it('is exactly three, largest first', () => {
    // The dialog renders this order, so it is part of the contract rather than
    // an accident of declaration.
    expect([...TASK_LABEL_SIZES]).toEqual(['full', 'medium', 'compact']);
  });

  it('defaults to full — the owner asked for the space filled', () => {
    expect(DEFAULT_TASK_LABEL_SIZE).toBe('full');
  });

  it('maps each size to a line count, and only here', () => {
    // ⚠️ THE WHOLE REASON THIS MODULE EXISTS. Both the rail row and the card
    // header clamp with this table; if either held its own number, "full" could
    // mean three lines in one place and two in the other.
    expect(LABEL_LINES).toEqual({ full: 3, medium: 2, compact: 1 });
  });

  it("compact is exactly today's behaviour", () => {
    // One line, ellipsised — so anyone who preferred the rail before #877 keeps
    // it by choosing this, rather than being told the new layout is better.
    expect(LABEL_LINES.compact).toBe(1);
  });
});

describe('reading an untrusted value', () => {
  it('accepts the real sizes and nothing else', () => {
    for (const s of TASK_LABEL_SIZES) expect(isTaskLabelSize(s)).toBe(true);
    for (const junk of ['FULL', 'large', '', 3, null, undefined, {}, ['full']]) {
      expect(isTaskLabelSize(junk), `${JSON.stringify(junk)}`).toBe(false);
    }
  });

  it('falls back to the default, never to the smallest', () => {
    // Fail-open toward showing MORE. A corrupt file collapsing to `compact`
    // would look like a deliberate preference for terse labels, which is a
    // setting nobody chose being presented as one they did.
    expect(taskLabelSizeOf(undefined)).toBe('full');
    expect(taskLabelSizeOf('nonsense')).toBe('full');
    expect(taskLabelSizeOf(null)).toBe('full');
    expect(taskLabelSizeOf('medium')).toBe('medium');
  });

  it('gives a line count for anything, so a renderer never has to guard', () => {
    expect(labelLinesOf('full')).toBe(3);
    expect(labelLinesOf('medium')).toBe(2);
    expect(labelLinesOf('compact')).toBe(1);
    expect(labelLinesOf('junk')).toBe(3); // the default's line count
    expect(labelLinesOf(undefined)).toBe(3);
  });
});
