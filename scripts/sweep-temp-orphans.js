// #354 — sweeps THIS REPO'S leftover temp directories out of the OS temp dir.
//
// WHY THIS EXISTS, AND WHY IT IS NOT IN THE APP. #213 gave the test suite a
// registry (`src/test-temp-dirs.ts`) so a test file's directories are deleted
// even when the assertion above the teardown throws. That fixed the FLOW; it
// could not fix the POND. Every machine that ran a pre-#213 build still holds
// everything those builds made, forever, because deleting them is nobody's job.
// Measured on one dogfood machine on 2026-08-08: 115,314 `sb-*` directories in
// `%TEMP%`, oldest 20 days, median 6 — 7,624 of them `sb-ws-` (the slice #349's
// worker happened to count, and the reason #354 is titled after it).
//
// The obvious-looking home for a sweep is the app's startup, and that is the
// wrong one. Every `sb-*` producer in the tree is a `*.test.ts`, an e2e
// spec/fixture, or one of the local-only `check:*` probes — nothing that ships
// makes one. (The shipped app does use the OS temp dir, for exactly one thing:
// `UpdateInstaller` stages downloads in a FIXED `switchboard-updates` directory
// which it empties itself, `src/main/update/install.ts`. `ORPHAN_NAME` cannot
// match a fixed name, so the two never meet — but "the app never touches temp"
// would be a false thing to leave written here.) An app-startup sweep for
// `sb-*` would therefore be the shipped product deleting directories it never
// created, on a user's machine, where they cannot exist unless that user ran
// our test suite — a real destructive behaviour bought for a benefit of exactly
// zero users. The litter is made by the test run, so the test run cleans it up
// — both runners' `globalSetup` (`vitest.config.ts`'s, and
// `playwright.config.ts`'s since #360), plus this file's own CLI for a backlog.
//
// WHAT IT WILL TOUCH. A candidate must clear all five:
//   1. it is a direct child of the temp dir it was pointed at (`os.tmpdir()`
//      unless a test says otherwise) — no recursion, no traversal;
//   2. its name matches `ORPHAN_NAME` — our `sb-` convention plus the six
//      random characters `mkdtemp` appends, so `sb-notes` typed by a human is
//      not a candidate and neither is anything without our prefix;
//   3. it is a directory (`isDirectory()`, no symlink follow — `readdir`'s
//      dirent answers from the lstat, which is the answer we want);
//   4. it is older than `minAgeMs` (default 24 h);
//   5. deleting it fits in the remaining budget.
//
// (4) is also the entire concurrency story, and it is why the age is measured
// in days rather than minutes. Another `npm test`, an e2e run, a second
// worktree's suite, a `check:*` probe — anything running now made its
// directories minutes ago at most, so none of them are candidates. No lock, no
// PID file, nothing to leave behind if a run is killed. The one thing in this
// tree that could in principle age past the floor while still live is
// `spike/s11/probe-1-longrun.cjs`, an 8 h soak with an env-overridable
// duration; 24 h clears its default three times over, and a deliberate >24 h
// soak is the case to remember when reading this.
//
// Two sweeps racing each other is a non-event in the common case — `rmSync`
// with `force` treats the loser's ENOENT as success. A racer that gets inside
// the tree mid-recursion produces ENOTEMPTY/EPERM instead, which lands in
// `failed`, is named in the log line, and is retried by the next run.
//
// Nothing here throws. A sweep that cannot list the directory, cannot stat an
// entry, or cannot delete a tree reports it in the summary and carries on —
// housekeeping must never be the reason a test run fails (#213's own rule, and
// P6 fail-open).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isOn } = require('./bundle-guard');

/**
 * Names this repo provably wrote: our `sb-` prefix, then a slug, then the six
 * characters `fs.mkdtempSync` substitutes for the `XXXXXX` libuv requires.
 *
 * The shape is the load-bearing half. An allow-list of today's prefixes was the
 * first draft and it is subtly the wrong rule: the census found ~3,500
 * directories under prefixes the tree no longer contains (`sb-tr-`, `sb-keep-`,
 * `sb-release-`, `sb-sha-`, `sb-ipc-`, the `sb-probe-*` spike leftovers), so an
 * allow-list would have walked past thousands of orphans AND gone stale again
 * the next time a test file is renamed — recreating "nobody's job", which is
 * the actual defect in #354.
 *
 * The suffix is what keeps it honest: `[A-Za-z0-9]{6}` is exactly libuv's
 * `tempchars` alphabet and exactly its length, so a hand-made `sb-scratch` or a
 * `sb-notes.txt` cannot match.
 *
 * The question that matters is not "do OUR directories match" but "could
 * SOMEBODY ELSE'S". The census answers it: across the 115,314 matches in one
 * machine's `%TEMP%` there were 23 distinct prefixes and every one of them was
 * ours or historically ours. No foreign producer in the tree's own convention
 * space — which is the risk this filter is carrying, and the reason the
 * `sb-` prefix alone was never enough.
 */
