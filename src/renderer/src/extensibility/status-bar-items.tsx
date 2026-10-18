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
import { CLAUDE_AI_ID } from '../../../shared/ais';
import type { EventDto } from '../model/types';
import type { PlanLimitWindow } from '../../../shared/usage-report';
import { AiIcon } from '../components/AiIcon';
import { aiLook, getAisState, subscribeAis, type AiLook, type AisState } from '../lib/ais-store';

const MONO: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10 };

function SessionCount({ count }: { count: number }): React.JSX.Element {
  const { t } = useTranslation();
  return <span>{t('statusbar.sessions', { count })}</span>;
}

/**
 * The workspace's tokens and spend.
 *
 * THREE WORDINGS, because a total that leaves sessions out must say so
 * (#1288). Every session priced: `~$X est`, exactly as before. Some sessions
 * on a model with no known price: `≥$X est`, since the total is short by an
 * amount nobody reported. None priced: `no price`, rather than `$0.00`, which
 * would read as "this cost nothing". The tooltip, in the last two, counts the
 * sessions left out; and any plan-limit window an AI reported is listed there.
 */
function Usage({
  tokens,
  cost,
  unpriced,
  limits,
}: {
  tokens: number;
  cost: number;
  unpriced: number;
  limits: PlanLimitWindow[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const n = formatTokens(tokens);
  const text =
    unpriced === 0
      ? t('statusbar.usage', { tokens: n, cost: formatUsd(cost) })
      : cost > 0
        ? t('statusbar.usagePartial', { tokens: n, cost: formatUsd(cost) })
        : t('statusbar.usageNoPrice', { tokens: n });
  const tip = [
    ...(unpriced > 0 ? [t('statusbar.usageUnpricedTitle', { count: unpriced })] : []),
    ...limits.map((w) => limitLine(t, w)),
  ];
  return (
    <span style={MONO} {...(tip.length ? { title: tip.join(' · ') } : {})}>
      {text}
    </span>
  );
}

/** "5h: 3% used, resets 15:19" — the AI's own label, or its window id. */
function limitLine(t: (key: string, params?: Record<string, unknown>) => string, w: PlanLimitWindow): string {
  const label = w.label ?? w.id;
  const pct = Math.round(w.usedPercent);
  const at = w.resetsAt ? new Date(w.resetsAt) : null;
  return at && !Number.isNaN(at.getTime())
    ? t('statusbar.limitResets', { label, pct, time: at.toLocaleString() })
    : t('statusbar.limit', { label, pct });
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

/**
 * §5.14's fourth readout: how many sessions are waiting on a human.
 *
 * Spec'd since §5.14 ("service health dot · plan-usage meter · active sessions
 * count · attention-queue count") and never built, because until P2-E14-01 the
 * Events column was always on screen saying it. Shape B collapses that column
 * to a tab on the far right edge, so the bar takes over the job it was always
 * meant to have: the count that is true whatever else is open, in the corner
 * you look at without moving your eyes off a terminal.
 *
 * Right beside the session count, and that pairing is the meaning: "9 sessions,
 * 3 waiting" is one sentence about the workspace.
 *
 * TINTED BY THE HOTTEST THING WAITING — the same fact, from the same queue
 * head, that tints the events drawer's tab. A fixed `needs-input` ink would
 * have painted a queue of nothing but `crashed` sessions in the "needs input"
 * colour, inches away from a tab painted in the crashed one: two readouts of
 * one number disagreeing, which is how a set of status inks stops being a
 * vocabulary and becomes decoration. Ink and not hue because this is a WORD
 * (the rule #221 established), and plain at zero, since "nothing is waiting" is
 * not news that deserves a colour.
 */
const ATTENTION_INK: Record<EventDto['kind'], string> = {
  done: 'var(--status-done-ink)',
  ready: 'var(--muted)',
  'needs-input': 'var(--status-needs-input-ink)',
  'needs-permission': 'var(--status-needs-permission-ink)',
  crashed: 'var(--status-crashed-ink)',
  // A returned dispatch is finished work, so it reads as `done` (P2-E13-05).
  'dispatch-result': 'var(--status-done-ink)',
};

function AttentionCount({
  count,
  binding,
  hottest,
}: {
  count: number;
  binding?: string;
  hottest?: EventDto['kind'] | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <span
      data-testid="status-attention"
      data-count={count}
      data-hottest={hottest ?? undefined}
      title={binding ? t('statusbar.attentionTitle', { binding }) : undefined}
      style={{ ...MONO, color: count > 0 && hottest ? ATTENTION_INK[hottest] : undefined }}
    >
      {t('statusbar.attention', { count })}
    </span>
  );
}

/** One AI on the status bar. */
export interface StatusBarAi {
  providerId: string;
  look: AiLook;
  version?: string;
}

/** Claude's catalog id: first on the bar, as the design record's screen 1 has it. */
const CLAUDE_ID = CLAUDE_AI_ID;

/**
 * WHICH AIs THE BAR LISTS, and in what order (#1293) — a pure function so the
 * rule is tested without a bar:
 *
 *   - Claude first, when detection found it installed OR preflight read its
 *     version (the line this replaced, so a Claude the bar showed before is
 *     never dropped by a detection that has not finished);
 *   - then every other AI whose detection says `installed === true`, in the
 *     list's own order. `'unknown'` is not installed: a slow probe is not a
 *     claim worth printing.
 *
 * Empty when there is no list: the caller then shows the old line.
 */
export function statusBarAis(state: AisState, cliVersion: string | null | undefined, unknownName: string): StatusBarAi[] {
  if (!state.items) return [];
  const out: StatusBarAi[] = [];
  const claude = state.items.find((i) => i.entry.id === CLAUDE_ID);
  if (claude && (claude.detection?.installed === true || cliVersion)) {
    const id = claude.providerId ?? CLAUDE_ID;
    out.push({ providerId: id, look: aiLook(state, id, unknownName), version: claude.detection?.version ?? cliVersion ?? undefined });
  }
  for (const item of state.items) {
    if (item.entry.id === CLAUDE_ID || item.detection?.installed !== true) continue;
    const id = item.providerId ?? item.entry.id;
    out.push({ providerId: id, look: aiLook(state, id, unknownName), version: item.detection.version });
  }
  return out;
}

/** Whether the AIs readout is drawing the health dot itself. */
function healthIsInline(state: AisState, cliVersion: string | null | undefined): boolean {
  if (!state.defaultId) return false;
  return statusBarAis(state, cliVersion, '').some((a) => a.providerId === state.defaultId);
}

function StandaloneHealth({ ctx }: { ctx: StatusBarContext }): React.JSX.Element | null {
  const state = React.useSyncExternalStore(subscribeAis, getAisState);
  if (!ctx.serviceHealth || healthIsInline(state, ctx.cliVersion)) return null;
  return <ServiceHealth status={ctx.serviceHealth} />;
}

/**
 * "<icon> Claude Code 2.1.288 ● · <icon> Codex 0.48" — the mockup's screen 1.
 *
 * THE HEALTH DOT goes after the AI it describes: main polls ONE status page,
 * the default AI's (#1288), so that is the entry it follows. Every other AI
 * has no health readout at all, because nothing is asking about it.
 *
 * NEVER WRAPS (the bar is one nowrap row, and a taller bar costs the
 * conversation its pixels — the `Chip` note in chrome.tsx). The readout may
 * shrink: past its share it clips with an ellipsis, and its `title` lists
 * every AI, so nothing is lost to a narrow window.
 */
function AisReadout({ ctx }: { ctx: StatusBarContext }): React.JSX.Element | null {
  const { t } = useTranslation();
  const state = React.useSyncExternalStore(subscribeAis, getAisState);
  const ais = statusBarAis(state, ctx.cliVersion, t('aiBadge.unknownAi'));
  if (ais.length === 0) return ctx.cliVersion ? <CliVersion version={ctx.cliVersion} /> : null;
  const words = (a: StatusBarAi): string =>
    a.version ? t('statusbar.aiVersion', { name: a.look.name, version: a.version }) : a.look.name;
  return (
    <span
      data-testid="status-ais"
      title={t('statusbar.aisTitle', { list: ais.map(words).join(', ') })}
      style={{
        ...MONO,
        // a BLOCK box, not a flex one: `text-overflow` only clips the inline
        // content of a block container, so this is what makes the ellipsis
        // real. Each AI is an atomic inline inside it.
        display: 'inline-block',
        minInlineSize: 0,
        maxInlineSize: 420,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
      }}
    >
      {ais.map((a, i) => (
        <span
          key={a.providerId}
          data-status-ai={a.providerId}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            verticalAlign: 'middle',
            marginInlineStart: i === 0 ? 0 : 10,
          }}
        >
          <AiIcon look={a.look} size={11} />
          <span>{words(a)}</span>
          {ctx.serviceHealth && a.providerId === state.defaultId && <ServiceHealth status={ctx.serviceHealth} />}
        </span>
      ))}
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
    // Between the session count and the usage meter — §5.14 lists it after the
    // session count, and it is about the same thing those sessions are doing.
    // Null only when the context carries no count at all (a bar rendered by a
    // test that does not care). App always passes one, so in the app this item
    // is ALWAYS on screen — including at zero, which is the same idiom the
    // session count next to it uses ("no sessions"). A readout that vanished
    // when it hit zero would read as broken rather than as calm, and "is
    // anything waiting?" has to be answerable by looking, not by remembering
    // whether the corner is usually occupied.
    manifest: manifest('status-attention-count', 'Attention queue count'),
    align: 'start',
    order: 15,
    render: (ctx) =>
      ctx.attentionCount === undefined ? null : (
        <AttentionCount
          count={ctx.attentionCount}
          binding={ctx.attentionBinding}
          hottest={ctx.attentionHottest}
        />
      ),
  },
  {
    manifest: manifest('status-usage', 'Workspace usage'),
    align: 'start',
    order: 20,
    // null when there is nothing to say — the item decides, not the bar
    render: (ctx) =>
      ctx.totalOutputTokens ? (
        <Usage
          tokens={ctx.totalOutputTokens}
          cost={ctx.totalCostUsd ?? 0}
          unpriced={ctx.unpricedSessions ?? 0}
          limits={ctx.planLimits ?? []}
        />
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
    //
    // Since #1293 the dot normally sits INSIDE the AIs readout, after the AI
    // it is about; this slot draws it only when that readout cannot (no list
    // of AIs yet, or the AI it describes is not on it). Fail-open: the dot is
    // never lost because the list of AIs was.
    render: (ctx) => (ctx.serviceHealth ? <StandaloneHealth ctx={ctx} /> : null),
  },
  {
    // E40 item 10 (#1293): each AI on this computer, with its version — Claude
    // first, then every other AI detection found installed. It replaced the one
    // `claude <version>` line, which is still what it says when no list of
    // AIs has arrived (`CliVersion`, below).
    manifest: manifest('status-ais', 'AIs and their versions'),
    align: 'end',
    order: 10,
    render: (ctx) => <AisReadout ctx={ctx} />,
  },
  {
    manifest: manifest('status-theme', 'Active theme'),
    align: 'end',
    order: 20,
    render: (ctx) => <Theme nameKey={ctx.themeNameKey} />,
  },
];
