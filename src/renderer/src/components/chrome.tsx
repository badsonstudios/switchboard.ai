// Window chrome (P1-E3-01): title bar and status bar — layout per
// design_handoff_control_room. The sessions rail outgrew this file and lives
// in ./SessionsRail.tsx (design_handoff_sessions_rail).
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ThemePreference } from '../theme/theme';
import { LanguageChoice } from '../i18n';
import { rendererRegistry } from '../extensibility/registry-instance';
import { listStatusBarItems } from '../extensibility/status-bar-items';
import { ContributionBoundary } from '../extensibility/boundary';
import { StatusBarContext } from '../extensibility/contributions';
import { ThemeDefinition } from '../theme/theme';

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
  /** what the app resolved from — the picker must not offer a theme the
   *  resolver cannot find, or the chip lights on a theme nobody painted */
  themes: readonly ThemeDefinition[];
  onTheme: (p: ThemePreference) => void;
  lang: LanguageChoice;
  onLang: (l: LanguageChoice) => void;
  notifEnabled: boolean;
  onToggleNotif: () => void;
  autonomy: string;
  onCycleAutonomy: () => void;
  autoTrust: boolean;
  onToggleTrust: () => void;
  /** sessions-rail visibility — the mouse path for the Ctrl+B command (E9-01) */
  railHidden: boolean;
  onToggleRail: () => void;
  railBinding: string;
  /** the palette's mouse path (E9-02) — the ONE way in from a terminal, where
   *  no binding may fire */
  onOpenPalette: () => void;
  paletteBinding: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <header style={barStyle}>
      <strong style={{ fontWeight: 600 }}>{t('app.title')}</strong>
      <span style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
        {t('titlebar.version', { version: props.version })}
      </span>
      <span style={{ flex: 1 }} />
      <Chip
        selected={false}
        onClick={props.onOpenPalette}
        title={t('titlebar.paletteHint', { binding: props.paletteBinding })}
      >
        {t('titlebar.palette')}
      </Chip>
      <Chip
        selected={!props.railHidden}
        onClick={props.onToggleRail}
        title={t('titlebar.railHint', { binding: props.railBinding })}
      >
        {t('titlebar.rail')}
      </Chip>
      <Chip selected={props.autoTrust} onClick={props.onToggleTrust}>
        {props.autoTrust ? t('titlebar.trustOn') : t('titlebar.trustOff')}
      </Chip>
      <Chip selected={false} onClick={props.onCycleAutonomy}>
        {t(`autonomy.${props.autonomy}`)}
      </Chip>
      <Chip selected={props.notifEnabled} onClick={props.onToggleNotif}>
        {props.notifEnabled ? t('titlebar.notifOn') : t('titlebar.notifOff')}
      </Chip>
      {/* 'system' is not a theme — it is the absence of a choice, so it is not
          a contribution either and stays hard-coded here (§5.20 OS sync). */}
      <Chip selected={props.pref === 'system'} onClick={() => props.onTheme('system')}>
        {t('theme.system')}
      </Chip>
      {props.themes.map((th) => (
        <Chip key={th.id} selected={th.id === props.pref} onClick={() => props.onTheme(th.id)}>
          {t(th.nameKey)}
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

export function StatusBar(props: {
  count: number;
  theme: ThemeDefinition;
  cliVersion?: string | null;
  totalOutputTokens?: number;
  totalCostUsd?: number;
}): React.JSX.Element {
  // Contributed items (§5.23): the bar owns the strip and the spacer, the
  // items own what they say. An item returning null renders nothing, which is
  // how "no usage yet" stays the item's business rather than the bar's.
  //
  // The theme arrives RESOLVED — id for the contract, name key for the label —
  // so an item never has to reach for the registry singleton to render a word.
  const ctx: StatusBarContext = { ...props, theme: props.theme.id, themeNameKey: props.theme.nameKey };
  const render = (align: 'start' | 'end'): React.JSX.Element[] =>
    listStatusBarItems(rendererRegistry, align).map((i) => (
      <ContributionBoundary key={i.manifest.id} id={i.manifest.id}>
        {i.render(ctx)}
      </ContributionBoundary>
    ));
  return (
    <footer style={{ ...barStyle, borderBlockEnd: 'none', borderBlockStart: '1px solid var(--border)', fontSize: 11, color: 'var(--muted)' }}>
      {render('start')}
      <span style={{ flex: 1 }} />
      {render('end')}
    </footer>
  );
}

export function Chip(props: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}): React.JSX.Element {
  return (
    <button
      onClick={props.onClick}
      title={props.title}
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
