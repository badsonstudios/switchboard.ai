// Runtime dependencies the MAIN bundle inlines instead of `require()`-ing (#471).
//
// `electron.vite.config.ts` externalizes `dependencies` by default
// (`externalizeDepsPlugin`), which is right for anything native or huge:
// bundling node-pty breaks it outright. The trade goes the other way for a
// small pure-JS library, and for i18next it goes the other way *decisively*:
//
//   • **`i18next-icu` declares `intl-messageformat` as a PEER dependency**, and
//     `intl-messageformat` pulls two `@formatjs/*` packages of its own. None of
//     the three is in this app's `dependencies`, so none would be caught by
//     `packaging.test.ts`'s runtime-dep guard — the installed app would throw
//     `MODULE_NOT_FOUND` from inside a notification, on Windows, at a moment no
//     unit test and no dev run reaches. Bundling makes the whole graph a build
//     -time fact instead of an install-time hope.
//   • They are pure ESM/CJS JavaScript with no native code and no `__dirname`
//     assumptions, which is the only thing that makes bundling safe at all.
//   • The renderer has bundled exactly these since the day i18n landed. Main
//     doing the same is the boring, consistent answer.
//
// Anything listed here MUST NOT appear in `electron-builder.js`'s `files`
// allowlist — shipping the node_modules copy of a dependency that is already
// inside `out/main/index.js` is dead weight that reads like a requirement.
// `src/main/packaging.test.ts` asserts both halves of that sentence.
// `yazl` (#815, the diagnostic zip) joins them for the FIRST reason above,
// almost exactly: it declares `buffer-crc32` as its own dependency, and that
// package is not in this app's `dependencies` either — so the runtime-dep guard
// cannot see it, and the installed build would throw `MODULE_NOT_FOUND` the
// first time someone tried to report a problem. That is a packaged-build-only
// failure at the worst possible moment: the one gesture whose entire job is to
// work when something else has already gone wrong.
//
// It meets the safety condition: pure JS, no native code, and its only other
// import is node's own `zlib`. Shipping `node_modules/buffer-crc32/**` in the
// allowlist instead was tried and is wrong twice over — nothing in our source
// imports it, so it reads as dead weight to the guard above, and it leaves the
// graph an install-time hope rather than a build-time fact.
export const BUNDLED_INTO_MAIN: readonly string[] = ['i18next', 'i18next-icu', 'yazl'];
