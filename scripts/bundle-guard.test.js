// #286 / #298 — tests for the stale-bundle guard.
//
// The guard's whole value is that it is RIGHT about staleness: a false "fresh"
// hands back the debugging cycle it exists to save, and a false "stale" trains
// people to type ALLOW_STALE_BUNDLE=1 until it means nothing. Both directions are
// pinned here, on real files in a temp dir rather than a mocked fs, because
// mtime comparison is exactly the thing a mock would let us get wrong.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  OVERRIDE_ENV,
  LEGACY_OVERRIDE_ENV,
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
  guardE2eBundle,
  e2eTarget,
  E2E_TARGET,
  NO_BUILD_HEADLINE,
  ago,
  run,
} from './bundle-guard.js';
import { isBuildOutput } from './run-electron-node.js';
import { cleanupTempDirs, tempDir } from '../src/test-temp-dirs';
// #300 — the build-time half of the same question. Imported so the two
// implementations are compared directly instead of via mirrored comments; see
// the `currentBranch` agreement test below. Test-only, and the one place these
// two corners of the tree meet.
import { probeBuildIdentity } from '../src/build/git-identity';

const SCRIPT = path.join(process.cwd(), 'scripts', 'bundle-guard.js');

/** A bundle the way electron-vite emits it once the define is substituted. */
function bundleWith(id) {
  const q = (v) => (v === null ? 'null' : JSON.stringify(v));
  return [
    'const UNKNOWN = { commit: null, branch: null, dirty: false, builtAt: null };',
    `function buildIdentity() { return normalize(typeof { commit: ${q(id.commit)}, branch: ${q(
      id.branch
    )}, dirty: ${id.dirty}, builtAt: ${q(id.builtAt)} } === "undefined" ? void 0 : { commit: ${q(
      id.commit
    )}, branch: ${q(id.branch)}, dirty: ${id.dirty}, builtAt: ${q(id.builtAt)} }); }`,
  ].join('\n');
}

/** Build a fake project root: sources, then artifacts stamped newer. */
function makeProject({ sources = {}, artifacts = true, identity = null } = {}) {
  // `sb-` prefixed since #360, and not for tidiness: the orphan sweeper
  // recognises leftovers by SHAPE (`sb-<slug>-XXXXXX`), so a fixture named
  // `e2e-guard-` was one nothing would ever collect if a teardown missed it.
  const root = tempDir('sb-e2e-guard-');
  const write = (rel, body) => {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  const OUT_OF_TREE = ['package.json', 'package-lock.json', 'electron.vite.config.ts'];
  write('package.json', '{}');
  write('package-lock.json', '{}');
  write('electron.vite.config.ts', '// config');
  for (const [rel, body] of Object.entries(sources)) write(rel, body);

  if (artifacts) {
    write('out/main/index.js', identity ? bundleWith(identity) : '// main');
    write('out/preload/index.js', '// preload');
    write('out/renderer/index.html', '<html></html>');
    // Every artifact strictly newer than every source, the way a real build
    // leaves things. Explicit times, because a build takes longer than the
    // filesystem's mtime granularity and the test must not depend on that.
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() - 30_000);
    for (const rel of Object.keys(sources)) touch(root, rel, past);
    for (const rel of OUT_OF_TREE) touch(root, rel, past);
    for (const rel of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
      touch(root, rel, future);
    }
  }
  return root;
}

function touch(root, rel, when) {
  fs.utimesSync(path.join(root, rel), when, when);
}

// Every fixture here is per-test, so the whole registry goes at the end of each
// one (#213, #360). It replaces a hand-rolled list and a bare `rmSync` — which
// a hook that threw above it would have skipped, silently, for ever.
afterEach(() => cleanupTempDirs());
function project(opts) {
  return makeProject(opts);
}

describe('isBundledSource', () => {
  it('counts the code that actually gets bundled', () => {
    expect(isBundledSource('src/main/index.ts')).toBe(true);
    expect(isBundledSource('src/renderer/App.tsx')).toBe(true);
    expect(isBundledSource('src/renderer/index.html')).toBe(true);
    expect(isBundledSource('src\\main\\index.ts')).toBe(true); // windows separators
  });

  it('ignores vitest files, so editing a unit test never demands a rebuild', () => {
    // The exclusion that makes a HARD failure tolerable: unit tests sit beside
    // their subject and are compiled by vitest, never by electron-vite.
    expect(isBundledSource('src/main/check-scripts.test.ts')).toBe(false);
    expect(isBundledSource('src/renderer/App.test.tsx')).toBe(false);
    expect(isBundledSource('src/test-setup.ts')).toBe(false);
  });
});

