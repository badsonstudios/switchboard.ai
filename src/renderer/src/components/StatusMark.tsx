// A session's status mark (§5.8): the working ring, or the one-glyph tile.
//
// Lifted out of `SessionRow` when the sessions strip (#1143) needed the same
// mark on its pills. "The same live status looks as a row" is only true while
// there is one of these, so there is one.
//
// DECORATION, always: `aria-label` on a role-less span is ignored by every
// screen reader anyway, and the state it would announce is in the accessible
// name of whatever it sits in (`sessionSpokenName`). `title` stays — that one
// is for the mouse. The ring was the ONLY animation (rule 3 of SessionsRail.tsx)
// until #718 gave a working session six selectable looks; it is still the only
// one a session that is NOT working ever has.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { attentionPaint, presentStatus } from '../lib/rail-view';
import { tint } from '../lib/tint';

export function StatusMark(props: {
  status: string | undefined;
  /** is this session one of the N being counted (#1137) — it decides the hue */
  needsYou: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const p = presentStatus(props.status);
  const paint = attentionPaint(props.status, props.needsYou);
  const hue = `var(--status-${paint.token})`;
  const ink = `var(--status-${paint.token}-ink)`;
  return p.spinner ? (
    <>
      <span
        aria-hidden
        // the handle the "working" looks restyle (#718): bigger in look 3,
        // gone in look 6
        className="status-ring"
        title={t(p.labelKey)}
        style={{
          inlineSize: 12,
          blockSize: 12,
          borderRadius: '50%',
          flexShrink: 0,
          border: `1.6px solid ${tint(hue, 22)}`,
          borderBlockStartColor: hue,
          animation: 'sb-spin 1.1s linear infinite',
        }}
      />
      {/* Look 6's four dancing bars. Always here beside the ring and
          `display: none` unless that look is in force, so which of the two
          is drawn is one CSS rule and not a setting threaded through every
          place a status mark is used. */}
      <span aria-hidden className="status-bars" title={t(p.labelKey)}>
        <i />
        <i />
        <i />
        <i />
      </span>
    </>
  ) : (
    <span
      aria-hidden
      title={t(p.labelKey)}
      style={{
        inlineSize: 16,
        blockSize: 16,
        borderRadius: 4,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--font-ui)',
        fontWeight: 700,
        fontSize: 10,
        color: ink,
        background: tint(hue, 14),
      }}
    >
      {p.glyphKey ? t(p.glyphKey) : ''}
    </span>
  );
}
