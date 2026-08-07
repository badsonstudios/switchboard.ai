// Events panel (P1-E4-01 → renamed from "Feed" per Dan 2026-07-22, §5.12):
// what needs attention right now — ONE item per session, its latest state.
// Items are pushed wholesale from the main process (adds, replacements, and
// removals when a permission is answered or a session closes).
//
// E9-03: the panel no longer subscribes to events itself and no longer decides
// their order. App owns the subscription and lib/queue owns the ordering, so
// what you read top-to-bottom here is exactly what Ctrl+Space will walk —
// "the feed is the log, the queue is the to-do list" (§5.12).
import { EventDto } from '../model/types';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { RailSession } from './SessionsRail';
import { panelOrder, nextInQueue } from '../lib/queue';

export type { EventDto } from '../model/types';

/** Space the status line leaves for the out-of-flow Dismiss button (#197).
 *  Sized to the widest thing that button can hold, which is a translated word
 *  rather than "Dismiss" (~61px) — generous on purpose, because the failure
 *  mode is text running underneath a control. */
const DISMISS_GUTTER = 64;

/**
 * An event kind's colour, TWICE — because a ring and a word are not the same
 * job (#246, the rule #221 established).
 *
 * `--status-<x>` is tuned to be seen as a dot, a ring or a tint; only
 * `--status-<x>-ink` is tuned against what is behind a WORD. One map served
 * both here, so the row's status line was painted in the raw hue: 1.80:1 for
 * needs-input on daylight's `--panel2`, 2.34-3.10:1 for the rest, and
 * 3.41-4.49:1 on nordic. The ring keeps the hue (an edge is held to 3:1, and
 * it clears that); the word takes the ink and lands at 5.25-12.36:1.
 *
 * `ready` has no ramp position and stays `--faint` in both — it is the only
 * kind that is not a status, and `--faint` is deliberately a hint rather than
 * text. Left alone rather than quietly promoted: see #246's hand-off, along
 * with this row's `opacity: 0.82`, which dims EVERY colour on a reviewed row
 * and is the reason those still miss 4.5:1 even with the ink.
 */
const KIND_HUE: Record<EventDto['kind'], string> = {
  done: 'var(--status-done)',
  ready: 'var(--faint)',
  'needs-input': 'var(--status-needs-input)',
  'needs-permission': 'var(--status-needs-permission)',
  crashed: 'var(--status-crashed)',
};
const KIND_INK: Record<EventDto['kind'], string> = {
  done: 'var(--status-done-ink)',
  ready: 'var(--faint)',
  'needs-input': 'var(--status-needs-input-ink)',
  'needs-permission': 'var(--status-needs-permission-ink)',
  crashed: 'var(--status-crashed-ink)',
};