describe('collectInputs', () => {
  it('walks src/ recursively and adds the out-of-tree build inputs', () => {
    const root = project({ sources: { 'src/main/index.ts': 'a', 'src/shared/deep/x.ts': 'b' } });
    const files = collectInputs(root).map((f) => f.file);
    expect(files).toEqual(
      expect.arrayContaining([
        'src/main/index.ts',
        'src/shared/deep/x.ts',
        'package.json',
        'electron.vite.config.ts',
      ])
    );
  });

  it('leaves test files out and returns newest first', () => {
    const root = project({ sources: { 'src/a.ts': 'a', 'src/a.test.ts': 'b' } });
    const files = collectInputs(root);
    expect(files.map((f) => f.file)).not.toContain('src/a.test.ts');
    for (let i = 1; i < files.length; i++) {
      expect(files[i - 1].mtimeMs).toBeGreaterThanOrEqual(files[i].mtimeMs);
    }
  });

  it('survives a project with no src/ at all', () => {
    const root = project({ artifacts: false });
    expect(() => collectInputs(root)).not.toThrow();
  });
});

describe('checkFreshness', () => {
  it('is fresh when out/ is newer than every bundled source', () => {
    const root = project({ sources: { 'src/main/index.ts': 'a' } });
    const result = checkFreshness(root, collectInputs(root));
    expect(result.status).toBe('fresh');
    expect(result.staleFiles).toEqual([]);
  });

  it('is stale the moment a bundled source is touched after the build', () => {
    const root = project({ sources: { 'src/renderer/App.tsx': 'a' } });
    touch(root, 'src/renderer/App.tsx', new Date());
    const result = checkFreshness(root, collectInputs(root));
    expect(result.status).toBe('stale');
    expect(result.staleFiles.map((f) => f.file)).toEqual(['src/renderer/App.tsx']);
  });

  it('stays fresh when only a unit test moved', () => {
    const root = project({ sources: { 'src/a.ts': 'a', 'src/a.test.ts': 'b' } });
    touch(root, 'src/a.test.ts', new Date());
    expect(checkFreshness(root, collectInputs(root)).status).toBe('fresh');
  });

  it('catches a build that died between targets, via the OLDEST artifact', () => {
    // main rebuilt, renderer left behind: half of out/ is stale and the stale
    // half is the one under test.
    const root = project({ sources: { 'src/renderer/App.tsx': 'a' } });
    const now = new Date();
    touch(root, 'src/renderer/App.tsx', new Date(Date.now() - 10_000));
    touch(root, 'out/main/index.js', now);
    const result = checkFreshness(root, collectInputs(root));
    expect(result.status).toBe('stale');
    expect(result.oldestArtifact).not.toBe('out/main/index.js');
  });

  it('reports which artifacts are missing when out/ was never built', () => {
    const root = project({ sources: { 'src/a.ts': 'a' }, artifacts: false });
    const result = checkFreshness(root, collectInputs(root));
    expect(result.status).toBe('missing');
    expect(result.missing).toContain('out/main/index.js');
  });

  it('notices the build inputs outside src/ too', () => {
    // package-lock.json included: renderer deps ARE bundled, so a lockfile-only
    // bump changes out/ with package.json untouched.
    for (const file of ['electron.vite.config.ts', 'package.json', 'package-lock.json']) {
      const root = project({ sources: { 'src/a.ts': 'a' } });
      touch(root, file, new Date());
      const result = checkFreshness(root, collectInputs(root));
      expect(result.status, file).toBe('stale');
      expect(result.staleFiles.map((f) => f.file)).toEqual([file]);
    }
  });
});

