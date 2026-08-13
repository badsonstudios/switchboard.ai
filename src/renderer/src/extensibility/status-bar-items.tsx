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
import { healthTone, healthTooltip } from '../lib/service-health';
import type { ServiceHealthStatus } from '../../../shared/service-health';

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

function Theme({ nameKey }: { nameKey: string }): React.JSX.Element {
  const { t } = useTranslation();
  // the id is the contract; what the bar SHOWS is the theme's own display name,
  // which a theme owns and i18n translates (§5.21)
  return <span style={MONO}>{t('statusbar.theme', { theme: t(nameKey) })}</span>;
}

/**
 * The service-health dot (P2-E14-07, §5.14) — the one item on this bar that is
 * about something OUTSIDE the app.
 *
 * Three things carry the meaning, and none of them is the colour alone (§5.32):
 * the glyph is filled or hollow, trouble puts a WORD next to the dot, and the
 * accessible name is the whole tooltip. `role="img"` with an `aria-label`
 * rather than bare text, because "●" read out as a character is noise; what a
 * screen reader should hear is the sentence.
 */
function ServiceHealth({ status }: { status: ServiceHealthStatus }): React.JSX.Element {
  const { t } = useTranslation();
  const tone = healthTone(status);
  const tip = healthTooltip(status)
    .map((l) => t(l.key, l.params))
    .join(' · ');
  return (
    <span
      data-testid="service-health"
      data-state={status.state}
      title={tip}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      <span role="img" aria-label={tip} style={{ color: tone.colorVar }}>
        {tone.glyph}
      </span>
      {tone.shortKey && <span>{t(tone.shortKey)}</span>}
    </span>
  );
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
    // §5.14's dot. FIRST on the right-hand side, ahead of the CLI version and
    // the theme: those two say what this app is, and this one says whether the
    // thing it talks to is answering — which is the question a stuck session
    // sends you to the corner of the screen to ask.
    manifest: manifest('status-service-health', 'Provider service health'),
    align: 'end',
    order: 6,
    // null until main has said anything: a window that has never heard from the
    // poller shows no dot rather than a grey one it cannot explain.
    render: (ctx) => (ctx.serviceHealth ? <ServiceHealth status={ctx.serviceHealth} /> : null),
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
    render: (ctx) => <Theme nameKey={ctx.themeNameKey} />,
  },
];
