// How full this session's context window is, under the prompt box (#715).
//
// The owner: bottom right, under the composer, 0 to 100%, as a number or a
// bar, and "when you get over 60%, you should reset it or compact it there".
//
// THE NUMBER IS THE CLI'S OWN. `get_context_usage` answers the fill directly
// (measured: shared/context-usage.ts), so nothing here counts tokens or knows a
// model's window. It is asked when the card appears, when a turn ends, when
// the model changes (the window is a different size), and every so often
// while a turn runs, because one long turn of tool calls is exactly how a
// window fills. The control channel answers mid-turn (measured, #721).
//
// NO YELLOW. The ticket says "yellow at about 60%", and it was written before
// the owner's rule that yellow and orange mean "a session needs you" and
// nothing else (#1165). A full window is not a session waiting on you, so:
// plain ink below 60, the "worth noticing" blue from 60, the failure red from
// 80. Flagged for him to overrule.
//
// NEVER COLOUR ALONE (DESIGN 5.32). The number is the signal. In the bar-only
// form the number is hidden while the window is comfortable and comes back
// from 60%, so the two states that ask something of you always say a figure.
//
// IT SHOWS NOTHING RATHER THAN A GUESS: no answer, an ended session, or a CLI
// that does not say, and there is no meter. Never an invented 0%.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { answered } from '../../../shared/ipc/refusal';
import { contextLevel, type ContextUsage } from '../../../shared/context-usage';

/** how long after a read nobody answered before asking once more */
export const CONTEXT_RETRY_MS = 4000;
/** how long after Compact or Clear it is asked a second time: the first read
 *  can beat the command to the session */
export const CONTEXT_SETTLE_MS = 2000;
/** how often it is asked again while a turn is running */
export const CONTEXT_POLL_MS = 20_000;

function readUsage(response: Record<string, unknown>): ContextUsage | null {
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const percentage = n(response.percentage);
  if (percentage === null) return null;
  return {
    percentage: Math.max(0, Math.min(100, Math.round(percentage))),
    totalTokens: n(response.totalTokens),
    maxTokens: n(response.maxTokens),
    autoCompactAt: n(response.autoCompactAt),
  };
}

export function ContextMeter(props: {
  /** the LIVE session this reads — the composer's own */
  liveId: string;
  /** a turn is running: ask now and then, and ask once more when it ends */
  working?: boolean;
  /** what the model chip says. Not read: a change in it is a cue to ask again,
   *  because the window's size goes with the model */
  model?: string | null;
  /** a counter the composer bumps after Compact or Clear: ask again now, and
   *  once more shortly after */
  refresh?: number;
}): React.JSX.Element | null {
  const { t, i18n } = useTranslation();
  const { liveId, working, model, refresh = 0 } = props;
  const [usage, setUsage] = React.useState<ContextUsage | null>(null);
  /** bumped to ask again; the effect below is the only thing that asks */
  const [ask, setAsk] = React.useState(0);
  const retried = React.useRef(false);

  // a new session is a new window: nothing carried over from the last one
  React.useEffect(() => {
    setUsage(null);
    retried.current = false;
  }, [liveId]);

  React.useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // FAIL OPEN (PHILOSOPHY P6): a bridge with no such channel — an older
    // preload, a test's stand-in — means no meter. Never a throw in an effect
    // of the composer, which is the one thing a session cannot lose.
    const sessions = window.switchboard?.sessions as
      | Partial<typeof window.switchboard.sessions>
      | undefined;
    if (typeof sessions?.contextUsage !== 'function') return;
    // inside a promise from the first step, so a bridge that THROWS instead
    // of rejecting cannot throw out of this effect either
    void Promise.resolve()
      .then(() => sessions.contextUsage!(liveId))
      .catch(() => undefined)
      .then((raw) => {
        // `answered` launders a capability refusal into undefined
        const v = answered(raw);
        if (!alive) return;
        const next = v?.ok ? readUsage(v.response) : null;
        if (next) {
          setUsage(next);
          return;
        }
        // NO ANSWER KEEPS WHAT WAS SHOWN. A read that timed out mid-turn does
        // not mean the window emptied; the last figure the session gave is
        // still the best one. A session still starting is asked once more.
        if (!retried.current) {
          retried.current = true;
          retry = setTimeout(() => alive && setAsk((n) => n + 1), CONTEXT_RETRY_MS);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
    };
    // `working` is here for its EDGES: a turn starting and a turn ending are
    // both moments the fill has just changed, or is about to
  }, [liveId, model, working, ask, refresh]);

  // after Compact or Clear: the read above went at once; this is the second
  React.useEffect(() => {
    if (refresh === 0) return;
    const timer = setTimeout(() => setAsk((n) => n + 1), CONTEXT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [refresh, liveId]);

  // while a turn runs, ask now and then
  React.useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setAsk((n) => n + 1), CONTEXT_POLL_MS);
    return () => clearInterval(timer);
  }, [working, liveId]);

  if (!usage) return null;

  const level = contextLevel(usage.percentage);
  const number = (n: number): string => {
    // a language tag the platform rejects must not throw in render
    try {
      return n.toLocaleString(i18n.language);
    } catch {
      return n.toLocaleString();
    }
  };
  const lines: string[] = [];
  lines.push(
    usage.totalTokens !== null && usage.maxTokens !== null
      ? t('contextMeter.hoverCounts', {
          percent: usage.percentage,
          used: number(usage.totalTokens),
          max: number(usage.maxTokens),
        })
      : t('contextMeter.hoverPercent', { percent: usage.percentage })
  );
  if (usage.autoCompactAt !== null) {
    lines.push(t('contextMeter.hoverCompacts', { at: number(usage.autoCompactAt) }));
  }
  if (level !== 'normal') lines.push(t(`contextMeter.hover.${level}`));
  const hover = lines.join(' ');

  return (
    <span
      data-testid="composer-context"
      data-context-level={level}
      className="context-meter"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={usage.percentage}
      aria-valuetext={t('contextMeter.valueText', { percent: usage.percentage })}
      aria-label={t('contextMeter.label')}
      title={hover}
    >
      <span className="context-meter-bar" aria-hidden>
        <span className="context-meter-fill" style={{ inlineSize: `${usage.percentage}%` }} />
      </span>
      <span className="context-meter-number">
        {t('contextMeter.percent', { percent: usage.percentage })}
      </span>
    </span>
  );
}
