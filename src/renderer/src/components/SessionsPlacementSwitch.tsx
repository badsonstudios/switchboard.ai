// The title bar's left / top switch for the sessions list (#1143).
//
// It replaces the `▤ rail` chip, which showed or hid the left rail and had
// nothing else to say. There are two places the list can be now, so the one
// chip became two halves of one control — and "hidden" is deliberately NOT a
// third half (the owner's call, 2026-10-08): the lit half is where the list is,
// clicking the lit half puts it away, and with it away neither half is lit.
// `lib/sessions-placement`'s `placementClick` is that rule; this file draws it.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { SESSIONS_PLACEMENTS, type SessionsPlacement } from '../lib/sessions-placement';

export function SessionsPlacementSwitch(props: {
  placement: SessionsPlacement;
  /** the list is put away (Ctrl+B, or a click on the lit half) */
  hidden: boolean;
  onClick: (clicked: SessionsPlacement) => void;
  /** the show / hide chord, spelled for this platform */
  binding: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <span
      // A group, not a radiogroup, for the reason `Chip` gives for
      // `aria-pressed`: a radio cannot be un-chosen, and the lit half here can —
      // that is how the list is hidden. Two toggle buttons say exactly that.
      role="group"
      aria-label={t('titlebar.placementLabel')}
      data-testid="sessions-placement"
      style={{ display: 'inline-flex', flexShrink: 0 }}
    >
      {SESSIONS_PLACEMENTS.map((p, i) => {
        const lit = !props.hidden && props.placement === p;
        const first = i === 0;
        const last = i === SESSIONS_PLACEMENTS.length - 1;
        // Three sentences, because the same half does three different things:
        // hide the list (lit), bring it back (hidden), or move it (the other).
        const hint = lit
          ? t(`titlebar.placementHide.${p}`, { binding: props.binding })
          : props.hidden
            ? t(`titlebar.placementShow.${p}`, { binding: props.binding })
            : t(`titlebar.placementMove.${p}`);
        return (
          <button
            key={p}
            type="button"
            data-placement={p}
            aria-pressed={lit}
            title={hint}
            onClick={() => props.onClick(p)}
            style={{
              background: lit ? 'var(--chip)' : 'transparent',
              color: lit ? 'var(--text)' : 'var(--muted)',
              border: '1px solid var(--border)',
              // the halves share their middle edge rather than doubling it
              borderInlineStartWidth: first ? 1 : 0,
              borderStartStartRadius: first ? 'var(--radius-chip)' : 0,
              borderEndStartRadius: first ? 'var(--radius-chip)' : 0,
              borderStartEndRadius: last ? 'var(--radius-chip)' : 0,
              borderEndEndRadius: last ? 'var(--radius-chip)' : 0,
              padding: '2px 8px',
              cursor: 'pointer',
              fontFamily: 'var(--font-ui)',
              fontSize: 11,
              whiteSpace: 'nowrap',
            }}
          >
            {t(`titlebar.placement.${p}`)}
          </button>
        );
      })}
    </span>
  );
}
