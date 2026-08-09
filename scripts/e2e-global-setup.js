// Playwright's `globalSetup`: the two housekeeping jobs that have to happen
// before a single spec starts — the stale-bundle guard (#329), and then the
// temp-orphan sweep (#354, wired in here by #360).
//
// It was a single-purpose file until #360 and the header said so. Both jobs are
// here for the same reason, which is the reason below: `globalSetup` is the one
// seam a Playwright invocation cannot route around. What each job DOES belongs
// to its own module (`bundle-guard.js`, `sweep-temp-orphans.js`); this file
// only decides that they run, and in which order.
//
// ---------------------------------------------------------------------------
// #329 — the stale-bundle guard.
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
//
// ---------------------------------------------------------------------------
// #360 — the temp-orphan sweep.
//
// #354 put the sweep on `npm test`'s `globalSetup` only, on the grounds that it
// is the far more frequent seam and that this file was single-purpose. The gap
// that left: e2e is the BIGGEST producer of the litter (22,512 `sb-e2e-proj-`
// in the 2026-08-08 census, plus an Electron `userData` tree per app home), so
// the run that makes the most of it was the one run that never cleared any, and
// a machine used mostly for e2e had to wait for someone to type `npm test`.
//
// One call, deliberately identical to vitest's — same `sweepBeforeTests`, same
// 2 s budget, same `SB_SKIP_TEMP_SWEEP` off-switch, same silence when there is
// nothing to remove, same 24 h floor that keeps a live run's directories out of
// range. Nothing about it is e2e-specific and nothing here re-decides it.
'use strict';

const path = require('path');
const { guardE2eBundle } = require('./bundle-guard');
const { sweepBeforeTests } = require('./sweep-temp-orphans');

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

/**
 * Everything that happens before the first spec: guard, then sweep.
 *
 * ORDER IS DELIBERATE. The guard can end the run, and when it is going to, the
 * developer should be told immediately rather than after two seconds of
 * housekeeping — so a stale bundle means no sweep this time, which costs
 * nothing: the sweep's whole design is that missing a run is fine (a 24 h
 * floor, a budget, and a next time). The reverse order would spend the budget
 * on a run that was never going to happen.
 *
 * `write` is threaded into both so a test can capture what a run would print.
 * The two have different conventions and that is theirs, not this file's: the
 * guard writes its report with the newline included, `sweepBeforeTests`
 * writes one line and lets its default writer add it.
 *
 * The sweep gets its three options NAMED, not the whole bag: `opts.root` is a
 * filesystem path meaning "project root", and handing that to a function whose
 * job is to delete directories is how a future option ends up somewhere nobody
 * decided it should be. `sweep-temp-orphans.js`'s `main` already refuses to
 * spread its parsed arguments for exactly this reason; same rule here.
 *
 * @param {{root?: string, env?: Record<string, string|undefined>,
 *          write?: (s: string) => void, budgetMs?: number}} [opts]
 */
function e2ePreflight(opts = {}) {
  e2eBundlePreflight(opts);
  sweepBeforeTests({ env: opts.env, write: opts.write, budgetMs: opts.budgetMs });
}

/** @type {() => void} Playwright's globalSetup entry point. */
module.exports = function globalSetup() {
  e2ePreflight();
};
module.exports.e2eBundlePreflight = e2eBundlePreflight;
module.exports.e2ePreflight = e2ePreflight;
