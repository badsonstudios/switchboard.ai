// #286 — `npm run e2e:only` runs Playwright against whatever is ALREADY in
// `out/`. It does not build. That is the point of the script (a rebuild is ~20s
// you don't want between two runs of the same spec) and it is also a trap:
//
//   edit src/renderer/Foo.tsx  ->  npm run e2e:only  ->  test fails
//
// ...and the failure looks exactly like a logic bug, because the code under
// test is the PREVIOUS build. #253's worker lost a debugging cycle to this;
// P2-E15-15 (build identity) was itself filed after a hand-tester lost one to
// the same shape of mistake. The information needed to catch it was already
// sitting in `out/` both times — nothing was printing it.
//
// So this runs first and answers, loudly, the one question that matters before
// a no-build test run: **are the bytes in `out/` the code I just wrote?**
//
// Why it FAILS rather than merely warning: the stamp prints at the top of a
// run that then spends minutes streaming Playwright output over it. A warning
// there is a warning nobody reads at the moment they need it — they read it
// after, while re-reading a stack trace. The cost of the false direction is a
// whole debugging cycle; the cost of the hard stop is typing `npm run build`.
//
// It is safe to be strict because the input set is precise: only files that
// are actually BUNDLED count (see `isBundledSource`), so editing a spec, a unit
// test or a doc and re-running `e2e:only` stays green — which is the single
// most common legitimate use of the script. `E2E_ALLOW_STALE=1` is the escape
// hatch for the remainder ("I know this change cannot reach the bundle").
//
// Fail-open where it can be: an unreadable/absent build identity degrades to
// "unknown" and the mtime comparison — the load-bearing half — still runs.
'use strict';

const fs = require('fs');
const path = require('path');

/** Env var that downgrades the stale verdict to a warning. */
const OVERRIDE_ENV = 'E2E_ALLOW_STALE';

/**
 * The build outputs whose age answers "when was `out/` last written".
 *
 * One per electron-vite target, and we take the OLDEST of the three: a build
 * that died after main and before renderer leaves a half-fresh `out/`, and the
 * stale half is the one that matters.
 */
const ARTIFACTS = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html'];

/**
 * Bundled inputs that live outside `src/`. `electron.vite.config.ts` decides
 * what goes into every target (and bakes the identity); `package.json` moves
 * dependencies and the main entry point; `package-lock.json` moves the actual
 * dependency BYTES, and the renderer's deps are bundled — a lockfile-only bump
 * (`npm update`, a merged Dependabot PR) changes `out/` with `package.json`
 * untouched.
 */
const EXTRA_INPUTS = ['electron.vite.config.ts', 'package.json', 'package-lock.json'];

/** Directories under the project root that are walked for bundled sources. */
const INPUT_DIRS = ['src'];

/**
 * Is this file part of what gets bundled into `out/`?
 *
 * The exclusions are what keeps a hard failure tolerable: unit tests sit right
 * next to the code they test (`src/**\/*.test.ts`) and are compiled by vitest,
 * never by electron-vite. Editing one and re-running `e2e:only` must not
 * demand a rebuild that would change nothing.
 *
 * @param {string} relPath path relative to the project root, either separator
 */
function isBundledSource(relPath) {
  const p = relPath.replace(/\\/g, '/');
  if (/\.test\.tsx?$/.test(p)) return false; // vitest's, not the bundler's
  if (p === 'src/test-setup.ts') return false; // vitest setup only
  return true;
}

/**
 * Every bundled input with its mtime, newest first.
 *
 * mtime, not content hashing: this runs before every `e2e:only` and has to be
 * instant. Two known false NEGATIVES come with that, both harmless next to what
 * it catches — a DELETED source bumps nobody's mtime (its code is still in
 * `out/`), and a file edited mid-build (read at T1, saved at T2, `out/` written
 * at T3) reads fresh. The false POSITIVE is the common one and is deliberate:
 * rebase / checkout / stash-pop rewrite mtimes without changing content, and
 * the honest answer to "is my code in out/?" then really is "rebuild and stop
 * wondering".
 *
 * @param {string} root project root
 * @returns {{file: string, mtimeMs: number}[]}
 */
function collectInputs(root) {
  /** @type {{file: string, mtimeMs: number}[]} */
  const found = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return; // a missing source dir is the build's problem to report, not ours
    }
    for (const entry of entries) {
      const rel = `${dir}/${entry.name}`;
      // `!isDirectory()` rather than `isFile()`: a symlink is neither, and
      // `statSync` below follows it. There are none under `src/` today; this
      // just means one appearing later is counted rather than silently skipped.
      if (entry.isDirectory()) {
        walk(rel);
      } else if (!entry.isDirectory() && isBundledSource(rel)) {
        try {
          found.push({ file: rel, mtimeMs: fs.statSync(path.join(root, rel)).mtimeMs });
        } catch {
          // raced with a delete; it cannot be in the bundle either way
        }
      }
    }
  };

  for (const dir of INPUT_DIRS) walk(dir);
  for (const file of EXTRA_INPUTS) {
    try {
      found.push({ file, mtimeMs: fs.statSync(path.join(root, file)).mtimeMs });
    } catch {
      // absent: nothing to compare
    }
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found;
}

