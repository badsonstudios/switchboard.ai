// Identity chip (P1-E3-03, §5.11): the ONE way a session's identity renders —
// used verbatim in the rail rows and the card tab header so seven sessions
// read identically everywhere. Accent survives theme switches by design.
import React from 'react';

/**
 * The identity BADGE's look — one definition, two render sites (#269).
 *
 * §5.11 says an identity renders identically everywhere it appears, and the lang
 * badge had drifted into two different looks: this chip wrote `--muted` on
 * `--chip` (4.10:1 on nordic — under AA), while the card header in SessionGrid
 * wrote the session's ACCENT as 9px text (3.39:1 on nordic at its worst, and
 * 1.80-3.11:1 on daylight for all eight accents). Both are the same defect seen
 * from two sides: a colour chosen to be DISTINGUISHABLE is not a colour tuned to
 * be READ, and the accent palette has no ink family to swap in.
 *
 * Dan's call (2026-08-10, DESIGN.md §5.11): the accent becomes the badge's
 * FIELD and the ink is neutral. That keeps the identity signal — it is the same
 * hue, and a filled tag is a stronger one at 9px than coloured letters — while
 * the thing you actually read is a fixed dark ink measured against every accent
 * in the palette (4.57-7.90:1, theme-independent because neither colour moves
 * with the theme).
 *
 * The border stays: on a light theme an accent field can be 1.8:1 against the
 * header behind it, so without an edge the badge loses its shape even though its
 * text is legible.
 *
 * NO ACCENT is not "paint it anyway" — a card whose record has not been read yet
 * has none, and a dark ink on nothing is invisible. It falls back to the neutral
 * chip that a chip-shaped thing wears everywhere else, with `--text` rather than
 * the `--muted` this used to use: 8.4:1 on nordic against the 4.10:1 it replaces.
 */
export function identityBadgeStyle(accent?: string): React.CSSProperties {
  // read out into locals so neither is a conditional inside `color:` — the
  // source scan in tokens.drift.test.ts reads that declaration's text and an
  // accent named there is the bug it now fails on
  const field = accent ?? 'var(--chip)';
  const ink = accent ? 'var(--accent-ink-on-fill)' : 'var(--text)';
  return {
    fontFamily: 'var(--font-mono)',
    fontSize: 9,
    fontWeight: 700,
    color: ink,
    background: field,
    border: '1px solid var(--border)',
    borderRadius: 4,
    paddingInline: 4,
    paddingBlock: 1,
    flexShrink: 0,
  };
}

export function IdentityChip(props: {
  title: string;
  accent?: string;
  badge?: string;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minInlineSize: 0 }}>
      <span
        aria-hidden
        style={{
          inlineSize: 8,
          blockSize: 8,
          borderRadius: '50%',
          background: props.accent ?? 'var(--faint)',
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: props.compact ? 11 : 12,
          fontWeight: 600,
          color: 'var(--text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {props.title}
      </span>
      {props.badge && (
        <span data-testid="identity-badge" style={identityBadgeStyle(props.accent)}>
          {props.badge}
        </span>
      )}
    </span>
  );
}
