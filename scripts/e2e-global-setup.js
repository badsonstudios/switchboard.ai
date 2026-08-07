// #329 — Playwright's `globalSetup`, and the only thing it does is run the
// stale-bundle guard before a single spec starts.
//
// The trap it closes: `npm run e2e` is `npm run build && playwright test`, and
// the guard was wired into the OTHER two scripts (`e2e:only`, `e2e:ui`). So
// every way of starting the suite that went round npm — `npx playwright test`,
// `npx playwright test e2e/one.spec.ts`, an IDE's run button, the documented
// `SWITCHBOARD_REAL_E2E=1 npx playwright test …` lane — built nothing, guarded
// nothing, and tested whatever bundle happened to be in `out/`. #315's worker
// paid the bill: nine minutes, eight failures, none of them about the change
// under test (#315 / PR #328). The information was sitting in `out/` the whole
// time and nobody was asking for it, which is #286's lesson arriving a second
// time by a different door.
//
// `globalSetup` is the seam that cannot be routed around: Playwright runs it
// once, before any worker starts, on every invocation. Three package.json
// entries were three chances to forget — the same reasoning that put the
// `check:*` guard inside `run-electron-node.js` rather than in five scripts
// (#298).
//
// It CALLS the guard (`guardE2eBundle`), it does not re-decide anything: one
// staleness rule, one report, one override (`ALLOW_STALE_BUNDLE=1`).
//
// `npm run e2e` is unchanged and remains the blessed path — it is the one that
// builds, so this pre-flight is a stamp there, not a gate. Cost on a fresh
// bundle is a directory walk of `src/` plus one `git rev-parse`, well under a
// second against a suite that runs for minutes.
'use strict';

const path = require('path');
const { guardE2eBundle } = require('./bundle-guard');

/** Root from __dirname, not cwd — the house pattern (bundle-guard.js's note). */
const ROOT = path.join(__dirname, '..');

/**
 * Run the guard; throw if `out/` cannot be trusted.
 *
 * Throwing is how `globalSetup` fails a run: Playwright reports the error and
 * exits WITHOUT running a spec, which is the whole point — the alternative is
 * the nine-minute red run. The message is deliberately short, because the
 * guard has already written the report (which files, how old, how to fix) to
 * stderr; repeating it here would only push it off the screen.
 *
 * Parameters are an options object, and the default export below ignores its
 * own arguments, so Playwright handing `globalSetup` a `FullConfig` can never
 * be mistaken for a project root.
 *
 * @param {{root?: string, env?: Record<string, string|undefined>,
 *          write?: (s: string) => void}} [opts]
 */
function e2eBundlePreflight(opts = {}) {
  const { root = ROOT, env = process.env, write } = opts;
  if (!guardE2eBundle(root, env, write)) {
    throw new Error(
      'Stale or missing out/ — see the bundle-guard report above. ' +
        'Run `npm run build` (or `npm run e2e`, which builds) and try again.'
    );
  }
}

/** @type {() => void} Playwright's globalSetup entry point. */
module.exports = function globalSetup() {
  e2eBundlePreflight();
};
module.exports.e2eBundlePreflight = e2eBundlePreflight;
