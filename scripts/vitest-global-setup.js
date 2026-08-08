// #354 — vitest's `globalSetup`, and the only thing it does is spend a couple
// of seconds deleting yesterday's leftover temp directories.
//
// WHY HERE. #213's registry deletes what a test file makes; nothing deletes
// what a build from before #213 made, or the handful per run that a Windows
// lock keeps past even the requeue. The sweep therefore needs a seam that fires
// on every test run without anyone remembering it, which is what `globalSetup`
// is — once per `vitest run`, in the main process, before a worker starts. The
// same reasoning that put the stale-bundle guard in `e2e-global-setup.js`
// rather than in three package.json entries (#329).
//
// `npm test` is the seam and not `npm run e2e`, even though e2e leaks the most
// (22,512 `sb-e2e-proj-` in the census): `npm test` is what every gate, every
// worker and every commit runs, so it is where a two-second job converges
// fastest, and `e2e-global-setup.js` stays the single-purpose file it says it
// is. Nothing stops a later item adding the same one-line call there.
//
// WHY IT IS BUDGETED. The backlog on a dogfood machine is six figures and
// deleting it takes minutes; a test run must not pay that. MEASURED: 2,000
// two-file directories go in 1.5 s, so `DEFAULT_BUDGET_MS` buys roughly 2,500 a
// run — invisible next to a suite that runs for minutes, and enough that even a
// six-figure pile drains over a couple of days of ordinary use. Anyone who
// wants it gone NOW types `npm run sweep:temp`, which is the same code with no
// budget. On CI, where the temp dir is fresh, the whole call is one `readdir`
// of an almost-empty directory.
'use strict';

const { isOn } = require('./bundle-guard');
const {
  DEFAULT_BUDGET_MS,
  SKIP_ENV,
  formatSummary,
  sweepTempOrphans,
} = require('./sweep-temp-orphans');

/**
 * @param {{env?: Record<string, string|undefined>, write?: (s: string) => void,
 *          budgetMs?: number}} [opts]
 */
function sweepBeforeTests(opts = {}) {
  const { env = process.env, write = (s) => process.stderr.write(s + '\n') } = opts;
  // `isOn`, not `=== '1'` — the repo already has one answer to "is this escape
  // hatch on" (`bundle-guard.js`, for ALLOW_STALE_BUNDLE) and this is the only
  // off-switch on a delete loop. A shell that exports SB_SKIP_TEMP_SWEEP=true
  // and gets swept anyway is the wrong direction to fail in.
  if (isOn(env[SKIP_ENV])) return;
  // Belt and braces. `sweepTempOrphans` is written not to throw and is tested
  // for it, but a throw from `globalSetup` aborts the ENTIRE run before a
  // single test executes — the one outcome housekeeping is never allowed to
  // cause. Cheapest possible insurance against a future edit.
  try {
    const line = formatSummary(sweepTempOrphans({ budgetMs: opts.budgetMs ?? DEFAULT_BUDGET_MS }));
    if (line) write(line);
  } catch {
    /* fail-open: never let a cleanup stop a test run */
  }
}

/**
 * @type {() => void} vitest's globalSetup entry point.
 *
 * A DEFAULT export (`module.exports = fn`), not a named `setup` — vitest's CJS
 * interop puts a `module.exports` object entirely behind `default` and then
 * rejects it with "default must be a function", so the object form silently
 * fails the whole run before a test loads. Same shape `e2e-global-setup.js`
 * uses for Playwright; it ignores its own arguments so whatever the runner
 * hands it can never be mistaken for an option.
 */
module.exports = function globalSetup() {
  sweepBeforeTests();
};
module.exports.sweepBeforeTests = sweepBeforeTests;
