// Performance summary (#923) — "is it better?" answered on screen.
//
// The palette command exists so the owner never has to open a log file to find
// out whether a change helped. That is the whole brief, and it sets the tone
// for everything here: this is a READING, not a dashboard. No charts, no
// history, no live updates — a snapshot of what this window has measured since
// it opened, in plain sentences with the numbers in them.
//
// **Percentiles, never a mean, and the screen explains what one is.** The
// complaint E21 exists to answer is bursts: typing that runs fine and then
// stalls. A mean is precisely the statistic that hides them, so it is not
// computed anywhere in this feature. `worst` is beside the percentiles because
// on a short capture the single worst sample is the only place a rare stall
// shows up at all — p95 of twenty samples is the nineteenth.
//
// Modelled on `AboutPanel`: same scrim, same focus handling, same Escape
// behaviour, same click-away. It is the other read-only "tell me about this
// build" surface and there is no reason for the two to feel different.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PerfSummary } from '../../../shared/perf';

export function PerfSummaryPanel(props: {
  open: boolean;
  onClose: () => void;
  /** `null` while the numbers are still being fetched from main */
  summary: PerfSummary | null;
  /** Another modal is stacked above — see AboutPanel for why this matters. */
  dialogAbove?: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const dialog = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!props.open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
  }, [props.open]);

  if (!props.open) return null;

  const close = (): void => {
    props.onClose();
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  const s = props.summary;
  const rows = s?.interactions ?? [];

  return (
    <div
      onMouseDown={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlockStart: '12vh',
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal={props.dialogAbove ? undefined : 'true'}
        aria-label={t('perf.title')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        style={{
          inlineSize: 'min(560px, 94vw)',
          maxBlockSize: '76vh',
          overflowY: 'auto',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: 'var(--tab-lift)',
          fontFamily: 'var(--font-ui)',
          color: 'var(--text)',
          outline: 'none',
        }}
      >
        <div
          style={{
            padding: '11px 14px',
            borderBlockEnd: '1px solid var(--border)',
            background: 'var(--panel2)',
            fontSize: 13,
            fontWeight: 600,
            position: 'sticky',
            insetBlockStart: 0,
          }}
        >
          {t('perf.title')}
        </div>

        <p style={{ margin: 0, padding: '12px 14px 0', fontSize: 11.5, color: 'var(--faint)' }}>
          {t('perf.intro')}
        </p>

        {rows.length === 0 ? (
          // "Nothing measured" and "everything was instant" must not look the
          // same. An empty table with zeros in it would read as the second.
          <p
            data-perf-field="empty"
            style={{ margin: 0, padding: '12px 14px', fontSize: 12, color: 'var(--muted)' }}
          >
            {t('perf.nothing')}
          </p>
        ) : (
          <table
            style={{
              inlineSize: 'calc(100% - 28px)',
              margin: '10px 14px',
              borderCollapse: 'collapse',
              fontSize: 12,
            }}
          >
            <thead>
              <tr style={{ color: 'var(--muted)', textAlign: 'end' }}>
                <th scope="col" style={{ textAlign: 'start', fontWeight: 600, paddingBlock: 4 }}>
                  {t('perf.interaction')}
                </th>
                <th scope="col" style={{ fontWeight: 600, paddingBlock: 4 }}>{t('perf.count')}</th>
                <th scope="col" style={{ fontWeight: 600, paddingBlock: 4 }}>{t('perf.p50')}</th>
                <th scope="col" style={{ fontWeight: 600, paddingBlock: 4 }}>{t('perf.p95')}</th>
                <th scope="col" style={{ fontWeight: 600, paddingBlock: 4 }}>{t('perf.worst')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} data-perf-row={r.name} style={{ textAlign: 'end' }}>
                  <td
                    style={{
                      textAlign: 'start',
                      paddingBlock: 3,
                      borderBlockStart: '1px solid var(--border)',
                    }}
                  >
                    {t(`perf.names.${r.name}`)}
                  </td>
                  <td style={{ paddingBlock: 3, borderBlockStart: '1px solid var(--border)' }}>
                    {r.count}
                  </td>
                  <td style={{ paddingBlock: 3, borderBlockStart: '1px solid var(--border)' }}>
                    {t('perf.ms', { ms: r.p50 })}
                  </td>
                  <td style={{ paddingBlock: 3, borderBlockStart: '1px solid var(--border)' }}>
                    {t('perf.ms', { ms: r.p95 })}
                  </td>
                  <td
                    data-perf-worst={r.name}
                    style={{ paddingBlock: 3, borderBlockStart: '1px solid var(--border)' }}
                  >
                    {t('perf.ms', { ms: r.worst })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ display: 'grid', gap: 7, padding: '2px 14px 14px', fontSize: 11.5 }}>
          <p data-perf-field="longTasks" style={{ margin: 0, color: 'var(--muted)' }}>
            {s && s.longTasks.count > 0
              ? t('perf.longTasks', {
                  count: s.longTasks.count,
                  total: s.longTasks.totalMs,
                  worst: s.longTasks.worstMs,
                })
              : t('perf.longTasksNone')}
          </p>

          <p data-perf-field="loop" style={{ margin: 0, color: 'var(--muted)' }}>
            {s?.loop
              ? t('perf.loop', { p50: s.loop.p50, p99: s.loop.p99, max: s.loop.maxMs })
              : t('perf.loopNone')}
          </p>

          {/* `null` detail and zero keystrokes are DIFFERENT sentences. One says
              the instrument was off, the other says it was on and saw nothing —
              and telling the owner his capture found no layout reads on a day he
              never switched it on is exactly the wrong answer. */}
          {s?.detail ? (
            <>
              <p data-perf-field="detail" style={{ margin: 0, color: 'var(--muted)' }}>
                {t('perf.detailOn', {
                  count: s.detail.keystrokes,
                  blocks: s.detail.maxBlocks,
                  rendered: s.detail.maxRendered,
                })}
              </p>
              <p
                data-perf-field="layout"
                style={{
                  margin: 0,
                  // Amber for a broken promise, the same ink About uses for a
                  // dirty tree: PR #739's guarantee is that typing reads no
                  // layout, so any number here is that fix having regressed.
                  color:
                    s.detail.layoutReads > 0 ? 'var(--status-needs-input-ink)' : 'var(--muted)',
                }}
              >
                {s.detail.layoutReads > 0
                  ? t('perf.layoutDirty', { count: s.detail.layoutReads })
                  : t('perf.layoutClean')}
              </p>
            </>
          ) : (
            <p data-perf-field="detail" style={{ margin: 0, color: 'var(--faint)' }}>
              {t('perf.detailOff')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
