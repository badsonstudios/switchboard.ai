// Events panel (P1-E4-01 → renamed from "Feed" per Dan 2026-07-22, §5.12):
// what needs attention right now — ONE item per session, its latest state.
// Items are pushed wholesale from the main process (adds, replacements, and
// removals when a permission is answered or a session closes).
//
// E9-03: the panel no longer subscribes to events itself and no longer decides
// their order. App owns the subscription and lib/queue owns the ordering, so
// what you read top-to-bottom here is exactly what Ctrl+Space will walk —
// "the feed is the log, the queue is the to-do list" (§5.12).
import React from 'react';
import { useTranslation } from 'react-i18next';
import { RailSession } from './SessionsRail';
import { panelOrder, nextInQueue } from '../lib/queue';

export interface EventDto {
  id: number;
  sessionId: string;
  kind: 'done' | 'ready' | 'needs-input' | 'needs-permission' | 'crashed';
  at: string;
}

const KIND_TOKEN: Record<EventDto['kind'], string> = {
  done: 'var(--status-done)',
  ready: 'var(--faint)',
  'needs-input': 'var(--status-needs-input)',
  'needs-permission': 'var(--status-needs-permission)',
  crashed: 'var(--status-crashed)',
};

export function EventsPanel(props: {
  sessions: RailSession[];
  /** the feed's current items — App owns the subscription (E9-03) */
  events: EventDto[];
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
}): React.JSX.Element {
  const { t } = useTranslation();
  const events = props.events;
  const ordered = panelOrder(events);
  // Where the hotkey will actually take you next — the same function the
  // hotkey itself calls, fed the same cursor. Anything cheaper (say, always
  // the head of the queue) would be a lie from the second press onward.
  const head = nextInQueue(events, props.visited).next?.id ?? null;

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
      {events.length === 0 && !props.reconnectOffer && (
        <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t('events.empty')}</div>
      )}
      {ordered.map((e) => {
        const s = byId.get(e.sessionId);
        const isNext = e.id === head;
        const reviewed = e.kind === 'ready';
        return (
          <div
            key={e.id}
            data-event-kind={e.kind}
            data-next={isNext ? 'true' : undefined}
            title={reviewed ? t('events.reviewed') : undefined}
            onClick={() => {
              props.onFocus(s?.id ?? e.sessionId);
              // clicking IS visiting: the hotkey must not send you straight
              // back to the row you just opened by hand (§5.8 — a click
              // anywhere is a reveal trigger)
              props.onVisit?.(e.id);
              void window.switchboard.events.ack(e.sessionId); // Done. -> Ready
            }}
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
              outline: isNext ? `1px solid ${KIND_TOKEN[e.kind]}` : undefined,
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
            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
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
            </div>
            {/* always rendered so every item is the SAME height (Dan round 4) */}
            <div
              style={{
                color: 'var(--muted)',
                fontSize: 10,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {s?.taskLabel ?? ' '}
            </div>
            {/* status on the left, dismiss on the right — the ✕ used to sit in
                the top-right corner, right in the click path of the row you
                were trying to OPEN (Dan 2026-07-26: make it a real button, put
                it out of the way) */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'space-between',
                gap: 6,
                marginBlockStart: 1,
              }}
            >
              <span style={{ color: KIND_TOKEN[e.kind], flex: 1, minInlineSize: 0 }}>
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
              <button
                onClick={(ev) => {
                  ev.stopPropagation(); // dismiss, don't focus
                  void window.switchboard.events.dismiss(e.sessionId);
                }}
                title={t('events.dismissHint')}
                style={{
                  background: 'var(--chip)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-chip)',
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  fontSize: 9.5,
                  lineHeight: 1.4,
                  padding: '0 7px',
                  fontFamily: 'var(--font-ui)',
                  flexShrink: 0,
                }}
              >
                {t('events.dismiss')}
              </button>
            </div>
          </div>
        );
      })}
    </aside>
  );
}
