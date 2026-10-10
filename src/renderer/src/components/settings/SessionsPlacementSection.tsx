// Sessions list (#1143) — where your open sessions are listed.
//
// One of three doors to the same choice (the title bar's left / top switch and,
// later, a right-click on the strip are the others). This is the one with room
// to SHOW the two arrangements, so it draws them: a setting whose two values
// are shapes is answered faster by two shapes than by two sentences.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { SESSIONS_PLACEMENTS, type SessionsPlacement } from '../../lib/sessions-placement';
import { tint } from '../../lib/tint';
import { SettingItem } from './controls';

export interface SessionsPlacementSectionProps {
  placement: SessionsPlacement;
  onSet: (placement: SessionsPlacement) => void;
}

/** the little picture of a window with the list shaded in — decoration; the
 *  option's own words say the same thing */
function Picture(props: { placement: SessionsPlacement; chosen: boolean }): React.JSX.Element {
  const fill = props.chosen ? tint('var(--status-working)', 55) : tint('var(--muted)', 35);
  return (
    <span
      aria-hidden
      style={{
        display: 'flex',
        flexDirection: props.placement === 'left' ? 'row' : 'column',
        inlineSize: 96,
        blockSize: 54,
        borderRadius: 4,
        border: '1px solid var(--border)',
        background: 'var(--bg)',
        overflow: 'hidden',
      }}
    >
      <span
        style={
          props.placement === 'left'
            ? { inlineSize: 24, background: fill }
            : { blockSize: 12, background: fill }
        }
      />
    </span>
  );
}

export function SessionsPlacementSection(
  props: SessionsPlacementSectionProps
): React.JSX.Element {
  const { t } = useTranslation();
  // #654, as in TaskLabelSizeSection: ids are generated, never published
  const fieldId = React.useId();

  // No Save button, for TaskLabelSizeSection's reason: one control, a closed
  // set, and the effect is visible behind the modal the instant it is picked.
  const option = (placement: SessionsPlacement): React.JSX.Element => {
    const chosen = props.placement === placement;
    return (
      <label
        key={placement}
        htmlFor={`${fieldId}p-${placement}`}
        style={{
          display: 'grid',
          // the two notes are different lengths; without this the shorter
          // card's rows spread out and its radio sits lower than its neighbour's
          alignContent: 'start',
          gap: 6,
          padding: 8,
          borderRadius: 6,
          border: `1px solid ${chosen ? 'var(--status-working-ink)' : 'var(--border)'}`,
          cursor: 'pointer',
        }}
      >
        <Picture placement={placement} chosen={chosen} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            id={`${fieldId}p-${placement}`}
            data-sessions-placement={placement}
            type="radio"
            name={`${fieldId}placement`}
            checked={chosen}
            // the note is a DESCRIPTION: left inside the label alone it becomes
            // part of the radio's name, and the top one is three sentences
            aria-labelledby={`${fieldId}n-${placement}`}
            aria-describedby={`${fieldId}d-${placement}`}
            onChange={() => props.onSet(placement)}
            style={{ margin: 0 }}
          />
          <span id={`${fieldId}n-${placement}`} style={{ fontSize: 11.5 }}>
            {t(`sessionsPlacement.${placement}`)}
          </span>
        </span>
        <span id={`${fieldId}d-${placement}`} style={{ fontSize: 11, color: 'var(--muted)' }}>
          {t(`sessionsPlacement.${placement}Note`)}
        </span>
      </label>
    );
  };

  return (
    <SettingItem
      item="sessions-placement"
      label={t('sessionsPlacement.title')}
      blurb={t('sessionsPlacement.blurb')}
    >
      <div
        data-settings-block="sessions-placement"
        role="radiogroup"
        aria-label={t('sessionsPlacement.title')}
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}
      >
        {SESSIONS_PLACEMENTS.map(option)}
      </div>
    </SettingItem>
  );
}
