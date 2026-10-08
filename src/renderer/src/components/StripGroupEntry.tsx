// One group, as an entry on the sessions strip (#1143).
//
// The strip's answer to the rail's group card: the same facts in one two-line
// cell — whose it is (a dot for a group you made, a folder for one the app
// made), its name, how many sessions, and its own "N need you" — with the
// sessions themselves one click away in a list that drops down from it.
//
// What marks it as a GROUP rather than a session is the tinted arrow panel at
// its end. There is deliberately no menu icon: the menu is a right-click, as it
// is everywhere else in the app.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { RailSession } from '../model/types';
import { needCount } from '../lib/rail-view';
import { tint } from '../lib/tint';
import { FolderGlyph } from './FolderGlyph';

/** the highest N that `Ctrl+N` reaches */
export const LAST_CHORD = 9;

/**
 * The `Ctrl+N` range a group holds, as the two ends to print — or `null` when
 * none of its sessions is within reach of a chord.
 *
 * Today's counting, unchanged: sessions inside the groups first, then the loose
 * ones, so a chord means the same session wherever the list is drawn. A group
 * that straddles the ninth session shows the part that is reachable.
 */
export function chordRange(
  members: readonly RailSession[],
  ordinalOf: ReadonlyMap<string, number>
): { from: number; to: number } | null {
  const reachable = members
    .map((m) => ordinalOf.get(m.id))
    .filter((n): n is number => n !== undefined && n <= LAST_CHORD);
  if (reachable.length === 0) return null;
  return { from: Math.min(...reachable), to: Math.max(...reachable) };
}

