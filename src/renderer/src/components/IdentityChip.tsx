// Identity chip (P1-E3-03, §5.11) — the MARK+NAME composition a session's tab
// draws. NOT "the one way a session's identity renders": that claim was false
// on the surface it named, and #337 is it being withdrawn rather than enforced.
//
// WHAT THIS FILE IS, EXACTLY:
//
//   • `IdentityChip` — one composition of §5.11's identity, with exactly one
//     consumer today: the card's dockview tab (SessionGrid's `IdentityTab`,
//     wired by #312).
//   • `identityWash` — the accent wash the open tab and its card header share
//     (#905), the one colour formula both paint through.
//
// There was a third piece until #1433: the project-type badge ("TS", or a boxed
// "·" for a folder nothing was detected in) after the name, and its look,
// `identityBadgeStyle`. The owner had it removed outright (2026-10-23) — it told
// him nothing and the "·" read as a glitch — so the name is the last thing in
// the chip and nothing trails it.
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
// tint." A chip in a rail row is a mark in front of the name — the thing that
// sentence forbids and the indent it exists to prevent. So the
// rail renders the SAME identity (same accent, same title, same fallback) in a
// different SHAPE, on purpose. §5.11 asks an identity to be recognisable on
// every surface, not to be the same widget on every surface.
//
// KNOWN DIVERGENCE, reported not silently patched: §5.11's accent bullet still
// says the accent is "applied to card border, sidebar DOT, feed entries, toast
// edge". The rail has drawn an edge bar rather than a dot since its 2026-07-26
// redesign, and the handoff quoted above is the later and more specific
// artifact — but only Dan can amend §5.11, so the wording is flagged on #337's
// PR instead of edited here.
import React from 'react';

/**
 * The identity WASH (#905) — the open tab and its card header, washed in the
 * session's accent so the tab visibly joins the card under it. One definition,
 * two render sites: two copies of a colour formula are one edit away from being
 * two identities.
 *
 * The strength is `--identity-wash` in tokens.css, where the contrast budget it
 * spends is written down and measured. NO ACCENT is `--panel`: plain, and the
 * same surface an accent-less open tab (a document, a Changes tab) paints.
 */
export function identityWash(accent?: string): string {
  return accent
    ? `color-mix(in srgb, ${accent} var(--identity-wash), var(--panel2))`
    : 'var(--panel)';
}

export function IdentityChip(props: {
  title: string;
  accent?: string;
  compact?: boolean;
  /**
   * What stands where the accent dot does (#1293): a session's tab passes the
   * AI's icon in its status ring (`AiBadge`), which the owner chose to REPLACE
   * the dot. A tab with no session (a document, a Changes tab) passes nothing
   * and keeps the dot, since it has no AI and no status.
   */
  mark?: React.ReactNode;
}): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minInlineSize: 0 }}>
      {props.mark ?? (
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
      )}
      {/* colour and weight are INHERITED (#905): the tab strip says which tab
          is open — `--text` and bold for the focused group's, `--muted` for the
          rest — and a fixed ink here would overrule it. `data-title` feeds
          `.identity-chip-title::after` in dockview-tokens.css, which reserves
          the BOLD width so opening a tab does not shove its neighbours. */}
      <span
        className="identity-chip-title"
        data-title={props.title}
        style={{
          display: 'inline-block',
          fontSize: props.compact ? 11 : 12,
          fontWeight: 'inherit',
          color: 'inherit',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {props.title}
      </span>
    </span>
  );
}
