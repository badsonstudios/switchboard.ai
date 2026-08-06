// #286 / #298 — the stale-bundle guard for every script that runs `out/`
// WITHOUT building it first.
//
// `npm run e2e:only` runs Playwright against whatever is ALREADY in `out/`. It
// does not build. That is the point of the script (a rebuild is ~20s you don't
// want between two runs of the same spec) and it is also a trap:
//
//   edit src/renderer/Foo.tsx  ->  npm run e2e:only  ->  test fails
//
// ...and the failure looks exactly like a logic bug, because the code under
// test is the PREVIOUS build. #253's worker lost a debugging cycle to this;
// P2-E15-15 (build identity) was itself filed after a hand-tester lost one to
// the same shape of mistake. The information needed to catch it was already
// sitting in `out/` both times — nothing was printing it.
//
// **The five `check:*` scripts had the identical exposure (#298)**: each one
// execs an `out/main/*-check.js` bundle directly, with no build step and no
// guard, so a check could silently pass or fail against a bundle from an older
// edit — or from another worktree entirely, since `out/` is git-ignored and
// nothing ever compared it to the checkout. They all run through
// `scripts/run-electron-node.js`, which now calls this before it spawns
// anything under `out/`; see the note there for why the guard lives in the
// runner rather than in five package.json entries.
//
// So this runs first and answers, loudly, the one question that matters before
// a no-build run: **are the bytes in `out/` the code I just wrote?**
//
// Why it FAILS rather than merely warning: the stamp prints at the top of a
// run that then spends minutes streaming output over it. A warning there is a
// warning nobody reads at the moment they need it — they read it after, while
// re-reading a stack trace. The cost of the false direction is a whole
// debugging cycle; the cost of the hard stop is typing `npm run build`.
//
// It is safe to be strict because the input set is precise: only files that
// are actually BUNDLED count (see `isBundledSource`), so editing a spec, a unit
// test or a doc and re-running stays green — which is the single most common
// legitimate use of these scripts. `ALLOW_STALE_BUNDLE=1` is the escape hatch
// for the remainder ("I know this change cannot reach the bundle").
//
// Fail-open where it can be: an unreadable/absent build identity degrades to
// "unknown" and the mtime comparison — the load-bearing half — still runs.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** Env var that downgrades the stale verdict to a warning. */
const OVERRIDE_ENV = 'ALLOW_STALE_BUNDLE';

/**
 * #286's spelling, still honoured. It was `E2E_ALLOW_STALE` for exactly as long
 * as e2e was the only caller; #298 gave the guard five more and the `E2E_`
 * prefix stopped being true. Both are read, so a shell that already exports the
 * old one keeps working.
 */
const LEGACY_OVERRIDE_ENV = 'E2E_ALLOW_STALE';

/**
 * The one bundle that carries the baked build identity.
 *
 * `electron.vite.config.ts` puts the `__SWITCHBOARD_BUILD__` define on all
 * three targets, but esbuild only SUBSTITUTES it where the identifier is
 * referenced — and only `src/main/index.ts`'s dependency graph references it.
 * The `*-check.js` entries genuinely contain no identity of their own (verified
 * against a real build: `grep -c SWITCHBOARD_BUILD out/main/*.js` is 0 for all
 * of them), so every target reads it from here. That is sound because one
 * `npm run build` emits all of `out/main/` in a single rollup pass: index.js's
 * identity describes the build that produced the check bundle beside it.
 */
const IDENTITY_ARTIFACT = 'out/main/index.js';

/**
 * The build outputs whose age answers "when was `out/` last written" for
 * `e2e:only` — one per electron-vite target. We take the OLDEST of the three: a
 * build that died after main and before renderer leaves a half-fresh `out/`,
 * and the stale half is the one that matters.
 */
const ARTIFACTS = [IDENTITY_ARTIFACT, 'out/preload/index.js', 'out/renderer/index.html'];