describe('extractBakedIdentity', () => {
  const id = {
    commit: 'd1ab9b79',
    branch: 'feature/286-e2eonly-guard',
    dirty: true,
    builtAt: '2026-08-05T19:17:11.275Z',
  };

  it('reads the define back out of an emitted bundle', () => {
    expect(extractBakedIdentity(bundleWith(id))).toEqual(id);
  });

  it('does not settle for the all-null UNKNOWN literal sitting in the same file', () => {
    // UNKNOWN_BUILD_IDENTITY has the identical shape and may be emitted first;
    // returning it would print "unknown" for a build that knows exactly who it is.
    const source = `const UNKNOWN = {commit:null,branch:null,dirty:false,builtAt:null};\n${bundleWith(
      id
    )}`;
    expect(extractBakedIdentity(source)).toEqual(id);
  });

  it('reads the exact form esbuild emits today (a hoisted define binding)', () => {
    // Verbatim from out/main/index.js. The regex is a contract with the
    // BUNDLER's output, and the bundler is the half we do not control - if a
    // vite/esbuild bump changes hoisting or quoting, this is the test that goes
    // red instead of the stamp quietly reading "unknown" forever.
    const source =
      'var define_SWITCHBOARD_BUILD_default = { commit: "ed7ee504", branch: ' +
      '"feature/286-e2eonly-guard", dirty: true, builtAt: "2026-08-05T19:55:37.300Z" };';
    expect(extractBakedIdentity(source)).toEqual({
      commit: 'ed7ee504',
      branch: 'feature/286-e2eonly-guard',
      dirty: true,
      builtAt: '2026-08-05T19:55:37.300Z',
    });
  });

  it('reads a minified bundle (quoted keys, no whitespace)', () => {
    const source = '{"commit":"abc12345","branch":"main","dirty":false,"builtAt":"2026-01-01T00:00:00.000Z"}';
    expect(extractBakedIdentity(source)).toEqual({
      commit: 'abc12345',
      branch: 'main',
      dirty: false,
      builtAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('reads a build git could not describe (null commit, real build time)', () => {
    const noGit = { commit: null, branch: null, dirty: false, builtAt: '2026-01-01T00:00:00.000Z' };
    expect(extractBakedIdentity(bundleWith(noGit))).toEqual(noGit);
  });

  it('returns null rather than throwing when there is no identity at all', () => {
    expect(extractBakedIdentity('console.log("hello")')).toBeNull();
  });
});

describe('formatReport', () => {
  const identity = {
    commit: 'd1ab9b79',
    branch: 'feature/286-e2eonly-guard',
    dirty: true,
    builtAt: '2026-08-05T19:17:11.275Z',
  };
  const now = Date.parse('2026-08-05T21:17:11.275Z');
  const fresh = {
    status: 'fresh',
    missing: [],
    builtMs: now - 7_200_000,
    oldestArtifact: 'out/renderer/index.html',
    staleFiles: [],
    newestInput: { file: 'src/main/index.ts', mtimeMs: now - 10_800_000 },
  };

  it('always stamps the bundle it is about to test, even when fresh', () => {
    const { lines, failed } = formatReport(fresh, identity, { now });
    const text = lines.join('\n');
    expect(failed).toBe(false);
    expect(text).toContain('NO BUILD RAN');
    expect(text).toContain('d1ab9b79*'); // dirty marker
    expect(text).toContain('feature/286-e2eonly-guard');
    expect(text).toContain('FRESH');
  });

  it('still stamps when the bundle has no identity to give', () => {
    const text = formatReport(fresh, null, { now }).lines.join('\n');
    expect(text).toContain('unknown');
    expect(text).toContain('FRESH');
  });

  it('dates the bundle in both clocks, so a foreign out/ stands out', () => {
    const text = formatReport(fresh, identity, { now }).lines.join('\n');
    expect(text).toContain('2026-08-05T19:17:11.275Z (2h ago)'); // baked
    expect(text).toContain('written 2h ago'); // mtime
  });

  it('fails with the offending files and the two ways out', () => {
    const stale = {
      ...fresh,
      status: 'stale',
      staleFiles: [{ file: 'src/renderer/App.tsx', mtimeMs: now - 60_000 }],
    };
    const { lines, failed } = formatReport(stale, identity, { now, platform: 'linux' });
    const text = lines.join('\n');
    expect(failed).toBe(true);
    expect(text).toContain('STALE');
    expect(text).toContain('src/renderer/App.tsx');
    expect(text).toContain('npm run e2e');
    expect(text).toContain(`${OVERRIDE_ENV}=1 npm run e2e:only`);
  });

  it('offers the PowerShell spelling of the override on Windows', () => {
    // `FOO=1 cmd` is a parse error in PowerShell, which is the shell this is
    // most likely to be read in. A remedy that cannot be pasted is not a remedy.
    const stale = {
      ...fresh,
      status: 'stale',
      staleFiles: [{ file: 'src/renderer/App.tsx', mtimeMs: now - 60_000 }],
    };
    const win = formatReport(stale, identity, { now, platform: 'win32' }).lines.join('\n');
    expect(win).toContain(`$env:${OVERRIDE_ENV}=1; npm run e2e:only`);
    expect(win).toContain(`${OVERRIDE_ENV}=1 npm run e2e:only`); // bash still offered

    const posix = formatReport(stale, identity, { now, platform: 'linux' }).lines.join('\n');
    expect(posix).not.toContain('$env:');
  });

  it('truncates a long stale list instead of burying the verdict', () => {
    const staleFiles = Array.from({ length: 12 }, (_, i) => ({
      file: `src/f${i}.ts`,
      mtimeMs: now - 60_000,
    }));
    const text = formatReport({ ...fresh, status: 'stale', staleFiles }, identity, {
      now,
    }).lines.join('\n');
    expect(text).toContain('12 bundled source file(s)');
    expect(text).toContain('...and 7 more');
  });

  it('says nothing about provenance when the branches agree or either is unknown', () => {
    expect(provenanceLines(identity, identity.branch)).toEqual([]);
    expect(provenanceLines({ ...identity, branch: null }, 'main')).toEqual([]);
    expect(provenanceLines(identity, null)).toEqual([]);
    expect(provenanceLines(null, 'main')).toEqual([]);
  });

  it('flags a bundle built on another branch, and does NOT fail over it (#298)', () => {
    // A hint, not proof: `npm run build` then `git checkout -b` leaves a bundle
    // stamped with the old branch whose bytes are perfectly correct. Failing
    // there would train people to type the override.
    const { lines, failed } = formatReport(fresh, identity, { now, branch: 'main' });
    const text = lines.join('\n');
    expect(failed).toBe(false);
    expect(text).toContain("built on 'feature/286-e2eonly-guard'");
    expect(text).toContain("this checkout is on 'main'");
    expect(text).toContain('another worktree');
  });

  it('the override warns loudly and still passes', () => {
    const stale = {
      ...fresh,
      status: 'stale',
      staleFiles: [{ file: 'src/renderer/App.tsx', mtimeMs: now - 60_000 }],
    };
    const { lines, failed } = formatReport(stale, identity, { now, overridden: true });
    expect(failed).toBe(false);
    expect(lines.join('\n')).toContain('may be the STALE');
  });

  it('a missing out/ fails even with the override — there is nothing to test', () => {
    const missing = { ...fresh, status: 'missing', missing: ['out/main/index.js'] };
    expect(formatReport(missing, null, { now, overridden: true }).failed).toBe(true);
    expect(formatReport(missing, null, { now }).lines.join('\n')).toContain('npm run build');
  });
});

describe('ago', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z');
  it.each([
    [0, 'just now'],
    [59_000, 'just now'],
    [5 * 60_000, '5m ago'],
    [3 * 3_600_000, '3h ago'],
    [4 * 86_400_000, '4d ago'],
  ])('%i ms -> %s', (delta, expected) => {
    expect(ago(now - delta, now)).toBe(expected);
  });

  it('clamps a future build time rather than counting backwards', () => {
    expect(ago(now + 60_000, now)).toBe('just now');
  });
});

describe('run', () => {
  it('passes a fresh project and reads its baked identity', () => {
    const root = project({
      sources: { 'src/main/index.ts': 'a' },
      identity: { commit: 'abc12345', branch: 'main', dirty: false, builtAt: '2026-08-05T00:00:00.000Z' },
    });
    const { lines, failed } = run(root, {});
    expect(failed).toBe(false);
    expect(lines.join('\n')).toContain('abc12345 on main');
  });

  it('fails a stale project', () => {
    const root = project({ sources: { 'src/main/index.ts': 'a' } });
    touch(root, 'src/main/index.ts', new Date());
    expect(run(root, {}).failed).toBe(true);
  });

  it.each([
    ['1', false],
    ['true', false],
    ['yes', false],
    ['0', true],
    ['false', true],
    ['no', true],
    ['off', true],
    ['', true],
  ])('%s honours/ignores the override as expected', (value, expectedFail) => {
    // `0`/`false`/`no`/`off`/empty must NOT open the gate: a shell that exports
    // the variable as off is saying off, and reading that as on would disable
    // the guard permanently for whoever set it.
    const root = project({ sources: { 'src/main/index.ts': 'a' } });
    touch(root, 'src/main/index.ts', new Date());
    expect(run(root, { [OVERRIDE_ENV]: value }).failed).toBe(expectedFail);
  });

  it('still honours #286’s E2E_ALLOW_STALE spelling', () => {
    // Renamed in #298 because four more callers made the `E2E_` prefix a lie.
    // The old name keeps working so an exported shell variable does not quietly
    // stop meaning anything.
    const root = project({ sources: { 'src/main/index.ts': 'a' } });
    touch(root, 'src/main/index.ts', new Date());
    expect(run(root, { [LEGACY_OVERRIDE_ENV]: '1' }).failed).toBe(false);
    expect(run(root, { [LEGACY_OVERRIDE_ENV]: '0' }).failed).toBe(true);
  });
});

describe('currentBranch', () => {
  it('never reports the literal "HEAD"', () => {
    // The whole reason this is not `git rev-parse --abbrev-ref HEAD` alone:
    // `actions/checkout` is detached, git answers "HEAD", and comparing a real
    // branch name against that would cry mismatch on every single CI run.
    expect(currentBranch(process.cwd(), {})).not.toBe('HEAD');
  });

  it('falls back to GitHub’s env exactly as the build did', () => {
    // A cwd that cannot exist forces the git side to fail, which is what a
    // detached CI checkout amounts to for this function.
    const nowhere = path.join(os.tmpdir(), 'bundle-guard-no-such-dir');
    expect(currentBranch(nowhere, { GITHUB_HEAD_REF: 'feature/x' })).toBe('feature/x');
    expect(currentBranch(nowhere, { GITHUB_REF_NAME: 'main' })).toBe('main');
    expect(currentBranch(nowhere, {})).toBeNull();
  });

  it('#300 — an empty GITHUB_HEAD_REF falls through to GITHUB_REF_NAME', () => {
    // GitHub DEFINES GITHUB_HEAD_REF on every event and sets it to '' when the
    // event has no head ref (push, schedule, dispatch). #298 shipped this as a
    // verbatim `??` copy of git-identity.ts, empty string and all, so that the
    // two could not disagree; #300 fixed both at once. Empty and absent mean
    // the same thing here, so `||` is the operator that belongs.
    const nowhere = path.join(os.tmpdir(), 'bundle-guard-no-such-dir');
    expect(currentBranch(nowhere, { GITHUB_HEAD_REF: '', GITHUB_REF_NAME: 'main' })).toBe('main');
    expect(currentBranch(nowhere, { GITHUB_HEAD_REF: '', GITHUB_REF_NAME: '' })).toBeNull();
  });

  it('answers identically to probeBuildIdentity for every env shape', () => {
    // The real pin, and the reason #298's mirrored COMMENT was not enough: this
    // guard's provenance NOTE compares the branch baked into the bundle (by
    // probeBuildIdentity, at build time) against the branch of the checkout (by
    // currentBranch, now). Any disagreement about how to read one env var makes
    // it invent a mismatch that does not exist. Two copies of a rule drift;
    // calling both functions does not. Touch either fallback chain alone and
    // this goes red.
    const nowhere = path.join(os.tmpdir(), 'bundle-guard-no-such-dir');
    // detached HEAD is what BOTH sides see on CI: actions/checkout lands on a
    // commit, so git has no branch name and only the environment does.
    const detachedGit = (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --short=8 HEAD') return 'a1b2c3d4\n';
      if (key === 'rev-parse --abbrev-ref HEAD') return 'HEAD\n';
      if (key === 'status --porcelain') return '';
      throw new Error(`unexpected git: ${key}`);
    };

    const envs = [
      {},
      { GITHUB_HEAD_REF: 'feature/300' },
      { GITHUB_REF_NAME: 'main' },
      { GITHUB_HEAD_REF: '', GITHUB_REF_NAME: 'main' }, // push event — #300
      { GITHUB_HEAD_REF: '', GITHUB_REF_NAME: '' }, // no CI at all
      { GITHUB_HEAD_REF: 'feature/300', GITHUB_REF_NAME: '300/merge' }, // pull_request
      { GITHUB_HEAD_REF: undefined, GITHUB_REF_NAME: 'main' },
    ];
    for (const env of envs) {
      const baked = probeBuildIdentity({ run: detachedGit, env }).branch;
      expect({ env, branch: currentBranch(nowhere, env) }).toEqual({ env, branch: baked });
    }
  });
});

describe('check bundles (#298)', () => {
  /** A project whose out/ also holds a check entry, wired in package.json. */
  function checkProject(opts) {
    const root = project(opts);
    const past = new Date(Date.now() - 60_000);
    const built = new Date(Date.now() - 30_000);
    fs.writeFileSync(path.join(root, 'out', 'main', 'pty-check.js'), '// pty check');
    fs.utimesSync(path.join(root, 'out', 'main', 'pty-check.js'), built, built);
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        scripts: { 'check:pty': 'node scripts/run-electron-node.js out/main/pty-check.js' },
      })
    );
    fs.utimesSync(path.join(root, 'package.json'), past, past);
    return root;
  }

  it('names the npm script by ASKING package.json, not by rewriting the filename', () => {
    // `pty-check.js` -> `check:pty`, but `hook-check.js` -> `check:hookS`. A
    // derived guess would print a command that does not exist, in the one
    // message whose whole job is to be pasteable.
    const cwd = process.cwd();
    expect(npmScriptFor(cwd, 'out/main/pty-check.js')).toBe('check:pty');
    expect(npmScriptFor(cwd, 'out/main/hook-check.js')).toBe('check:hooks');
    expect(npmScriptFor(cwd, 'out/main/transcript-check.js')).toBe('check:transcripts');
    expect(npmScriptFor(cwd, 'out/main/fake-stream-check.js')).toBe('check:fake-stream');
    expect(npmScriptFor(cwd, 'out/main/nothing-runs-this.js')).toBeNull();
  });

  it('guards the bundle plus the identity-carrying main entry, and nothing else', () => {
    const t = targetFor(process.cwd(), 'out/main/pty-check.js');
    expect(t.artifacts).toEqual(['out/main/index.js', 'out/main/pty-check.js']);
    expect(t.label).toBe('check:pty');
    expect(t.command).toBe('npm run check:pty');
  });

  it('takes an absolute path or Windows separators', () => {
    const cwd = process.cwd();
    expect(targetFor(cwd, path.join(cwd, 'out', 'main', 'pty-check.js')).label).toBe('check:pty');
    expect(targetFor(cwd, 'out\\main\\pty-check.js').label).toBe('check:pty');
  });

  it('falls back to the node invocation when no script runs the bundle', () => {
    const t = targetFor(process.cwd(), 'out/main/mystery.js');
    expect(t.label).toBe('out/main/mystery.js');
    expect(t.command).toContain('run-electron-node.js out/main/mystery.js');
  });

  it('passes a fresh check bundle, stamping the script name', () => {
    const root = checkProject({ sources: { 'src/main/pty/lifecycle-check.ts': 'a' } });
    let out = '';
    expect(guardBundle(root, 'out/main/pty-check.js', {}, (s) => (out += s))).toBe(true);
    expect(out).toContain('check:pty — NO BUILD RAN');
    expect(out).toContain('FRESH');
  });

  it('fails a stale check bundle with the CHECK command, not e2e’s', () => {
    const root = checkProject({ sources: { 'src/main/pty/lifecycle-check.ts': 'a' } });
    touch(root, 'src/main/pty/lifecycle-check.ts', new Date());
    let out = '';
    expect(guardBundle(root, 'out/main/pty-check.js', {}, (s) => (out += s))).toBe(false);
    expect(out).toContain('STALE');
    expect(out).toContain('npm run build && npm run check:pty');
    expect(out).not.toContain('e2e:only');
  });

  it('fails when the check bundle itself was never built', () => {
    const root = project({ sources: { 'src/a.ts': 'a' } }); // out/ has no *-check.js
    let out = '';
    expect(guardBundle(root, 'out/main/pty-check.js', {}, (s) => (out += s))).toBe(false);
    expect(out).toContain('out/main/pty-check.js');
    expect(out).toContain('npm run build');
  });

  it('ignores a half-built RENDERER, which no check script loads', () => {
    // The false positive that would get this guard overridden within a week:
    // `check:pty` does not care that out/renderer is behind. e2e:only does, and
    // still says so on the very same project.
    const root = checkProject({ sources: { 'src/renderer/App.tsx': 'a' } });
    touch(root, 'out/renderer/index.html', new Date(Date.now() - 120_000));
    expect(guardBundle(root, 'out/main/pty-check.js', {}, () => {})).toBe(true);
    expect(run(root, {}).failed).toBe(true); // e2e:only, same project
  });

  it('is honoured by the same override', () => {
    const root = checkProject({ sources: { 'src/main/pty/lifecycle-check.ts': 'a' } });
    touch(root, 'src/main/pty/lifecycle-check.ts', new Date());
    expect(guardBundle(root, 'out/main/pty-check.js', { [OVERRIDE_ENV]: '1' }, () => {})).toBe(true);
  });
});

