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
// P2-E9-08 added the other half of §5.8's idle-collapse bullet: once more than
// ~3 of these rows are idle they fold into a single expandable "N idle
// sessions" row, so the strip keeps showing the sessions that are saying
// something instead of a wall of identical idle chips.
//
// Ordering and status vocabulary are lib/ladder's and lib/rail-view's; this
// file only paints — including WHICH rows fold, which is lib/ladder's
// `stripItems`.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CollapsedRow, stripItems } from '../lib/ladder';

export function CollapsedStrip(props: {
  /** collapsed sessions, in rail order (lib/ladder collapsedRows) */
  rows: readonly CollapsedRow[];
  /** the card the user is in — §5.8 never folds it away (P2-E9-08) */
  activeCardId?: string | null;
  /** bring this session back to its slot (§5.8's reveal contract) */
  onExpand: (cardId: string) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  // §5.8's idle aggregation (P2-E9-08). The DISCLOSURE is deliberately local and
  // deliberately not persisted: it is a "let me look at that for a second", not
  // a workspace arrangement, and §5.25's promise to bring the workspace back as
  // you left it is about where sessions ARE, not about which summary row you
  // happened to have open when you quit.
  const [showIdle, setShowIdle] = React.useState(false);
  const items = React.useMemo(
    () => stripItems(props.rows, { activeCardId: props.activeCardId ?? null }),
    [props.rows, props.activeCardId]
  );
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
        // never give up height (#274), same call as the urgency strip's. The
        // 24px floor below is not a substitute: it is a number that happens to
        // sit near today's row height, and a larger UI font walks past it
        flexShrink: 0,
        minBlockSize: 24,
        overflowX: 'auto',
        background: 'var(--panel)',
        borderBlockEnd: '1px solid var(--border)',
      }}
    >
      <span style={{ flex: '0 0 auto', fontSize: 10, color: 'var(--faint)', whiteSpace: 'nowrap' }}>
        {t('ladder.stripLabel')}
      </span>
      {items.map((item) =>
        item.kind === 'row' ? (
          <Row key={item.row.cardId} row={item.row} onExpand={props.onExpand} t={t} />
        ) : (
          <React.Fragment key="idle-fold">
            <IdleFold
              count={item.rows.length}
              open={showIdle}
              onToggle={() => setShowIdle((o) => !o)}
              t={t}
            />
            {/* Disclosed rows are ORDINARY rows, so a folded session is exactly
                two gestures from being back on screen (§4's two-gesture rule):
                open the fold, click the session. One gesture, if you go via the
                rail — which lists it whether the fold is open or not. */}
            {showIdle &&
              item.rows.map((r) => (
                <Row key={r.cardId} row={r} onExpand={props.onExpand} t={t} />
              ))}
          </React.Fragment>
        )
      )}
    </div>
  );
}

/** §5.8's "N idle sessions" row (P2-E9-08) — a summary that opens, not a rung.
 *  It wears the collapsed row's chrome so the strip reads as one list, and a
 *  dashed edge so it is visibly a container rather than a session. */
function IdleFold(props: {
  count: number;
  open: boolean;
  onToggle: () => void;
  t: TFunction;
}): React.JSX.Element {
  const { t } = props;
  const label = props.open
    ? t('ladder.idleFoldHide', { count: props.count })
    : t('ladder.idleFoldShow', { count: props.count });
  return (
    <button
      type="button"
      className="collapsed-row idle-fold"
      // the COUNT on the attribute, like the strip's other data-* facts: it is
      // what the rule is about, and reading it out of the label would make the
      // e2e depend on a translated string
      data-idle-fold={props.count}
      data-open={props.open}
      aria-expanded={props.open}
      title={label}
      aria-label={label}
      onClick={props.onToggle}
    >
      <span aria-hidden className="collapsed-accent" />
      <span className="collapsed-name">{t('ladder.idleFold', { count: props.count })}</span>
      <span aria-hidden className="collapsed-state">
        {props.open ? t('ladder.idleFoldOpenIcon') : t('ladder.idleFoldIcon')}
      </span>
    </button>
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
      data-pinned={!!r.pinned}
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
      {/* §5.8's pin (E9-09). Worth drawing HERE and not only in the rail: a
          pinned row is the one row that visibly refused to fold in with the
          other idle ones, and without the mark the strip shows an exception
          with nothing saying why. Decorative — the button's own `aria-label`
          already carries the row's whole name. */}
      {r.pinned && (
        <span aria-hidden className="collapsed-pin">
          {props.t('rail.pinIcon')}
        </span>
      )}
      <span className="collapsed-name">{r.title}</span>
      <span className="collapsed-state">{props.t(r.labelKey)}</span>
    </button>
  );
}
