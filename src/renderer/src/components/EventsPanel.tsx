// Events panel (P1-E4-01 → renamed from "Feed" per Dan 2026-07-22, §5.12):
// what needs attention right now — ONE item per session, its latest state.
// Items are pushed wholesale from the main process (adds, replacements, and
// removals when a permission is answered or a session closes).
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RailSession } from './chrome';

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
  onFocus: (sessionId: string) => void;
  /** a saved display is back — offer a one-click layout restore (E8-06) */
  reconnectOffer?: boolean;
  onRestoreLayout?: () => void;
  onDismissOffer?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [events, setEvents] = useState<EventDto[]>([]);

  useEffect(() => {
    // a push landing while list() is in flight must not be overwritten by
    // the stale snapshot (review P1 #15) — pushes always win
    let gotPush = false;
    const off = window.switchboard.events.onChanged((l) => {
      gotPush = true;
      setEvents(l as EventDto[]);
    });
    void window.switchboard.events.list().then((l) => {
      if (!gotPush) setEvents(l as EventDto[]);
    });
    return off;
  }, []);

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
      {[...events].reverse().map((e) => {
        const s = byId.get(e.sessionId);
        return (
          <div
            key={e.id}
            onClick={() => {
              props.onFocus(s?.id ?? e.sessionId);
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
            {s?.taskLabel && (
              <div
                style={{
                  color: 'var(--muted)',
                  fontSize: 10,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.taskLabel}
              </div>
            )}
            <span style={{ color: KIND_TOKEN[e.kind] }}>{t(`events.kind.${e.kind}`)}</span>
          </div>
        );
      })}
    </aside>
  );
}
