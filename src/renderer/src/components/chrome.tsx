// Window chrome (P1-E3-01): title bar, sessions rail, status bar — layout per
// design_handoff_control_room. Real identity kit / live badges arrive with
// E3-03/E3-05; rows here reflect the grid's current cards.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ThemePreference } from '../theme/theme';
import { LanguageChoice } from '../i18n';
import { IdentityChip } from './IdentityChip';

const barStyle: React.CSSProperties = {
  background: 'var(--titlebar-bg)',
  borderBlockEnd: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  paddingInline: 12,
  fontSize: 12,
  minBlockSize: 34,
};

export function TitleBar(props: {
  version: string;
  pref: ThemePreference;
  onTheme: (p: ThemePreference) => void;
  lang: LanguageChoice;
  onLang: (l: LanguageChoice) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <header style={barStyle}>
      <strong style={{ fontWeight: 600 }}>{t('app.title')}</strong>
      <span style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
        {t('titlebar.version', { version: props.version })}
      </span>
      <span style={{ flex: 1 }} />
      {(['system', 'nordic', 'daylight'] as const).map((p) => (
        <Chip key={p} selected={p === props.pref} onClick={() => props.onTheme(p)}>
          {t(`theme.${p}`)}
        </Chip>
      ))}
      {(['en', 'pseudo'] as const).map((l) => (
        <Chip key={l} selected={l === props.lang} onClick={() => props.onLang(l)}>
          {t(`language.${l}`)}
        </Chip>
      ))}
    </header>
  );
}

export interface RailSession {
  id: string;
  title: string;
  accent?: string;
  badge?: string;
  status?: string;
}

const STATUS_TOKEN: Record<string, string> = {
  starting: 'var(--status-idle)',
  working: 'var(--status-working)',
  'needs-input': 'var(--status-needs-input)',
  'needs-permission': 'var(--status-needs-permission)',
  idle: 'var(--status-idle)',
  done: 'var(--status-done)',
  crashed: 'var(--status-crashed)',
};

export function SessionsRail(props: {
  sessions: RailSession[];
  onRename: (id: string, title: string) => void;
  onFocus: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  return (
    <nav
      style={{
        inlineSize: 200,
        background: 'var(--panel)',
        borderInlineEnd: '1px solid var(--border)',
        paddingInline: 7,
        paddingBlock: 8,
        overflowY: 'auto',
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
        {t('rail.eyebrow')}
      </div>
      {props.sessions.length === 0 && (
        <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t('rail.empty')}</div>
      )}
      {props.sessions.map((s) => (
        <div
          key={s.id}
          onClick={() => props.onFocus(s.id)}
          onDoubleClick={() => {
            setEditing(s.id);
            setDraft(s.title);
          }}
          style={{
            position: 'relative',
            padding: '6px 8px 6px 12px',
            borderRadius: 'var(--radius-chip)',
            marginBlockEnd: 2,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span
            style={{
              position: 'absolute',
              insetInlineStart: 0,
              insetBlockStart: 0,
              insetBlockEnd: 0,
              inlineSize: 3,
              background: s.accent ?? 'var(--faint)',
              borderRadius: 2,
            }}
          />
          {editing === s.id ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => setEditing(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  props.onRename(s.id, draft);
                  setEditing(null);
                }
                if (e.key === 'Escape') setEditing(null);
              }}
              style={{
                inlineSize: '100%',
                background: 'var(--panel2)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontSize: 12,
                fontFamily: 'var(--font-ui)',
              }}
            />
          ) : (
            <>
              <span style={{ flex: 1, minInlineSize: 0 }}>
                <IdentityChip title={s.title} accent={s.accent} badge={s.badge} />
              </span>
              <span
                aria-label={s.status}
                title={s.status}
                style={{
                  inlineSize: 7,
                  blockSize: 7,
                  borderRadius: '50%',
                  background: STATUS_TOKEN[s.status ?? ''] ?? 'var(--faint)',
                  flexShrink: 0,
                }}
              />
            </>
          )}
        </div>
      ))}
    </nav>
  );
}

export function StatusBar(props: { count: number; theme: string }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <footer style={{ ...barStyle, borderBlockEnd: 'none', borderBlockStart: '1px solid var(--border)', fontSize: 11, color: 'var(--muted)' }}>
      <span>{t('statusbar.sessions', { count: props.count })}</span>
      <span style={{ flex: 1 }} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
        {t('statusbar.theme', { theme: props.theme })}
      </span>
    </footer>
  );
}

export function Chip(props: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      onClick={props.onClick}
      style={{
        background: props.selected ? 'var(--chip)' : 'transparent',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-chip)',
        padding: '2px 9px',
        cursor: 'pointer',
        fontFamily: 'var(--font-ui)',
        fontSize: 11,
      }}
    >
      {props.children}
    </button>
  );
}
