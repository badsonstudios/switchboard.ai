// #354 — tests for the orphan sweep.
//
// This is a DELETE loop pointed at a shared, user-owned directory, so the tests
// that matter most are the ones proving what it will NOT touch. Every case runs
// against a real directory tree rather than a mocked `fs`: the whole question
// is what `readdir`, dirent `isDirectory()` and `mtime` actually say, which is
// precisely what a mock would let us assert wrongly.
//
// Nothing here points the sweeper at the real `os.tmpdir()`. `tempDir()` gives
// each case its own root (and #213's registry deletes it afterwards), and every
// call passes `dir:` explicitly.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { tempDir, cleanupTempDirs, withTempDirAt } from '../src/test-temp-dirs';
import {
  ORPHAN_NAME,
  DEFAULT_MIN_AGE_MS,
  MAX_LISTED_ERRORS,
  SKIP_ENV,
  USAGE,
  isPlausibleTempRoot,
  atLeast,
  MIN_AGE_FLOOR_HOURS,
  sweepTempOrphans,
  sweepBeforeTests,
  formatSummary,
  parseArgs,
  main,
} from './sweep-temp-orphans.js';
import vitestGlobalSetup from './vitest-global-setup.js';
import vitestConfig from '../vitest.config.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** @type {string} */
let root;

beforeEach(() => {
  root = tempDir('sb-sweep-test-');
  return () => cleanupTempDirs();
});

/** A directory with a file in it, aged by rewriting its mtime. */
function seed(name, ageMs = 10 * DAY) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace.json'), '{}');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, when, when);
  return dir;
}

const names = () => fs.readdirSync(root).sort();

describe('ORPHAN_NAME', () => {
  // The names in the 2026-08-08 census, i.e. every prefix the suite has ever
  // used, including the ones the tree no longer contains.
  it.each([
    'sb-ws-a1B2c3',
    'sb-e2e-proj-XyZ012',
    'sb-tw-check-log-aaaaaa',
    'sb-hook-check-work-ZZZZZZ',
    'sb-tr-000000',
    'sb-s11-longrun-Ab0Cd1',
    'sb-probe-140-qqqqqq',
  ])('matches %s', (name) => expect(ORPHAN_NAME.test(name)).toBe(true));

  it.each([
    ['no sb- prefix', 'tmp-abcdef'],
    ['someone else s sb', 'sbcl-tmp-abcdef'],
    ['hand-made, no random suffix', 'sb-scratch'],
    ['a file, not a mkdtemp name', 'sb-notes.txt'],
    ['suffix too short', 'sb-ws-a1B2c'],
    ['suffix too long', 'sb-ws-a1B2c3d'],
    ['suffix outside libuv alphabet', 'sb-ws-a1B2c_'],
    ['nothing between prefix and suffix', 'sb-abcdef'],
    ['leading separator in the slug', 'sb--abcdef'],
    ['a path, not a name', 'sb-ws-abcdef/evil'],
    ['traversal', '../sb-ws-abcdef'],
    ['trailing newline', 'sb-ws-abcdef\n'],
  ])('rejects %s', (_why, name) => expect(ORPHAN_NAME.test(name)).toBe(false));
});