/**
 * The identity `electron.vite.config.ts` baked into a built bundle.
 *
 * Read out of the ARTIFACT rather than from a sidecar written at build time,
 * deliberately: the bundle's own bytes cannot disagree with the bundle. A
 * sidecar can (a build that fails after writing it claims a freshness `out/`
 * does not have) — and this file exists precisely because something claimed a
 * freshness it did not have.
 *
 * The define is textually substituted, so an object literal in exactly the
 * field order of `probeBuildIdentity()` appears wherever `__SWITCHBOARD_BUILD__`
 * did. `UNKNOWN_BUILD_IDENTITY` — an all-null literal in the very same shape —
 * is also in that file, hence "first match that actually knows something".
 *
 * @param {string} source bundle text
 * @returns {{commit: string|null, branch: string|null, dirty: boolean, builtAt: string|null}|null}
 */
function extractBakedIdentity(source) {
  const value = '(?:null|"([^"]*)")';
  const key = (k) => `["']?${k}["']?\\s*:\\s*`;
  const re = new RegExp(
    `${key('commit')}${value}\\s*,\\s*${key('branch')}${value}\\s*,\\s*` +
      `${key('dirty')}(true|false)\\s*,\\s*${key('builtAt')}${value}`,
    'g'
  );

  /** @type {ReturnType<typeof extractBakedIdentity>} */
  let fallback = null;
  for (const m of source.matchAll(re)) {
    const id = {
      commit: m[1] ?? null,
      branch: m[2] ?? null,
      dirty: m[3] === 'true',
      builtAt: m[4] ?? null,
    };
    if (id.commit || id.builtAt) return id;
    fallback = fallback ?? id; // the all-null UNKNOWN literal; keep looking
  }
  return fallback;
}

/**
 * Compare `out/` against the sources that produced it.
 *
 * @param {string} root project root
 * @param {{file: string, mtimeMs: number}[]} inputs newest-first, from collectInputs
 * @returns {{status: 'missing'|'stale'|'fresh', missing: string[], builtMs: number|null,
 *            oldestArtifact: string|null, staleFiles: {file: string, mtimeMs: number}[],
 *            newestInput: {file: string, mtimeMs: number}|null}}
 */
function checkFreshness(root, inputs) {
  const missing = [];
  /** @type {{file: string, mtimeMs: number}[]} */
  const built = [];
  for (const rel of ARTIFACTS) {
    try {
      built.push({ file: rel, mtimeMs: fs.statSync(path.join(root, rel)).mtimeMs });
    } catch {
      missing.push(rel);
    }
  }

  const newestInput = inputs[0] ?? null;
  if (missing.length > 0) {
    return {
      status: 'missing',
      missing,
      builtMs: null,
      oldestArtifact: null,
      staleFiles: [],
      newestInput,
    };
  }

  const oldest = built.reduce((a, b) => (a.mtimeMs <= b.mtimeMs ? a : b));
  const staleFiles = inputs.filter((i) => i.mtimeMs > oldest.mtimeMs);
  return {
    status: staleFiles.length > 0 ? 'stale' : 'fresh',
    missing: [],
    builtMs: oldest.mtimeMs,
    oldestArtifact: oldest.file,
    staleFiles,
    newestInput,
  };
}

/**
 * "2h ago" / "just now". Deliberately coarse — the reader is deciding whether
 * to rebuild, not timing anything.
 *
 * The in-app twin is `buildAge()` in `src/shared/build-identity.ts`, which
 * answers the same question for the About panel. Duplicated rather than shared
 * because `scripts/` is plain CJS run by `node` with no TS pipeline; if one
 * ever gains a bucket, give the other the same one — they are read minutes
 * apart about the same build.
 *
 * @param {number} ms epoch millis
 * @param {number} now epoch millis
 */
