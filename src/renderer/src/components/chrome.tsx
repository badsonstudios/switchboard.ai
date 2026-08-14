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
import { BuildIdentity, commitStamp } from '../../../shared/build-identity';
import type { PresentationPolicy } from '../lib/presentation-policy';
import type { LayoutMode } from '../lib/layout-mode';
import type { ServiceHealthStatus } from '../../../shared/service-health';

const barStyle: React.CSSProperties = {
  background: 'var(--titlebar-bg)',
  borderBlockEnd: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  paddingInline: 12,
  fontSize: 12,
  // Never give up height (#274). The window is a 100vh flex COLUMN whose main
  // area is `flex: 1` with a basis of 0, so every pixel of negative free space
  // in a short window lands on the auto-basis children — these two bars among
  // them. `minBlockSize` below floors the damage but is not the promise: it is
  // a number that happens to sit where today's text does, and it says nothing
  // about intent. This line is the promise, and always-visible-notices.test.ts
  // is what keeps it here.
  flexShrink: 0,
  minBlockSize: 34,
};

export function TitleBar(props: {
  version: string;
  /** git stamp of the running build (P2-E15-15) */
  identity: BuildIdentity;
  /** open the About panel — the full build identity */
  onOpenAbout: () => void;
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
  /** §5.8's presentation policy — what a submit does to the card (E9-06) */
  presentationPolicy: PresentationPolicy;
  onCyclePresentationPolicy: () => void;
  /** §5.8's layout mode — how the whole workspace is arranged (E9-07) */
  layoutMode: LayoutMode;
  /** a session is blown up to fill the workspace right now (E9-07) */
  layoutMaximized: boolean;
  onCycleLayoutMode: () => void;
  layoutBinding: string;
  autoTrust: boolean;
  onToggleTrust: () => void;
  /** §5.11's auto task labels (P2-E7-06) — off hides every label the CLI filled
   *  in, on the card, in the rail and in OS toasts */
  autoLabels: boolean;
  onToggleAutoLabels: () => void;
  /** §5.9's per-session cues (P2-E14-05a) — on, each card rings its own sound
   *  instead of everything sharing one beep */
  soundsOn: boolean;
  onToggleSounds: () => void;
  /** spoken announcements (P2-E14-05a). The handler is given the localized
   *  sample sentence to say on the way ON — `t` lives here, not in App. */
  speakOn: boolean;
  onToggleSpeak: (sample: string) => void;
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
      <BuildStamp
        version={props.version}
        identity={props.identity}
        onOpenAbout={props.onOpenAbout}
      />
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
      {/* Auto task labels (P2-E7-06, §5.11). A chip and not a buried setting
          for the same reason as the two below it: the thing it governs is a
          phrase derived from what you asked the agent, rendered on every card
          and pushed into OS toasts — so the person who needs it off needs it
          off NOW, mid screen-share, without hunting. */}
      <Chip
        selected={props.autoLabels}
        onClick={props.onToggleAutoLabels}
        title={t('titlebar.autoLabelsHint')}
        testId="auto-labels"
      >
        {props.autoLabels ? t('titlebar.autoLabelsOn') : t('titlebar.autoLabelsOff')}
      </Chip>
      {/* The two audio channels (P2-E14-05a, §5.9). Chips, beside the labels
          chip and for the same reason: what they govern is NOISE in a shared
          room — the person who needs it off needs it off now, not after
          finding a settings page. Each states on/off in words, never colour
          alone (§5.32). */}
      <Chip
        selected={props.soundsOn}
        onClick={props.onToggleSounds}
        title={t('titlebar.soundsHint')}
        testId="session-sounds"
      >
        {props.soundsOn ? t('titlebar.soundsOn') : t('titlebar.soundsOff')}
      </Chip>
      <Chip
        selected={props.speakOn}
        onClick={() => props.onToggleSpeak(t('titlebar.speakSample'))}
        title={t('titlebar.speakHint')}
        testId="speak-announcements"
      >
        {props.speakOn ? t('titlebar.speakOn') : t('titlebar.speakOff')}
      </Chip>
      <Chip selected={false} onClick={props.onCycleAutonomy}>
        {t(`autonomy.${props.autonomy}`)}
      </Chip>
      {/* The GLOBAL presentation policy (E9-06, §5.8). A chip and not a buried
          setting because it changes what the workspace does on every prompt —
          "where did my card go?" has to be answerable by looking, and this is
          the answer. Per-session and per-group overrides live in the rail, next
          to the thing they override. */}
      <Chip
        selected={false}
        onClick={props.onCyclePresentationPolicy}
        title={t('policy.chipHint', { policy: t(`policy.${props.presentationPolicy}`) })}
        testId="presentation-policy"
      >
        {t('policy.chip', { policy: t(`policy.${props.presentationPolicy}`) })}
      </Chip>
      {/* The LAYOUT MODE (E9-07, §5.8). Beside the policy chip because the two
          answer neighbouring questions — that one is what happens to ONE card
          when you submit, this one is how the WHOLE workspace is arranged — and
          because "why is everything a strip all of a sudden?" has to be
          answerable by looking up, not by reading a settings page. */}
      <Chip
        /* lit for a MAXIMIZE too, even in grid: the chip's job is to answer
           "why is everything a strip all of a sudden?", and a maximize is one
           of the two ways that happens */
        selected={props.layoutMode !== 'grid' || props.layoutMaximized}
        onClick={props.onCycleLayoutMode}
        title={t('layout.chipHint', {
          mode: t(`layout.${props.layoutMode}`),
          binding: props.layoutBinding,
        })}
        testId="layout-mode"
      >
        {t(props.layoutMaximized ? 'layout.chipMaximized' : 'layout.chip', {
          mode: t(`layout.${props.layoutMode}`),
        })}
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

/**
 * Version + commit, always on screen, one click from the whole story
 * (P2-E15-15). It sits where the plain `v0.1.0` label used to, because the
 * question it answers — "are these the bytes I think they are?" — has to be
 * answerable in the first five seconds, before anyone starts diagnosing a bug
 * that a rebuild would have removed.
 *
 * A button, not a label: the tooltip carries branch and build time for a hover,
 * and the click opens the full panel. The `*` is a dirty working tree.
 */
function BuildStamp(props: {
  version: string;
  identity: BuildIdentity;
  onOpenAbout: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const stamp = commitStamp(props.identity);
  return (
    <button
      onClick={props.onOpenAbout}
      title={t('titlebar.buildHint', {
        branch: props.identity.branch ?? t('about.detached'),
        builtAt: props.identity.builtAt
          ? new Date(props.identity.builtAt).toLocaleString()
          : t('about.unknown'),
      })}
      aria-label={t('titlebar.buildLabel')}
      style={{
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        color: 'var(--faint)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
      }}
    >
      <span>{t('titlebar.version', { version: props.version })}</span>
      {/* raw git data, not a sentence — but "unknown" IS a word, so that one
          path goes through i18n like everything else (§5.21) */}
      <span style={{ color: props.identity.dirty ? 'var(--status-needs-input-ink)' : 'var(--faint)' }}>
        {stamp ?? t('about.unknown')}
      </span>
    </button>
  );
}

export function StatusBar(props: {
  count: number;
  theme: ThemeDefinition;
  /** the provider's service health (E14-07) — the dot's whole input */
  serviceHealth?: ServiceHealthStatus | null;
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
  /** a stable e2e handle for a chip whose LABEL is the thing under test */
  testId?: string;
}): React.JSX.Element {
  return (
    <button
      onClick={props.onClick}
      title={props.title}
      data-testid={props.testId}
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
