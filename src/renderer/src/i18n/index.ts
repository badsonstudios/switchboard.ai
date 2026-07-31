// i18n foundation (§5.21): i18next + ICU message format. English is the only
// real locale; "pseudo" is generated from en at init so untranslated strings
// are impossible to miss during dev.
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import ICU from 'i18next-icu';
import en from './locales/en.json';
import { pseudolocalizeResource } from './pseudo';
import { uiGet, uiSet } from '../lib/ui-state';

export type LanguageChoice = 'en' | 'pseudo';

// the workspace `ui` blob, not localStorage — same reason as the theme
// (P2-E15-06): the packaged renderer's origin changes port every launch, so
// anything stored against it is gone by the next one
const STORAGE_KEY = 'language';

export function loadLanguage(): LanguageChoice {
  return uiGet<string>(STORAGE_KEY, 'en') === 'pseudo' ? 'pseudo' : 'en';
}

export async function initI18n(): Promise<void> {
  await i18next
    .use(ICU)
    .use(initReactI18next)
    .init({
      lng: loadLanguage(),
      fallbackLng: 'en',
      resources: {
        en: { translation: en },
        pseudo: { translation: pseudolocalizeResource(en) as typeof en },
      },
      interpolation: { escapeValue: false }, // React escapes
      returnEmptyString: false,
    });
}

export async function setLanguage(lang: LanguageChoice): Promise<void> {
  uiSet(STORAGE_KEY, lang);
  await i18next.changeLanguage(lang);
}
