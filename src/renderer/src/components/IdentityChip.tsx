// Identity chip (P1-E3-03, §5.11) — the DOT+NAME+BADGE composition, and the
// home of the badge's look. NOT "the one way a session's identity renders":
// that claim was false on the surface it named, and #337 is it being withdrawn
// rather than enforced.
//
// WHAT THIS FILE IS, EXACTLY:
//
//   • `IdentityChip` — one composition of §5.11's identity, with exactly one
//     consumer today: the card's dockview tab (SessionGrid's `IdentityTab`,
//     wired by #312).
//   • `identityBadgeStyle` — the badge's LOOK, and the piece that genuinely IS
//     shared: the chip and the card HEADER both paint through it, which is what
//     #269 made true and what §5.11's "renders identically everywhere" buys on
//     this surface. Add a third badge site and it paints through here too.
//
// ── WHY THE RAIL DOES NOT USE THIS, AND WHY THAT IS NOT A BUG (#337) ────────
//
// The header used to claim the chip was "used verbatim in the rail rows"; that
// was corrected to "the rail hand-rolls its own row (#337 is the held issue for
// folding it back in)", which still framed the rail as the surface that had not
// caught up yet. It is not. The rail's appearance is a separately APPROVED,
// high-fidelity design (`design_handoff_sessions_rail/README.md`, "The chosen
// direction: no session icon"), and it rules this composition out in as many
// words:
//
//   "Sessions deliberately have no icon or avatar. Earlier rounds tried folder
//    icons, language glyphs, monograms, provider marks, geometric shapes,
//    channel numbers and identicons; all were rejected as noise. The colored
//    left edge bar IS the identity mark, which means every session name starts
//    at one flush left margin and the name itself becomes the thing you scan.
//    Do not reintroduce a per-session icon."
//
// ...and, of the accents: "Used only for the left edge bar and the selected-row
// tint." A chip in a rail row is a dot plus a badge in front of the name — the
// two things that sentence forbids and the indent it exists to prevent. So the
// rail renders the SAME identity (same accent, same title, same fallback) in a
// different SHAPE, on purpose. §5.11 asks an identity to be recognisable on
// every surface, not to be the same widget on every surface; the promise that
// has to hold literally is the one about a single badge look, and that one is
// `identityBadgeStyle` and is enforced by tests.
//
// KNOWN DIVERGENCE, reported not silently patched: §5.11's accent bullet still
// says the accent is "applied to card border, sidebar DOT, feed entries, toast
// edge". The rail has drawn an edge bar rather than a dot since its 2026-07-26
// redesign, and the handoff quoted above is the later and more specific
// artifact — but only Dan can amend §5.11, so the wording is flagged on #337's
// PR instead of edited here.
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
 * The border is the card header's existing edge, kept and extended to the tab so
 * the two are one shape. Measured, and NOT the "it carries the outline on light
 * themes" story it is easy to tell: on the three dark presets it is a real edge
 * (nordic `--border` #3b4252 against an amber field, 5.17:1), but on daylight
 * `--border` #dde1e7 is 1.48:1 against that field and 1.21:1 against the header,
 * i.e. a SOFTER step than the 1.80-3.11:1 the field already makes on its own. So
 * on daylight the field carries the shape and this line is neutral-to-slightly-
 * softening. It stays because it is what the header already drew and because
 * removing an edge is a look change nobody asked for — not because it is doing
 * the accessibility work. What does that work is the ink, below.
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
