// Settings ▸ Appearance ▸ Group colours (#1599): draw the groups you made in
// their own colours, or all in the theme's neutral ink. The choice lives in the
// renderer's group-colours store; the list behind the dialog changes at once,
// and no group's colour is changed by it.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { setGroupColours, useGroupColours } from '../../lib/group-colours';
import { SettingCheckbox, SettingItem } from './controls';

export function GroupColoursSection(): React.JSX.Element {
  const { t } = useTranslation();
  const on = useGroupColours();
  return (
    <SettingItem item="group-colours" label={t('groupColours.title')} unlabelled>
      <SettingCheckbox field="groupColours" checked={on} onChange={setGroupColours}>
        {t('groupColours.label')}
      </SettingCheckbox>
      <span data-group-colours-hint style={{ fontSize: 11, color: 'var(--muted)', maxInlineSize: '46em' }}>
        {on ? t('groupColours.onNote') : t('groupColours.offNote')}
      </span>
    </SettingItem>
  );
}
