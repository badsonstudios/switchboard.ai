// The sessions strip across the top (#1143) — the frame.
//
// The other place the sessions can be listed: one line of controls and, under
// it, one row that will hold the groups and then the loose sessions. While it is
// on, the left rail is gone. The lamps row and the collapsed row are meant to go
// too and are replaced by this strip's own entries — once it has entries. Until
// then App keeps both, and says why where it mounts this.
//
// THIS IS THE FRAME ONLY. The groups, the session pills, the arrow cells at
// each end, the menus and the dragging each land in their own change, and until
// the first two have, the row says so in words rather than sitting there empty:
// an empty row over a workspace full of sessions reads as "your sessions are
// gone", which is the one thing a list of sessions must never say by accident.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { tint } from '../lib/tint';

export function SessionsStrip(props: {
  /**
   * Gated INSIDE, like the banners in the shell column: App renders this
   * unconditionally and says whether it is wanted, so the shell's children stay
   * a flat list `always-visible-notices.test.ts` can read off the file.
   */
  shown: boolean;
  /** how many sessions are open, in groups or loose */
  sessionCount: number;
  /**
   * How many groups the user has made. Shown in the row's one line of words
   * while groups are not drawn yet, because without it "+ group" changes
   * nothing you can see and reads as a button that did not work — which is how
   * you end up with five groups called "New group".
   */
  groupCount: number;
  /** how many of them need you — the store's own count, the one the rail's
   *  footer and the lamps row show (#621, #1137) */
  needCount: number;
  onCreateGroup: (name: string) => void;
  onNewSession: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (!props.shown) return null;

  const lineButton: React.CSSProperties = {
    background: 'transparent',
    color: 'var(--muted)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-chip)',
    padding: '1px 8px',
    cursor: 'pointer',
    fontFamily: 'var(--font-ui)',
    fontSize: 10.5,
    whiteSpace: 'nowrap',
  };

  return (
    <div
      data-testid="sessions-strip"
      role="group"
      aria-label={t('strip.label')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        // never give up height (#274): this is the only list of sessions on
        // screen while it is on, and the shell column squeezes its auto-basis
        // children first
        flexShrink: 0,
        background: 'var(--panel2)',
        borderBlockEnd: '1px solid var(--border)',
      }}
    >
      {/* THE LINE ABOVE. In this order and nothing else: "+ group",
          "+ session", then the ONE total. It does not scroll — the row below
          will, and "7 need you" sliding off the edge is exactly when it starts
          to matter. */}
      <div
        data-strip-line
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingInline: 8,
          paddingBlock: 3,
          minBlockSize: 23,
        }}
      >
        <button
          type="button"
          data-strip-add-group
          title={t('rail.addGroupHint')}
          onClick={() => props.onCreateGroup(t('rail.newGroup'))}
          style={lineButton}
        >
          {t('rail.addGroup')}
        </button>
        <button
          type="button"
          data-strip-add-session
          title={t('strip.addSessionHint')}
          onClick={props.onNewSession}
          style={lineButton}
        >
          {t('strip.addSession')}
        </button>
        {props.needCount > 0 && (
          <span
            data-strip-need
            style={{
              borderRadius: 'var(--radius-chip)',
              padding: '1px 8px',
              fontFamily: 'var(--font-ui)',
              fontSize: 10.5,
              fontWeight: 700,
              whiteSpace: 'nowrap',
              color: 'var(--status-needs-input-ink)',
              background: tint('var(--status-needs-input)', 18),
              border: `1px solid ${tint('var(--status-needs-input)', 45)}`,
            }}
          >
            {t('urgency.needYou', { n: props.needCount })}
          </span>
        )}
      </div>
      {/* THE ROW. Its height is the finished strip's (two-line entries), held
          open now so the workspace does not jump when the entries arrive. */}
      <div
        data-strip-row
        style={{
          display: 'flex',
          alignItems: 'center',
          paddingInline: 8,
          minBlockSize: 53,
          borderBlockStart: '1px solid var(--border)',
          color: 'var(--muted)',
          fontFamily: 'var(--font-ui)',
          fontSize: 11,
        }}
      >
        <span
          data-strip-empty={props.sessionCount === 0 && props.groupCount === 0 ? 'none' : 'pending'}
        >
          {props.sessionCount === 0 && props.groupCount === 0
            ? t('rail.empty')
            : t('strip.pending', { count: props.sessionCount, groups: props.groupCount })}
        </span>
      </div>
    </div>
  );
}
