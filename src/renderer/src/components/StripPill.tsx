// One session that is not in a group, as a pill on the sessions strip (#1143).
//
// The strip's answer to a rail row for a loose session: the same facts in a
// two-line cell — name and the state as one short word, what it is working on
// underneath, the status mark at the end, the session's colour as a bar down
// the start edge. It carries the same live status looks as a row in every
// state, because it is built from the row's own pieces: `attentionPaint` for
// who is lit, `presentStatus` for the word, `StatusMark` for the mark, and
// `sessionSpokenName` for what it is called out loud.
//
// THE EDGE SAYS WHETHER IT IS ON SCREEN. Solid: its card is in the workspace.
// Dashed: it is folded away (collapsed or hidden), and a click brings it back.
// This is what the collapsed row used to be for; in this placement the pill is
// the only place a folded-away session is listed at all.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { RailSession } from '../model/types';
import { attentionPaint, presentStatus } from '../lib/rail-view';
import { tint } from '../lib/tint';
import { sessionSpokenName } from './SessionRow';
import { StatusMark } from './StatusMark';

export function StripPill(props: {
  session: RailSession;
  /** is this session one of the N the strip's total is counting (#1137) */
  needsYou: boolean;
  /** the card the grid is currently showing */
  selected: boolean;
  pinned: boolean;
  /** messages other sessions have left here (#774) */
  waiting: number;
  /** nested under the pill before it: the session that dispatched it (#951) */
  nested: boolean;
  /** its card is collapsed or hidden — not on screen until it is clicked */
  folded: boolean;
  /** the last jump landed here, and its beat has not run out (§5.8) */
  flash: boolean;
  onFocus: () => void;
  onContextMenu?: React.MouseEventHandler<HTMLButtonElement>;
  /** the drag handlers: a pill is dragged sideways to reorder, or onto a group */
  dragProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  /** a dragged pill would land on this side of it */
  dropEdge?: 'before' | 'after';
}): React.JSX.Element {
  const { t } = useTranslation();
  const s = props.session;
  const p = presentStatus(s.status);
  // WHO NEEDS YOU is the count's own answer (#1137), not the status's: a pill
  // is filled exactly when its session is one of the N in the line above.
  const paint = attentionPaint(s.status, props.needsYou);
  const hue = `var(--status-${paint.token})`;
  const ink = `var(--status-${paint.token}-ink)`;
  const accent = s.accent ?? 'var(--faint)';
  const spoken = sessionSpokenName(t, s, props.pinned, props.waiting);
  // a needy session outranks selection, and outranks being folded away: a pill
  // that needs you is filled in whether its card is on screen or not
  const fill = paint.lit
    ? tint(hue, 14)
    : props.selected
      ? tint(accent, 12)
      : props.folded
        ? 'transparent'
        : 'var(--rail-card)';
  const edge = paint.lit ? hue : props.selected ? accent : 'var(--group-frame)';

  return (
    <button
      type="button"
      data-strip-pill={s.id}
      // hover shows this session's last prompt (#631, `LastPromptHover`)
      data-last-prompt-for={s.id}
      data-needs-you={paint.lit}
      // read back by the strip when it measures what is off each end
      data-strip-item-need={paint.lit ? 1 : 0}
      data-session-status={p.token}
      data-folded={props.folded}
      data-pinned={props.pinned}
      data-flash={props.flash ? 'true' : undefined}
      // the row's own words, plus the one fact only a pill carries
      aria-label={props.folded ? t('strip.pillFolded', { name: spoken }) : spoken}
      aria-current={props.selected ? 'true' : undefined}
      title={props.folded ? t('strip.pillFoldedHint') : undefined}
      onClick={props.onFocus}
      onContextMenu={props.onContextMenu}
      {...props.dragProps}
      data-drop-edge={props.dropEdge}
      style={{
        // the session's own colour, for the "working" look in force (#718)
        ['--work-accent' as string]: accent,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
        maxInlineSize: 210,
        minBlockSize: 43,
        paddingBlock: 4,
        paddingInlineStart: 11,
        paddingInlineEnd: 8,
        margin: 0,
        borderRadius: 7,
        border: `1px ${props.folded ? 'dashed' : 'solid'} ${edge}`,
        background: fill,
        // the post-jump beat: the focus accent, as on a row in a list
        boxShadow: props.flash ? '0 0 0 2px var(--status-working-ink)' : undefined,
        font: 'inherit',
        color: 'inherit',
        textAlign: 'start',
        cursor: 'pointer',
        // a folded-away session that is calm steps back; one that needs you does not
        opacity: props.folded && !paint.lit ? 0.72 : 1,
      }}
    >
      {props.dropEdge && (
        // The insertion line: where the thing you are dragging will land. The
        // rail's own (#559), stood on end — same ink as the focus ring, because it
        // is the same kind of statement.
        <span
          aria-hidden
          data-drop-line={props.dropEdge}
          style={{
            position: 'absolute',
            insetBlock: 2,
            [props.dropEdge === 'before' ? 'insetInlineStart' : 'insetInlineEnd']: 0,
            inlineSize: 2,
            borderRadius: 1,
            background: 'var(--status-working-ink)',
            zIndex: 1,
          }}
        />
      )}
      <span
        aria-hidden
        data-accent-bar
        style={{
          position: 'absolute',
          insetInlineStart: 0,
          insetBlockStart: 4,
          insetBlockEnd: 4,
          // thickens when it needs you, as the row's does
          inlineSize: paint.lit ? 4 : 2.5,
          borderRadius: '0 2px 2px 0',
          background: paint.lit ? hue : props.selected ? accent : tint(accent, 45),
        }}
      />
      {props.nested && (
        <span
          aria-hidden
          data-strip-lineage={s.id}
          style={{ fontSize: 11, lineHeight: 1, color: 'var(--faint)', flex: 'none' }}
        >
          {t('rail.lineageMark')}
        </span>
      )}
      <span
        aria-hidden
        style={{ display: 'flex', flexDirection: 'column', gap: 2, minInlineSize: 0 }}
      >
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span
            data-strip-pill-title
            style={{
              minInlineSize: 0,
              fontSize: 11.5,
              fontWeight: paint.lit ? 700 : 600,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {s.title}
          </span>
          <span
            data-strip-pill-state
            style={{
              flexShrink: 0,
              fontFamily: 'var(--font-ui)',
              fontSize: 9,
              fontWeight: 700,
              color: paint.stateInk ? ink : 'var(--muted)',
              whiteSpace: 'nowrap',
            }}
          >
            {t(p.shortKey)}
          </span>
        </span>
        {/* ONE line, whatever the task-label size setting says: the strip's
            height is fixed, and the em dash holds the line open when there is
            no label so a pill does not change shape when one lands. */}
        <span
          data-strip-pill-label
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9.5,
            lineHeight: 1.35,
            color: s.taskLabel ? 'var(--muted)' : 'var(--faint)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {s.taskLabel ?? '—'}
        </span>
      </span>
      {props.pinned && (
        <span
          aria-hidden
          title={t('rail.pinnedHint')}
          style={{ fontSize: 9, lineHeight: 1, flexShrink: 0, color: 'var(--muted)' }}
        >
          {t('rail.pinIcon')}
        </span>
      )}
      {props.waiting > 0 && (
        // What other sessions have left here. Its own mark beside the status,
        // never instead of it, and never part of "need you" — the same call the
        // row makes, in the same ink.
        <span
          aria-hidden
          data-strip-pill-waiting={s.id}
          title={t('rail.waitingHint', { count: props.waiting })}
          style={{
            minInlineSize: 16,
            blockSize: 16,
            borderRadius: 8,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            paddingInline: 4,
            fontFamily: 'var(--font-ui)',
            fontWeight: 700,
            fontSize: 9.5,
            lineHeight: 1,
            color: 'var(--status-working-ink)',
            background: tint('var(--status-working)', 18),
          }}
        >
          {props.waiting}
        </span>
      )}
      <StatusMark status={s.status} needsYou={props.needsYou} />
    </button>
  );
}
