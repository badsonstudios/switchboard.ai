// The i18n foundation both processes share (§5.21, #471).
//
// WHY THIS LIVES IN `shared/` AND NOT IN THE RENDERER
// ---------------------------------------------------
// §5.21's first bullet is "**No hardcoded user-facing strings — ever**", and
// until #471 the MAIN process broke it wholesale: the catalog, the pseudo-locale
// and the i18next configuration all lived under `renderer/src/i18n/`, so every
// string main composes — an OS toast's title and body, the Allow/Deny buttons on
// it, the same text forwarded to a phone by push or to a webhook — was an
// English constant. A user on a translated app got English notifications.
//
// **The recorded decision (#471): ONE catalog, ONE configuration, TWO
// instances.** The alternatives were considered and rejected:
//
//   • *Route the text through the renderer*, the way the right-click menu
//     labels travel (#526, `renderer/src/lib/context-menu-labels.ts`). That
//     works for FOUR STATIC labels published at boot. It cannot work for a
//     toast: the text is composed per event from live data ("Allow Bash? npm
//     run build"), and the whole point of the toast is that it fires when the
//     window is BLURRED, minimized, or not yet mounted. Making a notification
//     depend on a round trip to a renderer that may be gone is a fail-CLOSED
//     dependency on the exact path that must fail open (PHILOSOPHY §3).
//   • *Accept English-only for main surfaces and document it.* Rejected: a
//     permission decision is the most consequential thing this app renders, and
//     §5.9 promises that answering from the notification is the same decision
//     the user would have made at the bar. "Same decision" cannot survive the
//     two surfaces speaking different languages.
//
// So the catalog moved HERE, where both processes may import it, and this
// module owns the ONE i18next configuration. `renderer/src/i18n/index.ts` adds
// the React binding on top; `main/i18n.ts` adds nothing. #380's rule — "nothing
// may be configured *almost* like the app" — now spans both processes: the ICU
// plugin, the resources, the fallback chain and the interpolation options are
// stated once, in `configureI18nBase`, and a caller can only ADD plugins.
//
// **Locale has one source of truth too, and main already owned it.** The
// language preference lives in the workspace `ui` blob under `language` — a
// file MAIN reads and writes (`workspace/store.ts`). So main does not have to
// be TOLD the locale over IPC, and there is no new channel here: it reads the
// same value the renderer wrote, at the moment it needs it. See `main/i18n.ts`
// for why that read is per-call rather than latched.
import type { i18n as I18nInstance } from 'i18next';
import ICU from 'i18next-icu';
import en from './locales/en.json';
import { pseudolocalizeResource } from './pseudo';

/**
 * The languages this build has resources for.
 *
 * `pseudo` is not a translation — it is generated from `en` at init so that a
 * hardcoded string is visually obvious (§5.21's pseudo-localization bullet).
 * **THE REPO HAS EXACTLY ONE REAL LOCALE**, and #471 did not change that: it
 * fixed the mechanism, not the coverage. A second locale is one JSON file in
 * `./locales/` plus an entry here, and NOTHING in either process needs to know
 * about it — which is the point.
 */
export type LanguageChoice = 'en' | 'pseudo';

/** The workspace `ui` blob key the language preference is stored under. */
export const LANGUAGE_UI_KEY = 'language';

/** Anything that is not a language we ship resources for is English. */
export function normalizeLanguage(value: unknown): LanguageChoice {
  return value === 'pseudo' ? 'pseudo' : 'en';
}

/**
 * The language, read out of a workspace `ui` blob.
 *
 * `unknown` in, because that is what `WorkspaceStore.getUi()` returns and what
 * a hand-edited `workspace.json` can actually contain. Fail-open at every step:
 * a missing blob, a blob that is a string, a `language` set to `42` — all
 * English, none throw. A notification must never be the thing that blows up on
 * a malformed pref.
 */
export function languageFromUi(ui: unknown): LanguageChoice {
  if (!ui || typeof ui !== 'object') return 'en';
  return normalizeLanguage((ui as Record<string, unknown>)[LANGUAGE_UI_KEY]);
}

/** The shape of `en.json` — the contract every locale file must satisfy. */
export type TranslationResource = typeof en;

/** What `i18next.use()` accepts. Named so callers don't have to spell it. */
export type I18nPlugin = Parameters<I18nInstance['use']>[0];

/**
 * A translation function, narrowed to what this codebase actually asks of one.
 *
 * Deliberately NOT i18next's `TFunction`: functions that only need to say a
 * sentence (`permissionSummary`, the toast wiring in `main/index.ts`) should be
 * testable with a three-line fake, and should not drag i18next's generics
 * through every signature they appear in.
 */
export type Translate = (key: string, vars?: Record<string, unknown>) => string;

/** The resource bundle both instances load: real English, generated pseudo. */
export function i18nResources(): Record<LanguageChoice, { translation: TranslationResource }> {
  return {
    en: { translation: en },
    pseudo: { translation: pseudolocalizeResource(en) as TranslationResource },
  };
}

/**
 * The app's i18next configuration — the plugin chain and the options — in ONE
 * place, so that nothing can be configured *almost* like the app (#380, now
 * across both processes).
 *
 * `renderer/src/i18n/index.ts` calls this with `initReactI18next`; `main/i18n.ts`
 * calls it with nothing; `renderer/src/i18n/test-i18n.ts` reaches it through the
 * renderer's wrapper, and that is the point. A test harness that built its own
 * chain was free to drift from the real one, and #207 is what that costs: the
 * harness omitted `ICU`, where i18next still runs its own `{{…}}` interpolator,
 * so a banner key written `{{file}}` passed its component test and would have
 * shown the user the literal braces. With `ICU` installed i18next hands the
 * whole message to the plugin and never interpolates itself.
 *
 * @param instance the i18next instance to configure — the shared singleton in
 *   the renderer, a private `createInstance()` in main. A parameter so neither
 *   process has to reach for the other's.
 * @param lng the starting language. The renderer takes it from the stored
 *   preference; main starts at `en` and selects per call (see `main/i18n.ts`);
 *   tests pin `'en'` so a leftover preference cannot move them.
 * @param plugins extra plugins to install AFTER ICU. Additive only — a caller
 *   cannot remove ICU or change an option, which is the whole guarantee.
 */
export async function configureI18nBase(
  instance: I18nInstance,
  lng: LanguageChoice,
  plugins: readonly I18nPlugin[] = []
): Promise<void> {
  let chain = instance.use(ICU);
  for (const plugin of plugins) chain = chain.use(plugin);
  await chain.init({
    lng,
    fallbackLng: 'en',
    resources: i18nResources(),
    // React escapes in the renderer, and an OS notification is not HTML at all
    // — escaping here would put `&#39;` in front of a user reading a toast.
    interpolation: { escapeValue: false },
    returnEmptyString: false,
  });
}

/**
 * The raw English string for a dotted key, ICU arguments UNEXPANDED.
 *
 * The last-ditch path for `main/i18n.ts`: if i18next itself failed to
 * initialise there is no interpolator left, and a toast reading
 * "Allow {tool}?" is still a better answer than an empty notification or a
 * thrown exception on an OS callback. Returns the key when the key does not
 * exist, which is i18next's own behaviour and therefore the same thing a
 * developer is used to seeing.
 */
export function englishString(key: string): string {
  let node: unknown = en;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return key;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : key;
}
