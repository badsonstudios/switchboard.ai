// Settings ▸ Attention ▸ Count on the app icon (#1605): on by default; off
// clears the badge at once.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { setAppBadge, useAppBadge } from '../../lib/app-badge';
import { SettingCheckbox, SettingItem } from './controls';

export function AppBadgeSection(): React.JSX.Element {
  const { t } = useTranslation();
  const on = useAppBadge();
  return (
    <SettingItem item="app-badge" label={t('appBadge.title')} unlabelled>
      <SettingCheckbox field="appBadge" checked={on} onChange={setAppBadge}>
        {t('appBadge.check')}
      </SettingCheckbox>
      <span style={{ fontSize: 11, color: 'var(--muted)', maxInlineSize: '46em' }}>{t('appBadge.note')}</span>
    </SettingItem>
  );
}
