// The main process's i18next instance (#471, §5.21).
//
// Main composes user-visible text: an OS toast's title and body, the Allow/Deny
// buttons on it, and — because push and webhook both forward `ctx.title` /
// `ctx.body` verbatim — the copy that reaches a phone. Until #471 every one of
// those was an English constant while the window around them was translated.
//
// This module is deliberately thin. It owns no strings, no catalog and no
// policy: `shared/i18n/index.ts` holds the one configuration and the one
// catalog (and the recorded decision for why they moved there), and this is the
// main-side instance that reads them.
//
// TWO DESIGN POINTS WORTH THE READ
// --------------------------------
// **1. The language is read per call, not latched.** `createMainI18n` takes a
// `language()` thunk and resolves it inside `t()` via `getFixedT`, rather than
// calling `changeLanguage` when something tells it the preference moved. That
// buys three things at once:
//
//   • a mid-session switch is instant and needs no plumbing — no IPC channel,
//     no `languageChanged` subscription, no ordering between "the renderer
//     saved the pref" and "main was told";
//   • there is no second copy of the preference to fall out of date, which is
//     the failure mode the right-click labels (#526) can have and this cannot;
//   • `changeLanguage` is ASYNC, and a notification fires on an OS callback.
//     A `t()` that has to await is a `t()` that renders the old language for
//     one toast, once, in a way nobody can reproduce.
//
// The thunk main passes reads the workspace `ui` blob, which is main's own file
// — so the "source of truth for the locale" is a value main already had.
//
// **2. It fails open, twice.** i18next initialisation is awaited at boot and a
// failure is logged rather than thrown, because a broken catalog must not be
// able to stop the app booting (PHILOSOPHY §3). After that, `t()` never throws:
// an ICU parse error inside one message costs that message, not the toast, and
// certainly not the main process — an exception on an OS notification callback
// is a crash dialog (P6).
import i18next, { type i18n as I18nInstance } from 'i18next';
import {
  configureI18nBase,
  englishString,
  type LanguageChoice,
  type Translate,
} from '../shared/i18n';
import type { Logger } from './log/logger';

export interface MainI18nDeps {
  /**
   * The language to speak RIGHT NOW. Called on every `t()` — see design point 1
   * above. Must not throw; if it does, `t` treats it as English.
   */
  language: () => LanguageChoice;
  log?: Logger;
  /**
   * How the instance is configured. The app never passes this — it exists so a
   * test can make initialisation FAIL, which is the only way to reach the
   * `ready === false` branch below.
   *
   * That branch is a fail-open promise, and a promise with no witness is a
   * comment. It is genuinely hard to trip in production — `configureI18nBase`
   * hands i18next in-memory resources with no backend, so there is nothing left
   * to reject — but "hard to trip" is not "cannot", and the cost of being wrong
   * is a main process that dies composing a notification.
   */
  configure?: (instance: I18nInstance, lng: LanguageChoice) => Promise<void>;
}

export interface MainI18n {
  /** Say something in the user's language. Never throws. */
  t: Translate;
  /** Whether i18next came up. False means `t` is serving raw English. */
  readonly ready: boolean;
}

/**
 * Build the main process's translator.
 *
 * Awaited once at boot, before the first window and long before any rule can
 * fire — every NOTIFICATION surface in main takes its `t` from the object this
 * returns (the OS toast, push, the webhook, and the spoken announcement), so
 * there is no path where one is composed against a half-initialised instance.
 *
 * Main's other user-visible strings are NOT here and are still English: the
 * application menu (`app-menu.ts`) and the quit-with-busy-sessions dialog in
 * `index.ts`. Both are chrome rather than notification, both are reachable only
 * with the window in front of you, and neither was in #471's scope — named so
 * the next reader does not have to grep to find out whether main is clean.
 *
 * A PRIVATE instance (`createInstance`), not the `i18next` default singleton:
 * main and the renderer are different processes today, but `src/shared` is
 * compiled into both bundles and the singleton is module state. Reaching for it
 * from a shared file is how the two would end up sharing a language by
 * accident in one bundle and not the other.
 */
export async function createMainI18n(deps: MainI18nDeps): Promise<MainI18n> {
  const instance = i18next.createInstance();
  let ready = false;
  try {
    // `'en'` as the starting language is not a default that matters: nothing
    // reads `instance.language`, because `t` selects per call. It is the
    // language i18next validates its own resources against at init.
    await (deps.configure ?? configureI18nBase)(instance, 'en');
    ready = true;
  } catch (err) {
    // Loud, because the symptom otherwise is "the notifications are in English"
    // — which looks exactly like a missing translation rather than a broken
    // process, and is the kind of thing that survives three releases.
    deps.log?.error('main i18n failed to initialise; notifications will be raw English', {
      error: String(err),
    });
  }

  // One warning, not one per string. A `language()` thunk that throws throws
  // for every key of every notification, and burying the rest of the log under
  // the same line a thousand times is the failure mode `sound-actions.ts`
  // introduced `reportFailure` to avoid.
  let warned = false;
  const warn = (msg: string, fields: Record<string, string>): void => {
    if (warned) return;
    warned = true;
    deps.log?.warn(msg, fields);
  };

  const t: Translate = (key, vars) => {
    if (!ready) return englishString(key);
    try {
      const lng = deps.language();
      // `getFixedT` rather than `changeLanguage` + `t` — synchronous, stateless,
      // and therefore correct for a toast that fires the instant after the user
      // changed the setting. See design point 1.
      const out: unknown = instance.getFixedT(lng)(key, vars);
      // A key that lands on a NAMESPACE rather than a leaf (`approval`,
      // `notification.kind`) resolves to the sub-object, and `String()` on that
      // is the text "[object Object]" — which would go on an OS toast and to a
      // phone. `englishString` has always guarded this; the live path must too,
      // or the last-ditch fallback is safer than the real one.
      return typeof out === 'string' ? out : englishString(key);
    } catch (err) {
      warn('a main-process string failed to translate', { key, error: String(err) });
      // The English source beats an empty notification and beats a throw. ICU
      // arguments come through unexpanded here, which is ugly and is meant to
      // be: it is a broken-catalog symptom, not a state to be comfortable in.
      return englishString(key);
    }
  };

  // `ready` is settled before this returns and never moves again, so a plain
  // property rather than a getter — a getter would imply it can change.
  return { t, ready };
}
