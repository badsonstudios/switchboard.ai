// What happens to a dispatched session once it has handed its findings over
// (#951, §5.15's "ephemeral by default").
//
// IN **ADVANCED**, beside the fork switch, and that is deliberate rather than
// alphabetical: Advanced is already where the other dispatch-facing setting lives
// (`Fork sessions`, which decides whether the `full` context policy is even
// offered), and the manual's Dispatch page already sends the reader there. It is
// not an `attention` setting — nothing here makes noise or takes the cursor — and
// it is not `appearance`, because it closes cards.
//
// A RADIO GROUP and not a checkbox, because there are three answers and §5.6 named
// all three. See `lib/dispatch-ephemeral.ts` for why the third one is spelled
// `keep` rather than `pin`, and why there is no per-session override.
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  DISPATCH_RETIRE_POLICIES,
  type DispatchRetirePolicy,
} from '../../lib/dispatch-ephemeral';
import { SettingItem } from './controls';

export interface DispatchRetireSectionProps {
  /** what is stored right now — the renderer's copy, already sanitised */
  policy: DispatchRetirePolicy;
  onSet: (policy: DispatchRetirePolicy) => void;
}

export function DispatchRetireSection(props: DispatchRetireSectionProps): React.JSX.Element {
  const { t } = useTranslation();
  /** The prefix for every `id` here (#654) — `PushSection.tsx` carries the full
   *  argument: a literal, published id is a name rendered content could take away
   *  from this field. The `data-` attributes stay as the test hooks. */
  const fieldId = React.useId();

  // No draft and no Save, like the task-label size: one control, a closed set of
  // values, and nothing to lose by writing through on the change.
  const option = (policy: DispatchRetirePolicy): React.JSX.Element => (
    <label
      key={policy}
      htmlFor={`${fieldId}r-${policy}`}
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: '2px 8px',
        alignItems: 'start',
        cursor: 'pointer',
      }}
    >
      <input
        id={`${fieldId}r-${policy}`}
        data-dispatch-retire={policy}
        type="radio"
        name={`${fieldId}retire`}
        checked={props.policy === policy}
        onChange={() => props.onSet(policy)}
        style={{ marginBlockStart: 2 }}
      />
      <span style={{ fontSize: 11.5 }}>{t(`dispatchRetire.${policy}`)}</span>
      <span />
      <span style={{ fontSize: 11, color: 'var(--faint)' }}>
        {t(`dispatchRetire.${policy}Note`)}
      </span>
    </label>
  );

  return (
    <SettingItem
      item="dispatch-retire"
      label={t('dispatchRetire.title')}
      blurb={t('dispatchRetire.blurb')}
    >
      <div
        data-settings-block="dispatch-retire"
        role="radiogroup"
        aria-label={t('dispatchRetire.title')}
        style={{ display: 'grid', gap: 12 }}
      >
        {DISPATCH_RETIRE_POLICIES.map(option)}
      </div>
    </SettingItem>
  );
}