export function StripGroupEntry(props: {
  /** the group's key: a made group's id, or `auto:<folder>` */
  groupKey: string;
  /**
   * `group` — yours. A coloured DOT, because a group you named is a label you
   * applied. `auto` — one the app made from a folder. A FOLDER and the word
   * "auto", so the two read as different kinds of thing at a glance, exactly as
   * they do in the rail.
   */
  kind: 'group' | 'auto';
  name: string;
  color: string;
  members: readonly RailSession[];
  /** the cards with an outstanding demand — the count's whole input (#621) */
  needing: ReadonlySet<string>;
  /** messages other sessions have left, per card (#774) */
  waiting: ReadonlyMap<string, number>;
  /** card id -> its place in the jump order, 1-based */
  ordinalOf: ReadonlyMap<string, number>;
  /** its list is showing */
  open: boolean;
  /** the id of the list it opens, for `aria-controls` */
  listId: string;
  /** asked to open or close; the element is what the list is placed against */
  onToggle: (anchor: HTMLElement) => void;
  /** open a NEW session in this group. Absent for an automatic group, whose
   *  membership is derived from a folder and cannot be given */
  onOpenInGroup?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const cell = React.useRef<HTMLDivElement | null>(null);
  const isAuto = props.kind === 'auto';
  // THE COUNT AND THE ROWS AGREE (#1137): this is `needCount` over the same
  // `needing` set the rows in the list are lit from, so "2 need you" is exactly
  // two highlighted rows. It is never re-derived from the members' statuses.
  const need = needCount(props.members, props.needing);
  const waitingHere = props.members.reduce((n, m) => n + (props.waiting.get(m.id) ?? 0), 0);
  const range = chordRange(props.members, props.ordinalOf);
  const summary =
    props.members.length === 0
      ? t('rail.groupEmpty')
      : need > 0
        ? t('rail.needSummary', { count: need })
        : t('rail.calm');
  const toggle = (): void => {
    if (cell.current) props.onToggle(cell.current);
  };

  return (
    <div
      ref={cell}
      data-strip-group={props.groupKey}
      data-strip-group-kind={props.kind}
      data-needs-you={need > 0}
      title={isAuto ? t('rail.autoGroupHint') : undefined}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        flexShrink: 0,
        minBlockSize: 43,
        borderRadius: 7,
        border: `1px solid ${props.open ? props.color : 'var(--group-frame)'}`,
        background: isAuto ? 'var(--auto-surface)' : 'var(--rail-card)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        data-strip-group-open={props.groupKey}
        aria-expanded={props.open}
        aria-controls={props.listId}
        // The whole of what the cell shows, in words: the marks beside the
        // name are decoration, and the second line is two facts a screen reader
        // should hear as one sentence about this group.
        // …and an automatic group says that it is one. The folder and the
        // word "auto" are decoration to a screen reader, so without this
        // nothing tells its user why this group has no "new session" button.
        aria-label={((): string => {
          const name = isAuto ? t('strip.autoGroupName', { name: props.name }) : props.name;
          return waitingHere > 0
            ? t('strip.groupLabelWaiting', {
                name,
                count: props.members.length,
                summary,
                waiting: waitingHere,
              })
            : t('strip.groupLabel', { name, count: props.members.length, summary });
        })()}
        onClick={toggle}
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'flex-start',
          gap: 3,
          paddingBlock: 4,
          paddingInline: 9,
          background: 'transparent',
          border: 'none',
          margin: 0,
          font: 'inherit',
          color: 'inherit',
          textAlign: 'start',
          cursor: 'pointer',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {isAuto ? (
            <span
              aria-hidden
              style={{ color: 'var(--auto-ink)', display: 'flex', alignItems: 'center', flexShrink: 0 }}
            >
              <FolderGlyph />
            </span>
          ) : (
            <span
              aria-hidden
              style={{
                inlineSize: 9,
                blockSize: 9,
                borderRadius: '50%',
                background: props.color,
                flexShrink: 0,
              }}
            />
          )}
          {range && (
            <span
              aria-hidden
              data-strip-group-range
              style={{
                paddingInline: 4,
                borderRadius: 3,
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                lineHeight: 1.4,
                color: 'var(--muted)',
                background: 'var(--chip)',
                whiteSpace: 'nowrap',
              }}
            >
              {range.from === range.to
                ? String(range.from)
                : t('strip.range', { from: range.from, to: range.to })}
            </span>
          )}
          <span
            data-strip-group-name
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: isAuto ? 'var(--auto-ink)' : 'var(--text)',
              whiteSpace: 'nowrap',
            }}
          >
            {props.name}
          </span>
          <span
            aria-hidden
            data-strip-group-count
            style={{
              minInlineSize: 14,
              paddingInline: 4,
              borderRadius: 7,
              textAlign: 'center',
              fontFamily: 'var(--font-ui)',
              fontSize: 9.5,
              fontWeight: 700,
              lineHeight: 1.5,
              color: 'var(--muted)',
              background: tint(props.color, 18),
            }}
          >
            {props.members.length}
          </span>
          {isAuto && (
            <span
              aria-hidden
              style={{
                fontSize: 8.5,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 0.4,
                color: 'var(--auto-ink)',
              }}
            >
              {t('rail.autoBadge')}
            </span>
          )}
        </span>
        <span
          aria-hidden
          style={{ display: 'flex', alignItems: 'center', gap: 5, paddingInlineStart: 15 }}
        >
          <span
            data-strip-group-summary
            style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 9.5,
              fontWeight: need > 0 ? 700 : 400,
              color: need > 0 ? 'var(--status-needs-input-ink)' : 'var(--muted)',
              whiteSpace: 'nowrap',
            }}
          >
            {summary}
          </span>
          {waitingHere > 0 && (
            // Its own fact, beside "need you" and never inside it: a message
            // from another session is something to read, not a session that is
            // blocked on you, so it is not in the count or the strip's total.
            <span
              data-strip-group-waiting
              style={{
                fontFamily: 'var(--font-ui)',
                fontSize: 9.5,
                color: 'var(--status-needs-input-ink)',
                whiteSpace: 'nowrap',
              }}
            >
              {t('strip.groupWaiting', { count: waitingHere })}
            </span>
          )}
        </span>
      </button>
      {props.onOpenInGroup && (
        <button
          type="button"
          className="rail-x"
          data-strip-group-add={props.groupKey}
          title={t('rail.openInGroup')}
          aria-label={t('strip.openInGroupLabel', { name: props.name })}
          onClick={props.onOpenInGroup}
          style={{ fontSize: 13, paddingInline: 6, alignSelf: 'center' }}
        >
          {t('rail.openInGroupIcon')}
        </button>
      )}
      {/* THE ARROW PANEL. The mouse's larger target for the same toggle the
          name button is. NOT a button: a second control that does what the
          first one does is one too many for anyone not aiming a pointer, so
          it is hidden from assistive tech — and a hidden thing must not be
          able to hold focus, which a button clicked with the mouse does. The
          mousedown is cancelled for the same reason: the click still
          toggles, and focus stays where it was. */}
      <span
        aria-hidden
        data-strip-group-arrow={props.groupKey}
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          paddingInline: 8,
          borderInlineStart: `1px solid ${tint(props.color, 45)}`,
          background: tint(props.color, 22),
          color: 'var(--text)',
          fontSize: 10,
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            display: 'inline-block',
            transform: props.open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.12s',
          }}
        >
          {t('rail.chevron')}
        </span>
      </span>
    </div>
  );
}
