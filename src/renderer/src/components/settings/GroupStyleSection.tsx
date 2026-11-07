// Settings ▸ Appearance ▸ Group style (#1556): how groups look in the Sessions
// list. Lists only the styles that are built (`AVAILABLE_GROUP_STYLES`), each
// with the number the mockup gave it, so "option 4" means the same thing here
// as in the ticket. The choice lives in the renderer's group-style store, and
// the list behind the dialog changes the moment one is picked.
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  AVAILABLE_GROUP_STYLES,
  groupStyleNumber,
  setGroupStyle,
  useGroupStyle,
  type GroupStyle,
} from '../../lib/group-style';
import { SettingItem } from './controls';

export function GroupStyleSection(): React.JSX.Element {
  const { t } = useTranslation();
  const style = useGroupStyle();
  // the id prefix, for the reason TaskLabelSizeSection gives (#654)
  const fieldId = React.useId();
  const option = (s: GroupStyle): React.JSX.Element => {
    const n = groupStyleNumber(s);
    const name = t(`groupStyle.${s}`);
    return (
      <label
        key={s}
        htmlFor={`${fieldId}g-${s}`}
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '2px 8px',
          alignItems: 'start',
          cursor: 'pointer',
        }}
      >
        <input
          id={`${fieldId}g-${s}`}
          data-group-style-option={s}
          type="radio"
          name={`${fieldId}style`}
          checked={style === s}
          onChange={() => setGroupStyle(s)}
          style={{ marginBlockStart: 2 }}
        />
        <span style={{ fontSize: 11.5 }}>
          {n === undefined ? name : t('groupStyle.numbered', { number: n, name })}
        </span>
        <span />
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t(`groupStyle.${s}Note`)}</span>
      </label>
    );
  };
  return (
    <SettingItem item="group-style" label={t('groupStyle.title')} blurb={t('groupStyle.blurb')}>
      <div
        data-settings-block="group-style"
        role="radiogroup"
        aria-label={t('groupStyle.title')}
        style={{ display: 'grid', gap: 12 }}
      >
        {AVAILABLE_GROUP_STYLES.map(option)}
      </div>
    </SettingItem>
  );
}