function ago(ms, now) {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The one-glance bundle stamp, in `describeIdentity()`'s wording.
 *
 * The baked build time gets its age appended so it can be compared at a glance
 * with the `out/` mtime line below it — two clocks that agree is a normal
 * build; two that disagree is an `out/` that came from somewhere else (copied
 * worktree, restored CI artifact) and is worth a second look.
 *
 * @param {ReturnType<typeof extractBakedIdentity>} id
 * @param {number} now epoch millis
 */
function describeBundle(id, now) {
  if (!id) return 'unknown (no build identity found in the bundle)';
  const sha = id.commit ? `${id.commit}${id.dirty ? '*' : ''}` : 'unknown';
  const stamped = Date.parse(id.builtAt ?? '');
  const when = id.builtAt
    ? `${id.builtAt}${Number.isNaN(stamped) ? '' : ` (${ago(stamped, now)})`}`
    : 'at an unknown time';
  return `${sha} on ${id.branch ?? 'detached'}, built ${when}`;
}

const RULE = '─'.repeat(72);

/**
 * The whole report, as lines. Pure, so the tests assert on the words a tired
 * reader is supposed to see rather than on a formatting side effect.
 *
 * @param {ReturnType<typeof checkFreshness>} result
 * @param {ReturnType<typeof extractBakedIdentity>} identity
 * @param {{now?: number, overridden?: boolean, platform?: string}} [opts]
 * @returns {{lines: string[], failed: boolean}}
 */
function formatReport(result, identity, opts = {}) {
  const now = opts.now ?? Date.now();
  const overridden = opts.overridden === true;
  const lines = [RULE, 'e2e:only — NO BUILD RAN. Testing the bundle already in out/.'];

  if (result.status === 'missing') {
    lines.push(
      `  out/ is incomplete — missing: ${result.missing.join(', ')}`,
      '  There is nothing to test. Run `npm run build` (or `npm run e2e`, which builds).',
      RULE
    );
    // Not overridable: the escape hatch means "my edit cannot have changed the
    // bundle", which presupposes there is a bundle.
    return { lines, failed: true };
  }

  lines.push(
    `  bundle:  ${describeBundle(identity, now)}`,
    `  out/:    written ${ago(result.builtMs, now)} (oldest artifact: ${result.oldestArtifact})`
  );

  if (result.status === 'fresh') {
    const newest = result.newestInput;
    lines.push(
      newest
        ? `  sources: newest bundled change is ${newest.file} (${ago(newest.mtimeMs, now)})`
        : '  sources: none found',
      '  FRESH — every bundled source is older than this build.',
      RULE
    );
    return { lines, failed: false };
  }

  const shown = result.staleFiles.slice(0, 5);
  lines.push(
    `  STALE — ${result.staleFiles.length} bundled source file(s) changed AFTER this build:`,
    ...shown.map((f) => `    ${f.file} (${ago(f.mtimeMs, now)})`)
  );
  if (result.staleFiles.length > shown.length) {
    lines.push(`    ...and ${result.staleFiles.length - shown.length} more`);
  }
  if (overridden) {
    lines.push(
      `  ${OVERRIDE_ENV}=1 — continuing anyway. Any failure below may be the STALE`,
      '  bundle talking, not your code.',
      RULE
    );
    return { lines, failed: false };
  }
  // The printed remedy IS the UX of this failure, so it has to be pasteable in
  // the shell the reader is actually in. `FOO=1 cmd` is a parse error in
  // PowerShell, and this project is developed on Windows across both PowerShell
  // and Git Bash — so on Windows, offer both spellings rather than guess.
  const how = [
    ['npm run e2e', 'build, then run the whole suite'],
    ['npm run build && npm run e2e:only', 'the same two steps, kept apart'],
    [`${OVERRIDE_ENV}=1 npm run e2e:only`, 'bash: this change cannot reach the bundle'],
  ];
  if ((opts.platform ?? process.platform) === 'win32') {
    how.push([`$env:${OVERRIDE_ENV}=1; npm run e2e:only`, 'powershell: the same override']);
  }
  const width = Math.max(...how.map(([cmd]) => cmd.length));
  lines.push(
    '  You are about to test code that is NOT in out/, and a failure will look',
    '  exactly like a logic bug (#286). One of:',
    ...how.map(([cmd, why]) => `    ${cmd.padEnd(width)}  # ${why}`),
    RULE
  );
  return { lines, failed: true };
}

/**
 * Read the baked identity out of the main bundle, or null if it cannot be had.
 * Never throws: the mtime check is the part that must always run.
 *
 * @param {string} root
 */
function readBundleIdentity(root) {
  try {
    return extractBakedIdentity(fs.readFileSync(path.join(root, ARTIFACTS[0]), 'utf8'));
  } catch {
    return null;
  }
}

/** Values of the override that mean "off" — a shell exporting it as `false` is
 *  saying no, and reading that as yes would open the gate permanently. */
const OFF = /^(0|false|no|off)$/i;

/**
 * @param {string} root
 * @param {Record<string, string|undefined>} env
 * @returns {{lines: string[], failed: boolean}}
 */
function run(root, env) {
  const result = checkFreshness(root, collectInputs(root));
  const identity = readBundleIdentity(root);
  const raw = env[OVERRIDE_ENV];
  const overridden = typeof raw === 'string' && raw !== '' && !OFF.test(raw);
  return formatReport(result, identity, { overridden });
}

module.exports = {
  OVERRIDE_ENV,
  ARTIFACTS,
  EXTRA_INPUTS,
  isBundledSource,
  collectInputs,
  extractBakedIdentity,
  checkFreshness,
  formatReport,
  ago,
  run,
};

if (require.main === module) {
  // Root from __dirname, not process.cwd() (the house pattern —
  // run-electron-node.js, release-notes.js): run from a subdirectory, cwd would
  // find no out/ and hard-fail with a message that is flatly untrue.
  const { lines, failed } = run(path.join(__dirname, '..'), process.env);
  // stderr for both verdicts: this is a preamble to a test run, and stdout is
  // where the test results go.
  console.error(lines.join('\n'));
  process.exit(failed ? 1 : 0);
}