describe('the e2e pre-flight target (#329)', () => {
  // Playwright's globalSetup guards EVERY way of starting the suite, including
  // the `npx playwright test` that skips npm — so the report has to name the
  // command the reader actually typed, and must not claim "NO BUILD RAN" over
  // an `npm run e2e` that just built.
  it('names the bare invocation when npm was not involved', () => {
    const t = e2eTarget({});
    expect(t.label).toBe('playwright test');
    expect(t.command).toBe('npx playwright test');
    expect(t.headline).toBe(NO_BUILD_HEADLINE);
    expect(t.remedies.map(([cmd]) => cmd)).toContain('npm run e2e');
  });

  it('names the npm script that is running, via npm_lifecycle_event', () => {
    expect(e2eTarget({ npm_lifecycle_event: 'e2e:only' }).command).toBe('npm run e2e:only');
    expect(e2eTarget({ npm_lifecycle_event: 'e2e:ui' }).label).toBe('e2e:ui');
  });

  it('does not say "NO BUILD RAN" behind the scripts that build', () => {
    for (const script of ['e2e', 'e2e:headed']) {
      const t = e2eTarget({ npm_lifecycle_event: script });
      expect(t.command).toBe(`npm run ${script}`);
      expect(t.headline).not.toBe(NO_BUILD_HEADLINE);
    }
    for (const script of ['e2e:only', 'e2e:ui']) {
      expect(e2eTarget({ npm_lifecycle_event: script }).headline).toBe(NO_BUILD_HEADLINE);
    }
  });

  it('recognises every package.json script that ends in a Playwright run', () => {
    // The one way this rots: a sixth e2e script lands, `npm_lifecycle_event`
    // says a name the table has never heard of, and its report quietly starts
    // advising `npx playwright test` to someone who typed something else. Ask
    // package.json rather than trusting the table to be maintained — the same
    // move `npmScriptFor` makes for the check bundles, and the same shape as
    // `check-scripts.test.ts` (#182).
    const { scripts } = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json')));
    const e2eScripts = Object.entries(scripts).filter(([, cmd]) => /\bplaywright test\b/.test(cmd));
    expect(e2eScripts.length).toBeGreaterThan(0);

    for (const [name, cmd] of e2eScripts) {
      const t = e2eTarget({ npm_lifecycle_event: name });
      expect({ name, command: t.command }).toEqual({ name, command: `npm run ${name}` });
      // ...and the headline must match reality: only the scripts that BUILD may
      // skip the "NO BUILD RAN" banner.
      const builds = /npm run build/.test(cmd);
      expect({ name, saysNoBuild: t.headline === NO_BUILD_HEADLINE }).toEqual({
        name,
        saysNoBuild: !builds,
      });
    }
  });

  it('falls back to the bare invocation for any other script', () => {
    // `npm test` spawning playwright, a wrapper script, a future entry point:
    // an unrecognised name must not be printed as `npm run <it>`.
    expect(e2eTarget({ npm_lifecycle_event: 'test' }).command).toBe('npx playwright test');
  });

  it('judges the same artifacts as e2e:only — only the words move', () => {
    for (const env of [{}, { npm_lifecycle_event: 'e2e' }, { npm_lifecycle_event: 'e2e:only' }]) {
      expect(e2eTarget(env).artifacts).toEqual(E2E_TARGET.artifacts);
    }
  });

  it('passes a fresh bundle and stamps it', () => {
    const root = project({ sources: { 'src/main/index.ts': 'a' } });
    let out = '';
    expect(guardE2eBundle(root, {}, (s) => (out += s))).toBe(true);
    expect(out).toContain('playwright test — NO BUILD RAN');
    expect(out).toContain('FRESH');
  });

  it('fails a stale bundle with a remedy for the command that was typed', () => {
    const root = project({ sources: { 'src/renderer/App.tsx': 'a' } });
    touch(root, 'src/renderer/App.tsx', new Date());
    let out = '';
    expect(guardE2eBundle(root, { npm_lifecycle_event: 'e2e:only' }, (s) => (out += s))).toBe(false);
    expect(out).toContain('STALE');
    expect(out).toContain('src/renderer/App.tsx');
    expect(out).toContain(`${OVERRIDE_ENV}=1 npm run e2e:only`);
  });

  it('is honoured by the same override', () => {
    const root = project({ sources: { 'src/main/index.ts': 'a' } });
    touch(root, 'src/main/index.ts', new Date());
    expect(guardE2eBundle(root, { [OVERRIDE_ENV]: '1' }, () => {})).toBe(true);
  });
});

