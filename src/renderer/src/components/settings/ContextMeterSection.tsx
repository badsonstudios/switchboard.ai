// Settings ▸ Appearance ▸ Context meter (#715): the number, a bar, or both.
//
// Each choice carries a small sample drawn with the meter's own classes, under
// the form it stands for, so what you pick is what you get under the prompt
// box. Each sample is a COMFORTABLE window (38%), because that is the only
// state in which the three forms differ: from 60% the bar-only form shows
// its number too, and two of the samples would be the same picture.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { CONTEXT_METER_FORMS, type ContextMeterForm } from '../../lib/context-meter';
import { SettingItem } from './controls';

export interface ContextMeterSectionProps {
  form: ContextMeterForm;
  onSet: (form: ContextMeterForm) => void;
}

const SAMPLE_PERCENT = 38;

export function ContextMeterSection(props: ContextMeterSectionProps): React.JSX.Element {
  const { t } = useTranslation();
  const fieldId = React.useId();
  return (
    <SettingItem item="context-meter" label={t('contextMeter.setting')} blurb={t('contextMeter.settingBlurb')}>
      <div role="radiogroup" aria-label={t('contextMeter.setting')} style={{ display: 'grid', gap: 6 }}>
        {CONTEXT_METER_FORMS.map((form) => (
          <label
            key={form}
            htmlFor={`${fieldId}-${form}`}
            style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 11.5 }}
          >
            <input
              id={`${fieldId}-${form}`}
              data-context-meter-choice={form}
              type="radio"
              name={`${fieldId}-form`}
              checked={props.form === form}
              onChange={() => props.onSet(form)}
              style={{ margin: 0 }}
            />
            <span style={{ minInlineSize: 120 }}>{t(`contextMeter.form.${form}`)}</span>
            {/* decoration: the label beside it says what it is */}
            <span aria-hidden data-context-meter={form}>
              <span className="context-meter" data-context-level="normal">
                <span className="context-meter-bar">
                  <span className="context-meter-fill" style={{ inlineSize: `${SAMPLE_PERCENT}%` }} />
                </span>
                <span className="context-meter-number">
                  {t('contextMeter.percent', { percent: SAMPLE_PERCENT })}
                </span>
              </span>
            </span>
          </label>
        ))}
      </div>
    </SettingItem>
  );
}