export function EventsPanel(props: {
  sessions: readonly RailSession[];
  /** the feed's current items — App owns the subscription (E9-03) */
  events: readonly EventDto[];
  /**
   * The subset the attention QUEUE may see — the same list minus the sessions
   * whose focus policy is `none` (E9-10). Only the next-up highlight reads it:
   * the list itself still shows every event, because §5.12's line is that the
   * feed is the log and the queue is the to-do list.
   *
   * REQUIRED, not defaulted to `events`. A mount that forgot it would silently
   * highlight a row `Ctrl+Space` will skip — the panel and the hotkey disagreeing
   * is the exact failure E9-03 moved this subscription up to App to prevent.
   */
  queueEvents: readonly EventDto[];
  /** event ids the walk has already taken you to (App owns the cursor) */
  visited: ReadonlySet<number>;
  onFocus: (sessionId: string) => void;
  /** the user opened this event by hand — mark it visited in the walk (E9-03).
   *  Required, not optional: a second call site that forgot it would silently
   *  send the hotkey back to the row the user just opened. */
  onVisit: (eventId: number) => void;
  /** label for the jump hotkey, e.g. 'Ctrl+Space' — derived from the registry */
  queueBinding: string;
  /** a saved display is back — offer a one-click layout restore (E8-06) */
  reconnectOffer?: boolean;
  onRestoreLayout?: () => void;
  onDismissOffer?: () => void;
  /**
   * The update feature's one non-modal surface (E19-04), in two flavours:
   *
   *   • `installed` — "You're now on vX", the post-update handshake. It goes
   *     HERE rather than in a dialog because the news is worth a glance and not
   *     worth a click, and this panel is already where "something happened"
   *     lives.
   *   • `available` — the release is still on offer. Shown once the dialog is
   *     out of the way without being answered (Escape, click-away, or a
   *     cancelled download), which is the item's "the persistent update
   *     available affordance remains". **Ignore and Skip do not produce it** —
   *     those are answers, and re-asking in the corner would make them lies.
   */
  updateNotice?: { kind: 'installed' | 'available'; version: string } | null;
  /** the `available` notice's button: reopen the dialog */
  onUpdateNow?: () => void;
  onDismissUpdateNotice?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  // the panel's heading doubles as the list's label — one "Events", not two
  const eyebrowId = React.useId();
  const events = props.events;
  const ordered = panelOrder(events);
  // Where the hotkey will actually take you next — the same function the
  // hotkey itself calls, fed the same cursor. Anything cheaper (say, always
  // the head of the queue) would be a lie from the second press onward.
  const head = nextInQueue(props.queueEvents, props.visited).next?.id ?? null;

  // events carry the LIVE session id; the rail rows know both ids (Dan #9 —
  // the panel was showing raw live-id fragments instead of session names)
  const byId = new Map<string, RailSession>();
  for (const s of props.sessions) {
    byId.set(s.id, s);
    if (s.liveId) byId.set(s.liveId, s);
  }

  return (
    <aside
      style={{
        inlineSize: 220,
        background: 'var(--panel)',
        borderInlineStart: '1px solid var(--border)',
        paddingInline: 7,
        paddingBlock: 8,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        id={eyebrowId}
        style={{
          fontSize: 9,
          letterSpacing: 1.3,
          fontWeight: 600,
          color: 'var(--faint)',
          textTransform: 'uppercase',
          marginBlockEnd: 8,
        }}
      >
        {t('events.eyebrow')}
      </div>
      {head !== null && props.queueBinding && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--muted)',
            marginBlockEnd: 6,
            fontFamily: 'var(--font-mono)',
          }}
        >
          {t('events.queueHint', { binding: props.queueBinding })}
        </div>
      )}
      {props.updateNotice && (
        // Same shell as the reconnect offer below — one notice shape in this
        // panel, so a second kind of "here is a thing you might do" does not
        // teach the eye a second pattern. Bordered in `--faint` rather than a
        // status hue: an update is news, not attention.
        <div
          data-events-notice={props.updateNotice.kind}
          style={{
            background: 'var(--panel2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-chip)',
            padding: '7px 9px',
            marginBlockEnd: 6,
            fontSize: 11,
          }}
        >
          <div
            // Both arrive AFTER mount — one from a handshake round-trip, one
            // when a dialog closes — so a screen reader would otherwise never
            // hear either. `status` rather than `alert`: this is news, and news
            // waits for a pause. (The reconnect offer below predates the rule
            // and is left alone rather than changed in an unrelated item.)
            role="status"
            aria-live="polite"
            style={{ color: 'var(--text)', marginBlockEnd: 6 }}
          >
            {props.updateNotice.kind === 'installed'
              ? t('events.updateInstalled', { version: props.updateNotice.version })
              : t('events.updateAvailable', { version: props.updateNotice.version })}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {props.updateNotice.kind === 'available' && (
              <button
                onClick={props.onUpdateNow}
                style={{
                  background: 'var(--btn-primary-bg)',
                  color: 'var(--btn-primary-text)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-chip)',
                  padding: '2px 10px',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontFamily: 'var(--font-ui)',
                }}
              >
                {t('events.updateNow')}
              </button>
            )}
            <button
              onClick={props.onDismissUpdateNotice}
              style={{
                background: 'transparent',
                color: 'var(--muted)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-chip)',
                padding: '2px 10px',
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: 'var(--font-ui)',
              }}
            >
              {props.updateNotice.kind === 'installed' ? t('events.gotIt') : t('events.notNow')}
            </button>
          </div>
        </div>
      )}
      {props.reconnectOffer && (
        <div
          style={{
            background: 'var(--panel2)',
            border: '1px solid var(--status-working)',
            borderRadius: 'var(--radius-chip)',
            padding: '7px 9px',
            marginBlockEnd: 6,
            fontSize: 11,
          }}
        >
          <div style={{ color: 'var(--text)', marginBlockEnd: 6 }}>{t('events.reconnectOffer')}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={props.onRestoreLayout}
              style={{
                background: 'var(--btn-primary-bg)',
                color: 'var(--btn-primary-text)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-chip)',
                padding: '2px 10px',
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: 'var(--font-ui)',
              }}
            >
              {t('events.restore')}
            </button>
            <button
              onClick={props.onDismissOffer}
              style={{
                background: 'transparent',
                color: 'var(--muted)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-chip)',
                padding: '2px 10px',
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: 'var(--font-ui)',
              }}
            >
              {t('events.notNow')}
            </button>
          </div>
        </div>
      )}
      {events.length === 0 && !props.reconnectOffer && !props.updateNotice && (
        <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t('events.empty')}</div>
      )}
      {/* A real list, so the rows read as a set and their count is announced
          (#197). Only the rows are inside it — the eyebrow, the hotkey hint and
          the reconnect offer are not list items and would inflate that count. */}
      <div role="list" aria-labelledby={eyebrowId}>
        {ordered.map((e) => {
          const s = byId.get(e.sessionId);
          const isNext = e.id === head;
          const reviewed = e.kind === 'ready';
          const open = (): void => {
            props.onFocus(s?.id ?? e.sessionId);
            // clicking IS visiting: the hotkey must not send you straight back to
            // the row you just opened by hand (§5.8 — a click anywhere is a
            // reveal trigger). Pressing Enter on the row's button is the same act.
            props.onVisit?.(e.id);
            void window.switchboard.events.ack(e.sessionId); // Done. -> Ready
          };
          return (
            <div
              key={e.id}
              role="listitem"
              data-event-kind={e.kind}
              data-next={isNext ? 'true' : undefined}
              title={reviewed ? t('events.reviewed') : undefined}
              onClick={open}
              style={{
                position: 'relative',
                background: 'var(--panel2)',
                borderRadius: 'var(--radius-chip)',
                padding: '6px 9px 6px 12px',
                marginBlockEnd: 4,
                cursor: 'pointer',
                fontSize: 11,
                // outline, not border: a ring that shifts the row's box would
                // make the whole list jump every time the head changes
                outline: isNext ? `1px solid ${KIND_HUE[e.kind]}` : undefined,
                outlineOffset: -1,
                // the reviewed tail is a log, not a to-do — it recedes, but it
                // still has to be readable (Dan 2026-07-26: 0.65 was too dim)
                opacity: reviewed ? 0.82 : 1,
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  insetInlineStart: 0,
                  insetBlockStart: 0,
                  insetBlockEnd: 0,
                  inlineSize: 3,
                  background: s?.accent ?? 'var(--faint)',
                  borderRadius: 2,
                }}
              />
              {/* The row's real control (#197). Same call as #174's tool boxes:
                  the row CONTAINS a button (Dismiss), so the row itself cannot BE
                  one — a `button` takes presentational children, which would hide
                  the dismiss from a screen reader. So the readable body is the
                  button, the row div stays a role-less mouse convenience that
                  duplicates it, and its accessible name is the whole event: which
                  session, when, what it is doing, and what state it is in. */}
              <button
                type="button"
                className="event-open"
                data-event-open={e.id}
                onClick={(ev) => {
                  ev.stopPropagation(); // the row below would otherwise re-run it
                  open();
                }}
                style={{
                  display: 'block',
                  inlineSize: '100%',
                  textAlign: 'start',
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  margin: 0,
                  font: 'inherit',
                  fontSize: 11,
                  color: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <span style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                  <span
                    style={{
                      fontWeight: 600,
                      color: 'var(--text)',
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {s?.title ?? t('events.unknownSession')}
                  </span>
                  <span style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
                    {new Date(e.at).toLocaleTimeString()}
                  </span>
                </span>
                {/* always rendered so every item is the SAME height (Dan round 4) */}
                <span
                  style={{
                    display: 'block',
                    color: 'var(--muted)',
                    fontSize: 10,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {s?.taskLabel ?? ' '}
                </span>
                {/* the status line reserves the corner Dismiss sits in, so a long
                    status can never run underneath it */}
                <span
                  style={{
                    display: 'block',
                    color: KIND_INK[e.kind],
                    marginBlockStart: 1,
                    // width AND height: Dismiss is out of flow now, so this
                    // line is the only thing holding the row tall enough for
                    // it. Without the min height its button rides up into the
                    // task label above, which has no gutter of its own.
                    paddingInlineEnd: DISMISS_GUTTER,
                    minBlockSize: 16,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t(`events.kind.${e.kind}`)}
                  {isNext && (
                    <span
                      title={t('events.nextUpHint')}
                      style={{
                        marginInlineStart: 6,
                        fontSize: 9,
                        letterSpacing: 0.6,
                        textTransform: 'uppercase',
                        color: 'var(--faint)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {t('events.nextUp')}
                    </span>
                  )}
                </span>
              </button>
              {/* Dismiss keeps the bottom-right corner it has always had — out of
                  the click path of the row you are trying to OPEN (Dan
                  2026-07-26) — but it is a SIBLING of the open button now:
                  nested inside, it would have been unreachable by keyboard. */}
              <button
                onClick={(ev) => {
                  ev.stopPropagation(); // dismiss, don't focus
                  void window.switchboard.events.dismiss(e.sessionId);
                }}
                type="button"
                className="event-dismiss"
                title={t('events.dismissHint')}
                style={{
                  position: 'absolute',
                  insetBlockEnd: 6,
                  insetInlineEnd: 9,
                  background: 'var(--chip)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-chip)',
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  fontSize: 9.5,
                  lineHeight: 1.4,
                  padding: '0 7px',
                  fontFamily: 'var(--font-ui)',
                }}
              >
                {t('events.dismiss')}
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
