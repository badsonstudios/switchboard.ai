// @vitest-environment jsdom
// P2-E22-01 (#972) — what the card SAYS about the diff above it.
//
// ⚠️ WHY THIS FILE EXISTS AT ALL, and it is a coverage hole found in review: the
// done-when is "where a genuinely huge payload must still be bounded, the card
// STATES what it is withholding" — #953's rule that a user must never be silently
// shown less than they are signing for. `lib/approval-diff.test.ts` asserts the
// `withheld` OBJECT, which is the arithmetic. Nothing asserted the SENTENCE. And
// nothing could, through a render: Monaco does not run in jsdom, so a component test
// of `ApprovalDiffView` cannot mount, and the e2e would need a 400,000-character
// permission to reach the branch.
//
// So the two pure functions that build those strings are exported and tested here,
// directly. A claim whose only evidence was a comment now has a test.
import { describe, expect, it, beforeAll } from 'vitest';
import { initI18nForTests } from '../i18n/test-i18n';
import i18next from 'i18next';
import { approvalDiff, MAX_SIDE_CHARS } from '../lib/approval-diff';
import { caption, withheldText } from './ApprovalDiffView';

/** the real translator, not a stub: the plural forms are half of what is asserted */
const t = (key: string, vars?: Record<string, unknown>): string => i18next.t(key, vars ?? {});

beforeAll(async () => {
  await initI18nForTests();
});

describe('the caption says what the diff is OF', () => {
  it('calls an Edit a proposed change, and claims nothing about the file', () => {
    expect(caption(t, approvalDiff({ old_string: 'a', new_string: 'b' })!)).toBe('Proposed change');
  });

  it('counts a Write in LINES, not in changes', () => {
    // "1 change" was the first version and it was wrong in the most misleading
    // direction: a `Write` replaces a file wholesale, so the interesting number is
    // how much is going in, not how many operations that is.
    const d = approvalDiff({ content: ['one', 'two', 'three', ''].join('\n') })!;
    expect(caption(t, d)).toBe('New contents — 3 lines');
  });

  it('says "1 line" rather than "1 lines" for a one-line Write', () => {
    expect(caption(t, approvalDiff({ content: 'just this' })!)).toBe('New contents — 1 line');
  });

  it('says a MultiEdit is several changes AND that the order means something', () => {
    const d = approvalDiff({
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    })!;
    // The "in the order they apply" half is the point: without it the reader has no
    // reason to believe the sequence on screen is the sequence on disk.
    expect(caption(t, d)).toBe('2 changes, in the order they apply');
  });

  it('counts the REAL total, including changes the cap did not draw', () => {
    // 47 changes, 40 hunks: the caption still says 47, because the size of what is
    // being approved is not the same as the size of what fitted.
    const d = approvalDiff({
      edits: Array.from({ length: 47 }, (_, i) => ({
        old_string: `o${i}`,
        new_string: `n${i}`,
      })),
    })!;
    expect(caption(t, d)).toBe('47 changes, in the order they apply');
  });
});

describe('and the card NAMES what it withheld (#953)', () => {
  it('reports whole changes it never drew', () => {
    expect(withheldText(t, { lines: 0, chars: 0, changes: 7 })).toBe(
      'Not shown here: 7 changes'
    );
  });

  // The thousands separators below are the i18n layer's, and are worth asserting
  // rather than working around: a number on this line is read by someone deciding
  // whether to sign, and `9000` reads as smaller than `9,000` at a glance.
  it('reports lines AND characters together, because the pair is the information', () => {
    // ⚠️ `chars` USED TO SIT BEHIND AN `else if` AND WAS DEAD (found in review), and
    // the first attempt to fix it was wrong too: there is no payload that reports
    // characters and no lines, because `lineCount`'s human rule makes any non-empty
    // remainder at least one line. So both are reported. "1 line" alone understates
    // a minified file catastrophically; the character count beside it does not.
    expect(withheldText(t, { lines: 412, chars: 9000, changes: 0 })).toBe(
      'Not shown here: 412 lines, 9,000 characters'
    );
  });

  it('puts CHANGES first, because it prompts a different action', () => {
    // A reader told "3 changes are not shown" knows to ask for the rest; one told
    // "412 lines" knows the change in front of them is a fragment. Different moves,
    // so the bigger unit leads.
    expect(withheldText(t, { lines: 412, chars: 9000, changes: 3 })).toBe(
      'Not shown here: 3 changes, 412 lines, 9,000 characters'
    );
  });

  it('is honest about a MINIFIED file, which is the case lines alone cannot describe', () => {
    const d = approvalDiff({ content: 'z'.repeat(MAX_SIDE_CHARS + 500) })!;
    // One line, and 500 characters of it missing. Reporting only the line count here
    // would say "1 line" about a bound that cut half a megabyte.
    expect(d.withheld).toEqual({ lines: 1, chars: 500, changes: 0 });
    expect(withheldText(t, d.withheld!)).toBe('Not shown here: 1 line, 500 characters');
  });

  it('singularises, because this is the line that has to be trusted', () => {
    expect(withheldText(t, { lines: 1, chars: 1, changes: 1 })).toBe(
      'Not shown here: 1 change, 1 line, 1 character'
    );
  });
});
