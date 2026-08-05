// The session card's status pill (§5.8) — the state in words, on every card
// header, permanently.
//
// Its own file because it is the half of a contrast promise that lives in a
// component: tokens.css owns the look and tokens.drift.test.ts computes the
// ratio the rule paints, but WHICH hue and ink the rule receives is decided
// here, and a promise whose second half nothing reads is not a promise. Pulling
// it out of SessionGrid's 2,400 lines is what lets StatusPill.test.tsx mount it
// and check the pair for every position of the ramp.
import React from 'react';
import { presentStatus, statusVars } from '../lib/rail-view';

/**
 * Two things used to be wrong here and both are #221.
 *
 * It painted the word in the RAW status hue over a 14% tint of that same hue —
 * 1.7-2.6:1 on daylight at 9.5px, on the surface that is always on screen — so
 * the word is now in that status's INK, and the ratio is asserted in every
 * shipped theme. And it carried a private colour table that had drifted from
 * the rail it claimed to mirror: `starting` read as idle here and as working
 * there, and `suspended` had a hue no ink token exists for, which is why the
 * fix could not simply swap one token for another. presentStatus is the one
 * vocabulary — the same call the rail rows, the urgency lamps and the collapsed
 * rows make, so a session's state cannot look like two different states in two
 * places.
 *
 * The look is in tokens.css; only the two values a stylesheet cannot know
 * statically come from here.
 */
export function StatusPill(props: { status?: string; label: string }): React.JSX.Element {
  const { token } = presentStatus(props.status);
  const v = statusVars(token);
  return (
    <span
      className="status-pill"
      // one attribute per independent fact, as the lamps and the collapsed rows
      // do it — the ramp position is what the CSS and any assertion key off
      data-status={token}
      style={{ '--pill-hue': v.hue, '--pill-ink': v.ink } as React.CSSProperties}
    >
      {props.label}
    </span>
  );
}