/**
 * What `npm run e2e:only` / `e2e:ui` is about to test.
 *
 * A "target" is the small amount this guard needs to know about its caller: the
 * artifacts whose mtime decides the verdict, and the words to print — the
 * printed remedy IS the UX of the failure, so it has to name the command the
 * reader actually typed, not e2e's.
 *
 * @typedef {{label: string, command: string, artifacts: string[],
 *            buildHint: string, remedies: [string, string][]}} Target
 * @type {Target}
 */
const E2E_TARGET = {
  label: 'e2e:only',
  command: 'npm run e2e:only',
  artifacts: ARTIFACTS,
  buildHint: 'Run `npm run build` (or `npm run e2e`, which builds).',
  remedies: [
    ['npm run e2e', 'build, then run the whole suite'],
    ['npm run build && npm run e2e:only', 'the same two steps, kept apart'],
  ],
};

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

/** `a\b` -> `a/b`, so a Windows-shaped argument compares against our tables. */
const toPosix = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Is this file part of what gets bundled into `out/`?
 *
 * The exclusions are what keeps a hard failure tolerable: unit tests sit right
 * next to the code they test (`src/**\/*.test.ts`) and are compiled by vitest,
 * never by electron-vite. Editing one and re-running must not demand a rebuild
 * that would change nothing.
 *
 * @param {string} relPath path relative to the project root, either separator
 */
function isBundledSource(relPath) {
  const p = toPosix(relPath);
  if (/\.test\.tsx?$/.test(p)) return false; // vitest's, not the bundler's
  if (p === 'src/test-setup.ts') return false; // vitest setup only
  return true;
}

/**
 * Every bundled input with its mtime, newest first.
 *
 * mtime, not content hashing: this runs before every no-build run and has to be
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
 * @param {string[]} [artifacts] build outputs to age-check; defaults to e2e's three
 * @returns {{status: 'missing'|'stale'|'fresh', missing: string[], builtMs: number|null,
 *            oldestArtifact: string|null, staleFiles: {file: string, mtimeMs: number}[],
 *            newestInput: {file: string, mtimeMs: number}|null}}
 */