describe('isBuildOutput — which runs run-electron-node guards (#298)', () => {
  const root = process.cwd();

  it('recognises a bundle under out/, however it is spelled', () => {
    expect(isBuildOutput(root, 'out/main/pty-check.js')).toBe(true);
    expect(isBuildOutput(root, path.join(root, 'out', 'main', 'pty-check.js'))).toBe(true);
    expect(isBuildOutput(root, 'out\\main\\pty-check.js')).toBe(true);
  });

  it('leaves anything that did not come from a build alone', () => {
    // The runner is general. Pointed at a hand-written script it must stay a
    // plain runner — failing because there is no out/main/index.js beside a
    // file that never came from a build would be pure noise.
    expect(isBuildOutput(root, 'scripts/some-scratch.js')).toBe(false);
    expect(isBuildOutput(root, '../outside.js')).toBe(false);
    expect(isBuildOutput(root, undefined)).toBe(false);
  });
});

describe('the CLI entry point', () => {
  it('reports on THIS repo without throwing (whatever the verdict)', () => {
    // The hand-run spelling — `node scripts/bundle-guard.js` — and the shape
    // every in-process caller shares. (#329 moved e2e's call into Playwright's
    // globalSetup, so no package.json script runs this file directly any more;
    // it remains the way to ask the question without starting a suite.) It must
    // print its stamp to stderr and exit 0 or 1 - never crash, because a guard
    // that throws blocks a test run it was only supposed to describe.
    //
    // Both verdicts are acceptable: ci.yml runs `npm test` BEFORE `npm run
    // build`, so on a runner out/ is absent and this exits 1.
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: process.cwd(), encoding: 'utf8' });
    expect([0, 1]).toContain(r.status);
    expect(r.stderr).toContain('NO BUILD RAN');
  });

  it('finds the real build identity whenever out/ has been built', () => {
    // The other half of the bundler contract: if a bundler change ever broke
    // extraction, everything above would still pass on synthetic fixtures while
    // the real stamp silently read "unknown". Skipped when out/ is absent,
    // which is exactly CI - hence the fixture test above carries it there.
    if (!fs.existsSync(path.join(process.cwd(), 'out', 'main', 'index.js'))) return;
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: process.cwd(), encoding: 'utf8' });
    expect(r.stderr).not.toContain('no build identity found');
  });

  it('gives the same verdict from a subdirectory as from the project root', () => {
    // Root is resolved from __dirname; a cwd-relative guard would find no out/
    // from anywhere but the root and hard-fail with a message that is untrue.
    const at = (cwd) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
    const root = at(process.cwd());
    const sub = at(path.join(process.cwd(), 'scripts'));
    expect(sub.status).toBe(root.status);
    // ages drift by a second between the two runs; the verdict word must not
    const verdict = ['FRESH', 'STALE', 'out/ is incomplete'].find((v) => root.stderr.includes(v));
    expect(verdict, `no verdict in:\n${root.stderr}`).toBeTruthy();
    expect(sub.stderr).toContain(verdict);
  });
});
