// Theme and language (#885) — seven of the eight controls that left the title
// bar.
//
// **Why these left and the off-switches did not.** The bar's rule, written into
// `chrome.tsx` beside the labels and audio chips, is that a chip is earned by
// "the person who needs it off needs it off NOW" — mid screen-share, without
// hunting (§5.11 litmus #4). Nobody changes theme hourly and nobody changes
// language twice. They were seven of nineteen controls and 410px of a 1009px
// bar that was overflowing by 568px (#879), which is what made them the
// lowest-risk third to move.
//
// ⚠️ **MOVING THE CONTROL MUST NOT CHANGE WHAT IT DOES.** Both of these are
// live-switching surfaces with contrast tests behind them across all four
// themes (`theme/tokens.drift.test.ts`, `e2e/theme.spec.ts`) and an RTL path
// for language. The handlers are `App`'s, unchanged and passed straight
// through; the buttons are `chrome.tsx`'s `Chip`, so their accessible names are
// the same strings the old chips had and every assertion that names one still
// names the same control.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ThemeDefinition, ThemePreference } from '../../theme/theme';
import { LanguageChoice } from '../../i18n';
import { Chip } from '../chrome';
import { SettingItem } from './controls';

export interface ThemeSectionProps {
  pref: ThemePreference;
  /** what the app resolved from — the picker must not offer a theme the
   *  resolver cannot find, or the control lights on a theme nobody painted */
  themes: readonly ThemeDefinition[];
  onTheme: (p: ThemePreference) => void;
  lang: LanguageChoice;
  onLang: (l: LanguageChoice) => void;
}

const row: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6 };

export function ThemeSection(props: ThemeSectionProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <SettingItem item="theme" label={t('settings.theme')} blurb={t('settings.themeBlurb')}>
        <div data-settings-block="theme" role="group" aria-label={t('settings.theme')} style={row}>
          {/* 'system' is not a theme — it is the absence of a choice, so it is
              not a contribution either and stays hard-coded here (§5.20 OS
              sync). */}
          <Chip pressed selected={props.pref === 'system'} onClick={() => props.onTheme('system')}>
            {t('theme.system')}
          </Chip>
          {props.themes.map((th) => (
            <Chip
              key={th.id}
              pressed
              selected={th.id === props.pref}
              onClick={() => props.onTheme(th.id)}
            >
              {t(th.nameKey)}
            </Chip>
          ))}
        </div>
      </SettingItem>

      <SettingItem item="language" label={t('settings.language')} blurb={t('settings.languageBlurb')}>
        <div
          data-settings-block="language"
          role="group"
          aria-label={t('settings.language')}
          style={row}
        >
          {(['en', 'pseudo'] as const).map((l) => (
            <Chip key={l} pressed selected={l === props.lang} onClick={() => props.onLang(l)}>
              {t(`language.${l}`)}
            </Chip>
          ))}
        </div>
      </SettingItem>
    </>
  );
}