function checkFreshness(root, inputs, artifacts = ARTIFACTS) {
  const missing = [];
  /** @type {{file: string, mtimeMs: number}[]} */
  const built = [];
  for (const rel of artifacts) {
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

/**
 * Which branch this CHECKOUT is on — the other half of the provenance question
 * #298 asked: `out/` is git-ignored, so a directory copied in from another
 * worktree (or left over from one) looks exactly like a local build.
 *
 * Deliberately the SAME resolution order as `probeBuildIdentity()` in
 * `src/build/git-identity.ts`, including the GitHub fallback. `actions/checkout`
 * lands on a detached commit, so `--abbrev-ref HEAD` says `HEAD` on every CI
 * run; a naive equality check would then compare a real branch name against
 * "HEAD" and cry mismatch on every PR. Asking the environment the way the
 * BUILD asked it means CI compares like with like and stays quiet.
 *
 * The fallback chain is `||`, not `??`, and it must stay whatever
 * `probeBuildIdentity()` uses. #298 shipped this as a verbatim `??` copy of a
 * bug — GitHub sets `GITHUB_HEAD_REF` to `''` on non-PR events and `'' ?? x` is
 * `''`, so both sides answered null on a push build instead of reaching
 * `GITHUB_REF_NAME` — on the grounds that agreeing wrongly beats disagreeing.
 * #300 fixed both sides at once. The agreement is what matters: two different
 * readings of one env var would make this guard invent a mismatch that does not
 * exist, so `bundle-guard.test.js` cross-checks the two functions directly
 * rather than trusting two copies of a comment to stay in step.
 *
 * Never throws, and returns null for "don't know" (no git, no repo, a genuinely
 * detached local checkout) — unknown is not a mismatch.
 *
 * @param {string} root
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
function currentBranch(root, env) {
  try {
    const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    if (head && head !== 'HEAD') return head;
  } catch {
    // no git, no repo — the env fallback is the only answer left
  }
  return env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || null;
}

const RULE = '─'.repeat(72);

/**
 * The provenance note, or nothing.
 *
 * A WARNING and not a failure, unlike staleness, because the evidence is not
 * conclusive. mtimes are proof: a source newer than `out/` cannot be in `out/`.
 * A branch name is a hint — `npm run build` and then `git checkout -b` leaves a
 * bundle stamped with the old branch whose BYTES are perfectly correct, and
 * that is a normal morning. Failing there would teach people to type the
 * override, which is how a guard stops being one.
 *
 * @param {ReturnType<typeof extractBakedIdentity>} id
 * @param {string|null|undefined} branch the checkout's branch
 * @returns {string[]}
 */
function provenanceLines(id, branch) {
  if (!id || !id.branch || !branch || id.branch === branch) return [];
  return [
    `  NOTE — built on '${id.branch}', but this checkout is on '${branch}'.`,
    '  out/ is git-ignored, so it can outlive a branch switch or be copied in from',
    '  another worktree. Not a failure (build-then-branch does this legitimately),',
    '  but if a result surprises you, `npm run build` before believing it.',
  ];
}

/**
 * The whole report, as lines. Pure, so the tests assert on the words a tired
 * reader is supposed to see rather than on a formatting side effect.
 *
 * @param {ReturnType<typeof checkFreshness>} result
 * @param {ReturnType<typeof extractBakedIdentity>} identity
 * @param {{now?: number, overridden?: boolean, platform?: string, target?: Target,
 *          branch?: string|null}} [opts]
 * @returns {{lines: string[], failed: boolean}}
 */
function formatReport(result, identity, opts = {}) {
  const now = opts.now ?? Date.now();
  const overridden = opts.overridden === true;
  const target = opts.target ?? E2E_TARGET;
  const lines = [RULE, `${target.label} — NO BUILD RAN. Testing the bundle already in out/.`];

  if (result.status === 'missing') {
    lines.push(
      `  out/ is incomplete — missing: ${result.missing.join(', ')}`,
      `  There is nothing to run. ${target.buildHint}`,
      RULE
    );
    // Not overridable: the escape hatch means "my edit cannot have changed the
    // bundle", which presupposes there is a bundle.
    return { lines, failed: true };
  }

  lines.push(
    `  bundle:  ${describeBundle(identity, now)}`,
    `  out/:    written ${ago(result.builtMs, now)} (oldest artifact: ${result.oldestArtifact})`,
    ...provenanceLines(identity, opts.branch)
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
    ...target.remedies,
    [`${OVERRIDE_ENV}=1 ${target.command}`, 'bash: this change cannot reach the bundle'],
  ];
  if ((opts.platform ?? process.platform) === 'win32') {
    how.push([`$env:${OVERRIDE_ENV}=1; ${target.command}`, 'powershell: the same override']);
  }
  const width = Math.max(...how.map(([cmd]) => cmd.length));
  lines.push(
    '  You are about to run code that is NOT in out/, and a failure will look',
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
    return extractBakedIdentity(fs.readFileSync(path.join(root, IDENTITY_ARTIFACT), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The npm script that runs this bundle, found by ASKING package.json rather
 * than by transforming the filename: `pty-check.js` is `check:pty` but
 * `hook-check.js` is `check:hooks`, and a guess that is wrong tells the reader
 * to type a command that does not exist. Returns null when nothing matches, and
 * the caller falls back to spelling out the node invocation.
 *
 * @param {string} root
 * @param {string} relBundle posix-shaped, e.g. `out/main/pty-check.js`
 * @returns {string|null}
 */
function npmScriptFor(root, relBundle) {
  try {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const hit = Object.entries(scripts ?? {}).find(([, cmd]) => toPosix(cmd).includes(relBundle));
    return hit ? hit[0] : null;
  } catch {
    return null;
  }
}

/**
 * The target for one `out/` bundle executed directly — every `check:*` script.
 *
 * The artifact set is the bundle itself PLUS `out/main/index.js`: the latter is
 * where the identity lives, and it is emitted by the same rollup pass, so its
 * age is real evidence about whether that build ran to completion. The renderer
 * and preload are deliberately NOT included — a check script never loads them,
 * and failing `check:pty` over a half-built renderer would be a false positive
 * of exactly the kind that gets a guard overridden.
 *
 * @param {string} root
 * @param {string} bundle path to the bundle, relative to the root or absolute
 * @returns {Target}
 */
function targetFor(root, bundle) {
  const rel = toPosix(path.isAbsolute(bundle) ? path.relative(root, bundle) : bundle);
  const script = npmScriptFor(root, rel);
  const command = script ? `npm run ${script}` : `node scripts/run-electron-node.js ${rel}`;
  return {
    label: script ?? rel,
    command,
    artifacts: rel === IDENTITY_ARTIFACT ? [rel] : [IDENTITY_ARTIFACT, rel],
    buildHint: 'Run `npm run build` — the check bundles come out of the app build.',
    remedies: [[`npm run build && ${command}`, 'build, then run it']],
  };
}

/** Values of the override that mean "off" — a shell exporting it as `false` is
 *  saying no, and reading that as yes would open the gate permanently. */
const OFF = /^(0|false|no|off)$/i;

/** @param {string|undefined} raw */
const isOn = (raw) => typeof raw === 'string' && raw !== '' && !OFF.test(raw);

/**
 * @param {string} root
 * @param {Record<string, string|undefined>} env
 * @param {Target} [target] defaults to `e2e:only`
 * @returns {{lines: string[], failed: boolean}}
 */
function run(root, env, target = E2E_TARGET) {
  const result = checkFreshness(root, collectInputs(root), target.artifacts);
  const identity = readBundleIdentity(root);
  const overridden = isOn(env[OVERRIDE_ENV]) || isOn(env[LEGACY_OVERRIDE_ENV]);
  return formatReport(result, identity, {
    overridden,
    target,
    branch: currentBranch(root, env),
  });
}

/**
 * Guard one `out/` bundle and print the verdict; true means "you may proceed".
 * This is the entry point `scripts/run-electron-node.js` calls in-process — a
 * `spawnSync` of the CLI below would work too, but the check scripts are the
 * hot path and a node startup per check buys nothing.
 *
 * @param {string} root
 * @param {string} bundle
 * @param {Record<string, string|undefined>} env
 * @param {(s: string) => void} [write]
 * @returns {boolean}
 */
function guardBundle(root, bundle, env, write = (s) => process.stderr.write(s)) {
  const { lines, failed } = run(root, env, targetFor(root, bundle));
  write(`${lines.join('\n')}\n`);
  return !failed;
}

module.exports = {
  OVERRIDE_ENV,
  LEGACY_OVERRIDE_ENV,
  ARTIFACTS,
  IDENTITY_ARTIFACT,
  EXTRA_INPUTS,
  E2E_TARGET,
  isBundledSource,
  collectInputs,
  extractBakedIdentity,
  checkFreshness,
  formatReport,
  provenanceLines,
  currentBranch,
  npmScriptFor,
  targetFor,
  guardBundle,
  ago,
  run,
};

if (require.main === module) {
  // Root from __dirname, not process.cwd() (the house pattern —
  // run-electron-node.js, release-notes.js): run from a subdirectory, cwd would
  // find no out/ and hard-fail with a message that is flatly untrue.
  const root = path.join(__dirname, '..');
  // An argument names a bundle to guard (`node scripts/bundle-guard.js
  // out/main/pty-check.js`); no argument is e2e:only, the original caller.
  const arg = process.argv[2];
  const { lines, failed } = run(root, process.env, arg ? targetFor(root, arg) : E2E_TARGET);
  // stderr for both verdicts: this is a preamble to a run, and stdout is where
  // the results go.
  console.error(lines.join('\n'));
  process.exit(failed ? 1 : 0);
}
