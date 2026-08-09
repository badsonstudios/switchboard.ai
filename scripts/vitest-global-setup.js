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
// `npm test` was the FIRST seam and not the only one: #360 added the same call
// to `e2e-global-setup.js`, so both runners now sweep. `npm test` is still the
// one that matters most — it is what every gate, every worker and every commit
// runs, so it is where a two-second job converges fastest — while e2e is the
// biggest producer (22,512 `sb-e2e-proj-` in the census) and used to have to
// wait for the next `npm test` to have its litter taken.
//
// The sweep itself — how long it may spend, which off-switch it honours, and
// what it does with a throw — is `sweepBeforeTests` in
// `sweep-temp-orphans.js`, so that this file and the Playwright one cannot
// answer those three questions differently (#360). The sizing of the budget is
// documented on `DEFAULT_BUDGET_MS` there.
'use strict';

const { sweepBeforeTests } = require('./sweep-temp-orphans');

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
