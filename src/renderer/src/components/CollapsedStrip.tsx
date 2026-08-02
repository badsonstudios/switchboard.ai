// The collapsed strip (P2-E9-05, DESIGN §5.8 — the ladder's second rung).
//
// A collapsed session has given its dock slot back; this is where it goes. One
// slim row per collapsed session: identity, name, what it is doing, and a click
// to bring it back to exactly the slot it left.
//
// It sits in the APP SHELL, directly under the urgency strip, for the reason
// that strip is there: it must not live inside the grid, because the grid is
// what a collapsed card has just left, and E9-07's layout modes rearrange the
// grid wholesale. Outside it, "the collapsed sessions are listed here" holds in
// every mode by construction.
//
// UNLIKE the urgency strip, this one RENDERS NOTHING when it is empty. The
// urgency strip is a permanent readout whose absence would have to be learned;
// a band of collapsed sessions with no collapsed sessions in it is just a bar
// of dead chrome above the workspace.
//
// Ordering and status vocabulary are lib/ladder's and lib/rail-view's; this
// file only paints.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CollapsedRow } from '../lib/ladder';

export function CollapsedStrip(props: {
  /** collapsed sessions, in rail order (lib/ladder collapsedRows) */
  rows: readonly CollapsedRow[];
  /** bring this session back to its slot (§5.8's reveal contract) */
  onExpand: (cardId: string) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (props.rows.length === 0) return null;
  return (
    <div
      data-testid="collapsed-strip"
      // a group, not a toolbar: the rows are ordinary buttons and each one
      // should be its own tab stop (same call as the urgency strip's)
      role="group"
      aria-label={t('ladder.stripLabel')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingInline: 8,
        paddingBlock: 3,
        minBlockSize: 24,
        overflowX: 'auto',
        background: 'var(--panel)',
        borderBlockEnd: '1px solid var(--border)',
      }}
    >
      <span style={{ flex: '0 0 auto', fontSize: 10, color: 'var(--faint)', whiteSpace: 'nowrap' }}>
        {t('ladder.stripLabel')}
      </span>
      {props.rows.map((r) => (
        <Row key={r.cardId} row={r} onExpand={props.onExpand} t={t} />
      ))}
    </div>
  );
}

function Row(props: {
  row: CollapsedRow;
  onExpand: (cardId: string) => void;
  /** passed down rather than re-subscribed per row */
  t: TFunction;
}): React.JSX.Element {
  const r = props.row;
  const label = props.t('ladder.rowTitle', { title: r.title, state: props.t(r.labelKey) });
  return (
    <button
      type="button"
      className="collapsed-row"
      // one attribute per independent fact, exactly as the lamps do it: which
      // card, what state, and whether a human is needed. Folding them together
      // makes both the CSS and the e2e assertions guess.
      data-collapsed-row={r.cardId}
      data-status={r.token}
      data-needs-you={r.needsYou}
      title={label}
      aria-label={label}
      onClick={() => props.onExpand(r.cardId)}
      style={
        {
          '--row-hue': `var(--status-${r.token})`,
          '--row-ink': `var(--status-${r.token}-ink)`,
          // the identity accent, which only the session knows
          '--row-accent': r.accent ?? 'var(--faint)',
        } as React.CSSProperties
      }
    >
      <span aria-hidden className="collapsed-accent" />
      <span className="collapsed-name">{r.title}</span>
      <span className="collapsed-state">{props.t(r.labelKey)}</span>
    </button>
  );
}
