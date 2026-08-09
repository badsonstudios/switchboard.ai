// i18n foundation (§5.21): i18next + ICU message format. English is the only
// real locale; "pseudo" is generated from en at init so untranslated strings
// are impossible to miss during dev.
import i18next, { type i18n as I18nInstance } from 'i18next';
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

/**
 * The app's i18next configuration — the plugin chain and the options — in ONE
 * place, so that nothing can be configured *almost* like the app.
 *
 * `test-i18n.ts` calls this too, and that is the point (#380). A test harness
 * that built its own chain was free to drift from the real one, and #207 is
 * what that costs: the harness omitted `ICU`, where i18next still runs its own
 * `{{…}}` interpolator, so a banner key written `{{file}}` passed its component
 * test and would have shown the user the literal braces. With `ICU` installed
 * i18next hands the whole message to the plugin and never interpolates itself.
 *
 * @param instance the i18next instance to configure (the shared singleton in
 *   both callers today; a parameter so neither has to reach for the other's).
 * @param lng the starting language. The app takes it from the stored
 *   preference; tests pin `'en'` so a leftover preference cannot move them.
 */
export async function configureI18n(instance: I18nInstance, lng: LanguageChoice): Promise<void> {
  await instance
    .use(ICU)
    .use(initReactI18next)
    .init({
      lng,
      fallbackLng: 'en',
      resources: {
        en: { translation: en },
        pseudo: { translation: pseudolocalizeResource(en) as typeof en },
      },
      interpolation: { escapeValue: false }, // React escapes
      returnEmptyString: false,
    });
}

export async function initI18n(): Promise<void> {
  await configureI18n(i18next, loadLanguage());
}

export async function setLanguage(lang: LanguageChoice): Promise<void> {
  uiSet(STORAGE_KEY, lang);
  await i18next.changeLanguage(lang);
}