const ORPHAN_NAME = /^sb-[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9]{6}$/;

/** 24 h. Long enough that no run of anything we own can still own a candidate. */
const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Budget for the automatic sweep in either runner's `globalSetup`
 * (`sweepBeforeTests` below).
 *
 * The backlog on a dogfood machine is six figures and deleting it takes
 * minutes; a test run must not pay that. MEASURED: 2,000 two-file directories
 * go in 1.5 s, so this buys roughly 2,500 a run — invisible next to a suite
 * that runs for minutes, and enough that even a six-figure pile drains over a
 * couple of days of ordinary use. Anyone who wants it gone NOW types
 * `npm run sweep:temp`, which is this code with no budget. On CI, where the
 * temp dir is fresh, the whole call is one `readdir` of an empty directory.
 */
const DEFAULT_BUDGET_MS = 2_000;

/** Set to `1` to make the automatic sweep a no-op. */
const SKIP_ENV = 'SB_SKIP_TEMP_SWEEP';

/**
 * @typedef {object} SweepSummary
 * @property {number} scanned    entries `readdir` returned
 * @property {number} matched    entries that look like ours (name + isDirectory)
 * @property {number} tooYoung   ours, but inside `minAgeMs`
 * @property {number} removed    directories deleted (or would be, when dry)
 * @property {number} failed     deletes that threw
 * @property {number} remaining  ours BY NAME, left unexamined for the next run
 *                               (age unchecked — see the budget comment)
 * @property {number} elapsedMs
 * @property {boolean} budgetHit did we stop early
 * @property {string[]} errors   the FIRST `MAX_LISTED_ERRORS`, in order — once
 *                               it is full nothing more is recorded
 */

/** Errors are for a human reading one log line, not an audit trail. */
const MAX_LISTED_ERRORS = 3;

/**
 * Is `dir` a plausible temp root? Guards the one input that is not ours.
 *
 * `os.tmpdir()` reads `TMPDIR`/`TEMP`/`TMP`, which a caller can set to anything
 * — including `/` or a home directory. A filesystem root is refused outright;
 * everything else is only ever filtered by `ORPHAN_NAME`, so the blast radius
 * of a bad `TEMP` is still nil.
 */
function isPlausibleTempRoot(dir) {
  const resolved = path.resolve(dir);
  return path.dirname(resolved) !== resolved;
}

/**
 * Delete our old leftovers under `dir`. Never throws.
 *
 * @param {{dir?: string, now?: number, minAgeMs?: number, budgetMs?: number,
 *          dryRun?: boolean}} [opts]
 * @returns {SweepSummary}
 */
