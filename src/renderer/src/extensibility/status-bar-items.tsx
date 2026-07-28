// Status bar items as CONTRIBUTIONS (P2-E15-03, §5.10 + §5.23).
//
// The simplest of the three points, and deliberately so: `panel` renders whole
// views with a mount/keep-mounted lifecycle, `feed-block-renderer` competes to
// claim an input, and this one just puts a thing on a bar. Three shapes that
// differ is what makes them worth dogfooding — a contract that only ever sees
// one shape of consumer has not been tested.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { manifestFor, StatusBarContext, StatusBarItemContribution } from './contributions';
import { RendererRegistry } from './registry-instance';
import { formatTokens, formatUsd } from '../lib/usage';

const MONO: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10 };

function SessionCount({ count }: { count: number }): React.JSX.Element {
  const { t } = useTranslation();
  return <span>{t('statusbar.sessions', { count })}</span>;
}

function Usage({ tokens, cost }: { tokens: number; cost: number }): React.JSX.Element {
  const { t } = useTranslation();
  return <span style={MONO}>{t('statusbar.usage', { tokens: formatTokens(tokens), cost: formatUsd(cost) })}</span>;
}

function CliVersion({ version }: { version: string }): React.JSX.Element {
  const { t } = useTranslation();
  return <span style={MONO}>{t('preflight.version', { version })}</span>;
}

function Theme({ theme }: { theme: string }): React.JSX.Element {
  const { t } = useTranslation();
  return <span style={MONO}>{t('statusbar.theme', { theme })}</span>;
}

const manifest = (id: string, displayName: string) => manifestFor(id, displayName, 'statusbar.item');

/** The items on one side of the bar, in order — the ONE definition of that rule. */
export function listStatusBarItems(
  registry: RendererRegistry,
  align: 'start' | 'end'
): StatusBarItemContribution[] {
  return [...registry.list('status-bar-item')]
    .filter((i) => i.align === align)
    .sort((a, b) => a.order - b.order);
}

export const statusBarItems: StatusBarItemContribution[] = [
  {
    manifest: manifest('status-session-count', 'Session count'),
    align: 'start',
    order: 10,
    render: (ctx: StatusBarContext) => <SessionCount count={ctx.count} />,
  },
  {
    manifest: manifest('status-usage', 'Workspace usage'),
    align: 'start',
    order: 20,
    // null when there is nothing to say — the item decides, not the bar
    render: (ctx) =>
      ctx.totalOutputTokens ? (
        <Usage tokens={ctx.totalOutputTokens} cost={ctx.totalCostUsd ?? 0} />
      ) : null,
  },
  {
    manifest: manifest('status-cli-version', 'CLI version'),
    align: 'end',
    order: 10,
    render: (ctx) => (ctx.cliVersion ? <CliVersion version={ctx.cliVersion} /> : null),
  },
  {
    manifest: manifest('status-theme', 'Active theme'),
    align: 'end',
    order: 20,
    render: (ctx) => <Theme theme={ctx.theme} />,
  },
];
