// Event feed panel (P1-E4-01, §5.12): attention events with session color
// stripes, newest first, click-to-focus.
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RailSession } from './chrome';

export interface FeedEventDto {
  id: number;
  sessionId: string;
  kind: 'done' | 'needs-input' | 'needs-permission' | 'crashed';
  at: string;
}

const KIND_TOKEN: Record<FeedEventDto['kind'], string> = {
  done: 'var(--status-done)',
  'needs-input': 'var(--status-needs-input)',
  'needs-permission': 'var(--status-needs-permission)',
  crashed: 'var(--status-crashed)',
};

export function FeedPanel(props: {
  sessions: RailSession[];
  onFocus: (sessionId: string) => void;
  /** a saved display is back — offer a one-click layout restore (E8-06) */
  reconnectOffer?: boolean;
  onRestoreLayout?: () => void;
  onDismissOffer?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [events, setEvents] = useState<FeedEventDto[]>([]);

  useEffect(() => {
    void window.switchboard.feed.list().then((l) => setEvents(l as FeedEventDto[]));
    return window.switchboard.feed.onEvent((e) =>
      setEvents((prev) => [...prev.slice(-199), e as FeedEventDto])
    );
  }, []);

  const byId = new Map(props.sessions.map((s) => [s.id, s]));
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
        {t('feed.eyebrow')}
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
          <div style={{ color: 'var(--text)', marginBlockEnd: 6 }}>{t('feed.reconnectOffer')}</div>
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
              {t('feed.restore')}
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
              {t('feed.notNow')}
            </button>
          </div>
        </div>
      )}
      {events.length === 0 && (
        <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t('feed.empty')}</div>
      )}
      {[...events].reverse().map((e) => {
        const s = byId.get(e.sessionId);
        return (
          <div
            key={e.id}
            onClick={() => props.onFocus(e.sessionId)}
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
              <span style={{ fontWeight: 600, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s?.title ?? e.sessionId.slice(0, 8)}
              </span>
              <span style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
                {new Date(e.at).toLocaleTimeString()}
              </span>
            </div>
            <span style={{ color: KIND_TOKEN[e.kind] }}>{t(`feed.kind.${e.kind}`)}</span>
          </div>
        );
      })}
    </aside>
  );
}