function sweepTempOrphans(opts = {}) {
  const {
    dir = os.tmpdir(),
    now = Date.now(),
    minAgeMs = DEFAULT_MIN_AGE_MS,
    budgetMs = Infinity,
    dryRun = false,
  } = opts;

  const startedAt = Date.now();
  /** @type {SweepSummary} */
  const summary = {
    scanned: 0,
    matched: 0,
    tooYoung: 0,
    removed: 0,
    failed: 0,
    remaining: 0,
    elapsedMs: 0,
    budgetHit: false,
    errors: [],
  };
  const note = (msg) => {
    if (summary.errors.length < MAX_LISTED_ERRORS) summary.errors.push(msg);
  };
  const done = () => {
    summary.elapsedMs = Date.now() - startedAt;
    return summary;
  };

  if (!isPlausibleTempRoot(dir)) {
    note(`refusing to sweep ${dir}: filesystem root`);
    return done();
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A temp dir that will not list is not our problem to solve, and on a fresh
    // CI runner `TMPDIR` occasionally does not exist yet.
    note(`readdir ${dir}: ${String(err)}`);
    return done();
  }
  summary.scanned = entries.length;

  for (const entry of entries) {
    // `isDirectory()` comes off the dirent's lstat, so a symlink — even one
    // pointing at a directory, and on Windows a junction — answers false and is
    // skipped. Deliberate: a link is not a tree we made.
    //
    // Keep this on the DIRENT. Swapping it for a `statSync(...).isDirectory()`
    // would look like a tidy-up and would start following links. The delete
    // itself is safe either way (Node's recursive `rmSync` lstats as it
    // descends and unlinks a link rather than entering it, so the readdir→rm
    // window costs at most the link), but nothing in this file should be the
    // thing that resolves one.
    if (!entry.isDirectory() || !ORPHAN_NAME.test(entry.name)) continue;
    summary.matched++;

    // The budget is checked HERE — before the `stat`, not just before the
    // delete — because on the backlog this exists for, statting is the bigger
    // half. Measured on the 2026-08-08 census machine: 115,314 candidates cost
    // 3.9 s in `stat` alone, so a budget that only fenced the deletes would
    // still have added four seconds to every `npm test`, which is exactly the
    // "housekeeping must be invisible" promise it is supposed to keep. The
    // price is that `remaining` counts candidates BY NAME, with their age
    // unchecked — a deliberately pessimistic number, and the only field here
    // that is an estimate.
    //
    // It can overshoot by one delete (an e2e app home is a real tree, and
    // `maxRetries` can add 150 ms), so the budget is a couple of seconds
    // against a suite that runs for minutes, not a bound anything depends on.
    if (Date.now() - startedAt >= budgetMs) {
      summary.budgetHit = true;
      summary.remaining++;
      continue;
    }

    const full = path.join(dir, entry.name);
    let stats;
    try {
      stats = fs.statSync(full);
    } catch {
      // Vanished under us (another sweep, another suite's teardown) or
      // unreadable. Either way it is not ours to count as a failure.
      continue;
    }
    // mtime, not birthtime, because birthtime is not portable — some Linux
    // filesystems return 0, which would make every candidate look ancient.
    //
    // Be careful what you credit mtime with. MEASURED, and not what the first
    // draft of this comment claimed: a directory's mtime moves only when an
    // entry is added, removed or renamed IN THAT DIRECTORY. Appending to a file
    // already inside it does not move it, and neither does anything happening
    // in a subdirectory. So for a `mkdtemp` root the reading is usually
    // creation time and nothing more — mtime is NOT a liveness signal, and the
    // 24 h floor is carrying the concurrency argument on its own. It can carry
    // it: the floor is two orders of magnitude longer than any run we have.
    if (now - stats.mtimeMs < minAgeMs) {
      summary.tooYoung++;
      continue;
    }

    if (dryRun) {
      summary.removed++;
      continue;
    }
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      summary.removed++;
    } catch (err) {
      // Windows: an indexer or AV holding a handle. Left for the next sweep.
      summary.failed++;
      note(`rm ${full}: ${String(err)}`);
    }
  }

  return done();
}

/**
 * One line, or nothing at all when there was genuinely nothing to do.
 *
 * Silence is the common case and it has to stay silent — a machine with a clean
 * temp dir must not grow a line of noise on every `npm test`. But `remaining`
 * counts too, or a budget that runs out before the first delete reports
 * "nothing to remove" while six figures of litter sit there, which is how the
 * backlog went unnoticed in the first place.
 */
function formatSummary(summary, { dryRun = false } = {}) {
  const quiet =
    summary.removed === 0 &&
    summary.failed === 0 &&
    summary.remaining === 0 &&
    summary.errors.length === 0;
  if (quiet) return '';
  const verb = dryRun ? 'would remove' : 'removed';
  const parts = [`temp sweep: ${verb} ${summary.removed} orphaned dir(s) in ${summary.elapsedMs}ms`];
  if (summary.remaining > 0) parts.push(`${summary.remaining} left for the next run`);
  if (summary.tooYoung > 0) parts.push(`${summary.tooYoung} too young`);
  if (summary.failed > 0) parts.push(`${summary.failed} would not delete`);
  let line = parts.join(', ');
  for (const err of summary.errors) line += `\n  ${err}`;
  return line;
}

/**
 * The automatic sweep, as both test runners' `globalSetup` wants it: budgeted,
 * opt-outable, silent when clean, and incapable of failing a run.
 *
 * It lives HERE, next to the delete loop, and not in either global-setup file,
 * because there are two callers now — `scripts/vitest-global-setup.js` and
 * `scripts/e2e-global-setup.js` (#360) — and the three decisions it encodes
 * (which budget, which off-switch, what happens on a throw) must be one answer
 * rather than two that drift. Same reasoning that made #354 export `isOn` from
 * `bundle-guard.js` instead of re-spelling it here.
 *
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
 * A finite number that is at least `min`, or `NaN`.
 *
 * `Number('')` is 0 and `Number(undefined)` is `NaN`, so without this a
 * fat-fingered `--min-age-hours=` would mean "no age floor at all" — every
 * leftover in the temp dir, including the ones three live suites are using.
 */
