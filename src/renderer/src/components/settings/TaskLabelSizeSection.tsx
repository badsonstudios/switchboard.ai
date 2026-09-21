// Task label size (#877) — how many lines a task label may use.
//
// This was `TaskLabelSizeDialog.tsx`, which said of itself: "when the real
// settings screen lands (#885) these controls move into it and this file goes
// away." It landed one item later, which is about as short a life as a stopgap
// can hope for.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { TASK_LABEL_SIZES, type TaskLabelSize } from '../../../../shared/task-label-size';
import { SettingItem } from './controls';

export interface TaskLabelSizeSectionProps {
  /** what is stored right now — the renderer's copy, already sanitised */
  size: TaskLabelSize;
  onSet: (size: TaskLabelSize) => void;
}

export function TaskLabelSizeSection(props: TaskLabelSizeSectionProps): React.JSX.Element {
  const { t } = useTranslation();
  /**
   * The prefix for every `id` here (#654). `PushSection.tsx` carries the full
   * argument: `<label for>` binds to the FIRST element in tree order with that
   * id, so a literal, published id is a name rendered content could take away
   * from this field. The `data-` attributes stay as the test hooks.
   */
  const fieldId = React.useId();

  // No drafts and no Save button, unlike quiet hours: there is one control, its
  // values are a closed set, and the effect is visible on the rail BEHIND the
  // modal the instant it is picked. A Save button here would only add a state
  // to forget to press.
  const option = (size: TaskLabelSize): React.JSX.Element => (
    <label
      key={size}
      htmlFor={`${fieldId}s-${size}`}
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: '2px 8px',
        alignItems: 'start',
        cursor: 'pointer',
      }}
    >
      <input
        id={`${fieldId}s-${size}`}
        data-task-label-size={size}
        type="radio"
        name={`${fieldId}size`}
        checked={props.size === size}
        onChange={() => props.onSet(size)}
        style={{ marginBlockStart: 2 }}
      />
      <span style={{ fontSize: 11.5 }}>{t(`taskLabelSize.${size}`)}</span>
      <span />
      <span style={{ fontSize: 11, color: 'var(--faint)' }}>{t(`taskLabelSize.${size}Note`)}</span>
    </label>
  );

  return (
    <SettingItem
      item="task-label-size"
      label={t('taskLabelSize.title')}
      blurb={t('taskLabelSize.blurb')}
    >
      <div
        data-settings-block="task-label-size"
        role="radiogroup"
        aria-label={t('taskLabelSize.title')}
        style={{ display: 'grid', gap: 12 }}
      >
        {TASK_LABEL_SIZES.map(option)}
      </div>
    </SettingItem>
  );
}
