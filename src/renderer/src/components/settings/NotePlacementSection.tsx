// Where a session's sticky note sits (#1544 part 2): Settings ▸ Appearance.
//
// Four placements, one choice for every card, default "above the prompt". The
// choice lives in the renderer's note store (it is purely how the window
// draws), stored in the ui blob, so this section reads and writes the store
// directly instead of threading a prop through App.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { NOTE_PLACEMENTS, setNotePlacement, useNotePlacement, type NotePlacement } from '../../lib/session-notes';
import { SettingItem } from './controls';

export function NotePlacementSection(): React.JSX.Element {
  const { t } = useTranslation();
  const placement = useNotePlacement();
  // the id prefix, for the reason TaskLabelSizeSection gives (#654)
  const fieldId = React.useId();
  const option = (p: NotePlacement): React.JSX.Element => (
    <label
      key={p}
      htmlFor={`${fieldId}n-${p}`}
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: '2px 8px',
        alignItems: 'start',
        cursor: 'pointer',
      }}
    >
      <input
        id={`${fieldId}n-${p}`}
        data-note-placement-option={p}
        type="radio"
        name={`${fieldId}placement`}
        checked={placement === p}
        onChange={() => setNotePlacement(p)}
        style={{ marginBlockStart: 2 }}
      />
      <span style={{ fontSize: 11.5 }}>{t(`notePlacement.${p}`)}</span>
      <span />
      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t(`notePlacement.${p}Note`)}</span>
    </label>
  );
  return (
    <SettingItem item="note-placement" label={t('notePlacement.title')} blurb={t('notePlacement.blurb')}>
      <div
        data-settings-block="note-placement"
        role="radiogroup"
        aria-label={t('notePlacement.title')}
        style={{ display: 'grid', gap: 12 }}
      >
        {NOTE_PLACEMENTS.map(option)}
      </div>
    </SettingItem>
  );
}
