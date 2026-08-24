// The renderer's half of i18n (§5.21): the shared configuration plus the React
// binding and the stored preference.
//
// The catalog, the pseudo-locale and the i18next options moved to
// `src/shared/i18n/` in #471 so the MAIN process could speak the same language
// as the window — read that file for the decision and why the alternatives were
// rejected. What is left here is what only the renderer has: `initReactI18next`,
// and the preference the user actually clicks.
import i18next, { type i18n as I18nInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  configureI18nBase,
  LANGUAGE_UI_KEY,
  normalizeLanguage,
  type LanguageChoice,
} from '../../../shared/i18n';
import { uiGet, uiSet } from '../lib/ui-state';

export type { LanguageChoice };

// the workspace `ui` blob, not localStorage — same reason as the theme
// (P2-E15-06): the packaged renderer's origin changes port every launch, so
// anything stored against it is gone by the next one.
//
// It is ALSO how main learns the language (#471): the blob is main's own file,
// so writing the preference here is what tells the notification layer which
// language to speak. No IPC channel exists for it and none is needed.
const STORAGE_KEY = LANGUAGE_UI_KEY;

export function loadLanguage(): LanguageChoice {
  return normalizeLanguage(uiGet<unknown>(STORAGE_KEY, 'en'));
}

/**
 * Configure the renderer's i18next: the shared chain, plus React.
 *
 * `test-i18n.ts` calls this too, and that is the point (#380) — see
 * `shared/i18n/index.ts` → `configureI18nBase` for what a drifting harness
 * costs.
 *
 * @param instance the i18next instance to configure (the shared singleton in
 *   both callers today; a parameter so neither has to reach for the other's).
 * @param lng the starting language. The app takes it from the stored
 *   preference; tests pin `'en'` so a leftover preference cannot move them.
 */
export async function configureI18n(instance: I18nInstance, lng: LanguageChoice): Promise<void> {
  await configureI18nBase(instance, lng, [initReactI18next]);
}

export async function initI18n(): Promise<void> {
  await configureI18n(i18next, loadLanguage());
}

export async function setLanguage(lang: LanguageChoice): Promise<void> {
  // The `uiSet` goes FIRST, and it is not just ordering hygiene: it is what
  // makes the main process switch too (#471). Main reads this key out of the
  // workspace blob every time it composes a notification, so the toast that
  // fires a second after this line is already in the new language — with no
  // channel, no handshake and nothing to keep in sync.
  uiSet(STORAGE_KEY, lang);
  await i18next.changeLanguage(lang);
}