function atLeast(value, min) {
  if (value === undefined || value.trim() === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : NaN;
}

/**
 * The smallest age floor the CLI will accept, in hours.
 *
 * Not zero, and this is the one place a knob is deliberately not as flexible as
 * it could be. `--min-age-hours=0` means "delete every `sb-*` directory in the
 * temp dir right now", and on this machine that is three worktrees' suites plus
 * an e2e run having their fixtures pulled out from under them. An hour is still
 * far too aggressive to type by accident and no longer catastrophic; anyone who
 * genuinely wants zero can call `sweepTempOrphans({ minAgeMs: 0 })`, where it is
 * an argument in code rather than a flag in shell history.
 */
const MIN_AGE_FLOOR_HOURS = 1;

/**
 * `--flag=value` / `--flag` only — there is no positional argument, so a stray
 * path can never become the directory to sweep. That is also why there is no
 * `--dir`: the only sweepable directory is the OS temp dir.
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const opts = { dryRun: false };
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (flag === '--dry-run' || flag === '-n') {
      opts.dryRun = true;
    } else if (flag === '--min-age-hours') {
      const hours = atLeast(value, MIN_AGE_FLOOR_HOURS);
      if (Number.isNaN(hours)) opts.badNumber ??= flag;
      else opts.minAgeMs = hours * 60 * 60 * 1000;
    } else if (flag === '--budget-ms') {
      // Zero IS meaningful here — "list what you would do, spend nothing".
      const ms = atLeast(value, 0);
      if (Number.isNaN(ms)) opts.badNumber ??= flag;
      else opts.budgetMs = ms;
    } else {
      // The FIRST bad argument, not the last: it is the one the typo is in,
      // and everything after it is usually collateral.
      opts.unknown ??= arg;
    }
  }
  return opts;
}

const USAGE = `Usage: npm run sweep:temp -- [--dry-run] [--min-age-hours=N] [--budget-ms=N]

Deletes this repo's leftover mkdtemp directories (sb-<slug>-XXXXXX) from the OS
temp dir. Defaults: everything older than 24 hours, no time limit.

  --dry-run, -n        count what would go; delete nothing
  --min-age-hours=N    age floor; minimum ${MIN_AGE_FLOOR_HOURS}, because a smaller one
                       would delete the fixtures of a suite running right now
  --budget-ms=N        stop after N ms and leave the rest for next time`;

/**
 * CLI entry (`npm run sweep:temp`). Returns the exit code rather than calling
 * `process.exit`, so the tests can drive it in-process.
 *
 * The backlog run is UNBUDGETED on purpose: this is the command you type when
 * you want the six-figure pile gone, and a budget would turn it into a command
 * you have to type a hundred times.
 *
 * Exit 2 is a bad argument and nothing else. A sweep that failed every single
 * delete still exits 0 — the run happened, the failures are on stdout, and
 * housekeeping that could not finish is not an error anyone should gate on
 * (P6). Worth knowing before wiring this into anything that reads exit codes.
 *
 * @returns {0|2}
 */
function main(argv = process.argv.slice(2), write = (s) => process.stdout.write(s + '\n')) {
  const opts = parseArgs(argv);
  if (opts.unknown || opts.badNumber) {
    const why = opts.unknown
      ? `unknown argument: ${opts.unknown}`
      : `bad or out-of-range ${opts.badNumber}`;
    write(`${why}\n\n${USAGE}`);
    return 2;
  }
  // Explicitly, not by spreading `opts`: `parseArgs` also carries `unknown` and
  // `badNumber`, and a future flag whose name collided with a sweep option
  // would otherwise reach the delete loop without anyone deciding it should.
  const summary = sweepTempOrphans({
    dryRun: opts.dryRun,
    minAgeMs: opts.minAgeMs,
    budgetMs: opts.budgetMs,
  });
  write(formatSummary(summary, opts) || 'temp sweep: nothing to remove');
  return 0;
}

module.exports = {
  atLeast,
  MIN_AGE_FLOOR_HOURS,
  ORPHAN_NAME,
  DEFAULT_MIN_AGE_MS,
  DEFAULT_BUDGET_MS,
  MAX_LISTED_ERRORS,
  SKIP_ENV,
  USAGE,
  isPlausibleTempRoot,
  sweepTempOrphans,
  sweepBeforeTests,
  formatSummary,
  parseArgs,
  main,
};

if (require.main === module) process.exitCode = main();
