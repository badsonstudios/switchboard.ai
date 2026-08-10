// The §5.11 identity badge's colours (#269).
//
// `tokens.drift.test.ts` owns the NUMBERS — that the neutral ink clears 4.5:1 on
// every accent in the palette, in every theme. What it cannot see is which of
// the two colours the component hands to which property: it reads `color: ink`
// and has no way to know what `ink` holds, and that indirection is deliberate
// (a ternary spelled inside the declaration would read as an offender to its
// accent scan). So this is the other half of the promise, and it is the half
// that would have caught the original bug: the card header wrote the accent as
// the `color` and left the field alone.
//
// Asserted on the style object rather than through a render, because that object
// is the shared thing — both render sites take it verbatim, and a test that
// mounted one of them would be testing that site instead of the rule.
import { describe, it, expect } from 'vitest';
import { identityBadgeStyle } from './IdentityChip';

const ACCENT = 'var(--accent-pink)';

describe('the identity badge (issue 269)', () => {
  it('paints the accent as the FIELD, never as the ink', () => {
    const s = identityBadgeStyle(ACCENT);
    expect(s.background).toBe(ACCENT);
    expect(String(s.color)).not.toContain('accent-pink');
  });

  it('writes the one ink measured against the accent palette', () => {
    // named, not just "not the accent": `--muted` and `--text` are both
    // plausible-looking neutrals and neither is measured against a field
    expect(identityBadgeStyle(ACCENT).color).toBe('var(--accent-ink-on-fill)');
  });

  it('falls back to a neutral chip when the card has no accent yet', () => {
    // a dark on-field ink over nothing is invisible — the badge has to become a
    // different object, not the same one missing its fill
    const s = identityBadgeStyle(undefined);
    expect(s.background).toBe('var(--chip)');
    expect(s.color).toBe('var(--text)');
  });

  it('keeps an edge, so a field at 1.8:1 on a light theme still has a shape', () => {
    expect(identityBadgeStyle(ACCENT).border).toContain('var(--border)');
    expect(identityBadgeStyle(undefined).border).toContain('var(--border)');
  });

  it('is ONE look — the accent changes the colours and nothing else (§5.11)', () => {
    // the two render sites had drifted into two different badges; this is what
    // stops the next edit re-splitting them by adding a shape to one branch
    const shape = (s: ReturnType<typeof identityBadgeStyle>): unknown[] => [
      s.fontFamily,
      s.fontSize,
      s.fontWeight,
      s.border,
      s.borderRadius,
      s.paddingInline,
      s.paddingBlock,
    ];
    expect(shape(identityBadgeStyle(ACCENT))).toEqual(shape(identityBadgeStyle(undefined)));
  });
});