describe('sweepTempOrphans', () => {
  it('removes our old directories and reports them', () => {
    seed('sb-ws-aaaaaa');
    seed('sb-e2e-proj-bbbbbb');
    const summary = sweepTempOrphans({ dir: root });
    expect(summary.removed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(names()).toEqual([]);
  });

  it('leaves anything that is not one of our mkdtemp names', () => {
    seed('sb-ws-aaaaaa');
    // Each of these is a real thing that has been seen in a %TEMP%.
    seed('npm-cache-abcdef');
    seed('sb-scratch');
    fs.writeFileSync(path.join(root, 'sb-ws-ffffff.log'), 'x');
    const summary = sweepTempOrphans({ dir: root });
    expect(summary.removed).toBe(1);
    expect(names()).toEqual(['npm-cache-abcdef', 'sb-scratch', 'sb-ws-ffffff.log']);
  });

  it('leaves a FILE whose name has the mkdtemp shape', () => {
    // `force: true` would happily delete it, so the isDirectory() gate is the
    // only thing standing between a stray file and deletion.
    fs.writeFileSync(path.join(root, 'sb-ws-aaaaaa'), 'not a directory');
    const old = new Date(Date.now() - 10 * DAY);
    fs.utimesSync(path.join(root, 'sb-ws-aaaaaa'), old, old);
    const summary = sweepTempOrphans({ dir: root });
    expect(summary.matched).toBe(0);
    expect(summary.removed).toBe(0);
    expect(names()).toEqual(['sb-ws-aaaaaa']);
  });

  it('leaves a SYMLINK that points at a directory', () => {
    // `readdir`'s dirent answers from the lstat, so a link reads as "not a
    // directory" and is skipped — it is not a tree we made, and following it
    // would put the sweep somewhere it has no business being.
    const target = seed('sb-target-aaaaaa');
    const link = path.join(root, 'sb-ws-linked');
    // The link's own name MATCHES — that is what makes this test load-bearing.
    // Only the `isDirectory()` gate stands between it and deletion.
    expect(ORPHAN_NAME.test('sb-ws-linked')).toBe(true);
    let made = true;
    try {
      // 'junction' is the one Windows link type that needs no elevation.
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      const old = new Date(Date.now() - 10 * DAY);
      fs.lutimesSync(link, old, old);
      // Assert it really is old, or a failed lutimes would make this pass for
      // the wrong reason (spared as "too young" instead of "not a directory").
      expect(Date.now() - fs.lstatSync(link).mtimeMs).toBeGreaterThan(DAY);
    } catch {
      made = false; // no link privileges here; the target case below still runs
    }
    sweepTempOrphans({ dir: root });
    expect(fs.existsSync(target)).toBe(false); // the real directory did go
    if (made) expect(fs.readdirSync(root)).toContain('sb-ws-linked');
  });

  it('does not recurse — a nested orphan is out of reach', () => {
    const nest = seed('sb-ws-aaaaaa');
    const inner = path.join(nest, 'sb-ws-bbbbbb');
    fs.mkdirSync(inner);
    // The parent goes, so the child goes with it; what is pinned is that the
    // sweep only ever considers DIRECT children — `scanned` is one directory.
    const summary = sweepTempOrphans({ dir: root, dryRun: true });
    expect(summary.scanned).toBe(1);
    expect(summary.matched).toBe(1);
    expect(fs.existsSync(inner)).toBe(true);
  });

  describe('age', () => {
    it('spares anything younger than the threshold', () => {
      seed('sb-ws-young1', 2 * HOUR);
      seed('sb-ws-old111', 10 * DAY);
      const summary = sweepTempOrphans({ dir: root });
      expect(summary.tooYoung).toBe(1);
      expect(summary.removed).toBe(1);
      expect(names()).toEqual(['sb-ws-young1']);
    });

    it('is the whole concurrency story: a directory made just now survives', () => {
      // What a sibling suite, an e2e run or a `check:*` probe looks like.
      const live = path.join(root, 'sb-hooks-liveaa');
      fs.mkdirSync(live);
      expect(sweepTempOrphans({ dir: root }).removed).toBe(0);
      expect(fs.existsSync(live)).toBe(true);
    });

    it('defaults to 24 hours', () => {
      seed('sb-ws-just23', 23 * HOUR);
      seed('sb-ws-just25', 25 * HOUR);
      expect(DEFAULT_MIN_AGE_MS).toBe(DAY);
      sweepTempOrphans({ dir: root });
      expect(names()).toEqual(['sb-ws-just23']);
    });

    it('measures against `now`, so a caller can pin the clock', () => {
      seed('sb-ws-aaaaaa', 10 * DAY);
      // A clock 30 days behind makes a 10-day-old directory look unborn.
      const summary = sweepTempOrphans({ dir: root, now: Date.now() - 30 * DAY });
      expect(summary.tooYoung).toBe(1);
      expect(summary.removed).toBe(0);
    });

    it('reads mtime, which moves when an ENTRY is added to the directory', () => {
      const dir = seed('sb-ws-aaaaaa', 10 * DAY);
      fs.writeFileSync(path.join(dir, 'later.json'), '{}');
      expect(sweepTempOrphans({ dir: root }).removed).toBe(0);
    });

    it('...and NOT when the writing happens deeper in — mtime is not liveness', () => {
      // MEASURED, and the reason the 24 h floor has to carry the concurrency
      // argument by itself. An earlier draft of the code comment claimed a live
      // tree always reads as young; it does not. Appending to a file already
      // inside the directory, or writing anywhere in a subdirectory, leaves the
      // top-level mtime exactly where it was.
      const dir = seed('sb-ws-append', 10 * DAY);
      fs.appendFileSync(path.join(dir, 'workspace.json'), 'more');
      expect(Date.now() - fs.statSync(dir).mtimeMs).toBeGreaterThan(DAY);

      const nested = seed('sb-ws-nested', 10 * DAY);
      fs.mkdirSync(path.join(nested, 'sub')); // this DID move it — a new entry
      const nestedMtime = fs.statSync(nested).mtimeMs;
      fs.writeFileSync(path.join(nested, 'sub', 'deep.json'), '{}');
      expect(fs.statSync(nested).mtimeMs).toBe(nestedMtime); // deeper: no move

      // So the appended-to directory is swept despite having just been written.
      expect(sweepTempOrphans({ dir: root }).removed).toBe(1);
      expect(names()).toEqual(['sb-ws-nested']); // young only via the mkdir
    });
  });

  describe('budget', () => {
    it('stops early and says how much is left', () => {
      for (const n of ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd']) seed(`sb-ws-${n}`);
      // Zero budget: the first candidate already fails `elapsed >= budget`.
      const summary = sweepTempOrphans({ dir: root, budgetMs: 0 });
      expect(summary.budgetHit).toBe(true);
      expect(summary.removed).toBe(0);
      expect(summary.remaining).toBe(4);
      expect(names()).toHaveLength(4);
    });

    it('stops PART WAY: some removed, the rest left', () => {
      // The interesting middle, which a `budgetMs: 0` case never reaches.
      // A clock that jumps forward after the second delete is how the budget
      // is made to expire deterministically instead of by wall-clock luck.
      for (const n of ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd', 'eeeeee']) seed(`sb-ws-${n}`);
      const realNow = Date.now;
      let calls = 0;
      const t0 = realNow();
      Date.now = () => (++calls > 3 ? t0 + 10_000 : t0);
      let summary;
      try {
        summary = sweepTempOrphans({ dir: root, now: t0, budgetMs: 1_000 });
      } finally {
        Date.now = realNow;
      }
      expect(summary.budgetHit).toBe(true);
      expect(summary.removed).toBeGreaterThan(0);
      expect(summary.remaining).toBeGreaterThan(0);
      expect(summary.removed + summary.remaining).toBe(5);
      // And what is left is exactly what the next run will find.
      expect(names()).toHaveLength(summary.remaining);
    });

    it('is unlimited by default', () => {
      for (const n of ['aaaaaa', 'bbbbbb', 'cccccc']) seed(`sb-ws-${n}`);
      const summary = sweepTempOrphans({ dir: root });
      expect(summary.budgetHit).toBe(false);
      expect(summary.removed).toBe(3);
    });

    it('does not spend the budget on names that are not ours', () => {
      // Name-filtered entries are free: no stat, no budget, no `remaining`.
      seed('sb-notours-x', 10 * DAY); // no mkdtemp suffix
      seed('npm-cache-abcdef', 10 * DAY);
      const summary = sweepTempOrphans({ dir: root, budgetMs: 0 });
      expect(summary.matched).toBe(0);
      expect(summary.budgetHit).toBe(false);
      expect(summary.remaining).toBe(0);
    });

    it('bounds the STAT calls too, so `remaining` is a by-name estimate', () => {
      // The backlog this exists for is ~115k candidates and statting them all
      // costs ~4s — more than the budget it is supposed to be bounded by. So
      // once the budget is gone nothing is statted, and a YOUNG directory is
      // counted (pessimistically) as remaining rather than as `tooYoung`.
      seed('sb-ws-young1', 1 * HOUR);
      const realStat = fs.statSync;
      let stats = 0;
      fs.statSync = (...args) => {
        stats++;
        return realStat(...args);
      };
      try {
        const summary = sweepTempOrphans({ dir: root, budgetMs: 0 });
        expect(stats).toBe(0);
        expect(summary.tooYoung).toBe(0);
        expect(summary.remaining).toBe(1);
        expect(summary.budgetHit).toBe(true);
      } finally {
        fs.statSync = realStat;
      }
      expect(names()).toEqual(['sb-ws-young1']);
    });
  });

  describe('never throws', () => {
    it('on a temp dir that does not exist', () => {
      const summary = sweepTempOrphans({ dir: path.join(root, 'gone') });
      expect(summary.scanned).toBe(0);
      expect(summary.errors[0]).toContain('readdir');
    });

    it('on a filesystem root, which it refuses outright', () => {
      const rootPath = path.parse(process.cwd()).root;
      expect(isPlausibleTempRoot(rootPath)).toBe(false);
      const summary = sweepTempOrphans({ dir: rootPath });
      // Nothing was even listed — the refusal is before `readdir`.
      expect(summary.scanned).toBe(0);
      expect(summary.errors[0]).toContain('filesystem root');
    });

    it('accepts a normal temp dir', () => {
      expect(isPlausibleTempRoot(os.tmpdir())).toBe(true);
      expect(isPlausibleTempRoot(root)).toBe(true);
    });

    it('on an entry that vanishes between readdir and stat', () => {
      seed('sb-ws-aaaaaa');
      seed('sb-ws-bbbbbb');
      const realStat = fs.statSync;
      const spy = (p, ...rest) => {
        if (String(p).endsWith('aaaaaa')) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        return realStat(p, ...rest);
      };
      fs.statSync = spy;
      try {
        const summary = sweepTempOrphans({ dir: root });
        // The racer is skipped silently — a concurrent sweep winning is normal.
        expect(summary.matched).toBe(2);
        expect(summary.removed).toBe(1);
        expect(summary.failed).toBe(0);
        expect(summary.errors).toEqual([]);
      } finally {
        fs.statSync = realStat;
      }
    });

    it('on a delete that fails, and bounds how many it reports', () => {
      for (const n of ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd', 'eeeeee']) seed(`sb-ws-${n}`);
      const realRm = fs.rmSync;
      fs.rmSync = () => {
        throw new Error('EBUSY: the indexer has it');
      };
      try {
        const summary = sweepTempOrphans({ dir: root });
        expect(summary.failed).toBe(5);
        expect(summary.removed).toBe(0);
        expect(summary.errors).toHaveLength(MAX_LISTED_ERRORS);
        expect(summary.errors[0]).toContain('EBUSY');
      } finally {
        fs.rmSync = realRm;
      }
      // And the five are still there for the next run to try again.
      expect(names()).toHaveLength(5);
    });
  });

  it('dry-run counts without deleting', () => {
    seed('sb-ws-aaaaaa');
    const summary = sweepTempOrphans({ dir: root, dryRun: true });
    expect(summary.removed).toBe(1);
    expect(names()).toEqual(['sb-ws-aaaaaa']);
  });
});

describe('formatSummary', () => {
  it('says nothing when there was nothing to do', () => {
    expect(formatSummary(sweepTempOrphans({ dir: root }))).toBe('');
    seed('sb-ws-young1', 1 * HOUR);
    expect(formatSummary(sweepTempOrphans({ dir: root }))).toBe('');
  });

  it('speaks up when the budget ran out before the first delete', () => {
    // Otherwise "nothing to remove" while six figures of litter sit there —
    // which is how the backlog went unnoticed for twenty days.
    seed('sb-ws-aaaaaa');
    const line = formatSummary(sweepTempOrphans({ dir: root, budgetMs: 0 }));
    expect(line).toContain('1 left for the next run');
  });

  it('reports removals, and the dry-run says "would"', () => {
    seed('sb-ws-aaaaaa');
    expect(formatSummary(sweepTempOrphans({ dir: root, dryRun: true }), { dryRun: true })).toContain(
      'would remove 1'
    );
  });

  it('names the leftovers, the young and the failures', () => {
    const line = formatSummary({
      ...sweepTempOrphans({ dir: root }),
      removed: 4,
      remaining: 1,
      tooYoung: 3,
      failed: 2,
      errors: ['rm C:\\Temp\\sb-ws-aaaaaa: EBUSY'],
    });
    expect(line).toContain('removed 4 orphaned dir(s)');
    expect(line).toContain('1 left for the next run');
    expect(line).toContain('3 too young');
    expect(line).toContain('2 would not delete');
    expect(line).toContain('EBUSY');
  });

  it('reports a listing failure even though nothing was removed', () => {
    const line = formatSummary(sweepTempOrphans({ dir: path.join(root, 'gone') }));
    expect(line).toContain('removed 0 orphaned dir(s)');
    expect(line).toContain('readdir');
  });
});

describe('parseArgs', () => {
  it('defaults to a wet run with no overrides', () => {
    expect(parseArgs([])).toEqual({ dryRun: false });
  });

  it('reads the flags', () => {
    const opts = parseArgs(['--dry-run', '--min-age-hours=48', '--budget-ms=500']);
    expect(opts).toEqual({ dryRun: true, minAgeMs: 48 * HOUR, budgetMs: 500 });
  });

  it('accepts -n', () => expect(parseArgs(['-n']).dryRun).toBe(true));

  it('flags an unknown argument — including a bare path', () => {
    expect(parseArgs(['/tmp']).unknown).toBe('/tmp');
    expect(parseArgs(['--wat']).unknown).toBe('--wat');
  });

  it('flags a non-numeric value instead of turning it into NaN', () => {
    expect(parseArgs(['--min-age-hours=soon']).badNumber).toBe('--min-age-hours');
    expect(parseArgs(['--budget-ms']).badNumber).toBe('--budget-ms');
  });

  it('refuses an EMPTY value rather than reading it as zero', () => {
    // `Number('')` is 0, so this typo used to mean "no age floor", i.e. delete
    // the directory the running suite is using. It is now an error.
    expect(atLeast('', 0)).toBeNaN();
    expect(parseArgs(['--min-age-hours=']).badNumber).toBe('--min-age-hours');
    expect(parseArgs(['--min-age-hours=']).minAgeMs).toBeUndefined();
    expect(parseArgs(['--budget-ms=']).badNumber).toBe('--budget-ms');
  });

  it('refuses a negative age or budget, which reads the same way', () => {
    expect(parseArgs(['--min-age-hours=-1']).badNumber).toBe('--min-age-hours');
    expect(parseArgs(['--budget-ms=-1']).badNumber).toBe('--budget-ms');
  });

  it('refuses --min-age-hours=0 — the flag that empties a live suite', () => {
    // The whole safety argument is the age floor, so the CLI does not offer a
    // way to turn it off. Zero, and anything under an hour, is an error.
    expect(MIN_AGE_FLOOR_HOURS).toBe(1);
    expect(parseArgs(['--min-age-hours=0']).badNumber).toBe('--min-age-hours');
    expect(parseArgs(['--min-age-hours=0']).minAgeMs).toBeUndefined();
    expect(parseArgs(['--min-age-hours=0.5']).badNumber).toBe('--min-age-hours');
    expect(parseArgs(['--min-age-hours=1']).minAgeMs).toBe(HOUR);
    expect(USAGE).toContain('minimum 1');
  });

  it('keeps zero for the BUDGET, where it is meaningful', () => {
    expect(parseArgs(['--budget-ms=0'])).toEqual({ dryRun: false, budgetMs: 0 });
  });

  it('reports the FIRST bad argument, not the last', () => {
    expect(parseArgs(['--wat', '--nope']).unknown).toBe('--wat');
    expect(parseArgs(['--min-age-hours=x', '--budget-ms=y']).badNumber).toBe('--min-age-hours');
  });
});

describe('main', () => {
  // The CLI has no `--dir`, so these drive it the way a user would: by pointing
  // the OS temp dir at a fixture. Both process.env spellings are set because
  // `os.tmpdir()` reads TMPDIR on posix and TEMP/TMP on win32.
  const TMP_VARS = ['TMPDIR', 'TEMP', 'TMP'];
  const withTempDirAt = (dir, fn) => {
    const saved = TMP_VARS.map((k) => [k, process.env[k]]);
    for (const k of TMP_VARS) process.env[k] = dir;
    try {
      return fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('sweeps the temp dir and prints what it did, exit 0', () => {
    seed('sb-ws-aaaaaa');
    const out = [];
    expect(withTempDirAt(root, () => main([], (s) => out.push(s)))).toBe(0);
    expect(out.join('\n')).toContain('removed 1 orphaned dir(s)');
    expect(names()).toEqual([]);
  });

  it('says so when there is nothing to remove', () => {
    seed('sb-ws-young1', 1 * HOUR);
    const out = [];
    expect(withTempDirAt(root, () => main([], (s) => out.push(s)))).toBe(0);
    expect(out.join('\n')).toBe('temp sweep: nothing to remove');
    expect(names()).toEqual(['sb-ws-young1']);
  });

  it('--dry-run reports without deleting', () => {
    seed('sb-ws-aaaaaa');
    const out = [];
    expect(withTempDirAt(root, () => main(['--dry-run'], (s) => out.push(s)))).toBe(0);
    expect(out.join('\n')).toContain('would remove 1');
    expect(names()).toEqual(['sb-ws-aaaaaa']);
  });

  it('refuses a bad argument with usage and exit 2, sweeping nothing', () => {
    seed('sb-ws-aaaaaa');
    const out = [];
    expect(withTempDirAt(root, () => main(['--min-age-hours=nope'], (s) => out.push(s)))).toBe(2);
    expect(out.join('\n')).toContain('bad or out-of-range --min-age-hours');
    expect(out.join('\n')).toContain('Usage:');
    expect(names()).toEqual(['sb-ws-aaaaaa']);
  });

  it('refuses a positional path — the one that would be a disaster', () => {
    seed('sb-ws-aaaaaa');
    const out = [];
    expect(withTempDirAt(root, () => main([root], (s) => out.push(s)))).toBe(2);
    expect(out.join('\n')).toContain('unknown argument');
    expect(names()).toEqual(['sb-ws-aaaaaa']);
  });

  it('runs as a real process, and exits 2 on a bad argument', () => {
    seed('sb-ws-aaaaaa');
    // `process.cwd()`, not `__dirname` — the house pattern in
    // `bundle-guard.test.js`, and the only one eslint accepts in a test module.
    const script = path.join(process.cwd(), 'scripts', 'sweep-temp-orphans.js');
    const env = { ...process.env, TMPDIR: root, TEMP: root, TMP: root };
    const bad = spawnSync(process.execPath, [script, '--wat'], { encoding: 'utf8', env });
    expect(bad.status).toBe(2);
    expect(names()).toEqual(['sb-ws-aaaaaa']);

    const ok = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('removed 1 orphaned dir(s)');
    expect(names()).toEqual([]);
    // 30 s rather than vitest's 5 s default — the only case in this file that
    // spawns, and #512 is what two node starts can cost on a loaded runner.
  }, 30_000);
});

describe('the automatic sweep both globalSetups call', () => {
  // `sweepBeforeTests` deliberately exposes no `dir` — the seam it sits on gets
  // the OS temp dir and nothing else — so these point the OS temp dir at a
  // fixture, exactly as the `main` tests above do. NOTHING in this file may run
  // it against the real `%TEMP%`.
  // `withTempDirAt` is shared with `e2e-global-setup.test.js` and lives in
  // `src/test-temp-dirs.ts`; it refuses to run the callback if the redirect did
  // not take, which is the only thing keeping these tests off the real `%TEMP%`.

  it('sweeps and writes one line', () => {
    seed('sb-ws-aaaaaa');
    const wrote = [];
    withTempDirAt(root, () => sweepBeforeTests({ env: {}, write: (s) => wrote.push(s) }));
    expect(wrote.join('\n')).toContain('removed 1 orphaned dir(s)');
    expect(names()).toEqual([]);
  });

  it('stays silent when there is nothing to remove', () => {
    seed('sb-ws-young1', 1 * HOUR);
    const wrote = [];
    withTempDirAt(root, () => sweepBeforeTests({ env: {}, write: (s) => wrote.push(s) }));
    // A clean machine must not print a line on every single `npm test`.
    expect(wrote).toEqual([]);
  });

  it.each(['1', 'true', 'yes', 'on', 'whatever'])(
    'is a no-op when SB_SKIP_TEMP_SWEEP=%s',
    (value) => {
      // The house `isOn` rule (bundle-guard.js), not `=== '1'`. This is the only
      // off-switch on a delete loop, so `true` meaning "sweep anyway" would be
      // the wrong direction to fail in.
      seed('sb-ws-aaaaaa');
      const wrote = [];
      withTempDirAt(root, () =>
        sweepBeforeTests({ env: { [SKIP_ENV]: value }, write: (s) => wrote.push(s) })
      );
      expect(wrote).toEqual([]);
      expect(names()).toEqual(['sb-ws-aaaaaa']);
    }
  );

  it.each(['0', 'false', 'no', 'off', ''])('still sweeps when it is set to %s', (value) => {
    // The other half of `isOn`: a shell that turns the switch OFF explicitly
    // must not accidentally turn the sweep off too.
    seed('sb-ws-aaaaaa');
    withTempDirAt(root, () =>
      sweepBeforeTests({ env: { [SKIP_ENV]: value }, write: () => {} })
    );
    expect(names()).toEqual([]);
  });

  it('is budgeted by default, so a test run never pays for the backlog', () => {
    for (const n of ['aaaaaa', 'bbbbbb', 'cccccc']) seed(`sb-ws-${n}`);
    withTempDirAt(root, () => sweepBeforeTests({ env: {}, write: () => {}, budgetMs: 0 }));
    // Budget spent before the first delete: everything survives to the next run.
    expect(names()).toHaveLength(3);
  });

  it('swallows a throw rather than aborting the whole run', () => {
    // The sweep itself never throws; this pins the belt-and-braces catch by
    // making the WRITE throw, which is outside the sweep's own guards.
    const realReaddir = fs.readdirSync;
    fs.readdirSync = () => {
      throw new Error('boom');
    };
    try {
      expect(() =>
        withTempDirAt(root, () =>
          sweepBeforeTests({
            env: {},
            write: () => {
              throw new Error('stderr is gone');
            },
          })
        )
      ).not.toThrow();
    } finally {
      fs.readdirSync = realReaddir;
    }
  });

  // The wiring, which is the half that rots silently: a `globalSetup` that
  // stops being named in the config, or an export shape vitest rejects, both
  // look exactly like "there was nothing to sweep".
  it('is named in vitest.config.ts, and the file it names exists', () => {
    expect(vitestConfig.test.globalSetup).toEqual(['scripts/vitest-global-setup.js']);
    expect(fs.existsSync(path.join(process.cwd(), 'scripts/vitest-global-setup.js'))).toBe(true);
  });

  it('is what vitest.config.ts’s globalSetup actually runs', () => {
    // Driven through the real default export — a plain function, because
    // vitest's CJS interop rejects the `{ setup }` object form. Pointed at a
    // fixture: the real `%TEMP%` is never a target from a test.
    expect(typeof vitestGlobalSetup).toBe('function');
    seed('sb-ws-aaaaaa');
    // The default export takes no `write`, so its line goes to the real stderr
    // — captured here rather than printed, because a test that prints into the
    // run it is part of is indistinguishable from the thing going wrong.
    const realWrite = process.stderr.write;
    const wrote = [];
    process.stderr.write = (s) => (wrote.push(String(s)), true);
    // It reads the REAL `process.env` too, and a developer running the suite
    // with SB_SKIP_TEMP_SWEEP=1 (the sanctioned way to keep old `sb-*`
    // directories alive) would otherwise see this fail for the right reason.
    const skip = process.env[SKIP_ENV];
    delete process.env[SKIP_ENV];
    try {
      withTempDirAt(root, () => vitestGlobalSetup());
    } finally {
      process.stderr.write = realWrite;
      if (skip !== undefined) process.env[SKIP_ENV] = skip;
    }
    expect(wrote.join('')).toContain('removed 1 orphaned dir(s)');
    expect(names()).toEqual([]);
  });
});
