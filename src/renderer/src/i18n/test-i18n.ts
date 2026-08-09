// The ONLY way a test may initialise i18next (#380).
//
// WHY THIS FILE EXISTS
// --------------------
// Eleven component harnesses each wrote out their own `i18next.use(…).init(…)`
// chain. Ten of them installed `i18next-icu`; one did not, and before #379
// two did not — and a harness without ICU is not a slightly different harness,
// it is a DIFFERENT INTERPOLATOR. With an `i18nFormat` plugin installed
// i18next hands the whole message to it and never runs its own `{{…}}`
// interpolator; without one, `{{…}}` works. So a key written in the wrong
// dialect renders correctly under such a harness and renders its braces
// verbatim to the user. #207 shipped exactly that into review: a data-loss
// banner reading "…keeps failing to write {{file}}", green the whole way.
//
// `locales.test.ts` guards the other half of the same defect (no `{{` may
// appear in `en.json`). This guards the harness: there is one configuration,
// it is the app's own `configureI18n`, and a harness cannot drift from the app
// without changing the app. `test-i18n.test.ts` holds the proof — a probe key
// written mustache-style is left verbatim here exactly as it would be on
// screen.
//
// Not named `*.test.ts`: vitest collects those, and this file is a helper.
import i18next from 'i18next';
import { configureI18n } from './index';

let started: Promise<void> | undefined;

/**
 * Initialise the shared i18next singleton exactly as the app does, once.
 *
 * Idempotent, because vitest gives each test FILE its own module registry but
 * a file's own `beforeEach` may run many times; every harness guarded on
 * `isInitialized` for that reason, and the guard belongs here now. It is the
 * PROMISE that is remembered, not the flag: i18next only raises
 * `isInitialized` when init finishes, so a flag would let two calls that
 * overlap both start one — and let the second return before the instance is
 * ready. Every caller awaits today; this makes that not have to be true.
 */
export function initI18nForTests(): Promise<void> {
  // `isInitialized` still matters for the case the memo cannot see: a file that
  // reached the singleton some other way first (`main.tsx`'s `initI18n`).
  started ??= i18next.isInitialized ? Promise.resolve() : configureI18n(i18next, 'en');
  return started;
}
