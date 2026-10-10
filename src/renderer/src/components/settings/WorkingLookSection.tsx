// Settings ▸ Appearance ▸ "How a working session looks" (#718): the six
// treatments, each shown MOVING on a sample pill, with the one in use ticked.
//
// The sample is not a drawing of the treatment: it is the treatment. Each
// option wraps a stand-in pill in its own `data-working-look`, and the same
// rules in `theme/tokens.css` that paint a real working session paint it — so
// what you pick is exactly what you get, and a look that is changed later
// cannot drift from its picture.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { WORKING_LOOKS, type WorkingLook } from '../../lib/working-look';
import { tint } from '../../lib/tint';
import { SettingItem } from './controls';

export interface WorkingLookSectionProps {
  look: WorkingLook;
  onSet: (look: WorkingLook) => void;
}

/** A stand-in for a pill on the strip, marked up the way a real one is
 *  (`StripPill`), so the treatment's rules find it. Decoration: the option's
 *  own words say what it is. */
function Sample(props: { look: WorkingLook }): React.JSX.Element {
  const { t } = useTranslation();
  // a fixed session colour for the sample, so six samples differ only in the
  // treatment. A token, not a hex: this is renderer TSX.
  const accent = 'var(--accent-teal)';
  return (
    <span aria-hidden data-working-look={props.look} style={{ display: 'block' }}>
      <span
        data-strip-pill="sample"
        data-session-status="working"
        data-needs-you="false"
        style={
          {
            '--work-accent': accent,
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minBlockSize: 36,
            paddingBlock: 4,
            paddingInlineStart: 11,
            paddingInlineEnd: 8,
            borderRadius: 7,
            border: '1px solid var(--group-frame)',
            background: 'var(--rail-card)',
          } as React.CSSProperties
        }
      >
        <span
          data-accent-bar
          style={{
            position: 'absolute',
            insetInlineStart: 0,
            insetBlockStart: 4,
            insetBlockEnd: 4,
            inlineSize: 2.5,
            borderRadius: '0 2px 2px 0',
            background: tint(accent, 45),
          }}
        />
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minInlineSize: 0, flex: 1 }}>
          <span data-strip-pill-title style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)' }}>
            {t('workingLook.sampleName')}
          </span>
          <span data-strip-pill-state style={{ fontSize: 9, fontWeight: 700, color: 'var(--muted)' }}>
            {t('workingLook.sampleState')}
          </span>
        </span>
        <span
          className="status-ring"
          style={{
            inlineSize: 12,
            blockSize: 12,
            borderRadius: '50%',
            flexShrink: 0,
            border: `1.6px solid ${tint('var(--status-working)', 22)}`,
            borderBlockStartColor: 'var(--status-working)',
            animation: 'sb-spin 1.1s linear infinite',
          }}
        />
        <span className="status-bars">
          <i />
          <i />
          <i />
          <i />
        </span>
      </span>
    </span>
  );
}

export function WorkingLookSection(props: WorkingLookSectionProps): React.JSX.Element {
  const { t } = useTranslation();
  const fieldId = React.useId();

  const option = (look: WorkingLook, index: number): React.JSX.Element => {
    const chosen = props.look === look;
    return (
      <label
        key={look}
        htmlFor={`${fieldId}w-${look}`}
        style={{
          display: 'grid',
          alignContent: 'start',
          gap: 6,
          padding: 8,
          borderRadius: 6,
          border: `1px solid ${chosen ? 'var(--status-working-ink)' : 'var(--border)'}`,
          cursor: 'pointer',
        }}
      >
        <Sample look={look} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            id={`${fieldId}w-${look}`}
            data-working-look-choice={look}
            type="radio"
            name={`${fieldId}look`}
            checked={chosen}
            aria-labelledby={`${fieldId}n-${look}`}
            aria-describedby={`${fieldId}d-${look}`}
            onChange={() => props.onSet(look)}
            style={{ margin: 0 }}
          />
          <span id={`${fieldId}n-${look}`} style={{ fontSize: 11.5 }}>
            {t('workingLook.numbered', { number: index + 1, name: t(`workingLook.${look}`) })}
          </span>
        </span>
        <span id={`${fieldId}d-${look}`} style={{ fontSize: 11, color: 'var(--muted)' }}>
          {t(`workingLook.${look}Note`)}
        </span>
      </label>
    );
  };

  return (
    <SettingItem item="working-look" label={t('workingLook.title')} blurb={t('workingLook.blurb')}>
      <div
        data-settings-block="working-look"
        role="radiogroup"
        aria-label={t('workingLook.title')}
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}
      >
        {WORKING_LOOKS.map(option)}
      </div>
    </SettingItem>
  );
}
