// Messages from other sessions, waiting in this card's composer (P2-E11-05).
//
// §5.4: a sibling's `send_to_session` lands here as a highlighted "from
// @Session" block and is sent ONLY when the user presses Enter — with whatever
// they typed alongside it, through the composer's ordinary submit. This
// component renders and dismisses; it has no way to send, by design. The whole
// flow is in `lib/sibling-inbox.ts` and `main/sessions/delivery.ts`.
//
// Lives INSIDE the composer's root, above the attachment strip, for the reason
// the strip does: `roomForBox` counts everything in that root as chrome, so the
// textarea's height clamp measures against the room actually left.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { HeldMessage } from '../lib/sibling-inbox';

export function SiblingMessages({
  messages,
  onDismiss,
}: {
  messages: readonly HeldMessage[];
  onDismiss: (id: string) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (messages.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t('feedView.sibling.label')}
      data-sibling-messages=""
      style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      {messages.map((m) => (
        <div
          key={m.id}
          data-sibling-message={m.id}
          style={{
            // Highlighted, per §5.4 — and by an edge AND a wash, never the hue
            // alone (§5.32): the "From @…" line says what it is in words.
            border: '1px solid var(--accent)',
            borderRadius: 8,
            background: 'color-mix(in srgb, var(--accent) 10%, var(--panel))',
            padding: '5px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span
              // Two cards can share a name (two checkouts of one repo), so
              // the session id is one hover away — the same id `list_sessions`
              // shows an agent, so the user and the agent can compare notes.
              title={t('feedView.sibling.fromHint', { name: m.from.name, id: m.from.id })}
              style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', flex: 1, minInlineSize: 0 }}
            >
              {t('feedView.sibling.from', { name: m.from.name })}
            </span>
            <button
              onClick={() => onDismiss(m.id)}
              aria-label={t('feedView.sibling.dismiss', { name: m.from.name })}
              title={t('feedView.sibling.dismiss', { name: m.from.name })}
              data-sibling-dismiss={m.id}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--muted)',
                cursor: 'pointer',
                fontSize: 12,
                lineHeight: 1,
                padding: 0,
              }}
            >
              {t('feedView.sibling.dismissIcon')}
            </button>
          </div>
          <div
            // A sibling's text is shown EXACTLY — no markdown, no links. It is
            // another agent's words on their way into this session, and the user
            // is deciding whether to send them; rendering could hide what they
            // say. Scrolls rather than growing, so a 20k-character message
            // cannot push the box off the panel.
            style={{
              fontSize: 11.5,
              color: 'var(--text)',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              maxBlockSize: 120,
              overflowY: 'auto',
            }}
          >
            {m.text}
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>{t('feedView.sibling.hint')}</div>
        </div>
      ))}
    </div>
  );
}
