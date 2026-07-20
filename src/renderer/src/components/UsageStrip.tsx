// Live usage strip on a session card (P2-E7-01). Tokens are the primary,
// exact signal; the dollar figure is a labeled estimate (subscription-first).
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Usage, formatTokens, formatUsd, estimateCostUsd } from '../lib/usage';

export function UsageStrip(props: { usage: Usage; model?: string }): React.JSX.Element {
  const { t } = useTranslation();
  const u = props.usage;
  const cost = estimateCostUsd(u, props.model);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingInline: 8,
        paddingBlock: 2,
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        color: 'var(--muted)',
        background: 'var(--panel2)',
        borderBlockEnd: '1px solid var(--border)',
      }}
    >
      <span title={t('usage.inputTitle')}>{t('usage.input', { n: formatTokens(u.input) })}</span>
      <span title={t('usage.outputTitle')}>{t('usage.output', { n: formatTokens(u.output) })}</span>
      <span title={t('usage.cacheTitle')} style={{ color: 'var(--faint)' }}>
        {t('usage.cache', { n: formatTokens(u.cacheRead) })}
      </span>
      <span style={{ flex: 1 }} />
      <span title={t('usage.costTitle')}>{t('usage.cost', { cost: formatUsd(cost) })}</span>
    </div>
  );
}
