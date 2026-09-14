// Live usage readout for a session card (P2-E7-01, #787). Tokens are the
// primary, exact signal. The dollar figure has TWO possible sources and the
// strip says which one it is showing: our estimate while the session runs, the
// CLI's own number once it has ended. `costLine` owns that choice; this file
// only renders what it decided.
// `inline` renders just the spans (for embedding in the shared card header);
// otherwise it renders its own strip.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Usage, CliCost, formatTokens, costLine } from '../lib/usage';

export function UsageStrip(props: {
  usage: Usage;
  model?: string;
  cliCost?: CliCost;
  inline?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const u = props.usage;
  const cost = costLine(u, props.model, props.cliCost);
  // Three distinct tooltips, because the three cases make genuinely different
  // claims and a single "estimated cost" string would be a lie in two of them.
  const costTitle =
    cost.source === 'cli'
      ? cost.floor
        ? t('usage.costTitleCliFloor')
        : t('usage.costTitleCli')
      : t('usage.costTitleEstimate');
  const body = (
    <>
      <span title={t('usage.inputTitle')}>{t('usage.input', { n: formatTokens(u.input) })}</span>
      <span title={t('usage.outputTitle')}>{t('usage.output', { n: formatTokens(u.output) })}</span>
      <span title={t('usage.cacheTitle')} style={{ color: 'var(--faint)' }}>
        {t('usage.cache', { n: formatTokens(u.cacheRead) })}
      </span>
      <span title={costTitle}>{t('usage.cost', { cost: cost.text })}</span>
    </>
  );
  if (props.inline) {
    return <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>{body}</span>;
  }
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
      {body}
      <span style={{ flex: 1 }} />
    </div>
  );
}
